const knex = require('../../../knex');
const config = require('../../../config');
const {
    virtualNetworkClient, virtualNetworkWaiter, COMPARTMENT_ID
} = require('./clients');
const { MachineTypes } = require('../../../../../shared/remote-run');
const EXECUTOR_TYPE = MachineTypes.OCI_BASIC;
const GLOBAL_EXEC_STATE_TABLE = 'global_executor_type_state';
const VCN_CIDR_BLOCK = '11.0.0.0/16';
const RESERVED_VCN_NAME = 'IVIS-POOL-VCN';

async function createVcn() {
    const vcnRequest = {
        createVcnDetails: {
            cidrBlock: VCN_CIDR_BLOCK,
            compartmentId: COMPARTMENT_ID,
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

async function createGateway(vcnId) {
    const createGatewayResponse = await virtualNetworkClient.createInternetGateway(
        { createInternetGatewayDetails: { vcnId, compartmentId: COMPARTMENT_ID, isEnabled: true } }
    );

    const gatewayResponse = await virtualNetworkWaiter.forInternetGateway({
        igId: createGatewayResponse.internetGateway.id
    }, core.models.InternetGateway.LifecycleState.Available);

    return gatewayResponse.internetGateway.id;
}

async function addGatewayToVcnRouteTable(vcnId, gatewayId) {
    let tableId = null;
    for await (const table of virtualNetworkClient.listAllRouteTables({ compartmentId: COMPARTMENT_ID, vcnId })) {
        tableId = table.id;
    }

    if (!tableId) { throw new Error(`No Route Table found for table in compartment ${COMPARTMENT_ID} under VCN ${vcnId}`); }

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

/**
 * @returns { {vcn: string, routeTable: string, gateway: string, err: Error}} OCIDs of the corresponding components, null for each component not created, err is null on success   
 */
async function setupOCINetwork() {
    let retVal = {
        'vcn': null,
        'routeTable': null,
        'gateway': null,
        'err': null
    };

    try {
        retVal.vcn = await createVcn();
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
            vcnId = vcn.id;
        }
    }

    let state = await getGlobalStateForOCIExecType(knex);
    if (setupTask === null) {
        const vcnExists = vcnId !== null;
        const networkingIsOk = state.vnc && state.routeTable && state.gateway;
        if (vcnExists && networkingIsOk) {
            setupTask = undefined;
            return { vcn: state.vcn, routeTable: state.routeTable, gateway: state.gateway, err: null };
        }

        setupTask = vcnExists ? tryRecoverOCINetwork(vcnId) : setupOCINetwork();
        const result = await setupTask;
        await updateStateWithDiff(result);
        setupTask = undefined;
        return result;
    }
    else if (setupTask === undefined) {
        return { vcn: state.vcn, routeTable: state.routeTable, gateway: state.gateway, err: null };
    }
    else {
        return await setupTask;
    }
}

async function getVcn() {
    checkOCICanBeUsed();
    let state = await getGlobalStateForOCIExecType(knex);
    if (state.vcn) {
        return state.vcn;
    }
    let vncCreationResult = await setupVcnIfNeeded();
    if (!vncCreationResult.vcn || !vncCreationResult.routeTable || !vncCreationResult.gateway) {
        throw vncCreationResult.err;
    }
    return vncCreationResult.vcn;
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
    if (!state.vcnId) {
        state.vcn = null;
    }
    if (!state.routeTableId) {
        state.routeTable = null;
    }
    if (!state.gatewayId) {
        state.gateway = null;
    }
    return JSON.stringify(state);
}

async function updateState(tx, state) {
    await tx(GLOBAL_EXEC_STATE_TABLE).where('type', EXECUTOR_TYPE).update('state', getStateForDb(state));
}

async function updateStateWithDiff(diffObj) {
    return await knex.transaction(async tx => {
        let state = await getGlobalStateForOCIExecType(knex);
        for (const key in diffObj) {
            if (Object.hasOwnProperty.call(diffObj, key)) {
                state[key] = diffObj[key];
            }
        }
        await updateState(tx, state);
    });
}

async function storeIPsUsed(ipsUsed) {
    return await knex.transaction(async tx => {
        let state = getGlobalStateForOCIExecType(tx);
        state.ipsUsed = ipsUsed;
        await updateState(tx, state);
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

async function registerPoolRemoval({ subnetMask }) {
    checkOCICanBeUsed();
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
    VCN_CIDR_BLOCK
}