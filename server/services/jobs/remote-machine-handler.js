'use strict';

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const knex = require('../../lib/knex');
const { getTaskDevelopmentDir } = require('../../lib/task-handler'); 
const { PYTHON_JOB_FILE_NAME } = require('../../../shared/tasks');
  
const certPaths = {
    ca: '/opt/ca.cert.pem',
    cliCert: '/opt/server.cert.pem',
    cliKey: '/opt/server.key.insecure',
};

const httpsAgent = new https.Agent({
    ca: fs.readFileSync(certPaths.ca),
    cert: fs.readFileSync(certPaths.cliCert),
    key: fs.readFileSync(certPaths.cliKey),
  });

const httpsClient = axios.create({ httpsAgent });

// TODO: differentiate based on executionMachine.type
// for now, assuming type is remote job runner...

// TODO: support for insecure (HTTP) communication
// for now, assuming HTTPS...

function getMachineURLBase(executionMachine) {
    const port = JSON.parse(executionMachine.parameters).port;
    return `https://${executionMachine.hostname || executionMachine.ip_address}:${port}`;
}

async function handleRun(executionMachine, runId, jobId, spec) {

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

async function handleStop(executionMachine, runId) {
    await httpsClient.post(`${getMachineURLBase(executionMachine)}/run/${runId}/stop`);
}

module.exports = {
    handleRun, handleStop
}