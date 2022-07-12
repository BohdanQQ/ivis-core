const MACHINES_TABLE = 'job_execution_machines';
exports.up = (knex, Promise) => (async () => {
    await knex.schema.createTable(MACHINES_TABLE, table => {
        table.increments('id').primary();
        table.string('name').notNullable();
        table.string('ip_address').notNullable();
        table.string('type').notNullable();
        table.string('description');
        table.string('hostname');
        table.string('parameters');
    });

    await knex(MACHINES_TABLE).insert({
        id: 1,
        name: 'IVIS instance',
        description: 'Runs the job locally, on this IVIS instance.',
        ip_address: '127.0.0.1',
        type: 'local',
    });

    await knex.schema.table('jobs', table => {
        table.integer('execution_machine_id').unsigned().references(MACHINES_TABLE + '.id').defaultTo(1);
    });
    
})();

exports.down = (knex, Promise) => (async () => {
    await knex.schema.table('jobs', t => t.dropColumn('execution_machine_id'));

    await knex.schema.dropTable('job_execution_machines');
});