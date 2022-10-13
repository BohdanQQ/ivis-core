'use strict';

const config = require('../../lib/config');
const knex = require('../../lib/knex');
const log = require('../../lib/log');
const { RunStatus, JobMsgType } = require('../../../shared/jobs');
const { processCreateRequest, storeRunState } = require('../../lib/job-requests');
const { getSuccessEventType, getOutputEventType, EventTypes } = require('../../lib/task-events');

const { STATE_FIELD } = require('../../lib/task-handler').esConstants
const LOG_ID = 'Task-handler';

function parseRequest(req) {
    return JSON.parse(req);
}

async function handleRequest(jobId, requestStr) {
    let response = {};

    if (!requestStr) {
        response.error = "Request not specified";
        return response;
    }

    let request = {};
    try {
        request = parseRequest(requestStr);

        if (request.id) {
            response.id = request.id;
        }

    } catch (err) {
        response.error = `Request parsing failed: ${err.message}`;
        return response;
    }

    if (!request.type) {
        response.error = "Type not specified";
        return response;
    }

    try {
        switch (request.type) {
            case JobMsgType.CREATE_SIGNALS:
                if (request.signalSets || request.signals) {
                    const reqResult = await processCreateRequest(jobId, request.signalSets, request.signals);
                    response = {
                        ...response,
                        ...reqResult
                    };
                } else {
                    response.error = `Either signalSets or signals have to be specified`;
                }
                break;
            case JobMsgType.STORE_STATE:
                if (request[STATE_FIELD]) {
                    const reqResult = await storeRunState(jobId, request[STATE_FIELD]);
                    response = {
                        ...response,
                        ...reqResult
                    };
                } else {
                    response.error(`${STATE_FIELD} not specified`)
                }
                break;
            default:
                response.error = `Type ${request.type} not recognized`;
                break;
        }
    } catch (error) {
        log.warn(LOG_ID, error);
        response.error = error.message;
    }
    return response;
}

function createRunManager(jobId, runId, runOptions) {
    const runData = {};
    runData.started_at = new Date();

    const maxOutput = config.tasks.maxRunOutputBytes || 1000000;
    let outputBytes = 0;
    let limitReached = false;
    let outputBuffer = [];
    let timer;
    let accessTokenRefreshTimer;
    let accessToken = runOptions.config.inputData.accessToken;

    if (accessToken) {
        refreshAccessToken().catch(
            e => log.error(e)
        );
    }

    return {
        onRunEvent,
        onRunSuccess,
        onRunFail: onRunFailFromRunningStatus
    }

    async function refreshAccessToken() {
        runOptions.emit(EventTypes.ACCESS_TOKEN_REFRESH, {
            runId,
            jobId,
            accessToken
        });
        accessTokenRefreshTimer = setTimeout(refreshAccessToken, 30 * 1000);
    }

    async function onRunFailFromRunningStatus(errMsg) {
        await cleanBuffer();
        clearTimeout(accessTokenRefreshTimer);
        await runOptions.onRunFail(jobId, runId, runData, errMsg);
    }

    /**
     * Callback for successful run.
     * @param config
     * @returns {Promise<void>}
     */
    async function onRunSuccess(config) {
        await cleanBuffer();
        clearTimeout(accessTokenRefreshTimer);

        runOptions.onRunSuccess();
        runData.finished_at = new Date();
        runData.status = RunStatus.SUCCESS;
        try {
            await knex('job_runs').where('id', runId).update(runData);
            if (config) {
                await storeRunState(config);
            }
        } catch (err) {
            log.error(LOG_ID, err);
        }
        runOptions.emit(getSuccessEventType(runId));
    }

    async function cleanBuffer() {
        try {
            if (outputBuffer.length > 0) {
                let output = [...outputBuffer];
                outputBuffer = [];
                runOptions.emit(getOutputEventType(runId), output);
                await knex('job_runs').update({ output: knex.raw('CONCAT(COALESCE(`output`,\'\'), ?)', output.join('')) }).where('id', runId);
            }
            timer = null;
        } catch (e) {
            log.error(LOG_ID, `Output handling for the run ${runId} failed`, e);
            outputBuffer = [];
            timer = null;
        }
    }

    async function onRunEvent(type, data) {
        switch (type) {
            case 'output':
                try {
                    if (!limitReached) {
                        let byteLength = Buffer.byteLength(data, 'utf8');
                        outputBytes += byteLength
                        if (outputBytes >= maxOutput) {
                            limitReached = true;
                            if (config.tasks.printLimitReachedMessage === true) {
                                try {
                                    await knex('job_runs').update({ output: knex.raw('CONCAT(`output`, \'INFO: max output storage capacity reached\')') }).where('id', runId);

                                    const maxMsg = 'INFO: max output capacity reached'
                                    if (!timer) {
                                        runOptions.emit(getOutputEventType(runId), maxMsg);
                                    } else {
                                        outputBuffer.push(maxMsg);
                                    }
                                } catch (e) {
                                    log.error(LOG_ID, `Output handling for the run ${runId} failed`, e);
                                }
                            }
                        } else {
                            outputBuffer.push(data);
                            // TODO Don't know how well this will scale
                            // --   it might be better to append to a file, but this will require further syncing
                            // --   as we need full output for task development in the UI, not only output after the register of listener
                            // --   therefore keeping it this way for now
                            if (!timer) {
                                timer = setTimeout(cleanBuffer, 1000);
                            }
                        }
                    }

                } catch (e) {
                    log.error(LOG_ID, `Output handling for the run ${runId} failed`, e);
                }
                break;
            case 'request':
                return await handleRequest(jobId, data);
            default:
                log.info(LOG_ID, `Job ${jobId} run ${runId}: unknown event ${type} `);
                break;
        }
    }
}

module.exports = {
    createRunManager
}