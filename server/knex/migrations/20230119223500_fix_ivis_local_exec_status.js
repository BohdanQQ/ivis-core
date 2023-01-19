const { ExecutorStatus } = require('../../../shared/remote-run')
const EXECUTOR_TABLE = 'job_executors';
const STATUS_COL = 'status';

exports.up = (knex, Promise) => (async () => {
    await knex(EXECUTOR_TABLE).update({
        [STATUS_COL]: ExecutorStatus.READY
    }).where('id', 1);
})();

// no need to roll this back...
exports.down = (knex, Promise) => { return; };