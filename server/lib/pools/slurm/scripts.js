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
if [[ \\$3 != "nocheck" && -f \\$3 ]]; then
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
# create cache record
echo "\\$2" > \\$3
# remove build lock
rm -f "\\$3".build
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

/**
 *
 * @param {ExecutorPaths} execPaths
 * @returns
 */
function getRunBuildScript(execPaths) {
    return `#!/bin/bash
# the build & run script
# takes care of caching as well

# inputs:
# cacheRecordPath - path to the cache record to be checked
# cacheValidityGuard - the hash of the task type, subtype and archive
# arg1OfInitScript - seems like this is the task path
# thisBuildOutputPath - expected build output path, CHANGED!!! no need to refer to a job
# runJobName - name of the run job
# idMappingPath - path to which the runJobId is supposed to be put

cacheRecordPath=\\$1; shift
cacheValidityGuard=\\$1; shift
taskDirectory=\\\${1/#\\~/$HOME}; shift # expands the ~ to $HOME (mainly for the tar program)
outputsPath=\\$1; shift
runJobName=\\$1; shift
idMappingPath=\\$1; shift
pathToRunInput=\\$1; shift
failEvType=\\$1; shift
runId=\\$1; shift
buffTimeSecs=\\$1; shift
outEvType=\\$1; shift
succEvType=\\$1; shift
initScriptPath=\\$1; shift
startScriptPath=\\$1; shift
# these will remain last as the number of libraries may change

thisBuildOutputPath="nocheck"

scheduleBuild () {
    srun tar -xf "\\$taskDirectory"/____buildtaskarchive --directory="\\$taskDirectory"
    local buildId
    buildId=\\$(sbatch --parsable "\\$initScriptPath" "\\$taskDirectory" "\\$@")
    thisBuildOutputPath="\\$outputsPath"/IVIS-build-"\\$buildId".out
    # cleanup script also sets cached flag and removes the build lock
    local buildFinishId
    buildFinishId=\\$( sbatch --parsable --output=/dev/null --dependency=afterany:"\\$buildId" ${execPaths.buildOutputCleanScriptPath()} "\\$thisBuildOutputPath" "\\$cacheValidityGuard" "\\$cacheRecordPath")
    echo "\\$buildFinishId"
}

# cache check
cacheCheckResult=\\$( { [ -f "\\$cacheRecordPath" ] && [ "\\$(grep -e ^"\\$cacheValidityGuard"\\\\$ "\\$cacheRecordPath")" = "\\$cacheValidityGuard" ]; } || echo notCached)
buildLockPath="\\$cacheRecordPath".build

runDependency=""
# all below expects (just like IVIS-core) that there won't be any concurrent rebuild requests for a different task implementation (code1 and code2)
# and that a specific race condition won't happen (the cleanup script may remove the build lock when a job is inside the if and has not yet checked the build lock
# in which case the task would be incorrectly rebuilt )
if [[ "\\$cacheCheckResult" == "notCached" ]]; then
    # uncache
    rm -f "\\$cacheRecordPath"
    # atomically create a "build lock" so that only one build is happening
    # https://stackoverflow.com/questions/13828544/atomic-create-file-if-not-exists-from-bash-script#comment81812776_13829090
    if (set -o noclobber;true>\\$buildLockPath) &>/dev/null; then 
        # the above fails if another build has already started...
        # therefore if no builds have started, start building
        srun cp "\\$taskDirectory"/____taskarchive "\\$taskDirectory"/____buildtaskarchive
        scheduleBuild "\\$@" > "\\$buildLockPath"
    fi
    # in case the above if has not run, we wait a moment for the srun to schedule the jobs and
    # fill the buildLockPath file with the job id every run is supposed to wait for
    sleep 2
    runDependency=\\$(cat \\$buildLockPath || echo "")
fi

dependSwitch=""

if [[ \\$runDependency != "" ]]; then
    dependSwitch="--dependency=afterany:\\$runDependency"
fi

# submit run job
# when a run starts, it is ensured that the build is cached
sbatch --parsable \\$dependSwitch --job-name="\\$runJobName" "\\$startScriptPath" \\
"\\$taskDirectory" "\\$pathToRunInput" "\\$thisBuildOutputPath" \\
${execPaths.buildFailInformantScriptPath()} \\
"\\$failEvType" "\\$runId" \\
${config.tasks.maxRunOutputBytes} "\\$buffTimeSecs" ${config.www.trustedUrlBase}/rest/remote/emit "\\$outEvType" "\\$failEvType" "\\$succEvType" \\
${config.www.trustedUrlBase}/rest/remote/status ${RemoteRunState.RUN_FAIL} ${RemoteRunState.SUCCESS} ${execPaths.certPath()} ${execPaths.certKeyPath()} "\\$runId" > "\\$idMappingPath"
`;
}

function getRunBuildScriptCreationCommands(execPaths) {
    return createScriptHelper(execPaths.runBuildScriptPath(), getRunBuildScript(execPaths));
}

// $cacheRecordPath = $1; shift
// $cacheValidityGuard = $2; shift
// $taskDirectory = \\\${3/#\\~/$HOME}; shift # expands the ~ to $HOME (mainly for the tar program)
// $outputsPath = \\$4; shift
// $runJobName = \\$5; shift
// $idMappingPath = \\$6; shift
// $pathToRunInput = \\$7; shift
// $failEvType = \\$8; shift
// $runId = \\$9; shift
// $buffTimeSecs = \\\${10}; shift
// $outEvType = \\\${11}; shift
// $succEvType = \\\${12}; shift
// # these will remain last as the number of libraries may change
// $pythonLibsExpansion = \\$@

function getRunBuildArgs(taskType, runId, taskPaths, runPaths, cacheValidityGuard, subtype) {
    return [
        taskPaths.cacheRecordPath(),
        cacheValidityGuard,
        taskPaths.taskDirectory(),
        taskPaths.execPaths.outputsDirectory(),
        `${runId}`, // job name
        runPaths.idMappingPath(),
        runPaths.inputsPath(),
        getFailEventType(runId),
        runId,
        1,
        getOutputEventType(runId),
        getSuccessEventType(runId),
        scriptSetup[taskType][ScriptTypes.INIT].pathGetter(taskPaths.execPaths),
        scriptSetup[taskType][ScriptTypes.RUN].pathGetter(taskPaths.execPaths),
        ...ptyhonTaskSubtypeSpecs[subtype].libs,
    ];
}

function getRunBuildInvocation(taskType, runId, taskPaths, runPaths, cacheValidityGuard, subtype) {
    return `${taskPaths.execPaths.runBuildScriptPath()} ${getRunBuildArgs(taskType, runId, taskPaths, runPaths, cacheValidityGuard, subtype).join(' ')}`;
}

module.exports = {
    ScriptTypes,
    getScriptCreationCommands,
    getRunBuildScriptCreationCommands,
    getRunBuildInvocation,
    getBuildFailInformantScriptCreationCommands,
    getBuildCleanScriptCreationCommands,
    createFileCommand,
};
