'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDatabase } = require('../server/db');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

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

integration('postgres-health-and-migrations-are-idempotent', { timeout: 15000 }, async () => {
  const db = createDatabase({ connectionString: databaseUrl });
  try {
    const first = await db.migrate();
    const health = await db.query('SELECT 1 AS ok');
    assert.equal(Number(health.rows[0].ok), 1);
    assert.ok(first.includes('001_initial.sql'));
    assert.deepEqual(await db.migrate(), []);
  } finally {
    await db.close();
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
