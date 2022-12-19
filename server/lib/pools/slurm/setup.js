const { PYTHON_JOB_FILE_NAME, TaskType } = require('../../../../shared/tasks');
const config = require('../../config');
const { getSuccessEventType, getOutputEventType, getFailEventType } = require('../../task-events');
const { RemoteRunState } = require('../../../../shared/remote-run');
const { PythonSubtypes, defaultSubtypeKey } = require('../../../../shared/tasks');

// INIT script is expected to perform build output check and start the job execution if build succeeded
const taskTypeRunScript = {
// taskdir runInputPath buildOutputPath buildFailInformantPath runFailEmitTypeValue runId jobArgs
    [TaskType.PYTHON]: (sbatchOutputPath, runnerScriptPath) => `#!/bin/bash
#SBATCH --output ${sbatchOutputPath}
if [[ -f \\$3 ]]; then
    # build failed because the build output is not cleaned up => call build fail informant
    \\$4 \\$5 \\$6
    exit
fi
cd "\\$1"
. ./.venv/bin/activate
cat "\\$2" | python3 ${runnerScriptPath} ./${PYTHON_JOB_FILE_NAME} "\\\${@:7}"
echo "\\$?"
`,
};

function getPythonRunScript(sbatchOutputPath, runnerScriptPath) {
    return taskTypeRunScript[TaskType.PYTHON](sbatchOutputPath, runnerScriptPath);
}

// INIT script is expected to write "build complete" on the last line of its (successful) output
const taskTypeInitScript = {
    [TaskType.PYTHON]: (sbatchOutputPath, ivisPackageDirectory) => `#!/bin/bash
#SBATCH --output ${sbatchOutputPath}
mkdir -p "\\$1"
cd "\\$1"
python3 -m venv ./.venv
. ./.venv/bin/activate
pip install "\\\${@:2}"
pip install --no-index --find-links=${ivisPackageDirectory}/dist ivis
deactivate
echo "build complete"
`,
};

function getPythonTaskInitScript(sbatchOutputPath, ivisPackageDirectory) {
    return taskTypeInitScript[TaskType.PYTHON](sbatchOutputPath, ivisPackageDirectory);
}

function getBuildOutputCleanScript() {
    return `#!/bin/bash
grep -q "build complete$" "\\$1" && rm -f "\\$1"
`;
}

function buildFailInformantScript(keyPath, certPath, caCertPath, emitUrl, statusUrl, failStatus) {
    return `#!/bin/bash
#SBATCH --output /dev/null
curl --cert ${certPath} --key ${keyPath} ${config.oci.ivisSSLCertVerifiableViaRootCAs ? '' : `--cacert ${caCertPath} `}\\
--header "Content-Type: application/json" \\
--request POST --data '{"type":"'"\\$1"'","data":"remote build failed"}' ${emitUrl}
curl --cert ${certPath} --key ${keyPath} ${config.oci.ivisSSLCertVerifiableViaRootCAs ? '' : `--cacert ${caCertPath} `}\\
--header "Content-Type: application/json" \\
--request POST --data '{"runId":'"\\$2"', "status": { "status": ${failStatus}, "finished_at":'\\$(python3 -c "print(int(\\$(date +%s%N) / 1000000))")' },"output":"", "errors":"remote build failed"}' ${statusUrl}
`;
}

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

const ScriptTypes = {
    RUN: 'run',
    INIT: 'init',
};
Object.freeze(ScriptTypes);

const scriptSetup = {
    [TaskType.PYTHON]: {
        [ScriptTypes.RUN]: {
            pathGetter: (executorPaths) => `${executorPaths.remoteUtilsRepoDirectory()}/__python_start.sh`,
            contentCreator: (executorPaths, homeDirectory) => getPythonRunScript(executorPaths.outputSbatchFormatPath(homeDirectory), `${executorPaths.remoteUtilsRepoDirectory()}/runner.py`),
        },
        [ScriptTypes.INIT]: {
            pathGetter: (executorPaths) => `${executorPaths.remoteUtilsRepoDirectory()}/__python_init.sh`,
            contentCreator: (executorPaths, homeDirectory) => getPythonTaskInitScript(executorPaths.buildOutputSbatchFormatPath(homeDirectory), executorPaths.ivisPythonPackageDirectory()),
        },
    },
};
Object.freeze(scriptSetup);

function createFileCommand(path, contents) {
    return `cat > ${path} << HEREDOC_EOF\n${contents}\nHEREDOC_EOF`;
}

function createScriptHelper(scriptPath, contents) {
    return [
        createFileCommand(scriptPath, contents),
        `chmod u+x ${scriptPath}`,
    ];
}

function getScriptCreationCommands(taskType, scriptType, executorPaths, homeDirectory) {
    const scriptInfo = scriptSetup[taskType][scriptType];
    const scriptPath = scriptInfo.pathGetter(executorPaths);
    return createScriptHelper(scriptPath, scriptInfo.contentCreator(executorPaths, homeDirectory));
}

function getBuildCleanScriptCreationCommands(execPaths) {
    return createScriptHelper(execPaths.buildOutputCleanScriptPath(), getBuildOutputCleanScript());
}

function getBuildFailInformantScriptCreationCommands(execPaths) {
    return createScriptHelper(execPaths.buildFailInformantScriptPath(), buildFailInformantScript(
        execPaths.certKeyPath(),
        execPaths.certPath(),
        execPaths.caPath(),
        `${config.www.trustedUrlBase}/rest/remote/emit`,
        `${config.www.trustedUrlBase}/rest/remote/status`,
        RemoteRunState.RUN_FAIL,
    ));
}

function getBuildCleanInvocation(taskPaths, buildSlurmId) {
    return `${taskPaths.execPaths.buildOutputCleanScriptPath()} ${taskPaths.execPaths.buildOutputPath(buildSlurmId)}`;
}

function getPythonRunScriptArgs(taskPaths, runId, runPaths, buildSlurmId) {
    return [
        taskPaths.taskDirectory(),
        runPaths.inputsPath(),
        taskPaths.execPaths.buildOutputPath(buildSlurmId),
        taskPaths.execPaths.buildFailInformantScriptPath(),
        // build fail informant args ...
        getFailEventType(runId),
        runId,
        // python runner args...
        config.tasks.maxRunOutputBytes,
        1, // buffering time in seconds
        `${config.www.trustedUrlBase}/rest/remote/emit`,
        getOutputEventType(runId),
        getFailEventType(runId),
        getSuccessEventType(runId),
        `${config.www.trustedUrlBase}/rest/remote/status`,
        RemoteRunState.RUN_FAIL,
        RemoteRunState.SUCCESS,
        taskPaths.execPaths.certPath(),
        taskPaths.execPaths.certKeyPath(),
        runId,
    ];
}

function getPythonInitScriptArgs(taskPaths, subtype) {
    return [
        taskPaths.taskDirectory(),
        ...ptyhonTaskSubtypeSpecs[subtype].libs,
    ];
}

const scriptArgGetters = {
    [TaskType.PYTHON]: {
        [ScriptTypes.RUN]: getPythonRunScriptArgs,
        [ScriptTypes.INIT]: getPythonInitScriptArgs,
    },
};
Object.freeze(scriptArgGetters);

function getRunScriptInvocation(taskType, taskPaths, runId, runPaths, buildSlurmId) {
    const type = ScriptTypes.RUN;
    const path = scriptSetup[taskType][type].pathGetter(taskPaths.execPaths);
    const args = scriptArgGetters[taskType][type](taskPaths, runId, runPaths, buildSlurmId);
    return `${path} ${args.join(' ')}`;
}

function getInitScriptInvocation(taskType, taskPaths, subtype) {
    const type = ScriptTypes.INIT;
    const path = scriptSetup[taskType][type].pathGetter(taskPaths.execPaths);
    const args = scriptArgGetters[taskType][type](taskPaths, subtype);
    return `${path} ${args.join(' ')}`;
}

module.exports = {
    ScriptTypes,
    getScriptCreationCommands,
    getRunScriptInvocation,
    getInitScriptInvocation,
    getBuildCleanInvocation,
    getBuildFailInformantScriptCreationCommands,
    getBuildCleanScriptCreationCommands,
    createFileCommand,
};
