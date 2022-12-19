const crypto = require('crypto');
const fs = require('fs');
const log = require('../../log');
const ssh = require('../../instance-ssh');
const { TaskType, defaultSubtypeKey } = require('../../../../shared/tasks');
const config = require('../../config');
const scripts = require('./scripts');
const {
    ExecutorPaths, TaskPaths, RunPaths,
} = require('./paths');
const { RemoteRunState } = require('../../../../shared/remote-run');
const certs = require('../../remote-certificates');

const LOG_ID = 'slurm-pool';

class CacheRecord {
    constructor(commandExecutor, executorId, taskId) {
        this.commandExecutor = commandExecutor;
        this.taskPaths = new TaskPaths(new ExecutorPaths(executorId), taskId);
    }

    async isValid(cacheValidityGuard) {
        const cacheRecordPath = this.taskPaths.cacheRecordPath();
        const notCachedExpectedOutput = 'notcached';
        const output = await getCommandOutput(this.commandExecutor, `( [ -f ${cacheRecordPath} ] && [ $(grep -e ^${cacheValidityGuard}$ ${cacheRecordPath}) = "${cacheValidityGuard}" ] ) || echo ${notCachedExpectedOutput}`);
        // ^^^^^ checks file exists and contains exactly the guard - prints notCachedExpectedOutput if NOT cached ^^^^^
        return output !== notCachedExpectedOutput;
    }

    async remove() {
        const command = `rm -f ${this.taskPaths.cacheRecordPath()}`;
        await this.commandExecutor(command);
    }

    async create(cacheValidityGuard) {
        const command = `echo ${cacheValidityGuard} > ${this.taskPaths.cacheRecordPath()}`;
        await this.commandExecutor(command);
    }
}

function createSlurmSSHCommander(host, port, username, password) {
    log.verbose(LOG_ID, `creating SSH commander for ${username}@${host}:${port}`);
    return async (command) => {
        log.verbose(LOG_ID, `$> ${command}`);
        return ssh.executeCommand(command, host, port, username, password);
    };
}

function commanderFromExecutor(executor) {
    const {
        hostname, port, username, password,
    } = executor.parameters;
    return createSlurmSSHCommander(hostname, port, username, password);
}

async function getCommandOutput(executor, command) {
    return (await executor(command)).stdout.join('\n').trim();
}

async function getIdMapping(runPaths, commandExecutor) {
    try {
        return await getCommandOutput(commandExecutor, `cat ${runPaths.idMappingPath()}`);
    } catch (err) {
        return null;
    }
}

function getArchiveHash(archivePath, type, subtype) {
    const HASH_INPUT_ENCODING = 'utf-8';
    const HASH_OUTPUT_ENCODING = 'hex';
    return crypto.createHash('sha512')
        .update(type.toString(), HASH_INPUT_ENCODING)
        .update(fs.readFileSync(archivePath), HASH_INPUT_ENCODING)
        .update(subtype.toString(), HASH_INPUT_ENCODING)
        .digest(HASH_OUTPUT_ENCODING);
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
            trustedEmitPath: '/rest/remote/emit',
        },
        state: runConfig.state,
    };
    const inputFileContents = `${JSON.stringify(realRunConfig)}\n`;

    await commandExecutor(scripts.createFileCommand(runPaths.inputsPath(), inputFileContents));
}

function getRunJobSlurmName(runId) {
    return `${runId}`;
}

async function runImpl(taskPaths, runPaths, runConfig, taskType, commandExecutor, buildDependency, outputCheckId) {
    await createRunInput(taskPaths, runPaths, runConfig, commandExecutor);
    const dependencyOption = buildDependency ? ` --dependency=afterany:${buildDependency} ` : ' ';
    const command = `sbatch${dependencyOption}--job-name=${getRunJobSlurmName(runConfig.runId)} --parsable ${scripts.getRunScriptInvocation(taskType, taskPaths, runConfig.runId, runPaths, outputCheckId)} > ${runPaths.idMappingPath()}`;
    await commandExecutor(command);
}

async function run(executor, archivePath, runConfig, type, subtype) {
    const toUseSubtype = subtype || defaultSubtypeKey;
    const execPaths = new ExecutorPaths(executor.id);
    const taskPaths = new TaskPaths(execPaths, runConfig.taskId);
    const runPaths = new RunPaths(execPaths, runConfig.runId);

    const archiveHash = getArchiveHash(archivePath, type, toUseSubtype);
    const commandExecutor = commanderFromExecutor(executor);
    const cacheRecord = new CacheRecord(commandExecutor, executor.id, runConfig.taskId);
    let waitForId = null;
    let checkOutputId = null;
    if (!(await cacheRecord.isValid(archiveHash))) {
        await cacheRecord.remove();
        [waitForId, checkOutputId] = await build(taskPaths, type, toUseSubtype, archivePath, commandExecutor, executor);
        await cacheRecord.create(archiveHash);
    }

    await runImpl(taskPaths, runPaths, runConfig, type, commandExecutor, waitForId, checkOutputId);
}

async function getHomeDir(commandExecutor) {
    return getCommandOutput(commandExecutor, 'echo ~');
}

async function build(taskPaths, type, subtype, archivePath, commandExecutor, executor) {
    const homedir = await getHomeDir(commandExecutor);
    const remoteArchivePath = `${taskPaths.taskDirectoryWithHomeDir(homedir)}/____taskarchive`;
    const {
        hostname, port, username, password,
    } = executor.parameters;
    log.info(LOG_ID, 'from: ', archivePath, ' to: ', remoteArchivePath);
    await commandExecutor(`mkdir -p ${taskPaths.taskDirectory()}`);
    await ssh.uploadFile(archivePath, remoteArchivePath, hostname, port, username, password);

    const unarchiveCmd = `tar -xf ${remoteArchivePath} --directory=${taskPaths.taskDirectoryWithHomeDir(homedir)}`;
    await commandExecutor(unarchiveCmd);
    await commandExecutor(`rm -f ${remoteArchivePath}`);

    const initCmd = `sbatch --parsable ${scripts.getInitScriptInvocation(type, taskPaths, subtype)}`;
    const buildId = await getCommandOutput(commandExecutor, initCmd);
    if (buildId.match(/^[0-9]+$/g) === null) {
        throw new Error(`Build job slurm ID was invalid: ${buildId}`);
    }

    // cleanup after SUCCESSFUL build
    // if output is not cleared out, run script should detect that and report the run failure to IVIS-core
    const jobId = await getCommandOutput(commandExecutor, `sbatch --parsable --output=/dev/null --dependency=afterany:${buildId} ${scripts.getBuildCleanInvocation(taskPaths, buildId)}`);
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
    const jobId = await getIdMapping(runPaths, commandExecutor);
    await commandExecutor(`rm -f ${runPaths.inputsPath()} ${runPaths.idMappingPath()}`);
    if (jobId !== null) {
        await commandExecutor(`rm -f ${runPaths.slurmOutputsPath(jobId)}`);
    }
}

const slurmStateToIvisState = {
    CD: RemoteRunState.SUCCESS,
    CG: RemoteRunState.SUCCESS,
    CA: RemoteRunState.RUN_FAIL,
    F: RemoteRunState.RUN_FAIL,
    PD: RemoteRunState.QUEUED,
    PR: RemoteRunState.RUN_FAIL,
    R: RemoteRunState.RUNNING,
    S: RemoteRunState.RUN_FAIL,
    ST: RemoteRunState.RUN_FAIL,
    OOM: RemoteRunState.RUN_FAIL,
    TO: RemoteRunState.RUN_FAIL,
    NF: RemoteRunState.RUN_FAIL,
};

async function getRunSqueueStatus(slurmId, commandExecutor) {
    try {
        const squeueState = await getCommandOutput(commandExecutor, `squeue --job ${slurmId} -o "%t" | sed -n 2p`);
        const ivisState = slurmStateToIvisState[squeueState];
        return ivisState === undefined ? null : ivisState;
    } catch (err) {
        // TODO make sure request is repeated, log error
        return null;
    }
}

// returns RemoteRunState of a finieshed job, null if status cannot be determined
async function resolveFinishedState(runPaths, slurmId, commandExecutor) {
    const getStatusCodeCommand = `cat ${runPaths.slurmOutputsPath(slurmId)} | tail -n 1`;
    let lastOutputLine = null;
    try {
        lastOutputLine = await getCommandOutput(commandExecutor, getStatusCodeCommand);
    } catch (err) {
        // TODO make sure request is repeated, log error
        return null;
    }

    try {
        const statusCode = Number.parseInt(lastOutputLine, 10);
        return statusCode === 0 ? RemoteRunState.SUCCESS : RemoteRunState.RUN_FAIL;
    } catch {
        log.error(LOG_ID, 'Unexpected last line of run output. Expecting a number indicating the run exit code, got:', lastOutputLine);
    }

    return null;
}

/**
 *
 * @param {object} executor
 * @param {number} runId
 * @returns RemoteRunState of the run, null if the state cannot be determined (unknown/already finished run)
 */
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
        return resolveFinishedState(runPaths, slurmJobId, commandExecutor);
    }

    return state;
}

function getPoolInitCommands(executorId, certCA, certKey, cert, homedir) {
    const utilsRepoURL = config.slurm.utilsRepo.url;
    const utilsRepoCommit = config.slurm.utilsRepo.commit;
    const execPaths = new ExecutorPaths(executorId);
    // create required directories
    const commands = [execPaths.rootDirectory(), execPaths.tasksRootDirectory(), execPaths.certDirectory(), execPaths.cacheDirectory(),
        execPaths.outputsDirectory(), execPaths.inputsDirectory()]
        .map((path) => `mkdir -p ${path}`);
    // inject certificates
    [[execPaths.caPath(), certCA], [execPaths.certKeyPath(), certKey], [execPaths.certPath(), cert]].forEach(([path, contents]) => commands.push(scripts.createFileCommand(path, contents)));
    // clone auxiliary repository providing basics for running jobs
    commands.push(...[
        `git clone ${utilsRepoURL} ${execPaths.remoteUtilsRepoDirectory()}`,
        (utilsRepoCommit ? `cd ${execPaths.remoteUtilsRepoDirectory()} && git checkout ${utilsRepoCommit}` : 'echo using HEAD'),
    ]);

    // creates standalone scripts for bulding, running & informing IVIS core of run fail in the case of failed build
    for (const taskType of [TaskType.PYTHON]) {
        /** INIT script
         * - will be run via slurm => creates an output file
         * - builds the taskType tasks
         */
        commands.push(...scripts.getScriptCreationCommands(taskType, scripts.ScriptTypes.INIT, execPaths, homedir));
        /** RUN script
         * - will be run via slurm => creates an output file (cleanup as part of runRemove call)
         * - checks whether build failed and if so, calls BUILD FAIL INFORMANT and exits
         * - otherwise runs a job of this taskType
         * - output file can be examined to determine JOB success/fail (as part of the getStatus call)
         */
        commands.push(...scripts.getScriptCreationCommands(taskType, scripts.ScriptTypes.RUN, execPaths, homedir));
    }
    /** BUILD CLEAN script
     * - will be run via slurm after the INIT script (using slurm dependency configuration)
     * - creates no output
     * - examines build output and removes the build output if the build succeeded
     * - otherwise does nothing => RUN script checks whether the build output exists (if yes, build failed)
     */
    commands.push(...scripts.getBuildCleanScriptCreationCommands(execPaths));
    /** BUILD FAIL INFORMANT script
     * - will be run by the RUN script when task build failed
     * - informs IVIS-core of build/run failure, calls the emit and status endpoint with
     *   proper data so that IVIS-core may terminate and clear the run
     */
    commands.push(...scripts.getBuildFailInformantScriptCreationCommands(execPaths));

    commands.push(`chmod u+x ${execPaths.remoteUtilsRepoDirectory()}/install.sh`);
    // waits for the result
    commands.push(`srun ${execPaths.remoteUtilsRepoDirectory()}/install.sh ${execPaths.remoteUtilsRepoDirectory()}`);
    return commands;
}

async function createSlurmPool(executor, certificateGeneratorFunction) {
    await certificateGeneratorFunction(null);

    const ca = certs.getRemoteCACert();
    const {
        cert,
        key,
    } = certs.getExecutorCertKey(executor.id);
    const commander = commanderFromExecutor(executor);
    const commands = getPoolInitCommands(executor.id, ca, key, cert, await getHomeDir(commander));

    for (const command of commands) {
        await commander(command);
    }
}

module.exports = {
    status, run, stop, removeRun, createSlurmPool,
};
