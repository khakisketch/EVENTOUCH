'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../server/db');
const { runMigrations } = require('../server/migrate');
const { createDatabaseAuth } = require('../server/auth');
const { createAccess } = require('../server/access');
const { openStore } = require('../server/store');
const { createHttpServer } = require('../server/server');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');
const { requestJson } = require('./helpers/postgres-api-server.cjs');

class FakeClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(text, values) {
    this.pool.clientQueries.push({ text, values });
    return { rows: [{ value: values && values[0] }], rowCount: 1 };
  }

  release() {
    this.pool.released += 1;
  }
}

class FakePool {
  constructor(options) {
    this.options = options;
    this.queries = [];
    this.clientQueries = [];
    this.released = 0;
    this.ended = false;
  }

  async query(text, values) {
    this.queries.push({ text, values });
    return { rows: [{ value: values && values[0] }], rowCount: 1 };
  }

  async connect() {
    return new FakeClient(this);
  }

  async end() {
    this.ended = true;
  }
}

test('database-query-forwards-parameterized-values', async () => {
  const db = createDatabase({ connectionString: 'postgres://test', PoolClass: FakePool });
  const value = "value'); DROP TABLE accounts; --";
  const result = await db.query('SELECT $1::text AS value', [value]);
  assert.deepEqual(result.rows, [{ value }]);
  assert.deepEqual(db.pool.queries, [{ text: 'SELECT $1::text AS value', values: [value] }]);
  await db.close();
});

test('database-transaction-commits-on-the-checked-out-client', async () => {
  const db = createDatabase({ connectionString: 'postgres://test', PoolClass: FakePool });
  const result = await db.transaction(async (client) => {
    await client.query('SELECT $1::text', ['same-client']);
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.deepEqual(db.pool.clientQueries.map((call) => call.text), [
    'BEGIN', 'SELECT $1::text', 'COMMIT',
  ]);
  assert.equal(db.pool.released, 1);
  await db.close();
});

test('database-transaction-rolls-back-and-releases-on-error', async () => {
  const db = createDatabase({ connectionString: 'postgres://test', PoolClass: FakePool });
  await assert.rejects(
    db.transaction(async (client) => {
      await client.query('INSERT INTO test_rows(value) VALUES ($1)', ['discard']);
      throw new Error('force rollback');
    }),
    /force rollback/
  );
  assert.deepEqual(db.pool.clientQueries.map((call) => call.text), [
    'BEGIN', 'INSERT INTO test_rows(value) VALUES ($1)', 'ROLLBACK',
  ]);
  assert.equal(db.pool.released, 1);
  await db.close();
});

test('database-close-ends-the-pool', async () => {
  const db = createDatabase({ connectionString: 'postgres://test', PoolClass: FakePool });
  await db.close();
  assert.equal(db.pool.ended, true);
});

test('test-database-helper-rejects-non-loopback-hosts', () => {
  assert.throws(
    () => testDatabaseUrl('postgres://test:secret@database.example.com/eventouch'),
    /loopback-only/
  );
  assert.throws(
    () => testDatabaseUrl('postgres://test:secret@localhost/eventouch?host=database.example.com'),
    /loopback-only/
  );
  const socketUrl = 'postgres://test:secret@localhost/eventouch?host=/tmp/opencode/eventouch-pg-test-task1';
  assert.equal(testDatabaseUrl(socketUrl), socketUrl);
});

const databaseUrl = testDatabaseUrl();
const integration = databaseUrl ? test : (name, options, fn) => test(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated loopback PostgreSQL test database' }, fn);

async function createIsolatedMigrationSchema() {
  const schema = `eventouch_migration_${crypto.randomUUID().replace(/-/g, '')}`;
  const admin = createDatabase({ connectionString: databaseUrl });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } catch (error) {
    await admin.close();
    throw error;
  }
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  return {
    connectionString: isolatedUrl.toString(),
    async drop() {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    },
  };
}

integration('postgres-concurrent-first-migrations-serialize', { timeout: 15000 }, async () => {
  const isolated = await createIsolatedMigrationSchema();
  const scopedFirst = createDatabase({ connectionString: isolated.connectionString });
  const scopedSecond = createDatabase({ connectionString: isolated.connectionString });
  let arrivals = 0;
  let release;
  const bothTransactionsStarted = new Promise((resolve) => { release = resolve; });
  const gate = (database) => ({
    transaction(fn) {
      return database.transaction(async (client) => {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothTransactionsStarted;
        return fn(client);
      });
    },
  });
  try {
    const outcomes = await Promise.allSettled([
      runMigrations(gate(scopedFirst)),
      runMigrations(gate(scopedSecond)),
    ]);
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(failures.length, 0, failures.map((outcome) => outcome.reason.message).join('\n'));
    assert.deepEqual(
      outcomes.map((outcome) => outcome.value).sort((a, b) => a.length - b.length),
      [[], ['001_initial.sql', '002_stored-file-dimensions.sql', '003_login-throttle.sql', '004_message-outbox.sql', '005_checkin-records.sql', '006_tickets.sql', '007_attendee-access.sql', '008_organizations.sql']]
    );
  } finally {
    await Promise.all([scopedFirst.close(), scopedSecond.close()]);
    await isolated.drop();
  }
});

integration('postgres-health-and-migrations-are-idempotent', { timeout: 15000 }, async () => {
  const isolated = await createIsolatedMigrationSchema();
  const db = createDatabase({ connectionString: isolated.connectionString });
  try {
    const first = await db.migrate();
    const health = await db.query('SELECT 1 AS ok');
    assert.equal(Number(health.rows[0].ok), 1);
    assert.ok(first.includes('001_initial.sql'));
    assert.deepEqual(await db.migrate(), []);
  } finally {
    await db.close();
    await isolated.drop();
  }
});

integration('postgres-failed-migration-rolls-back-schema-and-applied-version', { timeout: 15000 }, async () => {
  const isolated = await createIsolatedMigrationSchema();
  const db = createDatabase({ connectionString: isolated.connectionString });
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-migrations-test-'));
  fs.writeFileSync(path.join(migrationsDir, '001_create-marker.sql'),
    'CREATE TABLE migration_marker (id integer NOT NULL);');
  fs.writeFileSync(path.join(migrationsDir, '002_fail-insert.sql'),
    "INSERT INTO migration_marker (id) VALUES ('not-an-integer');");
  try {
    await assert.rejects(runMigrations(db, migrationsDir), /invalid input syntax/i);
    const state = await db.query(`
      SELECT to_regclass('schema_migrations') AS migrations,
             to_regclass('migration_marker') AS marker
    `);
    assert.equal(state.rows[0].migrations, null);
    assert.equal(state.rows[0].marker, null);
  } finally {
    await db.close();
    await isolated.drop();
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }
});

integration('postgres-public-signup-survives-http-server-restart', { timeout: 15000 }, async () => {
  const isolated = await createIsolatedMigrationSchema();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-server-restart-test-'));
  const eventId = `restart-event-${crypto.randomUUID()}`;
  const slug = `restart-${crypto.randomUUID()}`;
  const connectionString = isolated.connectionString;
  let db = null;
  let server = null;
  let serverUrl = '';

  const start = async () => {
    server = createHttpServer(openStore(dataDir), createDatabaseAuth(db), createAccess(db), db);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    serverUrl = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server = null;
  };

  try {
    db = createDatabase({ connectionString });
    await db.migrate();
    await db.query('INSERT INTO events (id, slug, payload) VALUES ($1, $2, $3::jsonb)', [
      eventId,
      slug,
      JSON.stringify({ id: eventId, slug, name: '재시작 지속 행사', date: '2026-12-01', stage: 'READY', capacity: 10, features: [] }),
    ]);
    await db.query('INSERT INTO event_workspaces (event_id, payload) VALUES ($1, $2::jsonb)', [
      eventId,
      JSON.stringify({
        participants: [],
        registrationOpen: true,
        publishedVersion: 1,
        publishedFields: [
          { id: 'name', label: '이름', type: 'text', required: true, options: [] },
          { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
        ],
        consentText: '',
        consentVersion: 1,
      }),
    ]);
    await start();
    const signup = await requestJson(serverUrl, `/api/events/${slug}/signup`, {
      method: 'POST',
      body: {
        commandId: `restart-${crypto.randomUUID()}`,
        formVersion: 1,
        name: '재시작 후 참가자',
        phone: '01098765432',
      },
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.json));
    const ticket = signup.json.participant.ticket;
    await stop();
    await db.close();

    db = createDatabase({ connectionString });
    await db.migrate();
    await start();
    const persisted = await requestJson(serverUrl, `/api/public/events/${slug}/ticket`, { bearer: ticket });
    assert.equal(persisted.status, 200, JSON.stringify(persisted.json));
    assert.equal(persisted.json.participant.name, '재시작 후 참가자');
  } finally {
    await stop();
    if (db) await db.close();
    await isolated.drop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

integration('postgres-transaction-commits-and-rolls-back', { timeout: 15000 }, async () => {
  const db = createDatabase({ connectionString: databaseUrl });
  const committedKey = 'test-' + crypto.randomUUID();
  const rolledBackKey = 'test-' + crypto.randomUUID();
  try {
    await db.migrate();
    await db.transaction(async (client) => {
      await client.query(
        'INSERT INTO global_state (key, payload) VALUES ($1, $2::jsonb)',
        [committedKey, JSON.stringify({ ok: true })]
      );
    });
    const committed = await db.query('SELECT payload FROM global_state WHERE key = $1', [committedKey]);
    assert.deepEqual(committed.rows[0].payload, { ok: true });

    await assert.rejects(db.transaction(async (client) => {
      await client.query(
        'INSERT INTO global_state (key, payload) VALUES ($1, $2::jsonb)',
        [rolledBackKey, JSON.stringify({ shouldNotPersist: true })]
      );
      throw new Error('force rollback');
    }), /force rollback/);
    const rolledBack = await db.query('SELECT payload FROM global_state WHERE key = $1', [rolledBackKey]);
    assert.equal(rolledBack.rowCount, 0);
  } finally {
    await db.query('DELETE FROM global_state WHERE key = ANY($1::text[])', [[committedKey, rolledBackKey]]).catch(() => {});
    await db.close();
  }
});
