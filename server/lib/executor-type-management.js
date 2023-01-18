const { MachineTypes } = require('../../shared/remote-run');
const { enforceTypePermission } = require('../models/shares');
const { clearState: clearOCIState } = require('./pools/oci/basic/global-state');

const noopHanlder = () => { return; };

const globalStateHandlers = {
    [MachineTypes.REMOTE_RUNNER_AGENT]: {
        clearGlobalState: noopHanlder,
    },
    [MachineTypes.OCI_BASIC]: {
        clearGlobalState: clearOCIState,
    },
    [MachineTypes.REMOTE_POOL]: {
        clearGlobalState: noopHanlder,
    },
    [MachineTypes.SLURM_POOL]: {
        clearGlobalState: noopHanlder,
    },
};
Object.freeze(globalStateHandlers);

/**
 * Checks permissions
 * @param {string} executorType
 * @returns {{clearGlobalState: function}}
 */
async function getGlobalExecTypeStateHandler(context, executorType) {
    // note: this code is not in the executor type commons module in order
    // to prevent cyclic dependencies
    if (!Object.values(MachineTypes).includes(executorType)) {
        throw new Error("Invalid executor type");
    }

    await enforceTypePermission(context, 'namespace', ['manageGlobalExecState']);

    return globalStateHandlers[executorType];
}

module.exports.getGlobalExecTypeStateHandler = getGlobalExecTypeStateHandler;
