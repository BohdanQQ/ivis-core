const core = require('oci-core');
const knex = require('../../../knex');
const log = require('../../../log');
const {
    virtualNetworkClient, virtualNetworkWaiter, COMPARTMENT_ID,
} = require('./clients');
const { MachineTypes } = require('../../../../../shared/remote-run');
const { REQUIRED_ALLOWED_PORTS } = require('./rjr-setup');
const stateCommons = require('../../../../models/exec-type-global-state-commons');

const LOG_ID = 'ocibasic-global-state';
const EXECUTOR_TYPE = MachineTypes.OCI_BASIC;
const VCN_CIDR_BLOCK = '11.0.0.0/16';
const RESERVED_VCN_NAME = 'IVIS-POOL-VCN';
const INSTANCE_SSH_PORT = 22;

/** Checks VCN state with the OCI servers, waits for resoltution if needed */
async function isSavedVcnOk(vcnId) {
    const response = await virtualNetworkClient.getVcn({ vcnId });
    if (response.vcn.lifecycleState === core.models.Vcn.LifecycleState.Terminated || response.vcn.lifecycleState === core.models.Vcn.LifecycleState.Terminating) {
        return false;
    }
    await virtualNetworkWaiter.forVcn(
        { vcnId },
        core.models.Vcn.LifecycleState.Available,
    );
    return true;
}

async function createVcn() {
    const vcnRequest = {
        createVcnDetails: {
            cidrBlock: VCN_CIDR_BLOCK,
            compartmentId: COMPARTMENT_ID,
            displayName: RESERVED_VCN_NAME,
        },
    };

    log.verbose(LOG_ID, 'create VCN: ', vcnRequest.createVcnDetails);
    let vcnResponse = await virtualNetworkClient.createVcn(vcnRequest);
    log.info(LOG_ID, 'created VCN: ', vcnResponse.vcn.id);

    const vcnWaitRequest = {
        vcnId: vcnResponse.vcn.id,
    };
    vcnResponse = await virtualNetworkWaiter.forVcn(
        vcnWaitRequest,
        core.models.Vcn.LifecycleState.Available,
    );

    return vcnResponse.vcn.id;
}

async function createGateway(vcnId) {
    const gwDetails = { vcnId, compartmentId: COMPARTMENT_ID, isEnabled: true };
    log.verbose(LOG_ID, `create gateway: ${gwDetails}`);
    const createGatewayResponse = await virtualNetworkClient.createInternetGateway(
        { createInternetGatewayDetails: gwDetails },
    );
    log.info(LOG_ID, `created gateway: ${createGatewayResponse.internetGateway.id}`);
    const gatewayResponse = await virtualNetworkWaiter.forInternetGateway({
        igId: createGatewayResponse.internetGateway.id,
    }, core.models.InternetGateway.LifecycleState.Available);

    return gatewayResponse.internetGateway.id;
}

async function addGatewayToVcnRouteTable(vcnId, gatewayId) {
    let tableId = null;
    for await (const table of virtualNetworkClient.listAllRouteTables({ compartmentId: COMPARTMENT_ID, vcnId })) {
        log.verbose(LOG_ID, `picking up (presumably default) route table: ${table}`);
        tableId = table.id;
    }

    if (!tableId) { throw new Error(`No Route Table found for table in compartment ${COMPARTMENT_ID} under VCN ${vcnId}`); }

    log.info(LOG_ID, `updating route table rules for table ${tableId}`);
    const tableUpdateResponse = await virtualNetworkClient.updateRouteTable({
        rtId: tableId,
        updateRouteTableDetails: {
            routeRules: [
                {
                    destinationType: core.models.RouteRule.DestinationType.CidrBlock,
                    networkEntityId: gatewayId,
                    cidrBlock: '0.0.0.0/0',
                    routeType: core.models.RouteRule.RouteType.Static,
                    destination: '0.0.0.0/0',
                },
            ],
        },
    });
    return tableId;
}

async function createSecurityList(vcnId) {
    const getPortRange = (min, max) => ({ max, min });
    const getInRule = (min, max) => {
        max = max === undefined ? min : max;
        return {
            source: '0.0.0.0/0',
            protocol: '6',
            tcpOptions: {
                destinationPortRange: getPortRange(min, max),
            },
        };
    };
    const inRules = REQUIRED_ALLOWED_PORTS.map((portNum) => getInRule(portNum));
    inRules.push(getInRule(INSTANCE_SSH_PORT));
    const outRules = [{
        destination: '0.0.0.0/0',
        protocol: 'all',
    }];

    log.verbose(LOG_ID, 'creating Security list for VCN ', vcnId, '\nwith INGRESS rules: ', inRules, '\nEGRESS rules: ', outRules);
    const listResponse = await virtualNetworkClient.createSecurityList({
        createSecurityListDetails: {
            compartmentId: COMPARTMENT_ID,
            vcnId,
            egressSecurityRules: outRules,
            ingressSecurityRules: inRules,
        },
    });
    log.info(LOG_ID, 'created security list ', listResponse.securityList.id);
    const list = await virtualNetworkWaiter.forSecurityList(
        { securityListId: listResponse.securityList.id },
        core.models.SecurityList.LifecycleState.Available,
    );
    return list.securityList.id;
}

/**
 * Sets up OCI Network Resources needed to allow pool creation using OCI
 * @returns { {vcn: string, routeTable: string, gateway: string, securityList: string, err: Error}}
 * OCIDs of the corresponding components, null for each component not created, err is null on success
 * or contains a throwable instance of an Error
 */
async function setupOCINetwork() {
    const retVal = {
        vcn: null,
        routeTable: null,
        gateway: null,
        securityList: null,
        err: null,
    };

    try {
        retVal.vcn = await createVcn();
        retVal.securityList = await createSecurityList(retVal.vcn);
        retVal.gateway = await createGateway(retVal.vcn);
        retVal.routeTable = await addGatewayToVcnRouteTable(retVal.vcn, retVal.gateway);
    } catch (err) {
        // TODO remove all created resources
        retVal.err = err;
    }
    return retVal;
}

/**
 * @param {string} vcnId
 * @returns { {vcn: string, routeTable: string, gateway: string, securityList: string, err: Error}} OCIDs of the corresponding components, null for each component not created, err is null on success
 */
async function tryRecoverOCINetwork(vcnId) {
    log.info(LOG_ID, 'trying to recover network configuration');
    // TODO: try to recover from the global state, otherwise throw error and lock the setup?
    return {
        vcn: vcnId, routeTable: null, gateway: null, err: new Error('TODO, unimplemented'),
    };
}

/** @returns {string} VCN OCID or null if not found */
async function tryToDiscoverVCNId() {
    for await (const vcn of
        virtualNetworkClient.listAllVcns({
            compartmentId: COMPARTMENT_ID,
        })) {
        if (vcn.displayName === RESERVED_VCN_NAME) {
            log.verbose(LOG_ID, `found VCN by name (looking for: ${RESERVED_VCN_NAME})`);
            if (vcn.lifecycleState === core.models.Vcn.LifecycleState.Terminating || vcn.lifecycleState === core.models.Vcn.LifecycleState.Terminated) {
                log.verbose(LOG_ID, `VNC with id ${vcn.id} was skipped because it is terminat(ing/ed)`);
                continue;
            }
            if (vcn.lifecycleState === core.models.Vcn.LifecycleState.Available) {
                log.verbose(LOG_ID, `VNC with id ${vcn.id} is available`);
                return vcn.id;
            }

            log.verbose(LOG_ID, `VNC with id ${vcn.id} is not terminating but also not available -> waiting for available status`);
            const vcnResponse = await virtualNetworkWaiter.forVcn(
                {
                    vcnId: vcn.id,
                },
                core.models.Vcn.LifecycleState.Available,
            );
            log.verbose(LOG_ID, 'VCN status wait complete');
            return vcnResponse.vcn.id;
        }
    }
    return null;
}

/**
 * @returns { {vcn: string, routeTable: string, gateway: string, securityList: string, err: Error}} OCIDs of the corresponding components, null for each component not created, err is null on success
 */
async function setupVcnIfNeeded() {
    const vcnId = await tryToDiscoverVCNId();

    const state = await assumesLocked_getGlobalStateForOCIExecType(knex);
    const vcnExists = vcnId !== null;
    const networkingIsOk = state.vnc && state.routeTable && state.gateway && state.securityList;
    if (vcnExists && networkingIsOk) {
        log.info(LOG_ID, `Already existing VCN + all network parameters are present in state: ${state}`);
        return {
            vcn: state.vcn, routeTable: state.routeTable, gateway: state.gateway, securityList: state.securityList, err: null,
        };
    }

    log.info(LOG_ID, 'Starting VCN setup task');
    const result = await (vcnExists ? tryRecoverOCINetwork(vcnId) : setupOCINetwork());

    const diff = { ...result };
    delete diff.err;
    await updateStateWithDiff(diff);

    return result;
}

async function impl_getVcn() {
    const state = await assumesLocked_getGlobalStateForOCIExecType(knex);
    if (state.vcn) {
        log.info(LOG_ID, 'VCN ID retrieved from global state: ', state);
        try {
            if (await isSavedVcnOk(state.vcn)) {
                return state.vcn;
            } // otherwise reset the state vcn and recreate the vcn
            await stateCommons.appendToLogByType(`OCI networking error: saved VCN ${state.vcn} incorrect/missing, trying to recover...\nEntire state: ${JSON.stringify(state)}`);

            await updateStateWithDiff({ vcn: null });
        } catch (err) {
            log.error(LOG_ID, 'saved VCN check failed', err);
            await stateCommons.appendToLogByType(`OCI networking error: VCN check failed, trying to recover...\nEntire state: ${JSON.stringify(state)}\nError: ${err}`);
            await updateStateWithDiff({ vcn: null });
        }
    }
    const vcnCreationResult = await setupVcnIfNeeded();
    if (!vcnCreationResult.vcn || !vcnCreationResult.routeTable || !vcnCreationResult.gateway || !vcnCreationResult.securityList || vcnCreationResult.err) {
        await stateCommons.appendToLogByType(`Unable to initialize OCI networking:\n\nParially correct state (with error): ${JSON.stringify(vcnCreationResult)}`);
        throw vcnCreationResult.err;
    }
    return vcnCreationResult.vcn;
}

async function getVcn() {
    return await stateManipulationWrapper(impl_getVcn);
}

/**
 * @returns { Promise<{vcn: string, routeTable: string, gateway: string, securityList: string}>}
 */
async function assumesLocked_getGlobalStateForOCIExecType(tx) {
    const json = await stateCommons.getRawStateByType(EXECUTOR_TYPE, tx);
    if (!json) {
        throw new Error(`State for executor of type ${EXECUTOR_TYPE} not found`);
    }
    return JSON.parse(json);
}

/**
 * @returns { Promise<{vcn: string, routeTable: string, gateway: string, securityList: string}>} null if the global state is locked
 */
async function getGlobalStateForOCIExecType(tx) {
    try {
        return await stateManipulationWrapper(async () => await assumesLocked_getGlobalStateForOCIExecType(tx));
    } catch (err) {
        throw err;
    }
}

function getStateForDb(state) {
    let cleanState = state;
    if (!cleanState) {
        cleanState = {};
    }
    if (!cleanState.ipsUsed) {
        cleanState.ipsUsed = [];
    }
    if (!cleanState.vcn) {
        cleanState.vcn = null;
    }
    if (!cleanState.routeTable) {
        cleanState.routeTable = null;
    }
    if (!cleanState.gateway) {
        cleanState.gateway = null;
    }
    if (!cleanState.securityList) {
        cleanState.securityList = null;
    }
    return JSON.stringify(cleanState);
}

async function updateState(tx, state) {
    await stateCommons.setRawStateByType(EXECUTOR_TYPE, getStateForDb(state), tx);
}

async function updateStateWithDiff(diffObj) {
    return await knex.transaction(async (tx) => {
        const state = await assumesLocked_getGlobalStateForOCIExecType(tx);
        log.silly(LOG_ID, 'global state update from ', state);
        Object.keys(diffObj).forEach((key) => { state[key] = diffObj[key]; });
        log.silly(LOG_ID, 'global state update to ', state);
        await updateState(tx, state);
    });
}

// a set of functions related to incrementing the pool parameters
// for each pool that is created
// so far, the pool parameters only consist of the subnet mask

// currently the subnet masks are incremented only on a single-index basis
// which covers only 254 subnets (1-254)
// TODO: add other indicies (in accordance with VCN limits)

function getNextAvailableIpRange(ipsUsed) {
    let expectedIndex = 1;
    for (const { index } of ipsUsed) {
        if (index !== expectedIndex) {
            return { index: expectedIndex };
        }
        expectedIndex += 1;
    }
    if (expectedIndex === 255) {
        return null;
    }
    return { index: expectedIndex };
}

/** returns sorted (ascending) IP address allocation */
async function getIPsUsed() {
    return await knex.transaction(async (tx) => {
        const state = await assumesLocked_getGlobalStateForOCIExecType(tx);
        const ipsUsed = state.ipsUsed || [];
        ipsUsed.sort((a, b) => a.index - b.index);
        return ipsUsed;
    });
}

async function storeIPsUsed(ipsUsed) {
    return await updateStateWithDiff({
        ipsUsed,
    });
}

/**
 * Wraps a closure call with locking logic, returning whatever the closure returns
 * while ensuring consistent unlocking
 * @param {function} closure 
 * @returns 
 */
async function stateManipulationWrapper(closure) {
    if (!virtualNetworkClient || !virtualNetworkWaiter || !COMPARTMENT_ID) {
        throw new Error('Oracle cloud infrastructure is misconfigured and cannot be used!');
    }

    const gotLock = await stateCommons.tryLock(EXECUTOR_TYPE, 3, 200);
    if (!gotLock) {
        throw new Error('Unable to accquire OCI pool state lock, please try again later');
    }
    try {
        const closureRetval = await closure();

        await stateCommons.unlockStateByType(EXECUTOR_TYPE);

        return closureRetval;
    } catch (err) {
        await stateCommons.unlockStateByType(EXECUTOR_TYPE);
        throw err;
    }
}

/**
 * Allocates from the "global" resources for use in a pool
 * @returns {Promise<{subnetMask: string}>}
 */
async function impl_createNewPoolParameters() {
    const ipsUsed = await getIPsUsed();
    const ipRange = getNextAvailableIpRange(ipsUsed);
    if (ipRange === null) {
        throw new Error('Dedicated IP address space depleted');
    }

    ipsUsed.push(ipRange);
    await storeIPsUsed(ipsUsed);
    await stateCommons.unlockStateByType(EXECUTOR_TYPE);

    return {
        subnetMask: `11.0.${ipRange.index}.0/24`,
    };
}

/**
 * Allocates from the "global" resources for use in a pool
 * @returns {Promise<{subnetMask: string}>}
 */
async function createNewPoolParameters() {
    return await stateManipulationWrapper(impl_createNewPoolParameters);
}

/**
 * Frees specific IP which matches on an index
 * @param {number} indexToRemove
 */
async function impl_removeIpIndex(indexToRemove) {
    let ipsUsed = await getIPsUsed();
    ipsUsed = ipsUsed.filter((x) => x.index !== indexToRemove);
    await storeIPsUsed(ipsUsed);
}

/**
 * Frees up any allocation of the "global" resources for use in other pools
 * @param {{subnetMask: string}} poolParameters
 */
async function registerPoolRemoval(poolParameters) {
    if (!poolParameters || !poolParameters.subnetMask) {
        return;
    }
    const { subnetMask } = poolParameters;
    const searchResult = /^11\.0\.(?<index>[0-9]{1,3})\.0\/24$/g.exec(subnetMask);
    if (searchResult === null || !searchResult.groups || !searchResult.groups.index) {
        throw new Error(`Invalid subnetMask provided: ${subnetMask}`);
    }

    const indexToRemove = Number.parseInt(searchResult.groups.index, 10);
    if (indexToRemove <= 0 || indexToRemove >= 255) {
        throw new Error(`Invalid subnetMask provided: ${subnetMask}`);
    }

    return await stateManipulationWrapper(async () => await impl_removeIpIndex(indexToRemove));
}

module.exports = {
    createNewPoolParameters,
    registerPoolRemoval,
    getVcn,
    getGlobalStateForOCIExecType,
    INSTANCE_SSH_PORT,
};
