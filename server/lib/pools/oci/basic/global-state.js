const knex = require('../../../knex');
const log = require('../../../log');
const LOG_ID = 'ocibasic-global-state';
const {
    virtualNetworkClient, virtualNetworkWaiter, COMPARTMENT_ID
} = require('./clients');
const core = require("oci-core");
const { MachineTypes } = require('../../../../../shared/remote-run');
const EXECUTOR_TYPE = MachineTypes.OCI_BASIC;
const GLOBAL_EXEC_STATE_TABLE = 'global_executor_type_state';
const VCN_CIDR_BLOCK = '11.0.0.0/16';
const RESERVED_VCN_NAME = 'IVIS-POOL-VCN';

async function isSavedVcnOk(vcnId) {
    const response = await virtualNetworkClient.getVcn({vcnId});
    if (response.vcn.lifecycleState === core.models.Vcn.LifecycleState.Terminated || response.vcn.lifecycleState === core.models.Vcn.LifecycleState.Terminating) {
        return false;
    } else {
        await virtualNetworkWaiter.forVcn( { vcnId },
            core.models.Vcn.LifecycleState.Available
        );
        return true;
    }
}

async function createVcn() {
    const vcnRequest = {
        createVcnDetails: {
            cidrBlock: VCN_CIDR_BLOCK,
            compartmentId: COMPARTMENT_ID,
            displayName: RESERVED_VCN_NAME
        }
    };

    log.verbose(LOG_ID, 'create VCN: ',vcnRequest);
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

async function createGateway(vcnId) {
    const gwDetails = { vcnId, compartmentId: COMPARTMENT_ID, isEnabled: true };
    log.verbose(LOG_ID, `create gateway: ${gwDetails}`);
    const createGatewayResponse = await virtualNetworkClient.createInternetGateway(
        { createInternetGatewayDetails: gwDetails }
    );

    const gatewayResponse = await virtualNetworkWaiter.forInternetGateway({
        igId: createGatewayResponse.internetGateway.id
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

    log.verbose(LOG_ID, `updating route table rules`);
    const tableUpdateResponse = await virtualNetworkClient.updateRouteTable({
        rtId: tableId,
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

async function createSecurityList(vcnId) {
    const getPortRange = (port) => { return { max: port, min: port }; };
    const getInRule = (port) => {
        return {
            source: '0.0.0.0/0',
            protocol: "6",
            tcpOptions: {
                destinationPortRange: getPortRange(port),
            }
        };
    };
    const inRules = [getInRule(22), getInRule(80), getInRule(443)];
    const outRules = [{
        destination: '0.0.0.0/0',
        protocol: "all",
    }];

    log.verbose(LOG_ID, 'creating Security list for VCN ', vcnId, '\nwith INGRESS rules: ', inRules, '\nEGRESS rules: ', outRules);
    const listResponse = await virtualNetworkClient.createSecurityList({
        createSecurityListDetails: {
            compartmentId: COMPARTMENT_ID,
            vcnId,
            egressSecurityRules: outRules,
            ingressSecurityRules: inRules,
        }
    });
    const list = await virtualNetworkWaiter.forSecurityList(
        { securityListId: listResponse.securityList.id },
        core.models.SecurityList.LifecycleState.Available);
    return list.securityList.id;
}

/**
 * @returns { {vcn: string, routeTable: string, gateway: string, securityList: string, err: Error}} OCIDs of the corresponding components, null for each component not created, err is null on success   
 */
async function setupOCINetwork() {
    let retVal = {
        'vcn': null,
        'routeTable': null,
        'gateway': null,
        'securityList': null,
        'err': null
    };

    try {
        retVal.vcn = await createVcn();
        retVal.securityList = await createSecurityList(retVal.vcn);
        retVal.gateway = await createGateway(retVal.vcn);
        retVal.routeTable = await addGatewayToVcnRouteTable(retVal.vcn, retVal.gateway);
    } catch (err) {
        retVal.err = err;
    } finally {
        return retVal;
    }
}

/**
 * @param {string} vcnId
 * @returns { {vcn: string, routeTable: string, gateway: string, err: Error}} OCIDs of the corresponding components, null for each component not created, err is null on success   
 */
async function tryRecoverOCINetwork(vcnId) {
    log.info(LOG_ID, 'trying to recover network configuration');
    // TODO: try to recover from the global state, otherwise throw error and lock the setup?
    return { vcn: vcnId, routeTable: null, gateway: null, err: new Error("TODO, unimplemented") };
}

let setupTask = null;
/**
 * @returns { {vcn: string, routeTable: string, gateway: string, err: Error}} OCIDs of the corresponding components, null for each component not created, err is null on success   
 */
async function setupVcnIfNeeded() {
    let vcnId = null;
    for await (const vcn of
        virtualNetworkClient.listAllVcns({
            compartmentId: COMPARTMENT_ID
        })) {
        if (vcn.displayName === RESERVED_VCN_NAME) {
            log.verbose(LOG_ID, `found VCN by name (looking for: ${RESERVED_VCN_NAME})`);
            if (vcn.lifecycleState === core.models.Vcn.LifecycleState.Terminating || vcn.lifecycleState === core.models.Vcn.LifecycleState.Terminated) {
                log.verbose(LOG_ID, `skipped because VNC with id ${vcn.id} is terminat(ing/ed)`);
                continue;
            }
            if (vcn.lifecycleState === core.models.Vcn.LifecycleState.Available) {
                log.verbose(LOG_ID, `VNC with id ${vcn.id} is available`);
                vcnId = vcn.id;
            }
            else {
                log.verbose(LOG_ID, `VNC with id ${vcn.id} is not terminating but also not available -> waiting for available status`);
                const vcnResponse = await virtualNetworkWaiter.forVcn(
                    {
                        vcnId: vcn.id
                    },
                    core.models.Vcn.LifecycleState.Available
                );
                log.verbose(LOG_ID, `VCN status wait complete`);
                vcnId = vcnResponse.vcn.id;
            }
        }
    }

    let state = await getGlobalStateForOCIExecType(knex);
    if (setupTask === null) {
        const vcnExists = vcnId !== null;
        const networkingIsOk = state.vnc && state.routeTable && state.gateway && state.securityList;
        if (vcnExists && networkingIsOk) {
            setupTask = undefined;
            log.info(LOG_ID, `Already existing VCN + all network parameters are present in state: ${state}`);
            return { vcn: state.vcn, routeTable: state.routeTable, gateway: state.gateway, securityList: state.securityList, err: null };
        }

        log.info(LOG_ID, `Starting VCN setup task`);
        setupTask = vcnExists ? tryRecoverOCINetwork(vcnId) : setupOCINetwork();
        const result = await setupTask;
        let diff = {...result};
        delete diff.err;
        await updateStateWithDiff(diff);
        setupTask = undefined;
        return result;
    }
    else if (setupTask === undefined) {
        log.info(LOG_ID, `VCN setup task has already run -> return state values: ${state}`);
        return { vcn: state.vcn, routeTable: state.routeTable, gateway: state.gateway, securityList: state.securityList, err: null };
    }
    else {
        log.info(LOG_ID, `VCN setup task has already started but has not finished -> wait for the task to finish`);
        return await setupTask;
    }
}

async function getVcn() {
    checkOCICanBeUsed();
    let state = await getGlobalStateForOCIExecType(knex);
    if (state.vcn) {
        log.info(LOG_ID, 'VCN ID retrieved from global state: ', state);
        try {
            if (await isSavedVcnOk(state.vcn)) {
                return state.vcn;
            } // otherwise reset the state vcn and recreate the vcn
            else {
                await updateStateWithDiff({vcn: null});
            }
        } catch (err) {
            log.error(LOG_ID, "saved VCN check failed", err);
            await updateStateWithDiff({vcn: null});
        }
    }
    let vcnCreationResult = await setupVcnIfNeeded();
    if (!vcnCreationResult.vcn || !vcnCreationResult.routeTable || !vcnCreationResult.gateway) {
        throw vcnCreationResult.err;
    }
    return vcnCreationResult.vcn;
}

function getNextAvailableIpRange(ipsUsed) {
    let expectedIndex = 1;
    for (const { index } of ipsUsed) {
        if (index !== expectedIndex) {
            return { index: expectedIndex };
        }
        expectedIndex++;
    }
    if (expectedIndex === 255) {
        return null;
    }
    return { index: expectedIndex };
}

/**
 * @returns { {vcn: string, routeTable: string, gateway: string, securityList: string}}   
 */
async function getGlobalStateForOCIExecType(tx) {
    const json = (await tx(GLOBAL_EXEC_STATE_TABLE).where('type', EXECUTOR_TYPE).first()).state;
    if (!json) {
        throw new Error(`State for executor of type ${EXECUTOR_TYPE} not found`);
    }
    return JSON.parse(json);
}

async function getIPsUsed() {
    return await knex.transaction(async tx => {
        const state = await getGlobalStateForOCIExecType(tx);
        let ipsUsed = state.ipsUsed || [];
        ipsUsed.sort((a, b) => a.index - b.index);
        return ipsUsed;
    });
}

function getStateForDb(state) {
    if (!state.ipsUsed) {
        state.ipsUsed = [];
    }
    if (!state.vcn) {
        state.vcn = null;
    }
    if (!state.routeTable) {
        state.routeTable = null;
    }
    if (!state.gateway) {
        state.gateway = null;
    }
    if (!state.securityList) {
        state.securityList = null;
    }
    return JSON.stringify(state);
}

async function updateState(tx, state) {
    await tx(GLOBAL_EXEC_STATE_TABLE).where('type', EXECUTOR_TYPE).update({
        'state': getStateForDb(state)
    });
}

async function updateStateWithDiff(diffObj) {
    return await knex.transaction(async tx => {
        let state = await getGlobalStateForOCIExecType(tx);
        log.verbose(LOG_ID, "state update from ", state);
        for (const key in diffObj) {
            if (Object.hasOwnProperty.call(diffObj, key)) {
                state[key] = diffObj[key];
            }
        }
        log.verbose(LOG_ID, "state update to ", state);
        await updateState(tx, state);
    });
}

async function storeIPsUsed(ipsUsed) {
    return await updateStateWithDiff({
        ipsUsed
    });
}

async function createNewPoolParameters() {
    checkOCICanBeUsed();
    let ipsUsed = await getIPsUsed();
    const ipRange = getNextAvailableIpRange(ipsUsed);
    if (ipRange === null) {
        throw new Error("Dedicated IP address space depleted");
    }

    ipsUsed.push(ipRange);
    await storeIPsUsed(ipsUsed);

    return {
        subnetMask: `11.0.${ipRange.index}.0/24`
    };
}

async function registerPoolRemoval(poolParameters) {
    checkOCICanBeUsed();
    if (!poolParameters || !poolParameters.subnetMask) {
        return;
    }
    const { subnetMask } = poolParameters;
    const searchResult = /^11\.0\.(?<index>[0-9]{1,3})\.0\/24$/g.exec(subnetMask);
    if (searchResult === null || !searchResult.groups || !searchResult.groups.index) {
        throw Error(`Invalid subnetMask provided: ${subnetMask}`);
    }

    const indexToRemove = Number.parseInt(searchResult.groups.index);
    if (indexToRemove <= 0 || indexToRemove >= 255) {
        throw Error(`Invalid subnetMask provided: ${subnetMask}`);
    }
    let ipsUsed = await getIPsUsed();
    ipsUsed = ipsUsed.filter((x) => x.index != indexToRemove);
    await storeIPsUsed(ipsUsed);
}


function checkOCICanBeUsed() {
    if (!virtualNetworkClient || !virtualNetworkWaiter || !COMPARTMENT_ID) {
        throw new Error("Oracle cloud infrastructure is misconfigured and cannot be used!");
    }
}

module.exports = {
    createNewPoolParameters,
    registerPoolRemoval,
    getVcn,
    VCN_CIDR_BLOCK,
    getGlobalStateForOCIExecType
}