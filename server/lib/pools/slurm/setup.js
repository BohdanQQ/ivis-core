const { PYTHON_JOB_FILE_NAME, TaskType } = require('../../../../shared/tasks');
const config = require('../../config');

// taskdir runInputPath buildOutputPath buildFailInformantPath runFailEmitTypeValue runId jobArgs
function getPythonRunScript(sbatchOutputPath, runnerScriptPath) {
    return `#!/bin/bash
#SBATCH --output ${sbatchOutputPath}
if [[ -f \\$3 ]]; then
    \\$4 \\$5 \\$6
    exit
fi
cd "\\$1"
. ./.venv/bin/activate
cat "\\$2" | python3 ${runnerScriptPath} ./${PYTHON_JOB_FILE_NAME} "\\\${@:7}"
echo "\\$?"
`;
}

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
`
}

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


module.exports = {
    getPythonRunScript, getPythonTaskInitScript, getBuildOutputCleanScript, buildFailInformantScript
}