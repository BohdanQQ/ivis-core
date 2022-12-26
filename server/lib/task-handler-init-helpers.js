'use strict';
const log = require('./log');
const esClient = require('./elasticsearch');
const { RunStatus } = require('../../shared/jobs');
const { getRunExecutor } = require('../models/jobs');
const remoteComms = require('./remote-executor-comms');
const { MachineTypes, RemoteRunState } = require('../../shared/remote-run');
const knex = require('./knex');
const taskHandler = require('./task-handler');

const LOG_ID = 'Task-handler-lib-helpers';
const INDEX_JOBS = 'jobs';
const TYPE_JOBS = '_doc';
const STATE_FIELD = 'state';

async function init() {
    // this is the original first part of taskHandler.init()
    // the following piece of code is dependant on  '../lib/remote-executor-comms'
    // but '../lib/remote-executor-comms' depend on './task-handler', thus creating
    // a circular dependency if this piece of code was inside './task-handler'
    // see taskHandler.init for the exact place where this code was extracted from
    log.info(LOG_ID, 'Spawning job handler process');
    await initIndices();

    try {
        await cleanRuns();
    } catch (err) {
        log.error(LOG_ID, err);
    }
    // the original first part of taskHandler.init() ENDS HERE

    await taskHandler.init();
}

/**
 * Create job index if it doesn't exists and set correct mapping for job config.
 * Mapping disables parsing for config field as job can include any json and it would clash with es types implementation
 * should two stored states differ
 */
async function initIndices() {
    let reachable = true;
    try {
        await esClient.ping();
    } catch (err) {
        log.error(LOG_ID, 'Creating index for job in elasticsearch failed, ES unreachable');
        reachable = false;
    }
    if (reachable) {
        const exists = await esClient.indices.exists({index: INDEX_JOBS});
        if (!exists) {
            let settings = {
                "mappings": {
                    [TYPE_JOBS]: {
                        "properties": {
                            [STATE_FIELD]: {
                                "type": "object",
                                "enabled": false
                            }
                        }
                    }
                }
            };
            // create index
            await esClient.indices.create({index: INDEX_JOBS, body: settings});
        }
    }
}

/**
 * Synchronizes local run state with remote run state. Removes remote run if needed.
 *
 * @param {object} state remote run state as received from the remote executor
 * @param {number} runId
 * @param {object} handler executor handler
 * @param {object} executor
 * @returns
 */
async function cleanUpdateRemoteRunFromStatus(state, runId, handler, executor) {
    if (state.status === RemoteRunState.SUCCESS || state.status === RemoteRunState.RUN_FAIL) {
        // status === success / fail -> overwrite entire run status + request run removal
        const outputToAppend = `${state.output || ''}${state.error || ''}`;
        const finishedTimestamp = state.finished_at || null;
        try {
            await knex.transaction(async (t) => {
                const run = await t('job_runs').where('id', runId).first();
                const diffObj = {
                    status: state.status === RemoteRunState.SUCCESS ? RunStatus.SUCCESS : RunStatus.FAILED,
                    output: run.output || ''
                };

                if (finishedTimestamp !== null) {
                    diffObj.finished_at = new Date(finishedTimestamp);
                }
                if (outputToAppend !== '') {
                    diffObj.output += '\n' + outputToAppend;
                }
                await t('job_runs').update(diffObj).where('id', runId);
            });
        } catch (error) {
            log.error(LOG_ID, `error when updating run on IVIS-core restart: ${error}`);
            return;
        }

        await handler.removeRun(executor, runId);
    }
    else if (state.status === RemoteRunState.QUEUED || state.status === RemoteRunState.RUNNING) {
        // status === running / scheduled -> only update status to received status
        try {
            await knex.transaction(async (t) => {
                const run = await t('job_runs').where('id', runId).first();
                // in db, the state should be queued or running
                // if running -> dont update
                // if scheduled -> update to running
                // else dont update ... run has finished in the meantime
                if (run.status === RunStatus.RUNNING) {
                    return;
                }
                else if (run.status === RunStatus.SCHEDULED) {
                    await t('job_runs').where('id', runId).update({ status: state.status });
                    return;
                }
            });
        } catch (error) {
            log.error(LOG_ID, `error when updating run on IVIS-core restart: ${error}`);
            return;
        }
    }
    else {
        throw new Error(`Invalid run status ${state.staus}`);
    }
}

/**
 * Prevents run DB table from being in inconsistent state on a new start.
 * @returns {Promise<void>}
 */
async function cleanRuns() {
    const runs = await knex('job_runs').whereIn('status', [RunStatus.INITIALIZATION, RunStatus.SCHEDULED, RunStatus.RUNNING]);
    if (runs) {
        for (const run of runs) {
            const remoteExec = await getRunExecutor(run.id);
            if (!remoteExec) {
                log.error(LOG_ID, `Failed to clear run with id ${run.id}: executor not found`);
                return
            }
            // uninitialized jobs can't have been run 
            if (run.status !== RunStatus.INITIALIZATION && remoteExec.type !== MachineTypes.LOCAL) {
                const handler = remoteComms.getRemoteHandler(remoteExec.type);
                // get remote run status 
                const status = await handler.getStatus(remoteExec, run.id)
                    .catch(err => {
                        if (err && err.response && err.response.status === 404) {
                            // remote run not found -> error
                            log.error(LOG_ID, `Invalid response from server - run not found - ${err}`);
                        } else {
                            log.error(LOG_ID, `response code - ${err}`);
                        }
                        return null;
                    });

                if (status !== null) {
                    await cleanUpdateRemoteRunFromStatus(status, run.id, handler, remoteExec);
                }
            }
            else {
                try {
                    await knex('job_runs').where('id', run.id).update({
                        status: RunStatus.FAILED,
                        output: 'Cancelled upon start'
                    })
                } catch (err) {
                    log.error(LOG_ID, `Failed to clear run with id ${run.id}: ${err.stack}`);
                }
            }
        }
    }
}

module.exports.init = init;
