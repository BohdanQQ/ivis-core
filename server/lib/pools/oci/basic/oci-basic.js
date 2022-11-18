
const { MachineTypes } = require("../../../../../shared/remote-run");
const { getById } = require("../../../../models/job-execs");
const { getAdminContext } = require("../../../context-helpers");
const executors = require('../../../../models/job-execs');
const {
    createNewPoolParameters,
    registerPoolRemoval,
    VCN_CIDR_BLOCK,
    getVcn
} = require('./global-state');
const {
    virtualNetworkClient, virtualNetworkWaiter, computeClient, computeWaiter, identityClient
} = require('./clients');

const log = require('../../../log');
const LOG_ID = 'oci-basic';

async function logErrorToExecutor(executorId, error) {
    const errMsg = `Cannot create OCI VCN: ${err}`;
    log.error(LOG_ID, errMsg);
    await executors.appendToLogById(executorId, errMsg);
}

async function createSubnet() {

}

async function createInstance() {

}

async function waitForInstanceSSH() {

}

async function initializePoolManager() {
    //await initializePoolPeer();

}

async function initializePoolPeer() {

}


async function shutdownSubnet() {

}

async function shutdownInstance() {

}

// OCI Homogenous pool:
// state: { vcnId, subnetId, masterInstanceId, masterInstanceIp, poolInstanceIds }
// params { size, tenancyId, compartmentId, shape, shapeConfigCPU, shapeConfigRAM }
// TODO: mutex all 3 fns
async function createOCIBasicPool(executorId, params) {

}

async function verifyOCIBasicPool(executorId) {

}

async function shutdownOCIBasicPool(executorId) {

}

module.exports = { createOCIBasicPool, shutdownOCIBasicPool, verifyOCIBasicPool };

// TODO: use elsewhere
// async function isExecutorOfType(executorType, executorId) {
//     const executor = await getById(getAdminContext(), executorId);
//     return executor && executor.type == executorType;
// }

// function wrapWithExecTypeCheck(fn, expectedExecType) {
//     return (executorId) => {
//         if (!isExecutorOfType(execType, executorId)) {
//             throw new Error(`Invalid Executor type: found ${execType} where ${expectedExecType} was expected`);
//         }
//         return fn(executorId);
//     }
// }




