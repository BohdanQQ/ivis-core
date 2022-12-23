class ExecutorPaths {
    constructor(executorId) {
        this.executorId = executorId;
    }

    _inRoot(path) {
        return `${this.rootDirectory()}${path}`;
    }

    // this thing exists only because the SFTP file transfer
    // DOES NOT expand ~ and neither does tar's --output option
    /**
     * @param {string} homedir the output of echo ~
     */
    rootDirectoryWithHomeDir(homedir) {
        return `${homedir}/IVIS_SLURM_EXECUTOR_${this.executorId}`;
    }

    rootDirectory() {
        return `~/IVIS_SLURM_EXECUTOR_${this.executorId}`;
    }

    cacheDirectory() {
        return this._inRoot('/cache');
    }

    certDirectory() {
        return this._inRoot('/cert');
    }

    caPath() {
        return `${this.certDirectory()}/ca.cert`;
    }

    certPath() {
        return `${this.certDirectory()}/runner.cert`;
    }

    certKeyPath() {
        return `${this.certDirectory()}/key.pem`;
    }

    outputsDirectory() {
        return this._inRoot('/outputs');
    }

    _outputsDirectoryWithHomeDir(homedir) {
        return `${this.rootDirectoryWithHomeDir(homedir)}/outputs`;
    }

    outputSbatchFormatPath(homedir) {
        return `${this._outputsDirectoryWithHomeDir(homedir)}/IVIS-run-%j-%x.out`;
    }

    buildOutputSbatchFormatPath(homedir) {
        return `${this._outputsDirectoryWithHomeDir(homedir)}/IVIS-build-%j.out`;
    }

    buildOutputPath(slurmJobId) {
        return `${this.outputsDirectory()}/IVIS-build-${slurmJobId}.out`;
    }

    inputsDirectory() {
        return this._inRoot('/inputs');
    }

    tasksRootDirectory() {
        return this._inRoot('/tasks');
    }

    tasksRootDirectoryWithHomeDir(homedir) {
        return `${this.rootDirectoryWithHomeDir(homedir)}/tasks`;
    }

    remoteUtilsRepoDirectory() {
        return this._inRoot('/utils');
    }

    ivisPythonPackageDirectory() {
        return `${this.remoteUtilsRepoDirectory()}/python-package`;
    }

    buildOutputCleanScriptPath() {
        return `${this.remoteUtilsRepoDirectory()}/__build_clean.sh`;
    }

    buildFailInformantScriptPath() {
        return `${this.remoteUtilsRepoDirectory()}/__build_fail_informant.sh`;
    }

    runBuildScriptPath() {
        return `${this.remoteUtilsRepoDirectory()}/__run_build.sh`;
    }
}

class TaskPaths {
    /**
     *
     * @param {ExecutorPaths} executorPaths
     * @param {*} taskId
     */
    constructor(executorPaths, taskId) {
        this.execPaths = executorPaths;
        this.taskId = taskId;
    }

    taskDirectory() {
        return `${this.execPaths.tasksRootDirectory()}/${this.taskId}`;
    }

    taskDirectoryWithHomeDir(homedir) {
        return `${this.execPaths.tasksRootDirectoryWithHomeDir(homedir)}/${this.taskId}`;
    }

    _cacheRecordName() {
        return `${this.taskId}.cache`;
    }

    cacheRecordPath() {
        return `${this.execPaths.cacheDirectory()}/${this._cacheRecordName()}`;
    }
}

class RunPaths {
    /**
     * @param {ExecutorPaths} executorPaths
     * @param {*} runId
     */
    constructor(executorPaths, runId) {
        this.execPaths = executorPaths;
        this.runId = runId;
    }

    slurmOutputsPath(slurmJobId) {
        return `${this.execPaths.outputsDirectory()}/IVIS-run-${slurmJobId}-${this.runId}.out`;
    }

    inputsPath() {
        return `${this.execPaths.inputsDirectory()}/${this.runId}`;
    }

    idMappingPath() {
        return `${this.execPaths.inputsDirectory()}/${this.runId}.id`;
    }
}

module.exports = {
    ExecutorPaths, TaskPaths, RunPaths,
};
