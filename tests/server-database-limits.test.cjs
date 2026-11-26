'use strict';

// Session limits of the running API's pool: a stuck statement or an idle open
// transaction ends as an unconfirmed failure, while migrations and maintenance
// callers keep unlimited sessions.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { databaseConnectionOptions, apiSessionLimits } = require('../server/database-config');
const { createDatabase } = require('../server/db');
const {
  databaseUrl, startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { createDatabaseAuth } = require('../server/auth');
const { createAccess } = require('../server/access');
const { createHttpServer } = require('../server/server');
const { openStore } = require('../server/store');
const { isolatedTestEnvironment } = require('./helpers/test-provider-env.cjs');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
const SHORT = { EVENTOUCH_DB_STATEMENT_TIMEOUT_MS: '1000', EVENTOUCH_DB_IDLE_TRANSACTION_TIMEOUT_MS: '1000' };
const SHOW = "SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle";

nodeTest('API session limits have validated defaults and overrides', () => {
  assert.deepEqual(apiSessionLimits({}), { statement_timeout: 15000, idle_in_transaction_session_timeout: 30000 });
  assert.deepEqual(apiSessionLimits({ EVENTOUCH_DB_STATEMENT_TIMEOUT_MS: '20000', EVENTOUCH_DB_IDLE_TRANSACTION_TIMEOUT_MS: '600000' }),
    { statement_timeout: 20000, idle_in_transaction_session_timeout: 600000 });
  for (const name of Object.keys(SHORT)) {
    for (const value of ['0', '-1', '999', '600001', '1500.5', '15s', ' ']) {
      assert.throws(() => apiSessionLimits({ [name]: value }), new RegExp(name), `${name}=${value}`);
    }
  }
});

nodeTest('only a caller that asks for API limits gets them', () => {
  const connectionString = 'postgres://test@db/app';
  const plain = databaseConnectionOptions({ connectionString, env: SHORT });
  assert.equal(plain.statement_timeout, undefined);
  assert.equal(plain.idle_in_transaction_session_timeout, undefined);
  const api = databaseConnectionOptions({ connectionString, env: SHORT, apiLimits: true });
  assert.equal(api.statement_timeout, 1000);
  assert.equal(api.idle_in_transaction_session_timeout, 1000);
});

const schema = `eventouch_limits_${crypto.randomUUID().replace(/-/g, '')}`;
let admin;
let limited;

function scopedUrl() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

before(async () => {
  if (!databaseUrl) return;
  admin = createDatabase({ connectionString: databaseUrl, env: {} });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  limited = createDatabase({ connectionString: scopedUrl(), env: SHORT, apiLimits: true });
  await limited.query('CREATE TABLE writes (id text PRIMARY KEY)');
});
after(async () => {
  if (!databaseUrl) return;
  await limited.close();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.close();
});

const written = async (id) => (await admin.query(`SELECT 1 FROM "${schema}".writes WHERE id = $1`, [id])).rowCount;
const unconfirmed = (code) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.status, undefined, 'no status means the HTTP layer answers 500');
  return true;
};

test('the API pool applies its limits and a maintenance pool keeps the server settings', async () => {
  const defaults = createDatabase({ connectionString: databaseUrl, env: {}, apiLimits: true });
  const maintenance = createDatabase({ connectionString: databaseUrl, env: SHORT });
  try {
    assert.deepEqual((await defaults.query(SHOW)).rows[0], { statement: '15s', idle: '30s' });
    assert.deepEqual((await limited.query(SHOW)).rows[0], { statement: '1s', idle: '1s' });
    assert.deepEqual((await maintenance.query(SHOW)).rows[0], (await admin.query(SHOW)).rows[0]);
  } finally {
    await defaults.close();
    await maintenance.close();
  }
});

test('a statement over the limit fails without a business status', async () => {
  await assert.rejects(limited.query('SELECT pg_sleep(3)'), unconfirmed('57014'));
});

test('a timed-out write is rolled back and the pool keeps working', async () => {
  await assert.rejects(limited.transaction(async (client) => {
    await client.query("INSERT INTO writes VALUES ('slow')");
    await client.query('SELECT pg_sleep(3)');
    return 'saved';
  }), unconfirmed('57014'));
  assert.equal(await written('slow'), 0);
  assert.equal((await limited.query('SELECT 1 AS ok')).rows[0].ok, 1);
});

test('a callback cannot turn a timeout into a business refusal or a success', async () => {
  await assert.rejects(limited.transaction(async (client) => {
    try { await client.query('SELECT pg_sleep(3)'); } catch (error) {
      throw Object.assign(new Error(error.message), { status: 403 });
    }
  }), unconfirmed('57014'));
  await assert.rejects(limited.transaction(async (client) => {
    await client.query("INSERT INTO writes VALUES ('swallowed')");
    await client.query('SELECT pg_sleep(3)').catch(() => {});
    return 'saved';
  }), unconfirmed('57014'));
  assert.equal(await written('swallowed'), 0);
});

test('a COMMIT that PostgreSQL answers with ROLLBACK is never a success', async () => {
  await assert.rejects(limited.transaction(async (client) => {
    await client.query("INSERT INTO writes VALUES ('aborted')");
    await client.query('SELECT 1/0').catch(() => {});
    return 'saved';
  }), unconfirmed('25P02'));
  assert.equal(await written('aborted'), 0);
});

test('a failure recovered through a savepoint still commits', async () => {
  const result = await limited.transaction(async (client) => {
    await client.query("INSERT INTO writes VALUES ('kept')");
    await client.query('SAVEPOINT optional');
    await client.query('SELECT pg_sleep(3)').catch(() => client.query('ROLLBACK TO SAVEPOINT optional'));
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.equal(await written('kept'), 1);
});

test('an idle open transaction is ended without crashing the process', async () => {
  await assert.rejects(limited.transaction(async (client) => {
    await client.query("INSERT INTO writes VALUES ('idle-then-query')");
    await delay(1800);
    await client.query('SELECT 1');
  }), unconfirmed('25P03'));
  await assert.rejects(limited.transaction(async (client) => {
    await client.query("INSERT INTO writes VALUES ('idle-then-return')");
    await delay(1800);
    return 'saved';
  }), unconfirmed('25P03'));
  assert.equal(await written('idle-then-query'), 0);
  assert.equal(await written('idle-then-return'), 0);
  assert.equal((await limited.query('SELECT 1 AS ok')).rows[0].ok, 1);
});

test('timed-out commands answer 500 and the same command id applies once afterwards', async () => {
  const harness = await startApiHarness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-limits-'));
  const lines = [];
  let database = null;
  let server = null;
  try {
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${(await harness.database.query('SELECT current_schema() AS name')).rows[0].name}`);
    database = createDatabase({ connectionString: url.toString(), env: SHORT, apiLimits: true });
    server = createHttpServer(openStore(dir), createDatabaseAuth(database), createAccess(database), database,
      { storageDir: path.join(dir, 'storage'), env: isolatedTestEnvironment(process.env), logWriter: (line) => lines.push(line) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await insertAccount(harness.database, { orgId: LEGACY_ORG, id: 'limit-owner', role: 'AGENCY', name: 'owner', email: 'limit-owner@example.test' });
    await insertEvent(harness.database, {
      orgId: LEGACY_ORG, id: 'limit-event', slug: 'limit-event',
      payload: { id: 'limit-event', slug: 'limit-event', stage: 'READY', capacity: 100, features: [] },
      workspace: { participants: [], checks: [], audit: [], registrationOpen: true, publishedVersion: 1, formVersion: 1, consentText: '',
        publishedFields: [{ id: 'name', label: '이름', type: 'text', required: true }, { id: 'phone', label: '연락처', type: 'tel', required: true }] },
    });
    const cookie = await sessionCookie(harness, 'limit-owner');
    const create = () => requestJson(base, '/api/events/limit-event/commands', { method: 'POST', cookie,
      body: { commandId: 'limit-create-0001', command: 'participant.create', payload: { name: '합성 참가자', phone: '01000000001', status: 'APPROVED' } } });
    const signup = () => requestJson(base, '/api/events/limit-event/signup', { method: 'POST',
      body: { commandId: 'limit-signup-0001', name: '합성 신청자', phone: '01000000002', formVersion: 1, consent: true } });
    const whileLocked = (sql, request) => harness.database.transaction(async (client) => {
      await client.query(sql);
      return request();
    });
    const people = async () => (await harness.database.query("SELECT payload FROM event_workspaces WHERE event_id = 'limit-event'")).rows[0].payload.participants.length;

    // The authority lookup normally rewrites its errors into 403.
    const authority = await whileLocked("SELECT 1 FROM accounts WHERE id = 'limit-owner' FOR UPDATE", create);
    assert.equal(authority.status, 500, JSON.stringify(authority.json));
    const busy = await whileLocked("SELECT 1 FROM events WHERE id = 'limit-event' FOR UPDATE", create);
    assert.equal(busy.status, 500, JSON.stringify(busy.json));
    const publicBusy = await whileLocked("SELECT 1 FROM events WHERE id = 'limit-event' FOR UPDATE", signup);
    assert.equal(publicBusy.status, 500, JSON.stringify(publicBusy.json));
    assert.equal(await people(), 0);
    assert.deepEqual(lines.map((line) => JSON.parse(line).code), ['57014', '57014', '57014']);

    for (const request of [create, signup]) {
      const first = await request();
      assert.ok([200, 201].includes(first.status), JSON.stringify(first.json));
      const again = await request();
      assert.ok([200, 201].includes(again.status), JSON.stringify(again.json));
    }
    assert.equal(await people(), 2);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (database) await database.close();
    await harness.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup migrates without the limits, serves with them and removes expired sessions', async () => {
  const name = `eventouch_startup_${crypto.randomUUID().replace(/-/g, '')}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-startup-'));
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${name}`);
  let database = null;
  let holder = null;
  let child = null;
  try {
    await admin.query(`CREATE SCHEMA "${name}"`);
    database = createDatabase({ connectionString: url.toString(), env: {} });
    await database.migrate();
    await database.query("INSERT INTO accounts (id, email, name, role, password_hash) VALUES ('a1', 'a1@example.test', 'a1', 'AGENCY', 'x')");
    await database.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ('old', 'a1', now() - interval '1 minute'), ('live', 'a1', now() + interval '1 hour')");
    // Make startup wait on the migration lock for longer than the API statement limit.
    holder = await admin.pool.connect();
    await holder.query('SELECT pg_advisory_lock(7319462041701)');
    const script = `const m = require('./server/server'); m.startServer().then(({ database, close }) => {
      database.query(${JSON.stringify(SHOW)}).then(result => process.send(result.rows[0]));
      process.once('message', () => close().then(() => process.exit(0), () => process.exit(1)));
    }).catch(() => process.exit(1));`;
    child = spawn(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { NODE_ENV: 'production', PORT: '0', EVENTOUCH_API_BIND: '127.0.0.1', DATABASE_URL: url.toString(), ...SHORT,
        DATA_DIR: path.join(dir, 'data'), STORAGE_DIR: path.join(dir, 'storage'), ADMIN_EMAIL: '', ADMIN_PASSWORD: '',
        EVENTOUCH_PUBLIC_URL: '', EVENTOUCH_SMS_MOCK: '1', EVENTOUCH_MAIL_MOCK: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const settings = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timed out')), 20000);
      child.once('message', (value) => { clearTimeout(timer); resolve(value); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited before listening: ${code}`)); });
    });
    settings.catch(() => {});
    let waiting = 0;
    for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
      waiting = (await admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())")).rowCount;
      if (!waiting) await delay(50);
    }
    assert.ok(waiting, 'startup reached the migration lock');
    await delay(1600);
    await holder.query('SELECT pg_advisory_unlock(7319462041701)');
    assert.deepEqual(await settings, { statement: '1s', idle: '1s' });
    let remaining = [];
    for (let attempt = 0; attempt < 100 && remaining.join() !== 'live'; attempt += 1) {
      remaining = (await database.query('SELECT token_hash FROM sessions ORDER BY token_hash')).rows.map((row) => row.token_hash);
      if (remaining.join() !== 'live') await delay(50);
    }
    assert.deepEqual(remaining, ['live']);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.send('stop');
    assert.equal(await exited, 0, 'shutdown completes cleanly');
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (holder) {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
    if (database) await database.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
