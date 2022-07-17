'use strict';

const {getRemoteHandler} = require('../../lib/remote-executor-comms');

async function handleRun(executionMachine, runId, jobId, spec) {
    const handler = getRemoteHandler(executionMachine.type);
    if (!handler) {
        // TODO log
        throw new Error(`handler for remote machine of type ${executionMachine.type} not found`);
    }
    await handler.run(executionMachine, runId, jobId, spec);
}

async function handleStop(executionMachine, runId) {
    const handler = getRemoteHandler(executionMachine.type);
    if (!handler) {
        // TODO log
        throw new Error(`handler for remote machine of type ${executionMachine.type} not found`);
    }

    await handler.stop(executionMachine, runId);
}

module.exports = {
    handleRun, handleStop
}