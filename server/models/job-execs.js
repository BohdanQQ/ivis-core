'use strict';

const knex = require('../lib/knex');
const hasher = require('node-object-hash')();
const { enforce, filterObject } = require('../lib/helpers');
const dtHelpers = require('../lib/dt-helpers');
const interoperableErrors = require('../../shared/interoperable-errors');
const namespaceHelpers = require('../lib/namespace-helpers');
const shares = require('./shares');
const { MachineTypes, MachineTypeParams } = require('../../shared/remote-run');
const allowedKeys = new Set(['name', 'description', 'type', 'parameters', 'hostname', 'ip_address', 'namespace']);
const allowedKeysUpdate = new Set(['name', 'description', 'type', 'parameters', 'namespace']);
const remoteCert = require('../lib/remote-certificates');
const log = require('../lib/log');
const LOG_ID = 'job-execs';

const EXEC_TYPEID = 'jobExecutor';
const EXEC_TABLE = 'job_executors';
function dbFieldName(name) {
    return `${EXEC_TABLE}.${name}`;
} 

const columns = [
    dbFieldName('id'), dbFieldName('name'), dbFieldName('description'), dbFieldName('type'), 'namespaces.name',
];


function getQueryFun() {
    return builder => builder
        .from(EXEC_TABLE)
        .innerJoin('namespaces', 'namespaces.id', dbFieldName('namespace'))
}

async function listDTAjax(context, params) {
    return await dtHelpers.ajaxListWithPermissions(
        context,
        [{ entityTypeId: 'jobExecutor', requiredOperations: ['view'] }],
        params,
        getQueryFun(),
        columns
    );
}

/**
 * Creates a job executor.
 * @param context
 * @param executor the job executor data
 * @returns {Promise<number>} id of the created job
 */
async function create(context, executor) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'namespace', executor.namespace, 'createExec');
        await namespaceHelpers.validateEntity(tx, executor);

        const filteredEntity = filterObject(executor, allowedKeys);
        filteredEntity.parameters = JSON.stringify(filteredEntity.parameters);

        if(!Object.values(MachineTypes).includes(executor.type)) {
            throw new interoperableErrors.NotFoundError(`Type ${executor.type} not found`);
        }

        const ids = await tx(EXEC_TABLE).insert(filteredEntity);
        const id = ids[0];
        filteredEntity.id = id;

        // certs are created for every executor (except the local one)
        // can also be adjusted to create only for those types that need it
        // and created on executor type update

        try {
            await remoteCert.createRemoteExecutorCertificate(filteredEntity)
        }
        catch {
            remoteCert.tryRemoveCertificate(filteredEntity.id);
            throw new interoperableErrors.ServerValidationError("Error when creating certificates");
        }

        await shares.rebuildPermissionsTx(tx, { entityTypeId: EXEC_TYPEID, entityId: id });

        return id;
    });
}

function hash(entity) {
    return hasher.hash(filterObject(entity, allowedKeys));
}

/**
 * Return an executor with given id.
 * @param context the calling user's context
 * @param {number} id the primary key of the executor
 * @returns {Promise<Object>}
 */
async function getById(context, id, includePermissions = true) {
    return await knex.transaction(async tx => {
        const exec = await tx(EXEC_TABLE).where('id', id).first();
        await shares.enforceEntityPermissionTx(tx, context, EXEC_TYPEID, id, 'view');
        exec.parameters = JSON.parse(exec.parameters);
        if (includePermissions) {
            exec.permissions = await shares.getPermissionsTx(tx, context, EXEC_TYPEID, id);
        }
        exec.execParams = MachineTypeParams[exec.type];
        return exec;
    });
}

/**
 * Update an existing job executor.
 * @param context
 * @param executor the executor that will overwrite based on its id property
 * @returns {Promise<void>}
 */
async function updateWithConsistencyCheck(context, executor) {
    enforce(executor.id !== 1, 'Local executor cannot be changed');
    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, EXEC_TYPEID, executor.id, 'edit');

        const existing = await tx(EXEC_TABLE).where('id', executor.id).first();
        if (!existing) {
            throw new interoperableErrors.NotFoundError();
        }

        existing.parameters = JSON.parse(existing.parameters);
        const existingHash = hash(existing);
        if (existingHash !== executor.originalHash) {
            throw new interoperableErrors.ChangedError();
        }

        await namespaceHelpers.validateEntity(tx, executor);
        await namespaceHelpers.validateMove(context, executor, existing, EXEC_TYPEID, 'createExec', 'delete');


        const filteredEntity = filterObject(executor, allowedKeysUpdate);
        filteredEntity.parameters = JSON.stringify(filteredEntity.parameters);

        await tx(EXEC_TABLE).where('id', executor.id).update(filteredEntity);

        await shares.rebuildPermissionsTx(tx, { entityTypeId: EXEC_TYPEID, entityId: executor.id });
    });

}


/**
 * Remove job executor.
 * @param context
 * @param id the primary key of the executor
 * @returns {Promise<void>}
 */
async function remove(context, id) {
    enforce(id !== 1, 'Local executor cannot be deleted');
    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, EXEC_TYPEID, id, 'delete');

        // TODO: decide what to do here - maybe stop pending runs addressed to the remote executor? (remove from work queue) 
        // disable jobs?
        remoteCert.tryRemoveCertificate(id);
        await tx('jobs').where('executor_id', id).update({executor_id: 1});
        await tx(EXEC_TABLE).where('id', id).del();
    });
}

async function getAllCerts(context, id) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, EXEC_TYPEID, id, 'viewCerts');
        
        try {
            const {
                cert,
                key
            } = remoteCert.getExecutorCertKey(id);
            return {
                ca: remoteCert.getRemoteCACert(),
                cert,
                key
            }
        }
        catch (err) {
            log.verbose(LOG_ID, 'error when getting certs', err);
            // rethrow different exception to not leak certificate-key paths / possibly contents
            throw new interoperableErrors.NotFoundError("Certificates not found");
        }
    });
}


module.exports = {
    listDTAjax, hash, getById, create, updateWithConsistencyCheck, remove, getAllCerts
}