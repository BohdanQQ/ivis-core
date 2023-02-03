const { PYTHON_JOB_FILE_NAME, TaskType } = require('../../../../shared/tasks');
const config = require('../../config');
const { getSuccessEventType, getOutputEventType, getFailEventType } = require('../../task-events');
const { RemoteRunState } = require('../../../../shared/remote-run');
const { PythonSubtypes, defaultSubtypeKey } = require('../../../../shared/tasks');
const { ExecutorPaths, RunPaths, TaskPaths } = require('./paths');

const JOB_ID_ENVVAR = 'SLURM_JOB_ID';
// INIT script is expected to perform build output check and start the job execution if build succeeded
const taskTypeRunScript = {
    // taskdir runInputPath buildOutputPath runFailEmitTypeValue runId runBuildOutputPath jobArgs
    [TaskType.PYTHON]: (sbatchOutputPath, runnerScriptPath, execPaths) => `#!/bin/bash
#SBATCH --output ${sbatchOutputPath}
function commonCancel {
    python3 -c "print(int(\\$( date +%s%N ) / 1000000))" > ${execPaths.runFinishedAtShellExpansion(JOB_ID_ENVVAR)}
}

function cancelRun {
    commonCancel
    exit 0
}

function cancelBySlurm {
    commonCancel
    # runfail informant because slurm cancelation is "unknown" to the IVIS server
    ${execPaths.runFailInformantScriptPath()} "\\$1" "\\$2" "cancelled by slurm (probably preemptied)"
    exit 0
}

trap cancelRun SIGINT

taskDir=\\$1; shift
runInputPath=\\$1; shift
buildOutputPath=\\$1; shift
runFailEmitTypeValue=\\$1; shift
runId=\\$1; shift
trap "cancelBySlurm \\$runFailEmitTypeValue \\$runId" SIGTERM

runBuildOutputPath=\\$1; shift

if [[ \\$buildOutputPath != "nocheck" && -f \\$buildOutputPath ]]; then
    # build failed because the build output is not cleaned up => call run fail informant
    ${execPaths.runFailInformantScriptPath()} "\\$runFailEmitTypeValue" "\\$runId" "remote build failed"
    # the build may have been awaited by other jobs => not cleaned up
    # this should be the only storage leak and should not be significant  
    exit
fi
# remove runbuild script output - comment this for debugging
rm -f "\\$runBuildOutputPath"
cd "\\$taskDir"
. ./.venv/bin/activate
( cat "\\$runInputPath" | python3 ${runnerScriptPath} ./${PYTHON_JOB_FILE_NAME} "\\\${@:1}" > ${execPaths.runStdOutShellExpansion(JOB_ID_ENVVAR)} 2> ${execPaths.runStdErrShellExpansion(JOB_ID_ENVVAR)} ) &
# without the following two lines, slurm does not immediately cancel this job and the job hangs in the "CG" (completing) status
child=$!
wait "$child"
python3 -c "print(int(\\$( date +%s%N ) / 1000000))" > ${execPaths.runFinishedAtShellExpansion(JOB_ID_ENVVAR)}
`,
};

function getPythonRunScript(sbatchOutputPath, runnerScriptPath, execPaths) {
    return taskTypeRunScript[TaskType.PYTHON](sbatchOutputPath, runnerScriptPath, execPaths);
}

// INIT script is expected to write "build complete" on the last line of its (successful) output
const taskTypeInitScript = {
    /**
     * @param {string} sbatchOutputPath
     * @param {string} ivisPackageDirectory
     * @param {ExecutorPaths} execPaths
     * @returns {string}
     */
    [TaskType.PYTHON]: (sbatchOutputPath, ivisPackageDirectory, execPaths) => `#!/bin/bash
#SBATCH --output ${sbatchOutputPath}
function commonCancel {
    # removes build lock - makes rebuild possible
    # runs waiting for this build will fail with "build failed"
    rm -f "\\$1"
    # makes sure the build output exists and contains indicaion of failure
    echo "bad build"
}

function cancelRun {
    commonCancel "\\$1"
    exit 0
}

function cancelBySlurm {
    commonCancel "\\$3"
    # runfail informant because slurm cancelation is "unknown" to the IVIS server
    ${execPaths.runFailInformantScriptPath()} "\\$1" "\\$2" "build cancelled by slurm (probably preemptied)"
    exit 0
}

taskPath=\\$1; shift
failEvType=\\$1; shift
runId=\\$1; shift
buildLockPath=\\$1; shift


trap "cancelRun \\$buildLockPath" SIGINT
trap "cancelBySlurm \\$failEvType \\$runId \\$buildLockPath" SIGTERM

mkdir -p "\\$taskPath"
cd "\\$taskPath"
python3 -m venv ./.venv
. ./.venv/bin/activate
pip install "\\\${@:1}"
pip install --no-index --find-links=${ivisPackageDirectory}/dist ivis
deactivate
echo "build complete"
rm -f "\\$buildLockPath"
`,
};

/**
 * @param {string} sbatchOutputPath sbatch-format output path
 * @param {string} ivisPackageDirectory path to the task helper package
 * @param {ExecutorPaths} execPaths
 * @returns {string}
 */
function getPythonTaskInitScript(sbatchOutputPath, ivisPackageDirectory, execPaths) {
    return taskTypeInitScript[TaskType.PYTHON](sbatchOutputPath, ivisPackageDirectory, execPaths);
}

/**
 * @returns {string}
 */
function getBuildOutputCleanScript() {
    return `#!/bin/bash
function preventCancel {
    # see below...
    if [[ \\$1 = 1 ]]; then
        echo "\\$3" > "\\$4"
        rm -f "\\$2"
    fi
}

trap "preventCancel 0 \\$1 \\$2 \\$3" SIGINT SIGTERM
grep -q "build complete$" "\\$1"
if [[ \\$? = 0 ]]; then
    trap "preventCancel 1 \\$1 \\$2 \\$3" SIGINT SIGTERM
    # create cache record
    echo "\\$2" > "\\$3"
    # remove build output - indicates build success for the pre-run checker
    # can also be useful for diagnosing build failures
    rm -f "\\$1"
fi
`;
}

/**
 *
 * @param {string} keyPath
 * @param {string} certPath
 * @param {string} caCertPath
 * @param {string} emitUrl complete url to the remote emit endpoint
 * @param {string} statusUrl complete url to the remote status endpoint
 * @param {string} failStatus fail state status id recognised by the remote status endpoint
 * @returns {string}
 */
function runFailInformantScript(keyPath, certPath, caCertPath, emitUrl, statusUrl, failStatus) {
    return `#!/bin/bash
#SBATCH --output /dev/null
curl --cert ${certPath} --key ${keyPath} ${config.oci.ivisSSLCertVerifiableViaRootCAs ? '' : `--cacert ${caCertPath} `}\\
--header "Content-Type: application/json" \\
--request POST --data '{"type":"'"\\$1"'","data":"'"\\$3"'"}' ${emitUrl}
curl --cert ${certPath} --key ${keyPath} ${config.oci.ivisSSLCertVerifiableViaRootCAs ? '' : `--cacert ${caCertPath} `}\\
--header "Content-Type: application/json" \\
--request POST --data '{"runId":'"\\$2"', "status": { "status": ${failStatus}, "finished_at":'\\$(python3 -c "print(int(\\$(date +%s%N) / 1000000))")' },"output":"'"\\$3"'"}' ${statusUrl}
`;
}

// TODO export from 1 place (python-handler also uses these)
// apparent conflict with the intention (specified in python-handler) to pull those things from the config??
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
            contentCreator: (executorPaths, homeDirectory) => getPythonRunScript(executorPaths.outputSbatchFormatPath(homeDirectory), `${executorPaths.remoteUtilsRepoDirectory()}/runner.py`, executorPaths),
        },
        [ScriptTypes.INIT]: {
            pathGetter: (executorPaths) => `${executorPaths.remoteUtilsRepoDirectory()}/__python_init.sh`,
            contentCreator: (executorPaths, homeDirectory) => getPythonTaskInitScript(executorPaths.buildOutputSbatchFormatPath(homeDirectory), executorPaths.ivisPythonPackageDirectory(), executorPaths),
        },
    },
};
Object.freeze(scriptSetup);
/**
 * returns a command which creates the specified file
 * @param {string} path
 * @param {string} contents
 */
function createFileCommand(path, contents) {
    return `cat > ${path} << HEREDOC_EOF\n${contents}\nHEREDOC_EOF`;
}

/**
 * @param {string} scriptPath
 * @param {string} contents
 * @returns {[string]} commands which create an executable script
 */
function createScriptHelper(scriptPath, contents) {
    return [
        createFileCommand(scriptPath, contents),
        `chmod u+x ${scriptPath}`,
    ];
}

/**
 * @param {string} taskType
 * @param {string} scriptType
 * @param {ExecutorPaths} executorPaths
 * @param {string} homeDirectory absolute (and expanded) path to home directory
 * @returns {[string]} commands to create a script for the specified task and script types
 */
function getScriptCreationCommands(taskType, scriptType, executorPaths, homeDirectory) {
    const scriptInfo = scriptSetup[taskType][scriptType];
    const scriptPath = scriptInfo.pathGetter(executorPaths);
    return createScriptHelper(scriptPath, scriptInfo.contentCreator(executorPaths, homeDirectory));
}

/**
 * @param {ExecutorPaths} execPaths
 * @returns {[string]}
 */
function getBuildCleanScriptCreationCommands(execPaths) {
    return createScriptHelper(execPaths.buildOutputCleanScriptPath(), getBuildOutputCleanScript());
}

/**
 * @param {ExecutorPaths} execPaths
 * @returns {[string]}
 */
function getRunFailInformantScriptCreationCommands(execPaths) {
    return createScriptHelper(execPaths.runFailInformantScriptPath(), runFailInformantScript(
        execPaths.certKeyPath(),
        execPaths.certPath(),
        execPaths.caPath(),
        `${config.www.trustedUrlBase}/rest/remote/emit`,
        `${config.www.trustedUrlBase}/rest/remote/status`,
        RemoteRunState.RUN_FAIL,
    ));
}

/**
 * @param {string} paritionValue
 * @returns {string}
 */
function getPartitionSwitchCommandPart(paritionValue) {
    if (!paritionValue) {
        return '';
    }
    return ` -p ${paritionValue}`;
}

/**
 *
 * @param {ExecutorPaths} execPaths
 * @param {string} homedir absolute (and expanded) path to the directory
 * @param {string?} partition
 * @returns {string}
 */
function getRunBuildScript(execPaths, homedir, partition) {
    const partitionSwitch = getPartitionSwitchCommandPart(partition);
    return `#!/bin/bash
#SBATCH --output ${execPaths.outputsDirectoryWithHomeDir(homedir)}/runbuild-%j
# the build & run script
# takes care of caching as well

# inputs:
# cacheRecordPath - path to the cache record to be checked
# cacheValidityGuard - the hash of the task type, subtype and archive
# taskDirectory - seems like this is the task path
# thisBuildOutputPath - expected build output path, CHANGED!!! no need to refer to a job
# runJobName - name of the run job
# idMappingPath - path to which the runJobId is supposed to be put

cacheRecordPath=\\$1; shift
cacheValidityGuard=\\$1; shift
taskDirectory=\\\${1/#\\~/$HOME}; shift # expands the ~ to $HOME (mainly for the tar program)
outputsPath=\\$1; shift
runJobName=\\$1; shift

idMappingPath=\\$1; shift
stopLockPath="\\$idMappingPath".stopLock

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

buildLockPath="\\$cacheRecordPath".build

function commonCancel {
    # if this run started a build... (thus created build lock)
    if [[ \\$1 = 1 ]]; then
        # remove build lock 
        # ( makes other (re)builds possible )
        rm -f "\\$2"
    fi
}

function finish {
    commonCancel \\$1 \\$2
    # at this point the build either finished entirely (with build cleanup)
    # and thus the build is "cached"
    # or the build has not finished but can (and will) be repeated by any subsequent job run request

    # all dependant tasks will fail due to failed build (notice commonCancel does not remove the thisBuildOutputPath)
    exit 0
}

function cancelBySlurm {
    commonCancel \\$3 \\$4
    ${execPaths.runFailInformantScriptPath()} "\\$1" "\\$2" "cancelled by slurm (probably preemptied)"
    exit 0
}

trap "finish 0 \\$buildLockPath" SIGINT
trap "cancelBySlurm \\$failEvType \\$runId 0 \\$buildLockPath"  SIGTERM

scheduleBuild () {
    srun${partitionSwitch} tar -xf "\\$taskDirectory"/____buildtaskarchive --directory="\\$taskDirectory"
    local buildId
    buildId=\\$(sbatch${partitionSwitch} --parsable "\\$initScriptPath" "\\$taskDirectory" "\\$failEvType" "\\$runId" "\\$buildLockPath" "\\$@")
    thisBuildOutputPath="\\$outputsPath"/IVIS-build-"\\$buildId".out
    # cleanup script also sets cached flag and removes the build lock
    local buildFinishId
    buildFinishId=\\$( sbatch${partitionSwitch} --parsable --output=/dev/null --dependency=afterany:"\\$buildId" ${execPaths.buildOutputCleanScriptPath()} "\\$thisBuildOutputPath" "\\$cacheValidityGuard" "\\$cacheRecordPath" )
    echo "\\$buildFinishId"^"\\$thisBuildOutputPath"
}

# cache check
cacheCheckResult=\\$( { [ -f "\\$cacheRecordPath" ] && [ "\\$(grep -e ^"\\$cacheValidityGuard"\\\\$ "\\$cacheRecordPath")" = "\\$cacheValidityGuard" ]; } || echo notCached)

# set stoplock here to ensure that a build finishes (ONLY FOR USER-INVOKED STOP)
# scenario: Job A builds task T, job B (of task T) waits for this build... Now stop job A
#   if the stopping of job A stops the build, job B will never run
#   can be improved by somehow cancelling all dependent jobs in a cascading fashion...
#   right now, the job B would detect the task is not built and will fail with "remote build failed"
# for now the stoplock prevents the build from being cancelled by run stop (reasonable to assume a build will finish)
touch "\\$stopLockPath"
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
        # reset traps with updated "thisRunCreatedBuildLock" value (1)
        # if the job is cancelled around here, the build lock remains in place... no idea how to fix that...
        trap "finish 1 \\$buildLockPath" SIGINT
        trap "cancelBySlurm \\$failEvType \\$runId 1 \\$buildLockPath"  SIGTERM
        # the above fails if another build has already started...
        # therefore if no builds have started, start building
        srun${partitionSwitch} cp "\\$taskDirectory"/____taskarchive "\\$taskDirectory"/____buildtaskarchive
        scheduleBuild "\\$@" > "\\$buildLockPath"
    fi
    # in case the above if has not run, we wait a moment for the srun to schedule the jobs and
    # fill the buildLockPath file with the job id every run is supposed to wait for
    sleep 2
    runDependency=\\$(cat "\\$buildLockPath" || echo "")
fi

dependSwitch=""

if [[ \\$runDependency != "" ]]; then
    # runDependency = [dependency Job ID]^[path to build output to be checked]
    dependSwitch="--dependency=afterany:\\$( echo "\\$runDependency" | cut -f 1 -d "^" )"
    thisBuildOutputPath=\\$( echo "\\$runDependency" | cut -f 2 -d "^" )
fi

# submit run job
# when a run starts, it is ensured that the build is cached
sbatch${partitionSwitch} --parsable \\$dependSwitch --job-name="\\$runJobName" "\\$startScriptPath" \\
"\\$taskDirectory" "\\$pathToRunInput" "\\$thisBuildOutputPath" \\
"\\$failEvType" "\\$runId" "${execPaths.outputsDirectoryWithHomeDir(homedir)}/runbuild-\\$${JOB_ID_ENVVAR}" \\
${config.tasks.maxRunOutputBytes} "\\$buffTimeSecs" ${config.www.trustedUrlBase}/rest/remote/emit "\\$outEvType" "\\$failEvType" "\\$succEvType" \\
${config.www.trustedUrlBase}/rest/remote/status ${RemoteRunState.RUN_FAIL} ${RemoteRunState.SUCCESS} ${execPaths.certPath()} ${execPaths.certKeyPath()} "\\$runId" \\
${RemoteRunState.RUNNING} > "\\$idMappingPath"
rm -f "\\$stopLockPath" # now the run's Job exists -> can be stopped
`;
}

/**
 * @param {ExecutorPaths} execPaths
 * @param {string} homedir absolute (and expanded) path to the directory
 * @param {string?} partition
 * @returns {[string]}
 */
function getRunBuildScriptCreationCommands(execPaths, homedir, partition) {
    return createScriptHelper(execPaths.runBuildScriptPath(), getRunBuildScript(execPaths, homedir, partition));
}

/**
 * @param {string} taskType
 * @param {number} runId
 * @param {TaskPaths} taskPaths
 * @param {RunPaths} runPaths
 * @param {string} cacheValidityGuard
 * @param {string} subtype
 * @returns {[any]} arguments to the runBuild script
 */
function getRunBuildArgs(taskType, runId, taskPaths, runPaths, cacheValidityGuard, subtype) {
    return [
        taskPaths.cacheRecordPath(),
        cacheValidityGuard,
        taskPaths.taskDirectory(),
        taskPaths.execPaths.outputsDirectory(),
        runId, // job name - cooperates with RunPaths.slurmOutputsPath !!
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

/**
 * @param {string} taskType
 * @param {number} runId
 * @param {TaskPaths} taskPaths
 * @param {RunPaths} runPaths
 * @param {string} cacheValidityGuard
 * @param {string} subtype
 * @returns {string} complete command to invoke the buildRun script
 */
function getRunBuildInvocation(taskType, runId, taskPaths, runPaths, cacheValidityGuard, subtype) {
    return `${taskPaths.execPaths.runBuildScriptPath()} ${getRunBuildArgs(taskType, runId, taskPaths, runPaths, cacheValidityGuard, subtype).join(' ')}`;
}

/**
 * @param {ExecutorPaths} execPaths
 * @param {string?} partition
 * @returns {string}
 */
function getRunRemoveScript(execPaths, partition) {
    const partitionSwitch = getPartitionSwitchCommandPart(partition);
    const slurmIdVariable = 'jobId';
    return `#!/bin/bash
#SBATCH --output /dev/null
runInputPath=\\$1; shift
runIdMappingPath=\\$1; shift
runId=\\$1; shift

${slurmIdVariable}=\\$( cat "\\$runIdMappingPath" || echo "null")
rm -f "\\$runInputPath" "\\$runIdMappingPath"
if [[ "\\$${slurmIdVariable}" != "null" ]]; then
    rm -f ${execPaths.slurmRunOutputShellExpansion(slurmIdVariable, 'runId')} # remove run script output - comment this for debugging
    rm -f ${execPaths.runStdOutShellExpansion(slurmIdVariable)}
    rm -f ${execPaths.runStdErrShellExpansion(slurmIdVariable)}
    srun${partitionSwitch} --dependency afterany:"\\$${slurmIdVariable}" rm -f ${execPaths.runFinishedAtShellExpansion(slurmIdVariable)}
fi
`;
}

/**
 * @param {RunPaths} runPaths
 * @returns {string}
 */
function getRunRemoveInvocation(runPaths) {
    return `${runPaths.execPaths.runRemoveScriptPath()} ${runPaths.inputsPath()} ${runPaths.idMappingPath()} ${runPaths.runId}`;
}

/**
 *
 * @param {ExecutorPaths} execPaths
 * @param {string?} partition
 * @returns {[string]}
 */
function getRunRemoveScriptCreationCommands(execPaths, partition) {
    return createScriptHelper(execPaths.runRemoveScriptPath(), getRunRemoveScript(execPaths, partition));
}

// terminates run with SIGINT signal (for the SLURM job)
// note that "external" cancellation by SLURM and scancel is SIGTERM
// (SLURM) cancellation of this script should be interpreted as an error...
function getRunStopScript() {
    return `#!/bin/bash
#SBATCH --output /dev/null
runIdtoSlurmIdMappingPath=\\$1; shift
runId=\\$1; shift
stopLockPath="\\$runIdtoSlurmIdMappingPath".stopLock
user=\\$( whoami )

#detect scheduled runbuild before stoplock is created -> scancel and exit
runBuildState=\\$( squeue -o "%j %u %t" | grep "ivis-runbuild-\\$runId \\$user" | cut -f 3 -d " " )
if [[ "\\$runBuildState" == "PD" ]]; then
    runBuildId=\\$( squeue -o "%j %u %i" | grep "ivis-runbuild-\\$runId \\$user" | cut -f 3 -d " " )
    if [[ "\\$runBuildId" != "" ]]; then
        rm -f "\\$stopLockPath"
        scancel "\\$runBuildId" --full --signal=SIGINT
        sleep 2
        exit 0
    fi
fi

# else
sleep 1
# let build finish, let the job "start"
stopLockPath="\\$runIdtoSlurmIdMappingPath".stopLock
while [ -f "\\$stopLockPath" ]
do
  sleep 1
done
# find the running job and cancel it
slurmRunId=\\$( cat "\\$runIdtoSlurmIdMappingPath" || echo "null" )
if [[ "\\$slurmRunId" != "null" ]]; then 
    scancel "\\$slurmRunId" --full --signal=SIGINT
fi
sleep 2 # wait for real cancellation, removeRun is expected to run next to clean the run's data
`;
}

/**
 *
 * @param {RunPaths} runPaths
 * @returns
 */
function getRunStopInvocation(runPaths) {
    return `${runPaths.execPaths.runStopScriptPath()} ${runPaths.idMappingPath()} ${runPaths.runId}`;
}

function getRunStopScriptCreationCommands(execPaths) {
    return createScriptHelper(execPaths.runStopScriptPath(), getRunStopScript());
}

function getRunStatusScript(execPaths) {
    return `#!/bin/bash
runIdtoSlurmIdMappingPath=\\$1; shift
runId=\\$1; shift

slurmRunId=\\$( cat "\\$runIdtoSlurmIdMappingPath" || echo "null" )
if [[ "\\$slurmRunId" == "null" ]]; then 
    echo "null"
    echo "null"
    echo "null"
    exit
fi

squeueState=\\$( squeue --job "\\$slurmRunId" -o "%t" | sed -n 2p ) # somehow || echo "null" does not work here...
if [[ "\\$squeueState" == "" ]]; then
        squeueState="null"
fi

lastRunOutputLine=\\$( ( cat ${execPaths.runStdOutShellExpansion('slurmRunId')} || echo "null" ) | tail -n 1 )
echo "\\$slurmRunId"
echo "\\$squeueState"
echo "\\$lastRunOutputLine"
`;
}

/**
 * @param {RunPaths} runPaths
 * @returns
 */
function getRunStatusInvocation(runPaths) {
    return `${runPaths.execPaths.runStatusScriptPath()} ${runPaths.idMappingPath()} ${runPaths.runId}`;
}

function getRunStatusScriptCreationCommands(execPaths) {
    return createScriptHelper(execPaths.runStatusScriptPath(), getRunStatusScript(execPaths));
}

module.exports = {
    ScriptTypes,
    getScriptCreationCommands,
    getRunBuildScriptCreationCommands,
    getRunBuildInvocation,
    getRunFailInformantScriptCreationCommands,
    getBuildCleanScriptCreationCommands,
    getRunRemoveScriptCreationCommands,
    getRunRemoveInvocation,
    getRunStopScriptCreationCommands,
    getRunStopInvocation,
    getRunStatusScriptCreationCommands,
    getRunStatusInvocation,
    createFileCommand,
};
