'use strict';

const axios = require('axios');
const https = require('https');
const knex = require('./knex');
const { MachineTypes, RemoteRunState } = require('../../shared/remote-run');
const remoteCerts = require('./remote-certificates');
const archiver = require('../lib/task-archiver');
const { RPS_PUBLIC_PORT } = require('./pools/oci/basic/rjr-setup');
const slurm = require('../lib/pools/slurm/slurm');
const { RunStatus } = require('../../shared/jobs');
const { EventTypes } = require('./task-events');

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
    },
    [MachineTypes.SLURM_POOL]: {
        run: handleSlurmRun,
        stop: handleSlurmStop,
        getStatus: handleSlurmStatus,
        removeRun: handleSlurmRemove,
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

async function handleSlurmRun(executionMachine, runId, jobId, spec) {
    const taskId = (await knex('jobs').where('id', jobId).first()).task;
    const task = await knex('tasks').where('id', taskId).first();
    const runRequest = {
        params: spec.params || {},
        entities: spec.entities,
        owned: spec.owned,
        accessToken: spec.accessToken,
        state: spec.state,
        jobId: jobId,
        runId: runId,
        taskId: task.id
    };
    console.log('run task settings', task.settings)
    await slurm.run(executionMachine, archiver.getTaskArchivePath(taskId), runRequest, task.type, JSON.parse(task.settings).subtype);
}

async function handleSlurmStop(executionMachine, runId, coreSystemEmission) {
    await slurm.stop(executionMachine, runId);
    stopRunLocally(runId, coreSystemEmission);
}

async function handleSlurmRemove(executionMachine, runId) {
    await slurm.removeRun(executionMachine, runId);
}

async function handleSlurmStatus(executionMachine, runId) {
    const state = await slurm.status(executionMachine, runId);
    return {
        status: state ? state : RemoteRunState.RUN_FAIL
    };
}

/**
 * If the remote executor is not able to report run stop back, use this function to
 * register necessary run stop events within the task handler process and format the run output 
 * to some expected format
 * @param {number} runId 
 * @param {function} coreSystemEmission 
 */
async function stopRunLocally(runId, coreSystemEmission) {
    const run = await knex('job_runs').where('id', runId).first();
    coreSystemEmission(EventTypes.REMOTE_STOP_FROM_LOCAL_SOURCE, {
        runId, 
        jobId: run.job
    });
    await knex('job_runs').where('id', runId).update({
        status: RunStatus.FAILED,
        finished_at: new Date()
    });
    await knex('job_runs').update({ output: knex.raw('CONCAT(\'INFO: Run Cancelled\n\nLog:\n\', `output`)') }).where('id', runId);

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