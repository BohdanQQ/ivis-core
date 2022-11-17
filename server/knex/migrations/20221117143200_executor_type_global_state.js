const { GlobalExecutorStateDefaults, MachineTypes } = require('../../../shared/remote-run')
const GLOBAL_EXEC_STATE_TABLE = 'global_executor_type_state';
const STATE_COL = 'state';
const TYPE_COL = 'type';

exports.up = (knex, Promise) => (async () => {
    await knex.schema.createTable(GLOBAL_EXEC_STATE_TABLE, table => {
        table.string(TYPE_COL).primary();
        table.string(STATE_COL).notNullable();
    });
    for (const key in MachineTypes) {
        if (Object.hasOwnProperty.call(MachineTypes, key)) {
            const type = MachineTypes[key];
            await knex(GLOBAL_EXEC_STATE_TABLE).insert({
                [TYPE_COL]: type,
                [STATE_COL]: JSON.stringify(GlobalExecutorStateDefaults[type])
            });
        }
    }
})();

exports.down = (knex, Promise) => Promise.all([
    knex.schema.dropTable(GLOBAL_EXEC_STATE_TABLE)
]);