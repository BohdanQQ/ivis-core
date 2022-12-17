const { PYTHON_JOB_FILE_NAME, TaskType } = require('../../../../shared/tasks');

function getPythonRunScript(sbatchOutputPath, runnerScriptPath,) {
    return `#!/bin/bash
#SBATCH --output ${sbatchOutputPath}

cd "\\$1"
. ./.venv/bin/activate
cat "\\$2" | python3 ${runnerScriptPath} ./${PYTHON_JOB_FILE_NAME} "\\\${@:3}"
echo "\\$?"
`;
}

const taskTypeInitScript = {
    [TaskType.PYTHON]: (ivisPackageDirectory) => `#!/bin/bash
mkdir -p "\\$1"
cd "\\$1"
python3 -m venv ./.venv
. ./.venv/bin/activate
pip install "\\\${@:2}"
pip install --no-index --find-links=${ivisPackageDirectory} ivis
deactivate
`
}

function getPythonTaskInitScript(ivisPackageDirectory) {
    return taskTypeInitScript[TaskType.PYTHON](ivisPackageDirectory);
}


module.exports = {
    getPythonRunScript, getPythonTaskInitScript
}