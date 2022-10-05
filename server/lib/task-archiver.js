const { exec } = require('child_process');
const fs = require('fs-extra-promise');
const taskHandler = require('./task-handler');
// TODO GENERAL CHECK
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
    const archiveCommand = `tar --exclude=".git" --create --file=${getTaskArchivePath(taskId)} --directory=${taskHandler.getTaskBuildOutputDir(taskId)} .`;
    console.log(`Archive Command: ${archiveCommand}`);
    return new Promise((resolve, reject) => {
        exec(archiveCommand)
            .on('error', (err) => reject(err))
            .on('exit', (code, signal) => {
                if (code === 0) {
                    console.log(`Archive Created`);
                    resolve();
                    return;
                }
                reject(new Error(`Archive process exited with code ${code} and signal ${signal}}`));
            });
    });
}


async function archiveExists(taskId) {
    return await fs.existsAsync(getTaskArchivePath(taskId));
}

/**
 * @param {number} taskId 
 * @returns {Promise<Buffer>>} the archive file
 */
async function getTaskArchive(taskId) {
    if (!await archiveExists(taskId)) {
        return Promise.reject("Task archive not found!");
    }

    return fs.readFileAsync(getTaskArchivePath(taskId));
}


module.exports = {
    archiveExists,
    archiveTaskCode,
    getTaskArchive,
}