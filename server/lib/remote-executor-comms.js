'use strict';

const axios = require('axios');
const https = require('https');
const knex = require('./knex');
const { MachineTypes } = require('../../shared/remote-run');
const remoteCerts = require('./remote-certificates');
const archiver = require('../lib/task-archiver');
const { RPS_PUBLIC_PORT } = require('./pools/oci/basic/rjr-setup');

const httpsAgent = new https.Agent({
    ca: remoteCerts.getRemoteCACert(),
    cert: remoteCerts.getIVISRemoteCert(),
    key: remoteCerts.getIVISRemoteKey(),
});

const httpsClient = axios.create({ httpsAgent });
const commsTimeoutMs = 2000;

const remoteExecutorHandlers = {
    [MachineTypes.REMOTE_RUNNER_AGENT]: {
        run: handleRJRRun,
        stop: handleRJRStop,
        getStatus: handleRJRStatus,
        removeRun: handleRJRRemove,
    },
    [MachineTypes.OCI_BASIC]: {
        run: handleRJRRun,
        stop: handleRJRStop,
        getStatus: handleRJRStatus,
        removeRun: handleRJRRemove,
    },
    [MachineTypes.REMOTE_POOL]: {
        run: handleRJRRun,
        stop: handleRJRStop,
        getStatus: handleRJRStatus,
        removeRun: handleRJRRemove,
    }
}
Object.freeze(remoteExecutorHandlers);

function isMachineRPSBased(executionMachine) {
    return executionMachine.type === MachineTypes.REMOTE_POOL || executionMachine.type === MachineTypes.OCI_BASIC;
}

function getExecutorCommsPort(executor) {
    if (executor.type === MachineTypes.OCI_BASIC) {
        return RPS_PUBLIC_PORT;
    }
    else {
        return executor.parameters.port;
    }
}

function getExecutorCommsHostOrIP(executor) {
    if (executor.type === MachineTypes.OCI_BASIC) {
        return executor.state.masterInstanceIp;
    } else {
        return executionMachine.parameters.hostname || executionMachine.parameters.ip_address;
    }
}

function getMachineURLBase(executionMachine) {
    // RJR-type specific, we are sure the parameters contain at least the IP
    const port = getExecutorCommsPort(executionMachine);
    const path = isMachineRPSBased(executionMachine) ? '/rps' : '';
    const host = getExecutorCommsHostOrIP(executionMachine);
    return `https://${host}:${port}${path}`;
}

async function handleRJRRun(executionMachine, runId, jobId, spec) {
    const taskId = (await knex('jobs').where('id', jobId).first()).task;
    const task = await knex('tasks').where('id', taskId).first();
    const runRequest = {
        params: spec.params || {},
        entities: spec.entities,
        owned: spec.owned,
        type: task.type,
        subtype: JSON.parse(task.settings).subtype,
        codeArchive: (await archiver.getTaskArchive(taskId)).toJSON(),
        accessToken: spec.accessToken,
        state: spec.state,
        jobId: jobId,
        runId: runId,
        taskId: task.id
    };

    await httpsClient.post(`${getMachineURLBase(executionMachine)}/run/${runId}`, runRequest, { timeout: commsTimeoutMs });
}

async function handleRJRStop(executionMachine, runId) {
    await httpsClient.post(`${getMachineURLBase(executionMachine)}/run/${runId}/stop`, { timeout: commsTimeoutMs });
}

async function handleRJRRemove(executionMachine, runId) {
    await httpsClient.delete(`${getMachineURLBase(executionMachine)}/run/${runId}`, { timeout: commsTimeoutMs });
}

async function handleRJRStatus(executionMachine, runId) {
    return await httpsClient.get(`${getMachineURLBase(executionMachine)}/run/${runId}`, { timeout: commsTimeoutMs }).then(resp => resp.data);
}

/**
 * 
 * @param {string} machineType 
 * @returns {{run: function, stop: function, getStatus: function, removeRun: function}}
 */
function getRemoteHandler(machineType) {
    return remoteExecutorHandlers[machineType];
}

module.exports.getRemoteHandler = getRemoteHandler;