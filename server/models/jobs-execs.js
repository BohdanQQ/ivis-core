'use strict';

const knex = require('../lib/knex');
const dtHelpers = require('../lib/dt-helpers');


const columns = [
    'job_executors.id', 'job_executors.name', 'job_executors.description', 'job_executors.type', 'namespaces.name'
];

function getQueryFun() {
    return builder => builder
        .from('job_executors')
        .innerJoin('namespaces', 'namespaces.id', 'job_executors.namespace')
}

async function listDTAjax(context, params) {
    return await dtHelpers.ajaxListWithPermissions(
        context,
        [{entityTypeId: 'jobExecutor', requiredOperations: ['view']}],
        params,
        getQueryFun(),
        columns
    );
}

module.exports = {
    listDTAjax
}