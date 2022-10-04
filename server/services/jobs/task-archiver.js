const { exec } = require('child_process');
const fs = require('fs-extra-promise');
const taskHandler = require('../../lib/task-handler');

/**
 * @param {number} taskId 
 * @returns {string} The path to the archive associated with this task
 */
function getTaskArchivePath(taskId) {
    return `${taskHandler.getTaskBuildOutputDir(taskId)}/../${taskId}.tar`;
}

/**
 * 
 * @param {number} taskId 
 * @returns {Promise<void>} promise of the archiving process, rejects on error
 */
async function archiveTaskCode(taskId) {
    // TODO specify output file!
    const archiveCommand = `tar --exclude=".git" ${taskHandler.getTaskBuildOutputDir(taskId)}`;
    return new Promise((resolve, reject) => {
        exec(archiveCommand)
            .on('error', (err) => reject(err))
            .on('exit', (code, signal) => {
                if (code !== null && code !== 0) {
                    resolve();
                    return;
                }
                reject(`Archive process exited with code ${code} and signal ${signal}}`);
            });
    });
}


async function archiveExists(taskId) {
    return await fs.existsAsync(getTaskArchivePath(taskId));
}

/**
 * @param {number} taskId 
 * @returns {Bluebird<Buffer>} the archive file
 */
async function getTaskArchive(taskId) {
    if (!await archiveExists(taskId)) {
        return Promise.reject("Task archive not found!");
    }

    return await fs.readFileAsync(getTaskArchivePath(taskId));
}


module.exports = {
    archiveExists,
    archiveTaskCode,
    getTaskArchive,
}