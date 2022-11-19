const config = require('./config');
const fs = require('fs');

const PRIVATE_KEY_PATH = config.ssh.privatePath;
const PUBLIC_KEY_PATH = config.ssh.publicPath;

function getPublicSSHKey() {
    return fs.readFileSync(PUBLIC_KEY_PATH).toString();
}

/**
 * CAUTION: this reveals extremely sensitive information, each call
 * better be justified and secured
 * @returns {string}
 */
function getPrivateSSHKey() {
    return fs.readFileSync(PRIVATE_KEY_PATH).toString();
}

function getAuthorizedKeyFormat(user) {
    const pubKey = getPublicSSHKey();
    const oneLinePubKey =
        pubKey
            .replace('-----BEGIN PUBLIC KEY-----', '')
            .replace('-----END PUBLIC KEY-----', '')
            .replace('ssh-rsa ', '')
            .replace(/[\n\r]/g, '');
    return `ssh-rsa ${oneLinePubKey} ${user}`;
}

module.exports = {
    getPrivateSSHKey, getPublicSSHKey, getAuthorizedKeyFormat
}