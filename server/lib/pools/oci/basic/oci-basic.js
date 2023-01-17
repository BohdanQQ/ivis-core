const core = require('oci-core');
const {
    createNewPoolParameters,
    getGlobalStateForOCIExecType,
    INSTANCE_SSH_PORT,
    registerPoolRemoval,
    getVcn,
} = require('./global-state');
const {
    virtualNetworkClient, virtualNetworkWaiter, COMPARTMENT_ID, TENANCY_ID, identityClient,
    computeClient, computeWaiter,
} = require('./clients');
const certs = require('../../../remote-certificates');
const log = require('../../../log');
const { getPublicSSHKey, sshWrapper, canMakeSSHConnectionTo } = require('../../../instance-ssh');
const knex = require('../../../knex');
const { getRJRSetupCommands, getRPSSetupCommands } = require('./rjr-setup');
const config = require('../../../config');

const LOG_ID = 'ocibasic-pool-creator';

const POOL_PEER_OS = 'Oracle Linux';
function getSubnetDisplayName(executorId) { return `IVIS-executor-${executorId}-subnet`; }
function getInstanceDisplayName(executorId, instanceIndex) { return `IVIS-PEER-ex${executorId}-${instanceIndex}`; }

async function createSubnet(executorId, subnetMask, vcnId, securityListId) {
    log.info(LOG_ID, `creating subnet with mask ${subnetMask} in VCN ${vcnId} for the executor ID ${executorId}`);
    const subnetRequest = {
        createSubnetDetails: {
            cidrBlock: subnetMask,
            compartmentId: COMPARTMENT_ID,
            displayName: getSubnetDisplayName(executorId),
            vcnId,
            securityListIds: [securityListId],
        },
    };
    log.verbose(LOG_ID, 'subnet request', subnetRequest);

    const subnetResponse = await virtualNetworkClient.createSubnet(subnetRequest);
    log.info(LOG_ID, `subnet ID created: ${subnetResponse.subnet.id}`);
    const subnetWaitRequest = {
        subnetId: subnetResponse.subnet.id,
    };

    await virtualNetworkWaiter.forSubnet(
        subnetWaitRequest,
        core.models.Subnet.LifecycleState.Available,
    );

    return subnetResponse.subnet.id;
}

async function getAvailabilityDomain() {
    const response = await identityClient.listAvailabilityDomains({
        compartmentId: TENANCY_ID,
    });
    return response.items[0];
}

async function getImageId(shapeName) {
    const request = {
        compartmentId: COMPARTMENT_ID,
        shape: shapeName,
        operatingSystem: POOL_PEER_OS,
    };

    const response = await computeClient.listImages(request);
    return response.items[0].id;
}

async function getInstanceRequestDetails(shapeName, instanceName, subnetId, authorizedSSHKey, params) {
    const domain = await getAvailabilityDomain();
    const sourceDetails = {
        imageId: await getImageId(shapeName),
        sourceType: 'image',
    };
    const result = {
        compartmentId: COMPARTMENT_ID,
        availabilityDomain: domain.name ? domain.name : '',
        shape: shapeName,
        displayName: instanceName,
        sourceDetails,
        createVnicDetails: {
            subnetId,
        },
        metadata: {
            ssh_authorized_keys: authorizedSSHKey,
        },
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
    const instanceName = getInstanceDisplayName(executorId, instanceIndex);
    log.info(LOG_ID, `Creating instance ${instanceName}`);
    const instanceRequest = {
        launchInstanceDetails: await getInstanceRequestDetails(
            params.shape,
            instanceName,
            subnetId,
            getPublicSSHKey(),
            params,
        ),
    };
    log.verbose(LOG_ID, 'Instance parameters', instanceRequest);

    const instanceResponse = await computeClient.launchInstance(instanceRequest);
    log.info(LOG_ID, `Created instance ${instanceResponse.instance.id}`);

    const instanceWaitRequest = {
        instanceId: instanceResponse.instance.id,
    };

    log.info(LOG_ID, `Waiting for the instance ${instanceName} to be available`);
    const getInstanceResponse = await computeWaiter.forInstance(
        instanceWaitRequest,
        core.models.Instance.LifecycleState.Running,
    );
    return getInstanceResponse.instance.id;
}

async function getInstanceVnic(instanceId) {
    const attachments = await computeClient.listVnicAttachments({
        compartmentId: COMPARTMENT_ID,
        instanceId,
    });
    if (attachments.items.length === 0) {
        return null;
    }

    // each instance gets its vnic, this is OK
    const { vnicId } = attachments.items[0];
    return (await virtualNetworkClient.getVnic({ vnicId })).vnic;
}

async function fallthroughIfError({ error, result }, promiseGenerator) {
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
    } catch (err) {
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
    if (typeof amount !== 'number' || amount < 1 || amount > 254) {
        throw new Error(`invalid amount requested: ${amount}`);
    }
    const peerIndicies = new Array(amount).fill(0).map((_, i) => i);
    const createdInstanceIds = [];
    const peerPromises = peerIndicies.map((peerIdx) => createPoolPeer(execId, peerIdx, subnetId, params)
        // using fallthrough here because I want all the promises to resolve / wait for the peer machine to be created
        .then((res) => fallthroughIfError(res, (instanceId) => {
            createdInstanceIds.push(instanceId);
        })));

    log.info(LOG_ID, 'Waiting for all peer machines to be created');
    const peerCreationResults = await Promise.all(peerPromises);
    if (createdInstanceIds.length !== amount) {
        log.error(LOG_ID, `Length ${createdInstanceIds.length} not matching pool size ${amount}`);
        const firstError = peerCreationResults.filter((result) => result.error)[0].error
            || new Error('At least one pool peer was not created yet no error was found!');
        throw firstError;
    }
    log.info(LOG_ID, 'Instance IDs of created peers: ', createdInstanceIds);
    return createdInstanceIds;
}

async function waitForSSHConnection(host, port, user, attemptCooldownSecs, timeoutSecs, maxRetryCount) {
    let stop = false;
    const timeout = setTimeout(() => {
        stop = true;
    }, timeoutSecs * 1000);

    let retryCount = 0;
    while (!stop && retryCount <= maxRetryCount) {
        log.verbose(LOG_ID, `SSH waiter retry ${retryCount}`);
        if (await canMakeSSHConnectionTo(host, port, user)) {
            log.verbose(LOG_ID, `SSH waiter SUCCESS ${retryCount}`);
            clearTimeout(timeout);
            return;
        }
        // sleep
        await new Promise((resolve) => { setTimeout(resolve, attemptCooldownSecs * 1000); });
        retryCount += 1;
    }
    throw new Error(`SSH connection to ${host} could not be estabilished after the specified retries (${maxRetryCount}, cooldown ${attemptCooldownSecs})`);
}

function getInstanceSetupCommands(subnetMask) {
    return [
        'sudo dnf install -y dnf-utils zip unzip curl git',
        'sudo dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo',
        'sudo dnf install -y docker-ce',
        'sudo systemctl stop firewalld && sudo systemctl disable firewalld',
        'sudo yum install -y iptables-services && sudo systemctl enable iptables && sudo systemctl start iptables',
        'sudo systemctl enable docker.service && sudo systemctl start docker.service && sudo docker info', // sets up docker iptables configuration
        'sudo curl -L https://github.com/docker/compose/releases/download/v2.12.2/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose',
        'sudo chmod +x /usr/local/bin/docker-compose',
        '/usr/local/bin/docker-compose  --version',
    ];
}

function getRJRInstallationCommands(masterInstancePrivateIp, instancePrivateIp, subnetMask) {
    const commands = getInstanceSetupCommands(subnetMask);
    commands.push(...getRJRSetupCommands(masterInstancePrivateIp, instancePrivateIp));
    return commands;
}

function getRPSInstallationCommands(peerIps, masterInstancePrivateIp, masterInstancePublicIp, subnetMask, execId) {
    const caCert = certs.getRemoteCACert();
    const { cert, key } = certs.getExecutorCertKey(execId);

    return [...getRPSSetupCommands(peerIps, masterInstancePrivateIp, masterInstancePublicIp, subnetMask, caCert, cert, key)];
}

async function runCommandsOnPeers(instanceIds, executorId, commandGenerator) {
    const user = 'opc';
    const installationPromises = instanceIds.map(async (id) => {
        const vnic = await getInstanceVnic(id);
        await waitForSSHConnection(vnic.publicIp, INSTANCE_SSH_PORT, user, 10, config.oci.instanceWaitSecs, 30);
        const commands = commandGenerator(vnic.privateIp);
        for (const command of commands) {
            log.verbose(LOG_ID, `executing: ${command}`);
            let firstError = null;
            const maxRetryCount = 3;
            let retryNum = 0;
            while (retryNum <= maxRetryCount) {
                if (retryNum > 0) {
                    log.verbose(LOG_ID, `Retrying the command ${command}`);
                }
                try {
                    await sshWrapper({ host: vnic.publicIp, port: INSTANCE_SSH_PORT, username: user }, async (connection) => {
                        await connection.execute(command);
                    });
                    // command executed successfully => reset the error
                    firstError = null;
                    break;
                } catch (err) {
                    if (!firstError) {
                        firstError = err;
                    }
                    retryNum += 1;
                    log.error(LOG_ID, err);
                }
            }
            if (firstError) {
                throw firstError;
            }
        }
    });
    await Promise.all(installationPromises);
}

function convertParams(params) {
    const retval = {
        ...params,
    };
    for (const paramName of ['size', 'shapeConfigCPU', 'shapeConfigRAM']) {
        retval[paramName] = Number(params[paramName]);
        if (retval.size <= 0 || Number.isNaN(retval.size)) {
            throw new Error(`Pool parameter ${paramName} is of invalid value. (${retval})`);
        }
    }
    return retval;
}

// OCI Homogenous pool:
/**
 * @callback certificateGenerator
 * @param {string} ip - the IP address associated with the pool master
 * @returns {Promise<void>}
 */

/**
 * @param { certificateGenerator } certificateGeneratorFunction
 * @returns {Promise<void>}
 */
async function createOCIBasicPool(executorId, params, certificateGeneratorFunction) {
    const state = {
        subnetId: null,
        subnetMask: null,
        masterInstanceId: null,
        masterInstanceIp: null,
        masterInstanceSubnetIp: null,
        poolInstanceIds: [],
    };
    params = convertParams(params);
    try {
        // ensures networking is set up
        await getVcn();
        const executorGlobalState = await getGlobalStateForOCIExecType(knex);
        if (executorGlobalState === null) {
            log.error(LOG_ID, 'OCI Global state is busy, please try again later');
            throw new Error('OCI Global state is busy, please try again later. Check out the OCI global state log.');
        }

        const {
            subnetMask,
        } = await createNewPoolParameters();
        state.subnetMask = subnetMask;
        state.subnetId = await createSubnet(executorId, subnetMask, executorGlobalState.vcn, executorGlobalState.securityList);

        state.poolInstanceIds = await createPoolPeers(params.size, executorId, state.subnetId, params);

        if (!(state.poolInstanceIds instanceof Array) || state.poolInstanceIds.length <= 0) {
            log.error(LOG_ID, 'Pool instance creation unexpectedly returned ', state.poolInstanceIds);
            throw new Error('No pool peers have been created! Cannot select Master Peer.');
        }
        state.masterInstanceId = state.poolInstanceIds[0];
        log.info(LOG_ID, `Master Peer Selected: ${state.masterInstanceId}`);
        const vnic = await getInstanceVnic(state.masterInstanceId);
        state.masterInstanceIp = vnic.publicIp;
        state.masterInstanceSubnetIp = vnic.privateIp;
        log.info(LOG_ID, 'Master Instance IPs', {
            public: state.masterInstanceIp,
            private: state.masterInstanceSubnetIp,
        });

        log.info(LOG_ID, 'Installing required software on pool peers');
        await runCommandsOnPeers(state.poolInstanceIds, executorId, (instanceIp) => getRJRInstallationCommands(state.masterInstanceSubnetIp, instanceIp, state.subnetMask));

        log.info(LOG_ID, 'Generating certificates for the master peer');
        await certificateGeneratorFunction(state.masterInstanceIp);
        const peerIPs = await (Promise.all(state.poolInstanceIds.map(async (id) => (await getInstanceVnic(id)).privateIp)));
        log.info(LOG_ID, 'Installing additional software on master peer');
        await runCommandsOnPeers([state.masterInstanceId], executorId, () => getRPSInstallationCommands(peerIPs, state.masterInstanceIp, state.masterInstanceSubnetIp, state.subnetMask, executorId));
    } catch (error) {
        log.error(LOG_ID, 'Failed to create OCI pool, partial executor state which will be saved:', state);
        await saveState(executorId, state);
        throw error;
    }
    await saveState(executorId, state);
}
const EXEC_TABLE = 'job_executors';
async function saveState(execId, stateToSave) {
    await knex(EXEC_TABLE).update({ state: JSON.stringify(stateToSave) }).where('id', execId);
}

async function shutdownSubnet(subnetId) {
    log.verbose(LOG_ID, 'Removing subnet with id', subnetId);
    const terminationRequest = {
        subnetId: subnetId
    };

    await virtualNetworkClient.deleteSubnet(terminationRequest);

    log.verbose(LOG_ID, 'Removed subnet with id', subnetId);
}

async function getInstanceShutdownPromise(instanceId) {
    log.verbose(LOG_ID, 'Shutting down instance with id', instanceId);
    const terminationRequest = {
        instanceId: instanceId,
        preserveBootVolume: false
    };
    await computeClient.terminateInstance(terminationRequest);

    await computeWaiter.forInstance(
        {
            instanceId: instanceId
        },
        core.models.Instance.LifecycleState.Terminated
    );
    log.verbose(LOG_ID, 'Shut down instance with id', instanceId);
}

async function shutdownInstances(instanceIds) {
    const promises = instanceIds.map((id) => getInstanceShutdownPromise(id).then(() => { return { ok: 'ok' } }).catch(err => { return { error: err, id: id } }));
    const completedShutdownAttempts = await Promise.all(promises);
    const errors = completedShutdownAttempts.filter(attempt => attempt.error).map(attempt => attempt.error);
    if (errors.length > 0) {
        const message = 'Some instances could not be shutdown with the following errors: '
            + errors.map(({ error, id }, index) => `Error ${index}, instance ID affected: ${id}\n` + error.toString())
                .concat('\n');
        throw new Error(message);
    }
}

/**
 * Performs shutdown steps, propagates errors only when allowStepFailure is false. 
 * @param {any} executor 
 * @param {Boolean} allowStepFailure 
 */
async function generalShutdownFromState(executor, allowStepFailure = false) {
    const state = executor.state;
    if (!state) {
        throw new Error(`Could not get executor state (id: ${executor.id}`);
    }
    let instancesTerminated = true;
    if (state.poolInstanceIds) {
        try {
            await shutdownInstances(state.poolInstanceIds);
            // a delete-and-save pattern on successful execution of a shutdown step
            // such as here allows to register those successful parts and not try to
            // repeat them in future executions
            delete state.poolInstanceIds;
            await saveState(executor.id, state);
        } catch (err) {
            instancesTerminated = false;
            if (!allowStepFailure) {
                throw err;
            }
        }
    } else if (!allowStepFailure) {
        throw new Error('Unexpected state format, missing pool instance IDs');
    } else {
        instancesTerminated = false;
    }
    // if instances not terminated, then subnet cannot be removed
    let subnetTerminated = instancesTerminated;
    // additionally, if state.subnetId is not present, there is no safe reason to deallocate the subnet mask later
    if (instancesTerminated && state.subnetId) {
        try {
            await shutdownSubnet(state.subnetId);
            delete state.subnetId;
            await saveState(executor.id, state);
        } catch (err) {
            subnetTerminated = false;
            if (!allowStepFailure) {
                throw err;
            }
        }
    } else if (!allowStepFailure) {
        if (!instancesTerminated) {
            throw new Error('Pool instances have not terminated as expected');
        } else {
            throw new Error('Unexpected state format, missing subnet IDs');
        }
    } else {
        subnetTerminated = false;
    }
    // allows the removal from global state in case force remove is perfomed
    if ((allowStepFailure) || (subnetTerminated && state.subnetMask)) {
        await registerPoolRemoval({ subnetMask: state.subnetMask });
        delete state.subnetMask;
        await saveState(executor.id, state);
    } else if (!allowStepFailure) {
        if (!subnetTerminated) {
            throw new Error('Subnet was not terminated as expected');
        } else {
            throw new Error('Unexpected state format, missing subnet mask');
        }
    }
}

async function shutdownPool(executor) {
    await generalShutdownFromState(executor, false);
}

async function killPoolForced(executor) {
    await generalShutdownFromState(executor, true);
}

module.exports = { createOCIBasicPool, shutdownPool, killPoolForced };
