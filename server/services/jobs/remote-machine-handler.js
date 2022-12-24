'use strict';

const { getRemoteHandler } = require('../../lib/remote-executor-comms');
const log = require('../../lib/log');
const LOG_ID = "remote-handler";

function getHandlerChecked(type) {
    const handler = getRemoteHandler(type);
    if (!handler) {
        const msg = `handler for remote machine of type ${type} not found`;
        log.error(LOG_ID, msg);
        throw new Error(msg);
    }
    return handler;
}

async function handleRun(executionMachine, runId, jobId, spec) {
    const handler = getHandlerChecked(executionMachine.type);
    await handler.run(executionMachine, runId, jobId, spec);
}

async function handleStop(executionMachine, runId, coreSystemEmission) {
    const handler = getHandlerChecked(executionMachine.type);
    await handler.stop(executionMachine, runId, coreSystemEmission);
}

module.exports = {
    handleRun, handleStop
}