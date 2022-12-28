const fs = require('fs');
const { Client } = require('ssh2');
const EventEmitter = require('events');
const config = require('./config');
const log = require('./log');

const LOG_ID = 'instance-ssh';

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

function getConnectionDescription(host, port, username, password) {
    const connectionDescription = {
        host,
        port,
        username,
        privateKey: getPrivateSSHKey(),
    };
    if (password !== null && password !== undefined) {
        connectionDescription.password = password;
    }
    return connectionDescription;
}

async function canMakeSSHConnectionTo(host, port, username) {
    return new Promise((resolve) => {
        const conn = new Client();
        log.verbose(LOG_ID, `trying ${username}@${host}:${port}`);
        conn.on('ready', () => {
            conn.end();
            log.verbose(LOG_ID, 'Connection estabilished');
            resolve(true);
        })
            .on('error', (message) => {
                log.verbose(LOG_ID, `connecting to ${host}:${port}`, message);
                resolve(false);
            })
            .connect(getConnectionDescription(host, port, username));
    });
}

async function uploadFile(localPath, remotePath, host, port, username, password) {
    const connectionDescription = getConnectionDescription(host, port, username, password);
    return new Promise((resolve, reject) => {
        const conn = new Client();
        try {
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) throw err;
                    sftp.fastPut(localPath, remotePath, (error) => {
                        conn.end();
                        if (error) throw error;
                        resolve();
                    });
                });
            }).on('error', (message) => {
                reject(new Error(`Cannot connect: ${message}`));
            })
                .connect(connectionDescription);
        } catch (err) {
            reject(err);
        }
    });
}

class SSHConnection {
    #EVENT_COMMAND = 'command';

    #EVENT_READY = 'ready';

    #EVENT_OK = 'ok';

    #EVENT_ERR = 'err';

    #host;

    #port;

    #username;

    #privateKey;

    #password;

    #client;

    #emitter;

    #reservedIds;

    #ended;

    constructor(host, port, username, privateKey, password = undefined) {
        this.#host = host;
        this.#port = port;
        this.#username = username;
        this.#privateKey = privateKey;
        this.#password = password;
        this.#client = new Client();
        this.#emitter = new EventEmitter();
        this.#reservedIds = new Set();
        this.#ended = false;
        this.#initConn();
    }

    static #randomString(length) {
        const alphabet = 'ABCDEFGHIJKLMOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890!@#$%^&*()-=_+';

        let result = '';
        for (let index = 0; index < length; index++) {
            result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        }

        return result;
    }

    #generateReturnId() {
        let id;
        do {
            id = SSHConnection.#randomString(8);
        } while (this.#reservedIds.has(id));
        this.#reservedIds.add(id);
        return id;
    }

    #freeReturnId(id) {
        this.#reservedIds.delete(id);
    }

    static #getReturnEventName(evType, returnId) {
        return `${evType}-${returnId}`;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.#emitter.once(this.#EVENT_READY, () => resolve());
            this.#client.on('error', (message) => {
                reject(new Error(`Cannot connect: ${message}`));
            })
                .connect(
                    getConnectionDescription(
                        this.#host,
                        this.#port,
                        this.#username,
                        this.#password,
                    ),
                );
        });
    }

    #commandExecutionClosure = (command, returnId) => {
        const [stdout, stderr] = [[], []];
        const errEvName = SSHConnection.#getReturnEventName(this.#EVENT_ERR, returnId);
        const successEvName = SSHConnection.#getReturnEventName(this.#EVENT_OK, returnId);
        this.#client.exec(command, (err, stream) => {
            if (err) {
                this.#emitter.emit(errEvName, {
                    stdout: '',
                    stderr: err.toString(),
                });
                return;
            }
            stream.on('close', (code, signal) => {
                if (code === 0) {
                    this.#emitter.emit(successEvName, {
                        stdout: stdout.join('\n'),
                        stderr: stderr.join('\n'),
                    });
                } else {
                    this.#emitter.emit(errEvName, {
                        stdout: stdout.join('\n'),
                        stderr: stderr.join('\n'),
                        code,
                        signal,
                    });
                }
            }).on('data', (data) => {
                stdout.push(data.toString().trim());
            }).stderr.on('data', (data) => {
                stderr.push(data.toString().trim());
            });
        });
    };

    #initConn() {
        this.#client.on('ready', () => {
            this.#emitter.emit(this.#EVENT_READY, null);
            this.#emitter.on(this.#EVENT_COMMAND, this.#commandExecutionClosure);
        });
    }

    #executeImpl(command) {
        return new Promise((resolve, reject) => {
            const returnId = this.#generateReturnId();
            const successName = SSHConnection.#getReturnEventName(this.#EVENT_OK, returnId);
            const errorName = SSHConnection.#getReturnEventName(this.#EVENT_ERR, returnId);
            let cleanUpEvent = false;
            this.#emitter.once(successName, ({ stdout, stderr }) => {
                if (cleanUpEvent) {
                    this.#freeReturnId(returnId);
                    return;
                }
                cleanUpEvent = true;
                this.#emitter.emit(errorName, {});
                resolve({ stdout, stderr });
            });
            this.#emitter.once(errorName, ({
                stdout, stderr, code, signal,
            }) => {
                if (cleanUpEvent) {
                    this.#freeReturnId(returnId);
                    return;
                }
                cleanUpEvent = true;
                this.#emitter.emit(successName, {});
                reject(new Error(`Command execution failed:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}\nCode, signal: ${code}, ${signal}`));
            });
            this.#emitter.emit(this.#EVENT_COMMAND, command, returnId);
        });
    }

    async execute(command) {
        if (this.#ended) {
            throw new Error('Cannot execute on dead connection!');
        }
        if (typeof command !== 'string') {
            throw new Error(`Cannot execute ${typeof command} as a command (epxected string)`);
        }
        log.verbose(LOG_ID, `$> ${command}`);
        return this.#executeImpl(command);
    }

    end() {
        if (this.#ended) {
            throw new Error('Double connection end!');
        }
        this.#ended = true;
        this.#client.end();
    }
}

async function makeReadySSHConnection(host, port, username, password = undefined) {
    const conn = new SSHConnection(host, port, username, getPrivateSSHKey(), password);
    await conn.connect();
    return conn;
}

/**
 * @callback SSHConnFn
 * @param {SSHConnection} connection
 * @returns {Promise<any>}
 */

/**
 * Wraps a function call utilizing a ssh connection in a wrapper which
 * always safely disposes of the connection
 * @param { {host : string, port: number, username: string, password?: string} } credentials
 * @param {SSHConnFn} func
 * @returns {any} whatever the func returns, errors are rethrown
 */
async function sshWrapper(credentials, func) {
    const connection = await makeReadySSHConnection(credentials.host, credentials.port, credentials.username, credentials.password);
    try {
        const result = await func(connection);
        connection.end();
        return result;
    } catch (err) {
        connection.end();
        throw err;
    }
}

module.exports = {
    getPublicSSHKey, canMakeSSHConnectionTo, uploadFile, sshWrapper,
};
