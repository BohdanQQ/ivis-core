const config = require('./config');
const log = require('./log');

const fs = require('fs');
const path = require('path');

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const LOG_ID = 'remote-certs';


const ROOT = path.join(__dirname, '..');
const EXEC_ROOT = path.join(ROOT, 'certs', 'remote');
const CA_CERT_PATH = path.join(ROOT, config.certs.remote.CACert);
const IVIS_KEY_PATH = path.join(ROOT, config.certs.remote.cliKey);
const IVIS_CERT_PATH = path.join(ROOT, config.certs.remote.cliCert);


function ensurePath(path, message) {
    if (!fs.existsSync(CA_CERT_PATH)) {
        throw new Error(`${message}, path: ${path}`);
    }
}

function ensureCACert() {
    ensurePath(CA_CERT_PATH, "The remote job executor CA certificate is missing in its configured location");
}

ensureCACert();
ensurePath(EXEC_ROOT, "The remote job executor client certificate store forlder is missing");


/**
 * @returns {string} the contents of the remote executor CA certificate
 */
function getRemoteCACert() {
    ensureCACert();
    return fs.readFileSync(CA_CERT_PATH).toString();  
}

/**
 * @returns {string} IVIS core certificate inteded for both client and server authentication 
 */
function getIVISRemoteCert() {
    ensurePath(IVIS_CERT_PATH, "The IVIS certificate for client/server authentication is missing in its configured location");
    return fs.readFileSync(IVIS_CERT_PATH).toString();
}

/**
 * WARNING !!! So far, this is only intended to be used within the task handler !!! Any other use should be carefully 
 * thought out and secured !!! 
 * @returns {string} IVIS core key for the corresponding certificate (returned by this module's getIVISRemoteCert) 
 */
 function getIVISRemoteKey() {
    ensurePath(IVIS_KEY_PATH, "The IVIS key for client/server certificate is missing in its configured location");
    return fs.readFileSync(IVIS_KEY_PATH).toString();
}

function getExecutorFilePrefix(executorId) {
    return `remote_executor_${executorId}`;
}

function getExecutorCertPath(executorId) {
    return path.join(EXEC_ROOT, `${getExecutorFilePrefix(executorId)}.cert`);
}

function getExecutorKeyPath(executorId) {
    return path.join(EXEC_ROOT, `${getExecutorFilePrefix(executorId)}.pem`);
}

// TODO rename?
/**
 * WARNING!!! this function shall be called only with sufficient authentication 
 * and authorization as it reveals the private keys of remote executor certificates!!!
 * 
 * @returns {{cert: string, key: string}} the contents of the remote executor certificate with corresponding key
 */
function getRemoteExecutorPrivateInfo(executorId) {
    const keyPath = getExecutorKeyPath(executorId);
    const certPath = getExecutorCertPath(executorId);
    ensurePath(keyPath);
    ensurePath(certPath);
    return { 
        key: fs.readFileSync(keyPath).toString(),
        cert: fs.readFileSync(certPath).toString()
    };
}
/** Creates a certificate-key pair signed by the local CA for an executor */
async function createRemoteExecutorCertificate(executor) {
    if (fs.existsSync(getExecutorCertPath(executor.id)) || fs.existsSync(getExecutorKeyPath(executor.id))) {
        throw new Error(`Executor ${executor.name} credentials already exist`);
    }
    try {
        const dnsName = typeof executor.hostname === 'string' && executor.hostname.trim() !== '' ? executor.hostname.trim() : null;
        const command = `cd ${EXEC_ROOT} && ./remote_executor_cert_gen.sh ${executor.ip_address} ${getExecutorFilePrefix(executor.id)}${dnsName === null ? '' : (' ' + dnsName)}`;
        log.verbose(LOG_ID, `Creating executor certificate with ${command}`);
        await exec(command);
    }catch (err) {
        log.error(LOG_ID, err);
       throw err;
    };
}
/**
 * This function does not throw any error
 * @param {number} executorId 
 */
function tryRemoveCertificate(executorId) {
    try {
        if (fs.existsSync(getExecutorCertPath(executorId))) {
            fs.unlinkSync(getExecutorCertPath(executorId))
        }

    }
    catch (err) {
        log.error(LOG_ID, "tryremove key", err);
    }

    try {
        if (fs.existsSync(getExecutorKeyPath(executorId))) {
            fs.unlinkSync(getExecutorKeyPath(executorId))
        }
    }
    catch (err) {
        log.error(LOG_ID, "tryremove key", err);
    }
}

module.exports = {
    createRemoteExecutorCertificate,
    getRemoteExecutorPrivateInfo,
    getRemoteCACert,
    tryRemoveCertificate,
    getIVISRemoteKey,
    getIVISRemoteCert
}