'use strict';

// Only expired credential rows leave the database; the cleanup never takes the
// server down and stops cleanly.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createDatabase } = require('../server/db');
const { pruneExpiredCredentials, startCredentialPruning, challengeRetentionHours } = require('../server/expired-credentials');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

const databaseUrl = testDatabaseUrl();
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
const schema = `eventouch_prune_${crypto.randomUUID().replace(/-/g, '')}`;
let admin;
let database;

before(async () => {
  if (!databaseUrl) return;
  admin = createDatabase({ connectionString: databaseUrl, env: {} });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  database = createDatabase({ connectionString: url.toString(), env: {} });
  await database.migrate();
  await database.query("INSERT INTO accounts (id, email, name, role, password_hash) VALUES ('a1', 'a1@example.test', 'a1', 'AGENCY', 'x')");
  await database.query("INSERT INTO events (id, slug, payload, org_id) VALUES ('e1', 'e1', '{}'::jsonb, 'org-legacy')");
});
after(async () => {
  if (!databaseUrl) return;
  await database.close();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.close();
});

const PAST = "now() - interval '1 minute'";
const FUTURE = "now() + interval '1 hour'";
const keys = async (table, key) => (await database.query(`SELECT ${key} AS key FROM ${table} ORDER BY ${key}`)).rows.map((row) => row.key);

test('expired credential rows are removed and everything else survives', async () => {
  await database.query(`INSERT INTO sessions (token_hash, account_id, expires_at) VALUES
    ('s-old-1', 'a1', ${PAST}), ('s-old-2', 'a1', ${PAST}), ('s-old-3', 'a1', ${PAST}), ('s-live', 'a1', ${FUTURE})`);
  await database.query(`INSERT INTO attendee_sessions (token_hash, expires_at) VALUES ('v-old', ${PAST}), ('v-live', ${FUTURE})`);
  await database.query(`INSERT INTO attendee_grants (token_hash, event_id, phone, purpose, expires_at, consumed_at) VALUES
    ('g-old', 'e1', '01000000001', 'ENROLL', ${PAST}, NULL), ('g-used-live', 'e1', '01000000001', 'ENROLL', ${FUTURE}, now()),
    ('g-live', 'e1', '01000000001', 'ENROLL', ${FUTURE}, NULL)`);
  // p-counted is expired but still inside the send caps' counting window.
  await database.query(`INSERT INTO account_email_proofs (id, account_id, email, purpose, token_hash, expires_at, created_at) VALUES
    ('p-old', 'a1', 'a1@example.test', 'VERIFY', 'h1', ${PAST}, now() - interval '3 days'),
    ('p-counted', 'a1', 'a1@example.test', 'RECOVER', 'h2', ${PAST}, now() - interval '2 minutes'),
    ('p-live', 'a1', 'a1@example.test', 'VERIFY', 'h3', ${FUTURE}, now()),
    ('p-live-old', 'a1', 'a1@example.test', 'VERIFY', 'h4', ${FUTURE}, now() - interval '3 days')`);
  await database.query(`INSERT INTO attendee_challenges (id, event_id, phone, purpose, code_hash, expires_at, created_at)
    VALUES ('c-old', 'e1', '01000000001', 'ENROLL', 'x', now() - interval '3 days', now() - interval '3 days'),
      ('c-just-expired', 'e1', '01000000002', 'ENROLL', 'y', now() - interval '1 hour', now() - interval '2 hours')`);
  await database.query(`INSERT INTO command_receipts (command_id, event_id, actor_id, result, created_at)
    VALUES ('r-old', 'e1', 'a1', '{}'::jsonb, now() - interval '30 days')`);

  const removed = await pruneExpiredCredentials(database, { batchSize: 2 });

  assert.deepEqual(removed, { sessions: 3, attendee_sessions: 1, attendee_grants: 1, account_email_proofs: 1, attendee_challenges: 1 });
  assert.deepEqual(await keys('sessions', 'token_hash'), ['s-live']);
  assert.deepEqual(await keys('attendee_sessions', 'token_hash'), ['v-live']);
  assert.deepEqual(await keys('attendee_grants', 'token_hash'), ['g-live', 'g-used-live']);
  assert.deepEqual(await keys('account_email_proofs', 'id'), ['p-counted', 'p-live', 'p-live-old']);
  // A challenge keeps its phone for the grace period after it expires; only the stale one leaves.
  assert.deepEqual(await keys('attendee_challenges', 'id'), ['c-just-expired']);
  assert.deepEqual(await keys('command_receipts', 'command_id'), ['r-old']);
  assert.deepEqual(await keys('accounts', 'id'), ['a1']);
  assert.deepEqual(await keys('events', 'id'), ['e1']);
});

test('a row another request holds is skipped instead of waited for', async () => {
  await database.query(`INSERT INTO attendee_sessions (token_hash, expires_at) VALUES ('v-held', ${PAST}), ('v-free', ${PAST})`);
  await database.transaction(async (client) => {
    await client.query("SELECT 1 FROM attendee_sessions WHERE token_hash = 'v-held' FOR UPDATE");
    const outcome = await Promise.race([pruneExpiredCredentials(database), delay(3000, 'blocked', { ref: false })]);
    assert.equal(outcome.attendee_sessions, 1);
  });
  assert.deepEqual(await keys('attendee_sessions', 'token_hash'), ['v-held', 'v-live']);
  assert.equal((await pruneExpiredCredentials(database)).attendee_sessions, 1);
});

nodeTest('challenge retention accepts a sane window and ignores a nonsensical one', () => {
  assert.equal(challengeRetentionHours(undefined), 24);
  assert.equal(challengeRetentionHours(''), 24);
  assert.equal(challengeRetentionHours('6'), 6);
  assert.equal(challengeRetentionHours('720'), 720);
  assert.equal(challengeRetentionHours('0'), 24, 'a zero window would delete a row a daily cap still counts');
  assert.equal(challengeRetentionHours('-5'), 24);
  assert.equal(challengeRetentionHours('abc'), 24);
  assert.equal(challengeRetentionHours('100000'), 24);
});

nodeTest('failures are logged without their message and do not stop the other tables or later runs', async () => {
  const lines = [];
  const tables = [];
  const broken = {
    async query(text) {
      tables.push(/DELETE FROM (\w+)/.exec(text)[1]);
      throw Object.assign(new Error('private-person@example.test'), { code: '57014' });
    },
  };
  const pruning = startCredentialPruning(broken, { intervalMs: 20, write: (line) => lines.push(line) });
  await delay(90);
  await pruning.stop();
  assert.ok(tables.length >= 8, `ran at startup and again: ${tables.length}`);
  assert.deepEqual(tables.slice(0, 5), ['sessions', 'attendee_sessions', 'attendee_grants', 'account_email_proofs', 'attendee_challenges']);
  assert.equal(lines[0], '[eventouch] expired credential cleanup failed for sessions (57014)\n');
  assert.doesNotMatch(lines.join(''), /private/);
  const after = tables.length;
  await delay(60);
  assert.equal(tables.length, after, 'no run starts after stop');
});

nodeTest('runs start at once, repeat hourly by default, never overlap and stop waits for the current one', async () => {
  let calls = 0;
  let release;
  const slow = { query: () => { calls += 1; return new Promise((resolve) => { release = () => resolve({ rowCount: 1000 }); }); } };
  const intervals = [];
  const original = global.setInterval;
  global.setInterval = (fn, ms) => { intervals.push(ms); return original(fn, 10); };
  let pruning;
  try { pruning = startCredentialPruning(slow, { write: () => {} }); }
  finally { global.setInterval = original; }
  assert.deepEqual(intervals, [3600000]);
  await delay(50);
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = pruning.stop().then(() => { stopped = true; });
  await delay(10);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(calls, 1, 'a full batch does not continue after stop');
});
