const {getGlobalNamespaceId} = require("../../../shared/namespaces");

const MACHINES_TABLE = 'job_executors';
const entityType = 'job_executor';


exports.up = (knex, Promise) => (async () => {
    await knex.schema.createTable(MACHINES_TABLE, table => {
        table.increments('id').primary();
        table.string('name').notNullable();
        table.string('ip_address').notNullable();
        table.string('type').notNullable();
        table.string('description');
        table.string('hostname');
        table.string('parameters');
        table.integer('namespace').notNullable().references('namespaces.id');
    });

    await knex(MACHINES_TABLE).insert({
        id: 1,
        name: 'IVIS instance',
        description: 'Runs the job locally, on this IVIS instance.',
        ip_address: '127.0.0.1',
        type: 'local',
        namespace: getGlobalNamespaceId()
    });

    await knex.schema
    .createTable(`shares_${entityType}`, table => {
        table.integer('entity').unsigned().notNullable().references(`${entityType}s.id`).onDelete('CASCADE');
        table.integer('user').unsigned().notNullable().references('users.id').onDelete('CASCADE');
        table.string('role', 128).notNullable();
        table.boolean('auto').defaultTo(false);
        table.primary(['entity', 'user']);
    })
    .createTable(`permissions_${entityType}`, table => {
        table.integer('entity').unsigned().notNullable().references(`${entityType}s.id`).onDelete('CASCADE');
        table.integer('user').unsigned().notNullable().references('users.id').onDelete('CASCADE');
        table.string('operation', 128).notNullable();
        table.primary(['entity', 'user', 'operation']);
    });

    await knex.schema.table('jobs', table => {
        table.integer('executor_id').unsigned().references(MACHINES_TABLE + '.id').defaultTo(1);
    });
    
})();

exports.down = (knex, Promise) => (async () => {
    await knex.schema.table('jobs', t => t.dropColumn('execution_machine_id'));

    await knex.schema.dropTable(`permissions_${entityType}`);
    await knex.schema.dropTable(`shares_${entityType}`); 
    await knex.schema.dropTable(MACHINES_TABLE);
});