const { ExecutorStatus } = require('../../../shared/remote-run')
const EXECUTOR_TABLE = 'job_executors';
const STATE_COL = 'state';
const STATUS_COL = 'status';
const LOG_COL = 'log';

exports.up = (knex, Promise) => (async () => {
    await knex.schema.table(EXECUTOR_TABLE, table => {
        table.string(STATE_COL).notNullable().defaultTo("{}");
        table.integer(STATUS_COL).notNullable().defaultTo(ExecutorStatus.FAIL);
        table.string(LOG_COL).notNullable().defaultTo("");
    });
})();

exports.down = (knex, Promise) => Promise.all([
    knex.schema.table(EXECUTOR_TABLE, t => {
        t.dropColumn(LOG_COL);
        t.dropColumn(STATUS_COL);
        t.dropColumn(STATE_COL);
    })
]);