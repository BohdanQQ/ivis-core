const knex = require('../lib/knex');
const log = require('../lib/log');
const dtHelpers = require('../lib/dt-helpers');
const { enforceTypePermission } = require('./shares');
const ExecTypes = require('../../shared/remote-run').MachineTypes;

const LOG_ID = 'global-exec-type-state-commons';
const GLOBAL_EXEC_STATE_TABLE = 'global_executor_type_state';

function isValidType(type) {
    return Object.values(ExecTypes).includes(type);
}

function checkValidType(type) {
    if (!isValidType(type)) {
        log.error(LOG_ID, 'exectype', type, 'is invalid');
        throw new Error("Unknown executor type");
    }
}

/**
 * Atomically checks whether a state can be locked and locks the state if it is possible.
 * It is expected the state will be manually unlocked later with certainty
 * 
 * @param {string} type the executor type whose state to lock 
 * @param {object} [tx] transaction, can be left out
 * @returns true if state was successfully locked locked, false otherwise - already locked. On error, assume not locked
 */
async function atomicLockStateByType(type, tx) {
    checkValidType(type);

    const tryLockWithTx = async (transaction) => {
        const locked = (await transaction(GLOBAL_EXEC_STATE_TABLE).where('type', type).first()).locked;
        if (locked) {
            return false;
        }

        await transaction(GLOBAL_EXEC_STATE_TABLE).where('type', type).update('locked', true);
        return true;
    };

    if (tx === undefined || tx === null) {
        return await knex.transaction(async (tx1) => {
            return await tryLockWithTx(tx1);
        });
    }
    return await tryLockWithTx(tx);
}

/** Tries to lock a state with specified number of retry attempts 
 * @param {string} type the executor type whose state to lock 
 * @param {number} attempts number of attempts 
 * @param {number} msTimeout in milliseconds
 * @param {object} [tx] transaction, can be left out
 * @returns true if state was successfully locked locked, false otherwise - already locked. On error, assume not locked
*/
async function tryLock(type, attempts, msTimeout, tx) {
    let result = false;
    try {
        result = await atomicLockStateByType(type, tx);
        while (!result && attempts > 0.1) {
            await new Promise((resolve) => setTimeout(resolve, msTimeout));
            result = await atomicLockStateByType(type, tx);
            attempts = attempts - 1;
        }
    } catch (err) {
        log.error(LOG_ID, 'tryLock - lock attempt failed', err);
        return false;
    }
    return result;
}

async function unlockStateByType(type) {
    checkValidType(type);
    return await knex(GLOBAL_EXEC_STATE_TABLE).where('type', type).update('locked', false);
}

/** 
 * @param {string} type 
 * @param {object} [tx] 
 * @returns {string | null}
 */
async function getRawStateByType(type, tx) {
    checkValidType(type);
    if (tx === undefined || tx === null) {
        tx = knex;
    }
    const state = (await tx(GLOBAL_EXEC_STATE_TABLE).where('type', type).first()).state;
    return state ? state : null;
}

/** 
 * @param {string} contents
 * @param {string} type 
 */
async function appendToLogByType(contents, type) {
    checkValidType(type);
    await knex(GLOBAL_EXEC_STATE_TABLE)
        .where('type', type)
        .update({ log: knex.raw('CONCAT(COALESCE(`log`,\'\'), ?)', (contents + '\n')) });
}

/**
 * @param {string} type 
 * @param {string} state 
 * @param {object} [tx] 
 */
async function setRawStateByType(type, state, tx) {
    checkValidType(type);
    if (tx === undefined || tx === null) {
        tx = knex;
    }
    await tx(GLOBAL_EXEC_STATE_TABLE).where('type', type).update({
        state: state,
    });
}

/**
 * @param {string} type 
 * @param {object} [tx] 
 */
async function getExecCountByType(type, tx) {
    checkValidType(type);
    if (tx === undefined || tx === null) {
        tx = knex;
    }
    return (await tx('job_executors').select(knex.raw('count(*) as cnt')).where('type', type).first()).cnt;
}

function dbFieldName(name) {
    return `${GLOBAL_EXEC_STATE_TABLE}.${name}`;
}

const columns = [
    dbFieldName('type'), dbFieldName('locked'), dbFieldName('log'), 'namespaces.name',
];

function getQueryFun() {
    return (builder) => builder
        .from(GLOBAL_EXEC_STATE_TABLE)
        .innerJoin('namespaces', 'namespaces.id', dbFieldName('namespace'));
}

async function listTypesDTAjax(context, params) {
    return await dtHelpers.ajaxListWithPermissions(
        context,
        [{ entityTypeId: 'namespace', requiredOperations: ['manageGlobalExecState'] }],
        params,
        getQueryFun(),
        columns,
    );
}

// only call on IVIS restart
async function unlockAllTypes() {
    return Promise.all(Object.values(ExecTypes).map(t => unlockStateByType(t)));
}


async function getByType(context, type) {
    if (!isValidType(type)) {
        return null;
    }
    await enforceTypePermission(context, 'namespace', ['manageGlobalExecState']);

    return await knex(GLOBAL_EXEC_STATE_TABLE).select('log', 'type').where('type', type).first();
}


module.exports = {
    getRawStateByType,
    setRawStateByType,
    atomicLockStateByType,
    unlockStateByType,
    appendToLogByType,
    getExecCountByType,
    tryLock,
    listTypesDTAjax,
    unlockAllTypes,
    getByType
};
