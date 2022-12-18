const { PYTHON_JOB_FILE_NAME, TaskType } = require('../../../../shared/tasks');

// taskdir runInputPath buildOutputPath buildFailInformantPath runFailEmitTypeValue jobArgs
function getPythonRunScript(sbatchOutputPath, runnerScriptPath) {
    return `#!/bin/bash
#SBATCH --output ${sbatchOutputPath}
if [[ -f \\$3 ]]; then
    \\$4 \\$5
    exit
fi
cd "\\$1"
. ./.venv/bin/activate
cat "\\$2" | python3 ${runnerScriptPath} ./${PYTHON_JOB_FILE_NAME} "\\\${@:6}"
echo "\\$?"
`;
}

const taskTypeInitScript = {
    [TaskType.PYTHON]: (sbatchOutputPath, ivisPackageDirectory) => `#!/bin/bash
#SBATCH --output ${sbatchOutputPath}
set -euxo pipefail
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
if [[ cat ./testb | grep -q "build complete$" \\$1 ]]; then 
    rm -f "\\$1"
fi
`;
}

function buildFailInformantScript(keyPath, certPath, useCaCert, caCertPath) {
    return `#!/bin/bash
#SBATCH --output /dev/null
curl --cert ${certPath} --key ${keyPath} ${useCaCert ? caCertPath : ''}\\
--header "Content-Type: application/json"\\
--request POST --data '{\\"type\\":\\""\\$1"\\",\\"data\\":\\"remote build failed\\"}' ${emitUrl}
`;
}


module.exports = {
    getPythonRunScript, getPythonTaskInitScript, getBuildOutputCleanScript, buildFailInformantScript
}