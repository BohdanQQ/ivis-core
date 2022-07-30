const MACHINES_TABLE = 'job_executors';
const CERT_COL = 'cert_serial';


exports.up = (knex, Promise) => (async () => {
    await knex.schema.table(MACHINES_TABLE, table => {
        table.string(CERT_COL).notNullable().defaultTo("");
    });
})();

exports.down = (knex, Promise) => (async () => {
    await knex.schema.table(MACHINES_TABLE, t => t.dropColumn(CERT_COL));
});