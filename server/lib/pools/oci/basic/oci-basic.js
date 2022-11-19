
const { MachineTypes } = require("../../../../../shared/remote-run");
const executors = require('../../../../models/job-execs');
const {
    createNewPoolParameters,
    registerPoolRemoval,
    VCN_CIDR_BLOCK,
    getVcn,
} = require('./global-state');
const core = require("oci-core");
const {
    virtualNetworkClient, virtualNetworkWaiter, COMPARTMENT_ID, TENANCY_ID, identityClient,
    computeClient, computeWaiter
} = require('./clients');

const log = require('../../../log');
const { getAuthorizedKeyFormat } = require("../../../instance-ssh");
const LOG_ID = 'ocibasic-pool-creator';

const POOL_PEER_OS = 'Oracle Linux';
function getSubnetDisplayName(executorId) { return `IVIS-executor-${executorId}-subnet` };

async function createSubnet(executorId, subnetMask, vcnId) {

    log.info(LOG_ID, `creating subnet with mask ${subnetMask} in VCN ${vcnId} for the executor ID ${executorId}`);
    const subnetRequest = {
        createSubnetDetails: {
            cidrBlock: subnetMask,
            compartmentId: COMPARTMENT_ID,
            displayName: getSubnetDisplayName(executorId),
            vcnId
        }
    };
    log.verbose(LOG_ID, 'subnet request', subnetRequest);

    const subnetResponse = await virtualNetworkClient.createSubnet(subnetRequest);

    const subnetWaitRequest = {
        subnetId: subnetResponse.subnet.id
    };

    await virtualNetworkWaiter.forSubnet(
        subnetWaitRequest,
        core.models.Subnet.LifecycleState.Available
    );

    return subnetResponse.subnet.id;
}

async function getAvailabilityDomain() {
    const response = await identityClient.listAvailabilityDomains({
        compartmentId: TENANCY_ID
    });
    return response.items[0];
}

async function getImageId(shapeName) {
    const request = {
        compartmentId: COMPARTMENT_ID,
        shape: shapeName,
        operatingSystem: POOL_PEER_OS
    };

    const response = await computeClient.listImages(request);
    return response.items[0].id;
}

async function getInstanceRequestDetails(shapeName, instanceName, subnetId, authorizedSSHKey, params) {
    const domain = await getAvailabilityDomain();
    const sourceDetails = {
        imageId: await getImageId(shapeName),
        sourceType: "image"
    };
    let result = {
        compartmentId: COMPARTMENT_ID,
        availabilityDomain: domain.name ? domain.name : "",
        shape: shapeName,
        displayName: instanceName,
        sourceDetails,
        createVnicDetails: {
            subnetId
        },
        metadata: {
            ssh_authorized_keys: authorizedSSHKey,
        }
    };
    if (shapeName.toLowerCase().indexOf('flex') !== -1) {
        result.shapeConfig = {
            ocpus: params.shapeConfigCPU ? params.shapeConfigCPU : 1,
            memoryInGBs: params.shapeConfigRAM ? params.shapeConfigRAM : 1,
        };
    }
    return result;
}

async function createInstance(executorId, instanceIndex, subnetId, params) {
    const instanceName = `IVIS-PEER-ex${executorId}-${instanceIndex}`;
    log.info(LOG_ID, `Creating instance ${instanceName}`);
    const instanceRequest = {
        launchInstanceDetails: await getInstanceRequestDetails(
            params.shape,
            instanceName,
            subnetId,
            getAuthorizedKeyFormat('core@IVIS'),
            params
        )
    };
    log.verbose(LOG_ID, 'Instance parameters', instanceRequest);

    const instanceResponse = await computeClient.launchInstance(instanceRequest);

    const instanceWaitRequest = {
        instanceId: instanceResponse.instance.id
    };

    log.info(LOG_ID, `Waiting for the instance ${instanceName} to be available`);
    const getInstanceResponse = await computeWaiter.forInstance(
        instanceWaitRequest,
        core.models.Instance.LifecycleState.Running
    );
    return getInstanceResponse.instance.id;
}

async function getInstanceIp(instanceId) {
    const attachments = await computeClient.listVnicAttachments({
        compartmentId: COMPARTMENT_ID,
        instanceId
    });
    if (attachments.items.lengh === 0) {
        return null;
    }

    const vnicId = attachments.items[0].vnicId;
    const vnic = await virtualNetworkClient.getVnic({ vnicId });
    return vnic.vnic.publicIp;
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
// state: { subnetId, subnetMask, masterInstanceId, masterInstanceIp, poolInstanceIds }
// params { size, shape, shapeConfigCPU, shapeConfigRAM }
// TODO: mutex all 3 fns
async function createOCIBasicPool(executorId, params, vcnId) {
    let retVal = {
        subnetId: null,
        subnetMask: null,
        masterInstanceId: null,
        masterInstanceIp: null,
        poolInstanceIds: [],
        error: null
    };

    try {
        const poolParams = await createNewPoolParameters();
        retVal.subnetMask = poolParams.subnetMask;
        retVal.subnetId = await createSubnet(executorId, poolParams.subnetMask, vcnId);
        retVal.masterInstanceId = await createInstance(executorId, 0, retVal.subnetId, params);
        retVal.masterInstanceIp = await getInstanceIp(retVal.masterInstanceId);
        retVal.poolInstanceIds = [retVal.masterInstanceId];
    } catch (error) {
        retVal.error = error;
    }

    if (retVal.error === null && retVal.masterInstanceIp === null) {
        retVal.error = new Error('MasterInstanceIP not found');
    }
    return retVal;
}

async function verifyOCIBasicPool(executorId) {

}

async function shutdownOCIBasicPool(executorId) {

}

// TODO? (shutdown == from ready state)
async function killPoolFromFailedState(executorId) {

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




