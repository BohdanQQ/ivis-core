const crypto = require('crypto');
const log = require('../../log');
const ssh = require('../../instance-ssh');
const LOG_ID = 'slurm-pool';
const { TaskType, PythonSubtypes, defaultSubtypeKey } = require('../../../../shared/tasks');
const config = require('../../config');
const scripts = require('./setup');
const { EventTypes, emitter, getSuccessEventType, getOutputEventType, getFailEventType } = require('../../task-events');
const {
    ExecutorPaths, TaskPaths, RunPaths
} = require('./paths');
const { RemoteRunState } = require('../../../../shared/remote-run');

// TODO export from 1 place (python-handler also uses these)
const defaultPythonLibs = ['elasticsearch6', 'requests'];
const ptyhonTaskSubtypeSpecs = {
    [defaultSubtypeKey]: {
        libs: [...defaultPythonLibs],
    },
    [PythonSubtypes.ENERGY_PLUS]: {
        libs: [...defaultPythonLibs, 'eppy', 'requests'],
    },
    [PythonSubtypes.NUMPY]: {
        libs: [...defaultPythonLibs, 'numpy', 'dtw'],
    },
    [PythonSubtypes.PANDAS]: {
        libs: [...defaultPythonLibs, 'pandas'],
    },
};

class CacheRecord {
    constructor(commandExecutor, executorId, taskId) {
        this.commandExecutor = commandExecutor;
        this.taskPaths = new TaskPaths(new ExecutorPaths(executorId), taskId);
    }

    async isValid(cacheValidityGuard) {
        const cacheRecordPath = this.taskPaths.cacheRecordPath();
        const notCachedExpectedOutput = 'notcached';
        const {
            stdout
        } = await this.commandExecutor(`( [ -f ${cacheRecordPath} ] && [ $(grep -e ^${cacheValidityGuard}$ ${cacheRecordPath}) = "${cacheValidityGuard}" ] ) || echo ${notCachedExpectedOutput}`);
        // ^^^^^ checks file exists and contains exactly the guard - prints notCachedExpectedOutput if NOT cached ^^^^^
        console.log('valid out: ', stdout.join('\n').trim());
        return stdout.join('\n').trim() != notCachedExpectedOutput;
    }

    async remove() {
        const command = `rm -f ${this.taskPaths.cacheRecordPath()}`;
        await this.commandExecutor(command);
    }

    async create(cacheValidityGuard) {
        const command = `echo ${cacheValidityGuard} > ${this.taskPaths.cacheRecordPath()}`;
        await this.commandExecutor(command);
    }
};


function createSlurmSSHCommander(host, port, username, password) {
    // TODO wrap with slurm calls (but not here - find scancel ... )
    log.verbose(LOG_ID, `creating SSH commander for ${username}@${host}:${port}`);
    return async (command) => {
        log.verbose(LOG_ID, `$> ${command}`);
        return await ssh.executeCommand(command, host, port, username, password)
    };
}

function commanderFromExecutor(executor) {
    const { hostname, port, username, password } = executor.parameters;
    return createSlurmSSHCommander(hostname, port, username, password);
}

async function getIdMapping(runPaths, commandExecutor) {
    try {
        return (await commandExecutor(`cat ${runPaths.idMappingPath()}`)).stdout.join('\n').trim();

    }
    catch (err) {
        return null;
    }
}

const scriptSetup = {
    [TaskType.PYTHON]: {
        'run': {
            'pathGetter': (executorPaths) => `${executorPaths.remoteUtilsRepoDirectory()}/__python_start.sh`,
            'contentCreator': scripts.getPythonRunScript
        },
        'init': {
            'pathGetter': (executorPaths) => `${executorPaths.remoteUtilsRepoDirectory()}/__python_init.sh`,
            'contentCreator': scripts.getPythonTaskInitScript
        }
    }
};

const fs = require('fs');
function getArchiveHash(archivePath, type, subtype) {
    const HASH_INPUT_ENCODING = 'utf-8';
    const HASH_OUTPUT_ENCODING = 'hex';
    return crypto.createHash('sha512')
        .update(type.toString(), HASH_INPUT_ENCODING)
        .update(fs.readFileSync(archivePath), HASH_INPUT_ENCODING)
        .update(subtype.toString(), HASH_INPUT_ENCODING)
        .digest(HASH_OUTPUT_ENCODING);
}

// TODO PATHS, maybe use inheritance?
const taskTypeRunCommand = {
    [TaskType.PYTHON]: (taskPaths, runPaths, runId, buildSlurmId) => {
        const pythonRunnerArgs = [
            config.tasks.maxRunOutputBytes,
            1, // buffering time in seconds
            `${config.www.trustedUrlBase}/rest/remote/emit`,
            getOutputEventType(runId)
        ].join(' ');
        const runnerScriptArgs = [
            taskPaths.taskDirectory(),
            runPaths.inputsPath(),
            taskPaths.execPaths.buildOutputPath(buildSlurmId),
            taskPaths.execPaths.buildFailInformantScriptPath(),
            getFailEventType(runId)
        ].join(' ');
        const runnerScript = scriptSetup[TaskType.PYTHON].run.pathGetter(taskPaths.execPaths);
        return `${runnerScript} ${runnerScriptArgs} ${pythonRunnerArgs} > ${runPaths.idMappingPath()}`;
    }
};

const taskTypeInitCommand = {
    [TaskType.PYTHON]: (taskPaths, subtype) => `${scriptSetup[TaskType.PYTHON].init.pathGetter(taskPaths.execPaths)} ${taskPaths.taskDirectory()} ${ptyhonTaskSubtypeSpecs[subtype].libs.join(' ')}`
};

function getRunJobSlurmName(runId) {
    return `${runId}`;
}

/**
 * 
 * @param {TaskPaths} taskPaths 
 * @param {RunPaths} runPaths 
 * @param {*} runConfig 
 * @param {*} commandExecutor 
 */
async function createRunInput(taskPaths, runPaths, runConfig, commandExecutor) {
    const realRunConfig = {
        context: {
            jobId: runConfig.jobId,
        },
        params: runConfig.params,
        entities: runConfig.entities,
        owned: runConfig.owned,
        accessToken: runConfig.accessToken,
        certs: true,
        caPath: taskPaths.execPaths.caPath(),
        certPath: taskPaths.execPaths.certPath(),
        keyPath: taskPaths.execPaths.certKeyPath(),
        es: {
            host: config.elasticsearch.host,
            port: config.elasticsearch.port,
        },
        server: {
            trustedUrlBase: `${config.www.trustedUrlBase}`,
            sandboxUrlBase: `${config.www.sandboxUrlBase}`,
            trustedEmitPath: '/rest/remote/emit'
        },
        state: runConfig.state,
    };
    const inputFileContents = `${JSON.stringify(realRunConfig)}\n`;
    await commandExecutor(`cat > ${runPaths.inputsPath()} << HEREDOC_EOF\n${inputFileContents}\nHEREDOC_EOF`);
}

async function runImpl(taskPaths, runPaths, config, taskType, commandExecutor, buildDependency, outputCheckId) {
    await createRunInput(taskPaths, runPaths, config, commandExecutor)
    const dependencyOption = buildDependency ? ` --dependency=after:${buildDependency} ` : ' ';
    const command = `sbatch${dependencyOption}--job-name=${getRunJobSlurmName(config.runId)} --parsable ${taskTypeRunCommand[taskType](taskPaths, runPaths, config.runId, outputCheckId)}`;
    await commandExecutor(command);
    return;
}

async function run(executor, archivePath, config, type, subtype) {
    subtype = subtype ? subtype : defaultSubtypeKey;
    const execPaths = new ExecutorPaths(executor.id);
    const taskPaths = new TaskPaths(execPaths, config.taskId);
    const runPaths = new RunPaths(execPaths, config.runId);

    const archiveHash = getArchiveHash(archivePath, type, subtype);
    const commandExecutor = commanderFromExecutor(executor);
    const cacheRecord = new CacheRecord(commandExecutor, executor.id, config.taskId);
    let waitForId = null;
    let checkOutputId = null
    if (!(await cacheRecord.isValid(archiveHash))) {
        await cacheRecord.remove();
        [waitForId, checkOutputId] = await build(taskPaths, type, subtype, archivePath, commandExecutor, executor);
        await cacheRecord.create(archiveHash);
    }

    await runImpl(taskPaths, runPaths, config, type, commandExecutor, waitForId, checkOutputId);
    return;
}

async function getHomeDir(commandExecutor) {
    return (await commandExecutor(`echo ~`)).stdout.join('\n').trim();
}

async function build(taskPaths, type, subtype, archivePath, commandExecutor, executor) {
    const homedir = await getHomeDir(commandExecutor);
    const remoteArchivePath = `${taskPaths.taskDirectoryWithHomeDir(homedir)}/____taskarchive`;
    const { hostname, port, username, password } = executor.parameters;
    log.info(LOG_ID, 'from: ', archivePath, ' to: ', remoteArchivePath);
    await commandExecutor(`mkdir -p ${taskPaths.taskDirectory()}`);
    await ssh.uploadFile(archivePath, remoteArchivePath, hostname, port, username, password);

    const unarchiveCmd = `tar -xf ${remoteArchivePath} --directory=${taskPaths.taskDirectoryWithHomeDir(homedir)}`;
    await commandExecutor(unarchiveCmd);
    await commandExecutor(`rm -f ${remoteArchivePath}`);

    const initCmd = `sbatch --parsable ${taskTypeInitCommand[type](taskPaths, subtype)}`;
    const buildId = (await commandExecutor(initCmd)).stdout.join('\n').trim();
    if (buildId.match(/^[0-9]+$/g) === null) {
        throw new Error(`Build job slurm ID was invalid: ${buildId}`);
    }

    // cleanup after build
    const jobId = (await commandExecutor(`sbatch --parasble --output=/dev/null --dependency=after:${buildId} ${taskPaths.execPaths.buildOutputCleanScriptPath()} ${taskPaths.execPaths.buildOutputPath(buildId)}`));
    if (jobId.match(/^[0-9]+$/g) === null) {
        throw new Error(`Build job slurm ID was invalid: ${jobId}`);
    }
    return [jobId, buildId];
}

async function stop(executor, runId) {
    const commandExecutor = commanderFromExecutor(executor);
    const runPaths = new RunPaths(new ExecutorPaths(executor.id), runId);
    const sbatchJobId = await getIdMapping(runPaths, commandExecutor);
    if (sbatchJobId === null) {
        return;
    }
    await commandExecutor(`scancel ${sbatchJobId}`);
}

async function removeRun(executor, runId) {
    const commandExecutor = commanderFromExecutor(executor);
    const execPaths = new ExecutorPaths(executor.id);
    const runPaths = new RunPaths(execPaths, runId);
    await commandExecutor(`rm -f ${runPaths.inputsPath()} ${runPaths.idMappingPath()}`);
    const jobId = await getIdMapping(runPaths, commandExecutor);
    if (jobId !== null) {
        await commandExecutor(`rm -f ${runPaths.slurmOutputsPath(jobId)}`);
    }
}

const slurmStateToIvisState = {
    "CD": RemoteRunState.SUCCESS,
    "CG": RemoteRunState.SUCCESS,
    "CA": RemoteRunState.RUN_FAIL,
    "F": RemoteRunState.RUN_FAIL,
    "PD": RemoteRunState.QUEUED,
    "PR": RemoteRunState.RUN_FAIL,
    "R": RemoteRunState.RUNNING,
    "S": RemoteRunState.RUN_FAIL,
    "ST": RemoteRunState.RUN_FAIL,
    "OOM": RemoteRunState.RUN_FAIL,
    "TO": RemoteRunState.RUN_FAIL,
    "NF": RemoteRunState.RUN_FAIL,
};

async function getRunSqueueStatus(slurmId, commandExecutor) {
    try {
        const squeueState = (await commandExecutor(`squeue --job ${slurmId} -o "%t" | sed -n 2p`)).stdout.join('\n').trim();
        const ivisState = slurmStateToIvisState[squeueState];
        return ivisState === undefined ? null : ivisState;
    } catch (err) {
        // TODO make sure request is repeated, log error
        return null;
    }
}

async function resolveFinishedState(runPaths, slurmId, commandExecutor) {
    const getStatusCodeCommand = `cat ${runPaths.slurmOutputsPath(slurmId)} | tail -n 1`;
    let lastOutputLine = null;
    try {
        lastOutputLine = (await commandExecutor(getStatusCodeCommand)).stdout.join('\n').trim();
    }
    catch (err) {
        // TODO make sure request is repeated, log error
        return null;
    }

    try {
        const statusCode = Number.parseInt(lastOutputLine, 10);
        return statusCode === 0 ? RemoteRunState.SUCCESS : RemoteRunState.RUN_FAIL;
    }
    catch {
        log.error(LOG_ID, "Unexpected last line of run output. Expecting a number indicating the run exit code, got:", lastOutputLine);
    }

    return null;
}

async function status(executor, runId) {
    const commandExecutor = commanderFromExecutor(executor);
    const runPaths = new RunPaths(new ExecutorPaths(executor.id), runId);

    // check mapping
    const slurmJobId = await getIdMapping(runPaths, commandExecutor);
    if (slurmJobId === null) {
        // no mapping -> return not found
        return null;
    }

    const state = await getRunSqueueStatus(slurmJobId, commandExecutor);
    if (state === null) {
        return await resolveFinishedState(runPaths, slurmJobId, commandExecutor);
    }

    return state;
}

function getPoolInitCommands(executorId, certCA, certKey, cert, homedir) {
    const utilsRepoURL = config.slurm.utilsRepo.url;
    const utilsRepoCommit = config.slurm.utilsRepo.commit;
    const execPaths = new ExecutorPaths(executorId);
    const commands = [execPaths.rootDirectory(), execPaths.tasksRootDirectory(), execPaths.certDirectory(), execPaths.cacheDirectory(),
    execPaths.outputsDirectory(), execPaths.inputsDirectory()]
        .map(path => `mkdir -p ${path}`);

    [[execPaths.caPath(), certCA], [execPaths.certKeyPath(), certKey], [execPaths.certPath(), cert]].forEach(([path, contents]) =>
        commands.push(`cat > ${path} << HEREDOC_EOF\n${contents}\nHEREDOC_EOF`));

    commands.push(...[
        `git clone ${utilsRepoURL} ${execPaths.remoteUtilsRepoDirectory()}`,
        (utilsRepoCommit ? `cd ${execPaths.remoteUtilsRepoDirectory()} && git checkout ${utilsRepoCommit}` : 'echo using HEAD')
    ]);

    // TODO adapt for more task types... ( runner.py ??? )
    // more TODO: adapt the ivis package paths for more task types
    for (const taskType of [TaskType.PYTHON]) {
        let scriptInfo = scriptSetup[taskType];
        commands.push(`cat > ${scriptInfo.init.pathGetter(execPaths)} << HEREDOC_EOF\n${scriptInfo.init.contentCreator(execPaths.buildOutputSbatchFormatPath(homedir), execPaths.ivisPackageDirectory())}\nHEREDOC_EOF`);
        commands.push(`chmod u+x ${scriptInfo.init.pathGetter(execPaths)}`);

        commands.push(`cat > ${scriptInfo.run.pathGetter(execPaths)} << HEREDOC_EOF\n${scriptInfo.run.contentCreator(execPaths.outputSbatchFormatPath(homedir), `${execPaths.remoteUtilsRepoDirectory()}/runner.py`)}\nHEREDOC_EOF`);
        commands.push(`chmod u+x ${scriptInfo.run.pathGetter(execPaths)}`);
    }
    // TODO - clean this mess
    commands.push(`cat > ${execPaths.buildOutputCleanScriptPath()} << HEREDOC_EOF\n${scripts.getBuildOutputCleanScript()}\nHEREDOC_EOF`);
    commands.push(`chmod u+x ${execPaths.buildOutputCleanScriptPath()}`);

    commands.push(`cat > ${execPaths.buildFailInformantScriptPath()} << HEREDOC_EOF\n${scripts.buildFailInformantScript(
        execPaths.certKeyPath(), execPaths.certPath(), config.oci.ivisSSLCertVerifiableViaRootCAs, execPaths.caPath()
    )}\nHEREDOC_EOF`);
    commands.push(`chmod u+x ${execPaths.buildFailInformantScriptPath()}`);

    commands.push(`chmod u+x ${execPaths.remoteUtilsRepoDirectory()}/install.sh`);
    // waits for the result
    commands.push(`srun ${execPaths.remoteUtilsRepoDirectory()}/install.sh ${execPaths.remoteUtilsRepoDirectory()}`);
    return commands;
}

const certs = require('../../remote-certificates');
async function createSlurmPool(executor, certificateGeneratorFunction) {
    await certificateGeneratorFunction(null);

    const ca = certs.getRemoteCACert();
    const {
        cert,
        key
    } = certs.getExecutorCertKey(executor.id);
    const commander = commanderFromExecutor(executor);
    const commands = getPoolInitCommands(executor.id, ca, key, cert, await getHomeDir(commander));


    for (const command of commands) {
        await commander(command);
    }
}

module.exports = {
    status, run, stop, removeRun, createSlurmPool
}