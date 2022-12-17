class ExecutorPaths {
    constructor(executorId) {
        this.executorId = executorId
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

    outputSbatchFormatPath() {
        return this._inRoot('/IVIS-run-%j-%x.out');
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

    ivisPackageDirectory() {
        return `${this.remoteUtilsRepoDirectory()}/ivis`;
    }
};

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
        return `${this.execPaths.tasksRootDirectory()}/${this.taskId}`
    }

    taskDirectoryWithHomeDir(homedir) {
        return `${this.execPaths.tasksRootDirectoryWithHomeDir(homedir)}/${this.taskId}`
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
    ExecutorPaths, TaskPaths, RunPaths
}