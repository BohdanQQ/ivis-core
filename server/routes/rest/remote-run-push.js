'use strict';
const router = require('../../lib/router-async').create();
const { emitter } = require('../../lib/task-events');
const { RequestType, RemoteRunState } = require('../../../shared/remote-run');
const { esConstants, scheduleRemoteRunFinished } = require('../../lib/task-handler');
const knex = require('../../lib/knex');
const { RunStatus } = require('../../../shared/jobs');
const log = require("../../lib/log");
const remoteComms = require('../../lib/remote-executor-comms');
const jobs = require('../../models/jobs');
const jobRequests = require('../../lib/job-requests');

const LOG_ID = 'remote-push'

function hasOwnProperties(obj, props) {
    return props.reduce((prev, prop) => prev && obj.hasOwnProperty(prop), true);
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
    } else if (dbPrio > incPrio) {
        return dbState;
    } else if (dbState !== incomingState) {
        return null;
    }
    return dbState;
}

router.postAsync('/remote/status', async (req, res) => {
    // errors and output can be undefined
    if (!hasOwnProperties(req.body, ['runId', 'status'])) {
        res.status(400);
        res.json({});
        return;
    }

    const { runId, status, output, errors } = req.body;
    const incomingStatus = translateRemoteState(status.status);
    if (incomingStatus === null) {
        res.status(400);
        log.error(LOG_ID, `invalid status ${status.status} received`);
        res.json({});
        return;
    }
    const outputToAppend = `${output || ''}${errors || ''}`;
    const finishedTimestamp = status.finished_at || null;
    const responseStatus = 200;
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
                output: run.output || ''
            };

            if (finishedTimestamp !== null) {
                diffObj.finished_at = new Date(finishedTimestamp);
            }
            if (outputToAppend !== '') {
                diffObj.output += '\n' + outputToAppend;
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
        const executor = await jobs.getRunExecutor(runId);
        if (executor) {
            await remoteComms.getRemoteHandler(executor.type).removeRun(executor, runId);
        }
        else {
            log.error(LOG_ID, `Executor for run ${runId} not found`);
        }
    }
    return res.json({});
});

router.postAsync('/remote/emit', async (req, res) => {
    // data can be undefined (success)
    if (!hasOwnProperties(req.body, ['type'])) {
        res.status(400);
        res.json({});
        return;
    }

    const { type, data } = req.body;
    emitter.emit(type, data);

    return res.json({});
});

router.postAsync('/remote/runRequest', async (req, res) => {

    if (!hasOwnProperties(req.body, ['type', 'payload'])) {
        res.status(400);
        res.json({});
        return;
    }

    const { type, payload } = req.body;
    let response = null;

    switch (type) {
        case RequestType.STORE_STATE:
            response = await setStatusByResponse(async () => await storeState(payload), res);
            break;
        case RequestType.CREATE_SIG:
            response = await setStatusByResponse(async () => await createRequest(payload), res);
            break;
    }
    return res.json(response);
});

async function setStatusByResponse(requestHandler, res) {
    const response = await requestHandler();
    if (response.errStatus) {
        res.status(response.errStatus);
    }
    else {
        res.status(200);
    }
    return response;
}

function createMisssingList(flags, values, sep) {
    return flags.map((x, idx) => x ? "" : values[idx]).filter((x) => x !== "").join(sep);
}

async function storeState(payload) {
    const statePresent = payload.request[esConstants.STATE_FIELD];
    const jobIdPresent = payload.jobId;

    if (statePresent && jobIdPresent) {
        const stateStoreErr = await jobRequests.storeRunState(payload.jobId, payload.request[esConstants.STATE_FIELD]);
        if (stateStoreErr) {
            return {
                ...stateStoreErr,
                errStatus: 500
            };
        }
        return {};
    } else {
        const nspecFields = jobRequests.createMisssingList([jobIdPresent, statePresent], ['jobId', `${esConstants.STATE_FIELD}`]);
        return { error: `${nspecFields} not specified`, errStatus: 400 };
    }
}

async function createRequest(payload) {
    const jobIdPresent = payload.jobId;
    const setsPresent = payload.signalSets;

    if (jobIdPresent && setsPresent) {
        const createResult = jobRequests.processCreateRequest(payload.jobId, payload.signalSets, payload.signalsSpec);
        if (createResult && createResult.error) {
            return {
                ...createResult,
                errStatus: 500
            };
        }
        return createResult;
    } else {
        const nspecFields = createMisssingList([jobIdPresent, setsPresent], ['jobId', `signalSets`]);
        return { error: `${nspecFields} not specified`, errStatus: 400 };
    }
}

module.exports = router;