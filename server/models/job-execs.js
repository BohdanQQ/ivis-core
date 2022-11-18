'use strict';

const knex = require('../lib/knex');
const hasher = require('node-object-hash')();
const { enforce, filterObject } = require('../lib/helpers');
const dtHelpers = require('../lib/dt-helpers');
const interoperableErrors = require('../../shared/interoperable-errors');
const namespaceHelpers = require('../lib/namespace-helpers');
const shares = require('./shares');
const { MachineTypes, MachineTypeParams, ExecutorStatus, ExecutorStateDefaults } = require('../../shared/remote-run');
const allowedKeys = new Set(['name', 'description', 'type', 'parameters', 'hostname', 'ip_address', 'namespace', 'status']);
const allowedKeysUpdate = new Set(['name', 'description', 'parameters', 'namespace']);
const remoteCert = require('../lib/remote-certificates');
const log = require('../lib/log');
const { getAdminContext } = require('../lib/context-helpers');
const LOG_ID = 'job-execs';
const {
    createNewPoolParameters,
    registerPoolRemoval
} = require('../lib/pools/oci/basic/global-state');

const EXEC_TYPEID = 'jobExecutor';
const EXEC_TABLE = 'job_executors';
function dbFieldName(name) {
    return `${EXEC_TABLE}.${name}`;
}

const columns = [
    dbFieldName('id'), dbFieldName('name'), dbFieldName('description'), dbFieldName('type'), 'namespaces.name', dbFieldName('status')
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
 * each call will be awaited => await only for reasonable time periods OR use the exexutor status to update the user 
 * the function is allowed and expected to throw exceptions if the executor is not ready when the function returns  
 */
const executorInitializer = {
    [MachineTypes.REMOTE_RUNNER_AGENT]: async (filteredEntity, tx) => { },
    [MachineTypes.OCI_BASIC]: async (filteredEntity, tx) => {
        const {
            subnetMask
        } = await createNewPoolParameters();
        await tx(EXEC_TABLE).update({ 'state': JSON.stringify({ subnetMask }) }).where('id', filteredEntity.id);
        // rough WIP outline
        // compartmentId, tenancyId
        // Global state:        vnic, subnet couners
        // Executor state:      vm names, subnet name, ip adds?
        // Executor parameters: vm count, tenancy, compartment, homogenous shape, [if shape flexible] shape config 
        // pregenerate vm names     (timestamp, displayName field)
        // pregenerate subnet name  (book-keeping the limits?)
        // pregenerate subnet values        ---- || -----
        // create master vm => init scheduler on vm
        // OCI: provision resource
        // SSH: provision pool sw 
        // create pool vms (parallel) => init RJE on vm
        // OCI: provision resource
        // SSH: provision pool sw 
        // check pool (send vm names/public/private IPs?)
        // impl: ping pool members on remote executor ports
        // set status READY
        // on excpetion set status false
    }
};

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

        if (!Object.values(MachineTypes).includes(executor.type)) {
            throw new interoperableErrors.NotFoundError(`Type ${executor.type} not found`);
        }

        const ids = await tx(EXEC_TABLE).insert(filteredEntity);
        const id = ids[0];
        filteredEntity.id = id;
        filteredEntity.status = ExecutorStatus.PROVISIONING;
        filteredEntity.state = JSON.stringify(ExecutorStateDefaults[executor.type]);

        // certs are created for every executor (except the local one)
        // can also be adjusted to create only for those types that need it
        // and created on executor type update

        try {
            const certHexSerial = await remoteCert.createRemoteExecutorCertificate(filteredEntity);
            if (certHexSerial === null) {
                throw new Error();
            }

            const certDecSerialString = BigInt(`0x${certHexSerial}`).toString();
            await tx(EXEC_TABLE).update({ 'cert_serial': certDecSerialString }).where('id', id);
        }
        catch (error) {
            remoteCert.tryRemoveCertificate(filteredEntity.id);
            await tx(EXEC_TABLE).update({ 'log': error.toString() }).where('id', filteredEntity.id);
            throw new interoperableErrors.ServerValidationError("Error when creating certificates");
        }

        try {
            await executorInitializer[filteredEntity.type](filteredEntity, tx);
            await tx(EXEC_TABLE).update({ 'status': ExecutorStatus.READY }).where('id', filteredEntity.id);
        }
        catch (error) {
            log.error(LOG_ID, error);
            await tx(EXEC_TABLE).update({ 'status': ExecutorStatus.FAIL, 'log': error.toString() }).where('id', filteredEntity.id);
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
        exec.state = JSON.parse(exec.state);
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

const executorDestructor = {
    [MachineTypes.REMOTE_RUNNER_AGENT]: async (filteredEntity, tx) => { },
    [MachineTypes.OCI_BASIC]: async (filteredEntity, tx) => {
        await registerPoolRemoval({ subnetMask: filteredEntity.state.subnetMask });
    }
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
        const exec = await getById(context, id, false);

        await executorDestructor[exec.type](exec, tx);
        
        await tx('jobs').where('executor_id', id).update({ executor_id: 1 });
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

async function appendToLogById(id, toAppend) {
    return await knex.transaction(async tx => {
        const { log } = await getById(getAdminContext(), id, false);
        await tx(EXEC_TABLE).update({ 'log': `${log}${toAppend}` }).where('id', id);
     });
}

module.exports = {
    listDTAjax, hash, getById, create, updateWithConsistencyCheck, remove, getAllCerts, appendToLogById
}