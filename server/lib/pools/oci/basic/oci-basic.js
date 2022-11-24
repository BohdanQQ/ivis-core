const {
    createNewPoolParameters,
    registerPoolRemoval,
    VCN_CIDR_BLOCK,
    getVcn,
    getGlobalStateForOCIExecType
} = require('./global-state');
const core = require("oci-core");
const {
    virtualNetworkClient, virtualNetworkWaiter, COMPARTMENT_ID, TENANCY_ID, identityClient,
    computeClient, computeWaiter
} = require('./clients');

const log = require('../../../log');
const { getPublicSSHKey, executeCommand, canMakeSSHConnectionTo } = require("../../../instance-ssh");
const knex = require("../../../knex");
const LOG_ID = 'ocibasic-pool-creator';

const POOL_PEER_OS = 'Oracle Linux';
function getSubnetDisplayName(executorId) { return `IVIS-executor-${executorId}-subnet` };

async function createSubnet(executorId, subnetMask, vcnId, securityListId) {

    log.info(LOG_ID, `creating subnet with mask ${subnetMask} in VCN ${vcnId} for the executor ID ${executorId}`);
    const subnetRequest = {
        createSubnetDetails: {
            cidrBlock: subnetMask,
            compartmentId: COMPARTMENT_ID,
            displayName: getSubnetDisplayName(executorId),
            vcnId,
            securityListIds: [securityListId]
        }
    };
    log.verbose(LOG_ID, 'subnet request', subnetRequest);

    const subnetResponse = await virtualNetworkClient.createSubnet(subnetRequest);
    log.info(LOG_ID, `subnet ID created: ${subnetResponse.subnet.id}`);
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
            getPublicSSHKey(),
            params
        )
    };
    log.verbose(LOG_ID, 'Instance parameters', instanceRequest);

    const instanceResponse = await computeClient.launchInstance(instanceRequest);
    log.info(LOG_ID, `Created instance ${instanceResponse.instance.id}`);

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

async function getInstanceVnic(instanceId) {
    const attachments = await computeClient.listVnicAttachments({
        compartmentId: COMPARTMENT_ID,
        instanceId
    });
    if (attachments.items.lengh === 0) {
        return null;
    }

    const vnicId = attachments.items[0].vnicId;
    return (await virtualNetworkClient.getVnic({ vnicId })).vnic;
}

async function waitForInstanceSSH() {

}

async function initializePoolManager() {
    //await initializePoolPeer();

}

async function initializePoolPeer() {
}

async function fallthroughIfError({ error, result }, promiseGenerator) {
    // TODO check this is executed
    if (error) {
        return {
            error,
            result: null,
        };
    }
    return await promiseGenerator(result);
}

/**
 * 
 * @param {Number} execId 
 * @param {Number} peerIndex 
 * @param {String} subnetId 
 * @param {Object} params 
* @returns { { error: String | null, result: String | null } }
 */
async function createPoolPeer(execId, peerIndex, subnetId, params) {
    try {
        return { error: null, result: await createInstance(execId, peerIndex, subnetId, params) };
    }
    catch (err) {
        return { error: err, result: null };
    }
}

/**
 * 
 * @param {Number} amount 
 * @param {Number} execId 
 * @param {String} subnetId 
 * @param {Object} params 
 * @returns {[String]}
 */
async function createPoolPeers(amount, execId, subnetId, params) {
    if (amount < 1 || amount > 254) {
        throw new Error(`invalid amount requested: ${amount}`);
    }
    const peerIndicies = new Array(amount).fill(0).map((_, i) => i);
    let createdInstanceIds = [];
    const peerPromises = peerIndicies.map((peerIdx) =>
        createPoolPeer(execId, peerIdx, subnetId, params)
            // using fallthrough here because I want all the promises to resolve / wait for the peer machine to be created
            .then((res) => fallthroughIfError(res, (instanceId) => {
                createdInstanceIds.push(instanceId);
            })));

    log.info(LOG_ID, "Waiting for all peer machines to be created");
    const peerCreationResults = await Promise.all(peerPromises);
    if (createdInstanceIds.length !== amount) {
        log.error(LOG_ID, `Length ${createdInstanceIds.length} not matching pool size ${amount}`);
        // TODO? destroyAllOkPeers
        const firstError = peerCreationResults.filter((result) => result.error)[0].error ||
            new Error("At least one pool peer was not created yet no error was found!");
        throw firstError;
    }
    log.info(LOG_ID, "Instance IDs of created peers: ", createdInstanceIds);
    return createdInstanceIds;
}

async function waitForSSHConnection(host, port, user, attemptCooldownSecs, timeoutSecs, maxRetryCount) {
    return new Promise(async (resolve, reject) => {
        let stop = false;
        let timeout = setTimeout(() => {
            stop = true;
            reject(new Error(`SSH connection to ${host} could not be estabilished in the specified time (${timeoutSecs}s)`));
        }, timeoutSecs * 1000);

        let retryCount = 0;
        while (!stop && retryCount <= maxRetryCount) {
            log.verbose(LOG_ID, `SSH waiter retry ${retryCount}`);
            if (await canMakeSSHConnectionTo(host, port, user)) {
                log.verbose(LOG_ID, `SSH waiter SUCCESS ${retryCount}`);
                clearTimeout(timeout);
                resolve();
                return;
            }
            // sleep
            await new Promise((resolveTimeout) => setTimeout(resolveTimeout, attemptCooldownSecs * 1000));
            retryCount = retryCount + 1;
        }
        reject(new Error(`SSH connection to ${host} could not be estabilished after the specified retries (${maxRetryCount}, cooldown ${attemptCooldownSecs})`));
    });
}

function getRJRInstallationCommands() {
    // TODO
    return ['echo hello, RJR > ./hello.txt'];
}

function getPSInstallationCommands() {
    // TODO
    return ['echo hello, PS > ./hello2.txt'];
}

async function runCommandsOnPeers(instanceIds, executorId, commands) {
    const user = 'opc';
    // TODO extract port from global state (creates securityLists)
    const sshPort = 22;

    try {
        const installationPromises = instanceIds.map(async (id) => {
            const ip = (await getInstanceVnic(id)).publicIp;
            await waitForSSHConnection(ip, sshPort, user, 10, 120, 30);
            for (const command of commands) {
                log.verbose(LOG_ID, `executing: ${command}`);
                await executeCommand(command, ip, sshPort, user);
            }
        });
        await Promise.all(installationPromises);
    }
    catch (error) {
        log.error(LOG_ID, error);
        // TODO destroyAllOkPeers
        // handle command execution error
        if (error.stdout) {
            log.error(LOG_ID, `STDOUT of one of the peers:\n${error.stdout.join('\n')}`);
        }
        if (error.stderr) {
            log.error(LOG_ID, `STDERR of one of the peers:\n${error.stderr.join('\n')}`);
        }
        if ((error.stdout || error.stderr) && error.error) {
            throw error;
        }

        // handle any other error
        throw error;
    }
}

async function shutdownSubnet() {

}

async function shutdownInstance() {

}

function convertParams(params) {
    let retval = {
        ...params
    };
    // TODO: check correctness of the values
    retval.size = Number(params.size);
    retval.shapeConfigCPU = Number(params.shapeConfigCPU);
    retval.shapeConfigRAM = Number(params.shapeConfigRAM);
    return retval;
}

// OCI Homogenous pool:
// TODO: mutex all 3 fns
async function createOCIBasicPool(executorId, params) {
    let retVal = {
        subnetId: null,
        subnetMask: null,
        masterInstanceId: null,
        masterInstanceIp: null,
        masterInstanceSubnetIp: null,
        poolInstanceIds: [],
        error: null
    };
    params = convertParams(params);
    try {
        const executorGlobalState = await getGlobalStateForOCIExecType(knex);
        const {
            subnetMask
        } = await createNewPoolParameters();
        retVal.subnetMask = subnetMask;
        retVal.subnetId = await createSubnet(executorId, subnetMask, executorGlobalState.vcn, executorGlobalState.securityList);

        retVal.poolInstanceIds = await createPoolPeers(params.size, executorId, retVal.subnetId, params);

        log.info(LOG_ID, "Obtaining Master Peer information");
        retVal.masterInstanceId = retVal.poolInstanceIds[0];
        log.info(LOG_ID, `Master Peer Selected: ${retVal.masterInstanceId}`);
        const vnic = await getInstanceVnic(retVal.masterInstanceId);
        retVal.masterInstanceIp = vnic.publicIp;
        retVal.masterInstanceSubnetIp = vnic.privateIp;
        log.info(LOG_ID, "Master Instance IPs", {
            'public': retVal.masterInstanceIp,
            'private': retVal.masterInstanceSubnetIp
        });

        log.info(LOG_ID, "Installing required software on pool peers");
        await runCommandsOnPeers(retVal.poolInstanceIds, executorId, getRJRInstallationCommands());
        log.info(LOG_ID, "Installing additional software on master peer");
        await runCommandsOnPeers([retVal.masterInstanceId], executorId, getPSInstallationCommands());
    } catch (error) {
        // TODO remove subnet and after that:
        // if (retVal.subnetMask) {
        //     await registerPoolRemoval({
        //         subnetMask: retVal.subnetMask
        //     });
        // }
        retVal.error = error;
    }

    if (retVal.error === null && (retVal.masterInstanceIp === null || retVal.masterInstanceSubnetIp === null)) {
        retVal.error = new Error('MasterInstance (Subnet)IP not found');
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




