
const { MachineTypes } = require("../../../../../shared/remote-run");
const { getById } = require("../../../../models/job-execs");
const { getAdminContext } = require("../../../context-helpers");
const executors = require('../../../../models/job-execs');
const {
    createNewPoolParameters,
    registerPoolRemoval,
    VCN_CIDR_BLOCK
} = require('./global-state');
const config = require('../../../config');
const core = require("oci-core");
const identity = require("oci-identity");
const wr = require("oci-workrequests");
const common = require("oci-common");
const log = require('../../../log');
const LOG_ID = 'oci-basic';

const OCI_CREDS_FILE_PATH = config.oci.credsPath;
const RESERVED_VCN_NAME = 'IVIS-POOL-VCN';

const authenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(OCI_CREDS_FILE_PATH);
const waiterFailAfterSeconds = 5 * 60;
const delayMaxSeconds = 30;
const waiterConfiguration = {
    terminationStrategy: new common.MaxTimeTerminationStrategy(waiterFailAfterSeconds),
    delayStrategy: new common.ExponentialBackoffDelayStrategy(delayMaxSeconds)
};

const computeClient = new core.ComputeClient({
    authenticationDetailsProvider
});

const workRequestClient = new wr.WorkRequestClient({
    authenticationDetailsProvider
});

const computeWaiter = computeClient.createWaiters(workRequestClient, waiterConfiguration);

const virtualNetworkClient = new core.VirtualNetworkClient({
    authenticationDetailsProvider
});

const virtualNetworkWaiter = virtualNetworkClient.createWaiters(
    workRequestClient,
    waiterConfiguration
);

const identityClient = new identity.IdentityClient({
    authenticationDetailsProvider
});

async function executorStateUpdater(key, valueMutator) {
    // change currentState.key = valueMutator(currentState.key)
}

async function createVcn(compartmentId) {
    const vcnRequest = {
        createVcnDetails: {
            cidrBlock: VCN_CIDR_BLOCK,
            compartmentId: compartmentId,
            displayName: RESERVED_VCN_NAME
        }
    };

    let vcnResponse = await virtualNetworkClient.createVcn(vcnRequest);

    const vcnWaitRequest = {
        vcnId: vcnResponse.vcn.id
    };

    vcnResponse = await virtualNetworkWaiter.forVcn(
        vcnWaitRequest,
        core.models.Vcn.LifecycleState.Available
    );

    return vcnResponse.vcn.id;
}

async function createGateway(compartmentId, vcnId) {
    const createGatewayResponse = await virtualNetworkClient.createInternetGateway({ createInternetGatewayDetails: { vcnId, compartmentId, isEnabled: true } });

    const gatewayResponse = await virtualNetworkWaiter.forInternetGateway({
        igId: createGatewayResponse.internetGateway.id
    }, core.models.InternetGateway.LifecycleState.Available);

    return gatewayResponse.internetGateway.id;
}

async function addGatewayToVcnRouteTable(compartmentId, vcnId, gatewayId) {
    let tableId = null;
    for await (const table of virtualNetworkClient.listAllRouteTables({ compartmentId, vcnId })) {
        tableId = table.id;
    }

    if (!tableId) { throw new Error(`No Route Table found for table in compartment ${compartmentId} under VCN ${vcnId}`); }

    const tableUpdateResponse = await virtualNetworkClient.updateRouteTable({
        tableId,
        updateRouteTableDetails: {
            routeRules: [
                {
                    destinationType: core.models.RouteRule.DestinationType.CidrBlock,
                    networkEntityId: gatewayId,
                    cidrBlock: "0.0.0.0/0",
                    routeType: core.models.RouteRule.RouteType.Static,
                    destination: "0.0.0.0/0"
                }
            ]
        }
    });
    return tableId;
}

async function logErrorToExecutor(executorId, error) {
    const errMsg = `Cannot create OCI VCN: ${err}`;
    log.error(LOG_ID, errMsg);
    await executors.appendToLogById(executorId, errMsg);
}

// TODO make VCN setup part of global setup?
// should be - only one VCN exists per EXECUTOR TYPE!
// other things - subnet, instance - are on executor basis
// logging? propagate here from global-state and log to the executor probably
/**
 * @param {Number} executorId
 * @param {string} compartmentId
 * @returns { {vnc: string, routeTable: string, gateway: string}} OCIDs of the corresponding components, null for each component not created   
 */
async function setupVcnIfNeeded(executorId, compartmentId) {

    for await (const vcn of
        virtualNetworkClient.listAllVcns({
            compartmentId
        })) {
        if (vcn.displayName === RESERVED_VCN_NAME) {
            return vcn.id;
        }
    }

    let retVal = {
        'vcn': null,
        'routeTable': null,
        'gateway': null,
    };
    try {
        retVal.vcn = await createVcn(compartmentId);
        retVal.gateway = await createGateway(compartmentId, retVal.vcn);
        retVal.routeTable = await addGatewayToVcnRouteTable(compartmentId, retVal.vcn, retVal.gateway);
    } catch (err) {
        logErrorToExecutor(executorId, err);
    } finally {
        return retVal;
    }
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
    "my fucktarded string";
    'another';
    `kill me please`;
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




