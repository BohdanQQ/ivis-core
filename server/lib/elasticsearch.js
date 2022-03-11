'use strict';

const elasticsearch = require('elasticsearch');
const config = require('../lib/config');

module.exports = new elasticsearch.Client({
    host: `${config.www.esUrlBase}`,
    httpAuth: `${config.elasticsearch.adminUsername}:${config.elasticsearch.adminPassword}`,
    // tls: {
    // // might be required if it's a self-signed certificate
    // rejectUnauthorized: false
    // }
    // , log: 'trace'
});