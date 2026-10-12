'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_NAME = /^(\d{3,}_[a-z0-9-]+\.sql)$/;
const MIGRATION_LOCK_ID = '7319462041701';

async function runMigrations(database, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const names = fs.readdirSync(migrationsDir)
    .filter((name) => MIGRATION_NAME.test(name))
    .sort();
  const migrations = names.map((name) => {
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    return {
      name,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
    };
  });

  return database.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const result = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(result.rows.map((row) => [row.version, row.checksum]));
    const newlyApplied = [];

    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        if (applied.get(migration.name) !== migration.checksum) {
          throw new Error(`마이그레이션 파일이 변경되었습니다: ${migration.name}`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum]
      );
      newlyApplied.push(migration.name);
    }
    return newlyApplied;
  });
}

async function main() {
  // Required here, not at module scope: db.js requires this file back, and a
  // top-level require would leave one of the two modules half-initialised
  // depending on which entry point loaded first.
  const { createDatabase } = require('./db');
  const database = createDatabase();
  try {
    const applied = await database.migrate();
    process.stdout.write(applied.length
      ? `[eventouch] applied ${applied.length} database migration(s)\n`
      : '[eventouch] database schema is current\n');
  } finally {
    await database.close();
  }
}

// Exported before the CLI block below. db.js requires this file lazily, and
// under the `npm run db:migrate` entry point that require happens while this
// module is still evaluating: main() calls database.migrate(), which requires
// this file back. Assigning exports after the CLI block left `runMigrations`
// undefined at exactly that moment and every CLI migration failed.
module.exports = { runMigrations };

if (require.main === module) {
  main().catch((error) => {
    const code = error && error.code ? ` (${error.code})` : '';
    process.stderr.write(`[eventouch] database migration failed${code}\n`);
    process.exitCode = 1;
  });
}
