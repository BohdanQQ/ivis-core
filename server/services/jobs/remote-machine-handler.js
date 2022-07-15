'use strict';

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const knex = require('../../lib/knex');
const { getTaskDevelopmentDir } = require('../../lib/task-handler'); 
const { PYTHON_JOB_FILE_NAME } = require('../../../shared/tasks');
const { MachineTypes } = require('../../../shared/remote-run');
const remoteCerts = require('../../lib/remote-certificates');

const httpsAgent = new https.Agent({
    ca: remoteCerts.getRemoteCACert(),
    cert: remoteCerts.getIVISRemoteCert(),
    key: remoteCerts.getIVISRemoteKey(),
  });

const httpsClient = axios.create({ httpsAgent });

const remoteExecutorHandlers = {
    [MachineTypes.REMOTE_RUNNER_AGENT]: {
        run: handleRJRRun,
        stop: handleRJRStop
    }
}
Object.freeze(remoteExecutorHandlers);

// TODO: support for insecure (HTTP) communication
// for now, assuming HTTPS...


async function handleRun(executionMachine, runId, jobId, spec) {
    await remoteExecutorHandlers[executionMachine.type].run(executionMachine, runId, jobId, spec);
}

async function handleStop(executionMachine, runId) {
    await remoteExecutorHandlers[executionMachine.type].stop(executionMachine, runId);
}

function getMachineURLBase(executionMachine) {
    const port = executionMachine.parameters.port;
    return `https://${executionMachine.hostname || executionMachine.ip_address}:${port}`;
}
async function handleRJRRun(executionMachine, runId, jobId, spec) {
    const task = await knex('tasks').where('id', (await knex('jobs').where('id', jobId).first()).task).first();
    const runRequest = {
        params: spec.params || {},
        entities: spec.entities,
        owned: spec.owned,
        type: task.type,
        subtype: JSON.parse(task.settings).subtype,
        code: fs.readFileSync(path.join(getTaskDevelopmentDir(task.id), PYTHON_JOB_FILE_NAME)).toString(),
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

module.exports = {
    handleRun, handleStop
}