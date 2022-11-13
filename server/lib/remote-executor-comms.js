'use strict';

const axios = require('axios');
const https = require('https');
const knex = require('./knex');
const { MachineTypes } = require('../../shared/remote-run');
const remoteCerts = require('./remote-certificates');
const archiver = require('../lib/task-archiver');

const httpsAgent = new https.Agent({
    ca: remoteCerts.getRemoteCACert(),
    cert: remoteCerts.getIVISRemoteCert(),
    key: remoteCerts.getIVISRemoteKey(),
});

const httpsClient = axios.create({ httpsAgent });

const remoteExecutorHandlers = {
    [MachineTypes.REMOTE_RUNNER_AGENT]: {
        run: handleRJRRun,
        stop: handleRJRStop,
        getStatus: handleRJRStatus,
        removeRun: handleRJRRemove,
    },
    [MachineTypes.OCI_BASIC]: {
        run: () => console.log("TODO run"),
        stop: () => console.log("TODO stop"),
        getStatus: () => console.log("TODO status"),
        removeRun: () => console.log("TODO remove"),
    }
}
Object.freeze(remoteExecutorHandlers);


function getMachineURLBase(executionMachine) {
    const port = executionMachine.parameters.port;
    return `https://${executionMachine.hostname || executionMachine.ip_address}:${port}`;
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

    await httpsClient.post(`${getMachineURLBase(executionMachine)}/run/${runId}`, runRequest);
}

async function handleRJRStop(executionMachine, runId) {
    await httpsClient.post(`${getMachineURLBase(executionMachine)}/run/${runId}/stop`);
}

async function handleRJRRemove(executionMachine, runId) {
    await httpsClient.delete(`${getMachineURLBase(executionMachine)}/run/${runId}`);
}

async function handleRJRStatus(executionMachine, runId) {
    return await httpsClient.get(`${getMachineURLBase(executionMachine)}/run/${runId}`).then(resp => resp.data);
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