const router = require('../../lib/router-async').create();
const { emitter } = require('../../lib/task-events');
const { RequestType, RemoteRunState } = require('../../../shared/remote-run');
const { esConstants, scheduleRemoteRunFinished } = require('../../lib/task-handler');
const knex = require('../../lib/knex');
const { RunStatus } = require('../../../shared/jobs');
const log = require('../../lib/log');
const remoteComms = require('../../lib/remote-executor-comms');
const jobs = require('../../models/jobs');
const { EventTypes, getRunIdFromEventType } = require('../../lib/task-events');
const contextHelpers = require('../../lib/context-helpers');
const jobRequests = require('../../lib/job-requests');

const LOG_ID = 'remote-push';

function hasOwnProperties(obj, props) {
    return props.reduce((prev, prop) => prev && Object.prototype.hasOwnProperty.call(obj, prop), true);
}

function translateRemoteState(remoteState) {
    const stateMap = {
        [RemoteRunState.SUCCESS]: RunStatus.SUCCESS,
        [RemoteRunState.RUN_FAIL]: RunStatus.FAILED,
        [RemoteRunState.RUNNING]: RunStatus.RUNNING,
        [RemoteRunState.QUEUED]: RunStatus.SCHEDULED,
    };
    return stateMap[remoteState] !== undefined ? stateMap[remoteState] : null;
}

function getStatePriority(state) {
    const prioMap = {
        [RunStatus.SUCCESS]: 10000,
        [RunStatus.FAILED]: 10000,
        [RunStatus.RUNNING]: 0,
        [RunStatus.SCHEDULED]: -1000,
        [RunStatus.INITIALIZATION]: -2000,
    };
    return prioMap[state];
}

function selectStateToWrite(dbState, incomingState) {
    if (incomingState === null) {
        return dbState;
    }

    const dbPrio = getStatePriority(dbState);
    const incPrio = getStatePriority(incomingState);
    if (incPrio > dbPrio) {
        return incomingState;
    }
    if (dbPrio > incPrio) {
        return dbState;
    }
    if (dbState !== incomingState) {
        return null;
    }
    return dbState;
}

const certCheckErrNo = {
    HEADER_NOT_FOUND: 'HEADER_NOT_FOUND',
    INVALID_FORMAT: 'INVALID_FORMAT',
};

/**
 * @param {object} request
 * @returns {BigInt | string } serial number of the certificate or an error
 */
function extractCertSerial(request) {
    const serialNumRegex = /{ serialNumber (?<serialNumber>[0-9]+),/g;
    const match = serialNumRegex.exec(request.headers['x-ivis-cert-serial']);

    if (match === null) {
        return certCheckErrNo.HEADER_NOT_FOUND;
    }

    const { serialNumber } = match.groups;
    let certSerial = null;
    try {
        certSerial = BigInt(serialNumber);
    } catch (e) {
        log.error(LOG_ID, e.toString());
        return certCheckErrNo.INVALID_FORMAT;
    }

    if (certSerial === null) {
        return certCheckErrNo.INVALID_FORMAT;
    }

    return certSerial;
}

// helper function to tie presence checking and the HTTP response
function certSerialPresenceCheck(req, res) {
    const extractedSerial = extractCertSerial(req);
    if (extractedSerial === certCheckErrNo.HEADER_NOT_FOUND) {
        res.status(400);
        res.json({});
        log.verbose('Invalid request with no certificate serial header');
        return false;
    }
    if (extractedSerial === certCheckErrNo.INVALID_FORMAT) {
        res.status(400);
        res.json({});
        log.verbose('Invalid certificate serial header value format');
        return false;
    }

    return extractedSerial;
}

router.postAsync('/remote/status', async (req, res) => {
    // request checking ...
    const certSerial = certSerialPresenceCheck(req, res);
    if (!certSerial) {
        return;
    }

    // output can be undefined
    if (!hasOwnProperties(req.body, ['runId', 'status'])) {
        res.status(400);
        log.info(LOG_ID, 'status request is invalid: ', req.body);
        res.json({});
        return;
    }

    const {
        runId, status, output,
    } = req.body;
    const incomingStatus = translateRemoteState(status.status);
    if (incomingStatus === null) {
        res.status(400);
        log.error(LOG_ID, `invalid status ${status.status} received`);
        res.json({});
        return;
    }

    const executor = await jobs.getRunExecutor(runId);
    if (!executor) {
        res.status(403);
        log.info(LOG_ID, `Unknown job/run with runId ${runId}`);
        res.json({});
        return;
    }
    if (executor.cert_serial !== certSerial.toString()) {
        res.status(403);
        log.info(LOG_ID, `Executor with certificate serial number ${certSerial.toString()} has attempted to manipulate status of a run managed by a different executor (id: ${executor.id}, certificate number: ${executor.cert_serial})`);
        res.json({});
        return;
    }

    // request execution
    const outputToAppend = output || '';
    const finishedTimestamp = status.finished_at || null;
    let responseStatus = 200;
    let stateWritten = null;
    let jobId;
    // get admin context because there is none
    // and access to rest/remote should be protected by client certificates
    await knex.transaction(async (t) => {
        try {
            const run = await t('job_runs').where('id', runId).first();
            if (!run) {
                responseStatus = 404;
                return;
            }

            jobId = run.job;
            const stateToWrite = selectStateToWrite(run.status, incomingStatus);
            if (stateToWrite === null) {
                responseStatus = 500;
                log.error(LOG_ID, `Status clash detected: db: ${run.status} vs incoming ${incomingStatus}`);
                return;
            }
            stateWritten = stateToWrite === incomingStatus ? incomingStatus : null;

            const diffObj = {
                status: stateToWrite,
                output: run.output || '',
            };

            if (finishedTimestamp !== null) {
                diffObj.finished_at = new Date(finishedTimestamp);
            }
            if (outputToAppend !== '') {
                diffObj.output += `\n${outputToAppend}`;
            }

            await t('job_runs').update(diffObj).where('id', runId);
        } catch (error) {
            log.error(LOG_ID, `error when updating run from remote status push: ${error}`);
            // 1 read & 1 write -> no need for rollback
            // if read fails, write won't happen, if write fails, it should not write into db and the previous read is irrelevant
        }
    });

    res.status(responseStatus);
    if (responseStatus === 200 && (stateWritten === RunStatus.SUCCESS || stateWritten === RunStatus.FAILED)) {
        scheduleRemoteRunFinished(runId, jobId);
        // the following code IS NOT in a catch block!
        // the reason this is not in a catch block is to allow the remote executor to
        // detect this error and retry the request which should be ok in terms of db:
        //  - state priority is equal -> nothing changes
        //  - output is not being appended -> nothing changes
        //  - remote run end event can also be repeated
        if (executor) {
            await remoteComms.getRemoteHandler(executor.type).removeRun(executor, runId);
        } else {
            log.error(LOG_ID, `Executor for run ${runId} not found`);
        }
    }
    res.json({});
});

async function emitExecutorCheck(type, data, certSerial, res) {
    let executor = null;
    if (type === EventTypes.ACCESS_TOKEN_REFRESH) {
        const { jobId } = data;
        executor = await jobs.getJobExecutor(contextHelpers.getAdminContext(), jobId);
    } else {
        const runId = getRunIdFromEventType(type);
        executor = await jobs.getRunExecutor(runId);
    }

    if (!executor) {
        res.status(400);
        log.info(LOG_ID, `Executor with certificate serial number ${certSerial.toString()} does not exist`);
        res.json({});
        return false;
    }

    if (executor.cert_serial !== certSerial.toString()) {
        res.status(403);
        log.info(LOG_ID, `Executor with certificate serial number ${certSerial.toString()} has attempted to emit an event on behalf of a run managed by a different executor (id: ${executor.id}, certificate number: ${executor.cert_serial})`);
        res.json({});
        return false;
    }

    return true;
}

router.postAsync('/remote/emit', async (req, res) => {
    const certSerial = certSerialPresenceCheck(req, res);
    if (!certSerial) {
        return;
    }
    // data can be undefined (success)
    if (!hasOwnProperties(req.body, ['type'])) {
        res.status(400);
        log.info(LOG_ID, 'emit request is missing type: ', req.body);
        res.json({});
        return;
    }

    const { type, data } = req.body;
    if (!await emitExecutorCheck(type, data, certSerial, res)) {
        return;
    }

    emitter.emit(type, data);

    res.json({});
});

router.postAsync('/remote/runRequest', async (req, res) => {
    const certSerial = certSerialPresenceCheck(req, res);
    if (!certSerial) {
        return;
    }

    if (!hasOwnProperties(req.body, ['type', 'payload']) || req.body.payload.jobId === undefined) {
        res.status(400);
        log.info(LOG_ID, 'Invalid request body (missing type, payload or payload.jobId): ', req.body);
        res.json({});
        return;
    }

    const { type, payload } = req.body;

    // payload.jobId must always be present, see storeState and createRequest
    const executor = await jobs.getJobExecutor(contextHelpers.getAdminContext(), payload.jobId);
    if (!executor) {
        res.status(400);
        log.info(LOG_ID, `Executor with certificate serial number ${certSerial.toString()} does not exist`);
        res.json({});
        return;
    }

    if (executor.cert_serial !== certSerial.toString()) {
        res.status(403);
        log.info(LOG_ID, `Executor with certificate serial number ${certSerial.toString()} has attempted to create a request on behalf of a run managed by a different executor (id: ${executor.id}, certificate number: ${executor.cert_serial})`);
        res.json({});
        return;
    }

    let response = null;

    switch (type) {
    case RequestType.STORE_STATE:
        response = await setStatusByResponse(async () => storeState(payload), res);
        break;
    case RequestType.CREATE_SIG:
        response = await setStatusByResponse(async () => createRequest(payload), res);
        break;
    default:
        log.error(LOG_ID, 'unknown request type');
        res.status(400);
        res.json({});
        return;
    }
    res.json(response);
});

async function setStatusByResponse(requestHandler, res) {
    const response = await requestHandler();
    if (response.errStatus) {
        res.status(response.errStatus);
    } else {
        res.status(200);
    }
    return response;
}

function createMisssingList(flags, values, sep) {
    return flags.map((x, idx) => (x ? '' : values[idx])).filter((x) => x !== '').join(sep);
}

async function storeState(payload) {
    const statePresent = payload.request[esConstants.STATE_FIELD];
    const jobIdPresent = payload.jobId;

    if (!statePresent || !jobIdPresent) {
        const nspecFields = jobRequests.createMisssingList([jobIdPresent, statePresent], ['jobId', `${esConstants.STATE_FIELD}`]);
        return { error: `${nspecFields} not specified`, errStatus: 400 };
    }

    const stateStoreErr = await jobRequests.storeRunState(payload.jobId, payload.request[esConstants.STATE_FIELD]);
    if (stateStoreErr && stateStoreErr.error) {
        return {
            ...stateStoreErr,
            errStatus: 500,
        };
    }
    return {};
}

async function createRequest(payload) {
    const jobIdPresent = payload.jobId;
    const setsPresent = payload.signalSets;

    if (!jobIdPresent || !setsPresent) {
        const nspecFields = createMisssingList([jobIdPresent, setsPresent], ['jobId', 'signalSets']);
        return { error: `${nspecFields} not specified`, errStatus: 400 };
    }
    const createResult = jobRequests.processCreateRequest(payload.jobId, payload.signalSets, payload.signalsSpec);
    if (createResult && createResult.error) {
        return {
            ...createResult,
            errStatus: 500,
        };
    }
    return createResult;
}

module.exports = router;
