const config = require('./config');
const log = require('./log');
const LOG_ID = 'instance-ssh';
const fs = require('fs');
const { Client } = require('ssh2');

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
    return fs.readFileSync(PRIVATE_KEY_PATH);
}

/**
 * 
 * @param {String} command 
 * @param {String} host 
 * @param {Number} port 
 * @param {String} username 
 * @returns {Promise<{stdout: [String], stderr: [String], error: Error | undefined}>}
 */
async function executeCommand(command, host, port, username) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        let stdout = [];
        let stderr = [];
        try {
            conn.on('ready', () => {
                conn.exec(command, (err, stream) => {
                    if (err) reject(err);
                    stream.on('close', (code, signal) => {
                        conn.end();
                        if (code == 0) {
                            resolve({
                                stdout,
                                stderr
                            });
                        }
                        else {
                            reject({
                                stdout,
                                stderr,
                                error: new Error(`Stream closed with code ${code} and signal ${signal}`)
                            });
                        }
                    }).on('data', (data) => {
                        stdout.push(data.toString().trim());
                    }).stderr.on('data', (data) => {
                        stderr.push(data.toString().trim());
                    });
                });
            }).on('error', (message) => {
                reject({
                    stdout,
                    stderr,
                    error: new Error(`Cannot connect: ${message}`)
                });
            })
                .connect({
                    host,
                    port,
                    username,
                    privateKey: getPrivateSSHKey()
                });
        } catch (err) {
            reject({
                stdout,
                stderr,
                error: err
            });
        }
    });
}

async function canMakeSSHConnectionTo(host, port, username) {
    return new Promise((resolve) => {
        const conn = new Client();
        log.verbose(LOG_ID, `trying ${username}@${host}:${port}`);
        conn.on('ready', () => {
            conn.end();
            log.verbose(LOG_ID, `Connection estabilished`);
            resolve(true);
        })
            .on('error', (message) => {
                log.verbose(LOG_ID, `connecting to ${host}:${port}`, message);
                resolve(false);
            })
            .connect({
                host,
                port,
                username,
                privateKey: getPrivateSSHKey().toString(),
            });
    });
}

module.exports = {
    getPublicSSHKey, executeCommand, canMakeSSHConnectionTo
}