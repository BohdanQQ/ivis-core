const hasher = require('node-object-hash')();
const knex = require('../lib/knex');
const { enforce, filterObject } = require('../lib/helpers');
const dtHelpers = require('../lib/dt-helpers');
const interoperableErrors = require('../../shared/interoperable-errors');
const namespaceHelpers = require('../lib/namespace-helpers');
const shares = require('./shares');
const {
    MachineTypes, MachineTypeParams, ExecutorStatus, ExecutorStateDefaults,
} = require('../../shared/remote-run');
const remoteCert = require('../lib/remote-certificates');
const log = require('../lib/log');
const { getAdminContext } = require('../lib/context-helpers');
const { createOCIBasicPool, shutdownPool, killPoolForced } = require('../lib/pools/oci/basic/oci-basic');
const slurm = require('../lib/pools/slurm/slurm');
const { RunStatus } = require('../../shared/jobs');

const LOG_ID = 'job-execs';
const allowedKeys = new Set(['name', 'description', 'type', 'parameters', 'namespace', 'status']);
const allowedKeysUpdate = new Set(['name', 'description', 'parameters', 'namespace']);
const EXEC_TYPEID = 'jobExecutor';
const EXEC_TABLE = 'job_executors';

async function failAllProvisioning() {
    const provisioningExecs = await knex(EXEC_TABLE).where('status', ExecutorStatus.PROVISIONING);
    await Promise.all(
        provisioningExecs.map((exec) => 
            appendToLogById(exec.id, 'Executor status update: status changed to fail because initialization/removal has not finished properly before IVIS server shutdown')
            .then(() => updateExecStatus(exec.id, ExecutorStatus.FAIL)))
    );
}

function dbFieldName(name) {
    return `${EXEC_TABLE}.${name}`;
}

const columns = [
    dbFieldName('id'), dbFieldName('name'), dbFieldName('description'), dbFieldName('type'), 'namespaces.name', dbFieldName('status'),
];

function getQueryFun() {
    return (builder) => builder
        .from(EXEC_TABLE)
        .innerJoin('namespaces', 'namespaces.id', dbFieldName('namespace'));
}

async function listDTAjax(context, params) {
    return await dtHelpers.ajaxListWithPermissions(
        context,
        [{ entityTypeId: 'jobExecutor', requiredOperations: ['view'] }],
        params,
        getQueryFun(),
        columns,
    );
}

async function logErrorToExecutor(executorId, precedingMessage, error) {
    const errMsg = `${precedingMessage}, error:\n${error.toString()}`;
    log.error(LOG_ID, errMsg);
    log.error(LOG_ID, error.stack);
    await appendToLogById(executorId, errMsg);
}

async function generateCertificates(executor, ip, hostname, tx) {
    if (!tx) {
        tx = knex;
    }
    const certHexSerial = await remoteCert.createRemoteExecutorCertificate(executor, ip, hostname);
    if (certHexSerial === null) {
        throw new Error('Certificate creation failed');
    }

    const certDecSerialString = BigInt(`0x${certHexSerial}`).toString();
    await tx(EXEC_TABLE).update({ cert_serial: certDecSerialString }).where('id', executor.id);
}

async function updateExecStatus(execId, status, tx) {
    if (!tx) {
        tx = knex;
    }
    return await tx(EXEC_TABLE).update({ status }).where('id', execId);
}

/**
 * each call will be awaited => await only for reasonable time periods OR use the exexutor status to update the user
 * the function is allowed and expected to throw exceptions if the executor is not ready when the function returns
 */
const executorInitializer = {
    [MachineTypes.REMOTE_RUNNER_AGENT]: async (filteredEntity, tx) => {
        try {
            await generateCertificates(filteredEntity, filteredEntity.parameters.ip_address, filteredEntity.parameters.hostname, tx);
        } catch (error) {
            remoteCert.tryRemoveCertificate(filteredEntity.id);
            await logErrorToExecutor(filteredEntity.id, 'Error when creating certificates', error);
            await updateExecStatus(filteredEntity.id, ExecutorStatus.FAIL, tx);
            return;
        }

        await updateExecStatus(filteredEntity.id, ExecutorStatus.READY, tx);
    },
    [MachineTypes.REMOTE_POOL]: async (filteredEntity, tx) => {
        try {
            await generateCertificates(filteredEntity, filteredEntity.parameters.ip_address, filteredEntity.parameters.hostname, tx);
        } catch (error) {
            remoteCert.tryRemoveCertificate(filteredEntity.id);
            await logErrorToExecutor(filteredEntity.id, 'Error when creating certificates', error);
            await updateExecStatus(filteredEntity.id, ExecutorStatus.FAIL, tx);
            return;
        }

        await updateExecStatus(filteredEntity.id, ExecutorStatus.READY, tx);
    },
    [MachineTypes.OCI_BASIC]: async (filteredEntity, tx) => {
        (async () => {
            try {
                log.verbose(LOG_ID, 'Pool params:', filteredEntity.parameters);
                await createOCIBasicPool(filteredEntity.id, filteredEntity.parameters, (ip) => generateCertificates(filteredEntity, ip, null, null));
            } catch (err) {
                await logErrorToExecutor(filteredEntity.id, 'Cannot create OCI pool', err);
                log.error(err);
                await updateExecStatus(filteredEntity.id, ExecutorStatus.FAIL);
                return;
            }
            await updateExecStatus(filteredEntity.id, ExecutorStatus.READY);
        })();
    },
    [MachineTypes.SLURM_POOL]: async (filteredEntity, tx) => {
        (async () => {
            let error = null;
            try {
                log.verbose(LOG_ID, 'Pool params:', filteredEntity.parameters);
                await slurm.createSlurmPool(filteredEntity, () => generateCertificates(filteredEntity, '10.0.0.1', filteredEntity.parameters.hostname, null));
            } catch (err) {
                error = err.error ? err.error : err;
            } finally {
                if (error === null) {
                    await updateExecStatus(filteredEntity.id, ExecutorStatus.READY);
                } else {
                    await logErrorToExecutor(filteredEntity.id, 'Cannot create SLURM pool', error);
                    log.error(error);
                    await updateExecStatus(filteredEntity.id, ExecutorStatus.FAIL);
                }
            }
        })();
    },
};

/**
 * Creates a job executor.
 * @param context
 * @param executor the job executor data
 * @returns {Promise<number>} id of the created job
 */
async function create(context, executor) {
    return await knex.transaction(async (tx) => {
        await shares.enforceEntityPermissionTx(tx, context, 'namespace', executor.namespace, 'createExec');
        await namespaceHelpers.validateEntity(tx, executor);

        const filteredEntity = filterObject(executor, allowedKeys);
        const jsonParams = filteredEntity.parameters;
        filteredEntity.parameters = JSON.stringify(filteredEntity.parameters);
        filteredEntity.state = JSON.stringify(ExecutorStateDefaults[executor.type]);
        filteredEntity.log = '';
        filteredEntity.status = ExecutorStatus.PROVISIONING;

        if (!Object.values(MachineTypes).includes(executor.type)) {
            throw new interoperableErrors.NotFoundError(`Type ${executor.type} not found`);
        }

        const ids = await tx(EXEC_TABLE).insert(filteredEntity);
        const id = ids[0];
        await shares.rebuildPermissionsTx(tx, { entityTypeId: EXEC_TYPEID, entityId: id });
        filteredEntity.id = id;
        filteredEntity.parameters = jsonParams;
        filteredEntity.state = ExecutorStateDefaults[executor.type];

        try {
            await executorInitializer[filteredEntity.type](filteredEntity, tx);
        } catch (error) {
            await logErrorToExecutor(filteredEntity.id, 'Executor Initializer failed', error);
            await updateExecStatus(filteredEntity.id, ExecutorStatus.FAIL);
            throw new interoperableErrors.ServerValidationError('Error when initializing the executor');
        }

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
    return await knex.transaction(async (tx) => {
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
    await knex.transaction(async (tx) => {
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

async function getRunsByExecutor(executorId) {
    return knex('job_runs')
        .innerJoin('jobs', 'job_runs.job', 'jobs.id')
        .where('jobs.executor_id', executorId).select('job_runs.id', 'job_runs.status');
}

async function finalExecutorRemovalSteps(executorId) {
    remoteCert.tryRemoveCertificate(executorId);
    await knex('jobs').where('executor_id', executorId).update({ executor_id: 1 });
    await knex(EXEC_TABLE).where('id', executorId).del();
}

// wraps executor-type dependent operation around common steps
// such as all executor-related run cancellation, certificate removal, ...  
async function execRemovalWith(runStopPromiseGenerator, afterStopPromiseGenerator, executor, forced) {
    const runStopPromises = (await getRunsByExecutor(executor.id))
        .filter((run) => run.status !== RunStatus.FAILED && run.status !== RunStatus.SUCCESS)
        .map((run) =>  runStopPromiseGenerator(executor, run.id));
    try {
        await Promise.all(runStopPromises);
        await afterStopPromiseGenerator();
        await finalExecutorRemovalSteps(executor.id);
    } catch (err) {
        if (executor.status === ExecutorStatus.FAIL) {
            await appendToLogById(executor.id, '\nWARNING: REMOVAL OF A FAILED EXECUTOR MAY FAIL BECAUSE THE INITIALIZATION HAS LEFT THE EXECUTOR IN ONLY PARTIALLY CORRECT STATE\n');
        }
        if (!forced) {
            await logErrorToExecutor(executor.id, `Pool removal failed, please stop all running jobs and remove the executor manually (force-remove the executor and free your resource using the executor state: ${JSON.stringify(executor.state)})`, err);
            await updateExecStatus(executor.id, ExecutorStatus.FAIL);
            await knex('jobs').where('executor_id', executor.id).update({ executor_id: 1 });
            return;
        }
        await finalExecutorRemovalSteps(executorId).catch(() => null);
    }
}

const executorDestructor = {
    // no await - this operation may take a long time (too long for the client form to wait)
    // TODO document - run stop must be directly awaitable, unlike task handler signalling
    // TODO RUN STOP
    [MachineTypes.REMOTE_RUNNER_AGENT]: async (executor, tx, isForced) => {
        execRemovalWith(() => console.log('stop rjr'), () => Promise.resolve(), executor, isForced);
    },
    // TODO RUN STOP
    [MachineTypes.OCI_BASIC]: async (executor, tx, isForced) => {
        execRemovalWith(() => console.log('stop oci'), async () => {
            if (isForced) {
                return await killPoolForced(executor);
            } else {
                return await shutdownPool(executor);
            }
        }, executor, isForced);
    },
    [MachineTypes.SLURM_POOL]: async (executor, tx, isForced) => {
        execRemovalWith(slurm.stop, async () => await slurm.removePool(executor), executor, isForced);
    },
};

/**
 * Remove job executor.
 * @param context
 * @param id the primary key of the executor
 * @returns {Promise<void>}
 */
async function remove(context, id) {
    enforce(id !== 1, 'Local executor cannot be deleted');
    const exec = await getById(context, id, false);
    enforce(exec.status !== ExecutorStatus.PROVISIONING, 'Please wait until executor creation/removal finishes');
    try {
        // ensures no runs can be scheduled to this executor during its removal
        await updateExecStatus(exec.id, ExecutorStatus.PROVISIONING);
        await knex.transaction(async (tx) => {
            await shares.enforceEntityPermissionTx(tx, context, EXEC_TYPEID, id, 'delete');

            await executorDestructor[exec.type](exec, tx, false);
        });
    } catch (err) {
        if (exec.status === ExecutorStatus.FAIL) {
            await appendToLogById(id, '\nWARNING: REMOVAL OF A FAILED EXECUTOR MAY FAIL BECAUSE THE INITIALIZATION HAS LEFT THE EXECUTOR IN ONLY PARTIALLY CORRECT STATE\n');
        }
        await logErrorToExecutor(id, 'pool removal error:', err);
        await updateExecStatus(id, ExecutorStatus.FAIL);
        await knex('jobs').where('executor_id', id).update({ executor_id: 1 });
        remoteCert.tryRemoveCertificate(id);
        throw new interoperableErrors.InteroperableError(`Removal of an executor failed: ${err.toString()}`);
    }
}

/**
 * FORCIBLY remove job executor. THERE IS ONLY ONE REASON TO CALL THIS FUNCTION
 * @param context
 * @param id the primary key of the executor
 * @returns {Promise<void>}
 */
async function removeForced(context, id) {
    enforce(id !== 1, 'Local executor cannot be deleted');
    const exec = await getById(context, id, false);
    // 2 possible solutions:
    // forceful removal does not care about executor state
    // forceful removal works only on non-provisioning executors => in case something goes wrong 
    // and the executor never switches to failed/success, the user would need the entire IVIS server 
    // to be restarted
    // thus keeping it this way (no check) for now
    await updateExecStatus(exec.id, ExecutorStatus.PROVISIONING);
    await shares.enforceEntityPermissionTx(knex, context, EXEC_TYPEID, id, 'delete');
    // no await because the form times out for too long requests
    executorDestructor[exec.type](exec, knex, true).catch(() => null).then( () => 
        remoteCert.tryRemoveCertificate(id))
        .then(() => knex('jobs').where('executor_id', id).update({ executor_id: 1 }))
        .then(knex(EXEC_TABLE).where('id', id).del())
        .catch((err) => log.error(LOG_ID, 'forced removal error', err));
}

async function getAllCerts(context, id) {
    return await knex.transaction(async (tx) => {
        await shares.enforceEntityPermissionTx(tx, context, EXEC_TYPEID, id, 'viewCerts');
        try {
            const {
                cert,
                key,
            } = remoteCert.getExecutorCertKey(id);
            return {
                ca: remoteCert.getRemoteCACert(),
                cert,
                key,
            };
        } catch (err) {
            log.verbose(LOG_ID, 'error when getting certs', err);
            // rethrow different exception to not leak certificate-key paths / possibly contents
            throw new interoperableErrors.NotFoundError('Certificates not found');
        }
    });
}

async function appendToLogById(id, toAppend) {
    return await knex.transaction(async (tx) => {
        const { log } = await getById(getAdminContext(), id, false);
        await tx(EXEC_TABLE).update({ log: `${log}\n${toAppend}` }).where('id', id);
    });
}

module.exports = {
    listDTAjax, hash, getById, create, updateWithConsistencyCheck, remove, getAllCerts, appendToLogById, removeForced, failAllProvisioning
};
