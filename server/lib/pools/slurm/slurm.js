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
const { RemoteRunState, RequestType } = require('../../../../shared/remote-run');
const certs = require('../../remote-certificates');

const LOG_ID = 'slurm-pool';

async function sshConnectionFromExecutor(executor) {
    const {
        hostname, port, username, password,
    } = executor.parameters;
    return ssh.makeReadySSHConnection(hostname, port, username, password);
}

async function getCommandOutput(executor, command) {
    return (await executor.execute(command)).stdout.trim();
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

async function isCacheRecordValid(taskPaths, cacheValidityGuard, commandExecutor) {
    const cacheRecordPath = taskPaths.cacheRecordPath();
    const notCachedExpectedOutput = 'notcached';
    const output = await getCommandOutput(commandExecutor, `( [ -f ${cacheRecordPath} ] && [ $(grep -e ^${cacheValidityGuard}$ ${cacheRecordPath}) = "${cacheValidityGuard}" ] ) || echo ${notCachedExpectedOutput}`);
    // ^^^^^ checks file exists and contains exactly the guard - prints notCachedExpectedOutput if NOT cached ^^^^^
    return output !== notCachedExpectedOutput;
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
            urlBase: `${config.www.remoteElasticsearchBase}`,
        },
        server: {
            trustedUrlBase: `${config.www.trustedUrlBase}`,
            sandboxUrlBase: `${config.www.sandboxUrlBase}`,
            trustedEmitPath: '/rest/remote/emit',
            trustedRunRequestPath: '/rest/remote/runRequest',
        },
        state: runConfig.state,
        requestTypes: {
            createSignal: RequestType.CREATE_SIG,
            storeState: RequestType.STORE_STATE,
        },
    };
    const inputFileContents = `${JSON.stringify(realRunConfig)}\n`;

    await commandExecutor.execute(scripts.createFileCommand(runPaths.inputsPath(), inputFileContents));
}

async function getHomeDir(commandExecutor) {
    return getCommandOutput(commandExecutor, 'echo ~');
}

async function sshWrapper(executor, func) {
    const commandExecutor = await sshConnectionFromExecutor(executor);
    try {
        const result = await func(commandExecutor);
        commandExecutor.end();
        return result;
    } catch (err) {
        commandExecutor.end();
        throw err;
    }
}

async function run(executor, archivePath, runConfig, type, subtype) {
    const toUseSubtype = subtype || defaultSubtypeKey;
    const execPaths = new ExecutorPaths(executor.id);
    const taskPaths = new TaskPaths(execPaths, runConfig.taskId);
    const runPaths = new RunPaths(execPaths, runConfig.runId);

    const archiveHash = getArchiveHash(archivePath, type, toUseSubtype);
    await sshWrapper(executor, async (commandExecutor) => {
        if (!(await isCacheRecordValid(taskPaths, archiveHash, commandExecutor))) {
            const homedir = await getHomeDir(commandExecutor);
            await commandExecutor.execute(`mkdir -p ${taskPaths.taskDirectory()}`);
            const remoteArchivePath = `${taskPaths.taskDirectoryWithHomeDir(homedir)}/____taskarchive`;
            const {
                hostname, port, username, password,
            } = executor.parameters;
            await ssh.uploadFile(archivePath, remoteArchivePath, hostname, port, username, password);
        }

        await createRunInput(taskPaths, runPaths, runConfig, commandExecutor);
        const command = `sbatch ${scripts.getRunBuildInvocation(type, runPaths.runId, taskPaths, runPaths, archiveHash, toUseSubtype)}`;
        await commandExecutor.execute(command);
    });
}

async function stop(executor, runId) {
    const runPaths = new RunPaths(new ExecutorPaths(executor.id), runId);
    await sshWrapper(executor, async (commandExecutor) => {
        try {
            await commandExecutor.execute(`srun ${scripts.getRunStopInvocation(runPaths)}`);
        } catch (err) {
            // pass - job is not running
            return;
        }
    });
}

async function removeRun(executor, runId) {
    const runPaths = new RunPaths(new ExecutorPaths(executor.id), runId);
    const command = scripts.getRunRemoveInvocation(runPaths);
    await sshWrapper(executor, async (commandExecutor) => {
        await commandExecutor.execute(`srun ${command}`);
    });
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
    return sshWrapper(executor, async (commandExecutor) => {
        const runPaths = new RunPaths(new ExecutorPaths(executor.id), runId);

        // SLURM SSH - share connection accross this function
        // !!! all of the usage is reading command output !!! TODO
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
    });
}

function getPoolInitCommands(executorId, certCA, certKey, cert, homedir) {
    const utilsRepoURL = config.slurm.utilsRepo.url;
    const utilsRepoCommit = config.slurm.utilsRepo.commit;
    const execPaths = new ExecutorPaths(executorId);
    // create required directories
    // SLURMSSH - try to put into one &&-delimited command an send it via srun
    // would require the usage of homedir
    const commands = [[execPaths.rootDirectory(), execPaths.tasksRootDirectory(), execPaths.certDirectory(), execPaths.cacheDirectory(),
    execPaths.outputsDirectory(), execPaths.inputsDirectory()]
        .map((path) => `mkdir -p ${path}`).join(' && ')];
    // inject certificates
    [[execPaths.caPath(), certCA], [execPaths.certKeyPath(), certKey], [execPaths.certPath(), cert]].forEach(([path, contents]) => commands.push(scripts.createFileCommand(path, contents)));
    // clone auxiliary repository providing basics for running jobs
    commands.push(...[
        `git clone ${utilsRepoURL} ${execPaths.remoteUtilsRepoDirectory()}`,
        (utilsRepoCommit ? `cd ${execPaths.remoteUtilsRepoDirectory()} && git checkout ${utilsRepoCommit}` : 'echo using HEAD'),
    ]);

    // creates standalone scripts for bulding, running & informing IVIS core of run fail in the case of failed build
    [TaskType.PYTHON].forEach((taskType) => {
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
    });
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
    commands.push(...scripts.getRunBuildScriptCreationCommands(execPaths, homedir));
    commands.push(...scripts.getRunRemoveScriptCreationCommands(execPaths));
    commands.push(...scripts.getRunStopScriptCreationCommands(execPaths));
    commands.push(`chmod u+x ${execPaths.remoteUtilsRepoDirectory()}/install.sh`);
    // waits for the result
    // SLURMSSH - nice... use this for other commands - again && delimited groups
    // directories, git repo, all scripts
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
    await sshWrapper(executor, async (commandExecutor) => {
        const commands = getPoolInitCommands(executor.id, ca, key, cert, await getHomeDir(commandExecutor));
        for (const command of commands) {
            await commandExecutor.execute(command);
        }
    });
}

/**
 * Removes the executor from the SLURM cluster. This action is a forceful act which
 * does not care about any running jobs. The executor is purged without any checks
 * so make sure you've done them all 
 * @param {object} executor 
 */
async function removePool(executor) {
    const execPaths = new ExecutorPaths(executor.id);
    await sshWrapper(executor, async (commandExecutor) => {
        await commandExecutor.execute(`srun rm -rf ${execPaths.rootDirectory()}`);
    });
}

module.exports = {
    status, run, stop, removeRun, createSlurmPool, removePool
};
