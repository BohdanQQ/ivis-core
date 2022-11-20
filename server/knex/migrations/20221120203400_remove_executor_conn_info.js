const EXEC_TABLE = 'job_executors';
const DROP_COLS = ['ip_address', 'hostname'];


exports.up = (knex, Promise) => (async () => {
    for (const col of DROP_COLS) {
        await knex.schema.table(EXEC_TABLE, t => t.dropColumn(col));
    }
})();

exports.down = (knex, Promise) => (async () => {
    await knex.schema.table(EXECS_TABLE, table => {
        table.string('hostname');
        table.string('ip_address').notNullable().default('INVALID');
    });
})();