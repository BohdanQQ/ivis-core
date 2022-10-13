'use strict';
const { getSignalEntitySpec, allowedKeysCreate: allowedSignalKeysCreate } = require('./signal-helpers')
const { esConstants } = require('./task-handler');
const knex = require('./knex');
const { getIndexName } = require('./indexers/elasticsearch-common');
const { filterObject } = require('./helpers');
const { SignalSetType } = require('../../shared/signal-sets');
const { getSignalSetEntitySpec, allowedKeysCreate: allowedSignalSetKeysCreate } = require('./signal-set-helpers')
const createSigSet = require('../models/signal-sets').createTx;
const createSignal = require('../models/signals').createTx;
const { getAdminContext } = require('./context-helpers');
const { SignalSource } = require('../../shared/signals');
const log = require("./log");
const es = require('./elasticsearch');

const LOG_ID = 'job-requests'

/**
 * Store config from job, overwrites old config
 * @param id ID of the job config belongs to
 * @param state Config to store, JSON format
 * @returns {Promise<void>}
 */
async function storeRunState(id, state) {
    const jobBody = {};
    jobBody[esConstants.STATE_FIELD] = state;
    try {
        await es.index({ index: esConstants.INDEX_JOBS, type: esConstants.TYPE_JOBS, id: id, body: jobBody });
    } catch (err) {
        log.error(LOG_ID, err);
        return { error: err.message };
    }
}


/**
 * Process request for signal set and signals creation
 * Signals are specified in sigSet.signals
 * Uses same data format as web creation
 * @param jobId
 * @param signalSets
 * @param signalsSpec
 * @returns {Promise<IndexInfo>} Created indices and mapping
 */
async function processCreateRequest(jobId, signalSets, signalsSpec) {
    const esInfo = {};


    try {
        await knex.transaction(async (tx) => {
            if (signalSets) {

                if (!Array.isArray(signalSets)) {
                    signalSets = [signalSets];
                }

                for (let signalSet of signalSets) {
                    esInfo[signalSet.cid] = await createSignalSetWithSignals(tx, signalSet);
                }
            }

            if (signalsSpec) {
                for (let [sigSetCid, signals] of Object.entries(signalsSpec)) {
                    const sigSet = await tx('signal_sets').where('cid', sigSetCid).first();
                    if (!sigSet) {
                        throw new Error(`Signal set with cid ${sigSetCid} not found`);
                    }

                    esInfo[sigSetCid] = esInfo[sigSetCid] || {};
                    esInfo[sigSetCid]['index'] = getIndexName(sigSet);
                    esInfo[sigSetCid]['signals'] = {};
                    const createdSignals = {};

                    if (!Array.isArray(signals)) {
                        signals = [signals];
                    }

                    for (let signal of signals) {
                        createdSignals[signal.cid] = await createComputedSignal(tx, sigSet.id, signal);
                    }

                    esInfo[sigSetCid]['signals'] = createdSignals;
                }
            }
        });
    } catch (error) {
        log.warn(LOG_ID, error);
        esInfo.error = error.message;
    }

    return esInfo;


    async function createSignalSetWithSignals(tx, signalSet) {
        let signals = signalSet.signals;
        const filteredSignalSet = filterObject(signalSet, allowedSignalSetKeysCreate);

        filteredSignalSet.type = SignalSetType.COMPUTED;

        filteredSignalSet.id = await createSigSet(tx, getAdminContext(), filteredSignalSet);
        const ceatedSignalSet = await tx('signal_sets').where('id', filteredSignalSet.id).first();
        const signalSetSpec = getSignalSetEntitySpec(ceatedSignalSet);

        const createdSignalsSpecs = {};
        if (signals) {
            if (!Array.isArray(signals)) {
                signals = [signals];
            }

            for (const signal of signals) {
                createdSignalsSpecs[signal.cid] = await createComputedSignal(tx, filteredSignalSet.id, signal);
            }
        }
        await tx('signal_sets_owners').insert({ job: jobId, set: filteredSignalSet.id });

        signalSetSpec['signals'] = createdSignalsSpecs;
        return signalSetSpec;
    }

    async function createComputedSignal(tx, signalSetId, signal) {
        const filteredSignal = filterObject(signal, allowedSignalKeysCreate);
        // Here are possible overwrites of input from job
        filteredSignal.source = SignalSource.JOB;
        const sigId = await createSignal(tx, getAdminContext(), signalSetId, filteredSignal);
        const createdSignal = await tx('signals').where('id', sigId).first();

        return getSignalEntitySpec(createdSignal);
    }
}

module.exports = {
    processCreateRequest,
    storeRunState
}