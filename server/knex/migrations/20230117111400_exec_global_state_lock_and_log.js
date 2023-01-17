const GLOBAL_EXEC_STATE_TABLE = 'global_executor_type_state';
const LOCK_COL = 'locked';
const LOG_COL = 'log';
const { getGlobalNamespaceId } = require("../../../shared/namespaces");

exports.up = (knex, Promise) => (async () => {
    await knex.schema.table(GLOBAL_EXEC_STATE_TABLE, table => {
        table.boolean(LOCK_COL).notNullable().defaultTo(false);
        table.text(LOG_COL).notNullable().defaultTo("");
        table.integer('namespace').notNullable().references('namespaces.id').defaultTo(getGlobalNamespaceId());
    });
})();

exports.down = (knex, Promise) => Promise.all([
    knex.schema.table(GLOBAL_EXEC_STATE_TABLE, t => {
        t.dropColumn(LOG_COL);
        t.dropColumn(LOCK_COL);
    })
]);