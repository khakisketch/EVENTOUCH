const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../server/db');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

const PORT = 18793;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'eventouch-throttle-admin@example.test';
const ADMIN_PASSWORD = 'throttle-admin-pw';
const VICTIM_EMAIL = 'eventouch-throttle-victim@example.test';
const VICTIM_PASSWORD = 'victim-account-pw';

// Deliberately small limits so the behaviour is observable without a test
// that has to issue hundreds of requests.
const ACCOUNT_LIMIT = '3';
const ADDRESS_LIMIT = '6';
const STALE_SCHEMA = 'eventouch_throttle_stale_schema';
const databaseUrl = testDatabaseUrl();
let child = null;
let db = null;
let dataDir = null;

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function startServer() {
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DATABASE_URL: databaseUrl,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      EVENTOUCH_LOGIN_ACCOUNT_LIMIT: ACCOUNT_LIMIT,
      EVENTOUCH_LOGIN_ADDRESS_LIMIT: ADDRESS_LIMIT,
      EVENTOUCH_LOGIN_WINDOW_MINUTES: '15',
    },
    stdio: 'ignore',
  });
  await waitForHealth();
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
  child = null;
}

async function resetThrottle() {
  await db.query('DELETE FROM login_attempts');
  await db.query('DELETE FROM login_lockout_overrides');
}

function loginRequest(email, password) {
  return fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  if (!databaseUrl) return;
  db = createDatabase({ connectionString: databaseUrl });
  await db.migrate();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-throttle-'));
  const { hashPassword } = require('../server/auth');
  // Both accounts are created explicitly rather than relying on ADMIN_EMAIL:
  // seedAdmin only fires when the database has no AGENCY account at all, and
  // this suite shares a database with other auth suites.
  await db.query(
    `INSERT INTO accounts (id, email, name, role, password_hash)
     VALUES ('throttle-victim', $1, 'Victim', 'MANAGER', $2)
     ON CONFLICT (id) DO NOTHING`,
    [VICTIM_EMAIL, hashPassword(VICTIM_PASSWORD)]
  );
  await db.query(
    `INSERT INTO accounts (id, email, name, role, password_hash)
     VALUES ('throttle-operator', $1, 'Operator', 'AGENCY', $2)
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD)]
  );
  await startServer();
  await resetThrottle();
});

after(async () => {
  await stopServer();
  if (db) {
    await db.query("DELETE FROM accounts WHERE id IN ('throttle-victim', 'throttle-operator')");
    await db.close();
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('correct-credentials-still-succeed-when-nothing-is-blocked', async () => {
  await resetThrottle();
  const res = await loginRequest(VICTIM_EMAIL, VICTIM_PASSWORD);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.email, VICTIM_EMAIL);
});

test('an-unknown-account-and-a-wrong-password-return-the-same-answer', async () => {
  await resetThrottle();
  const unknown = await loginRequest('nobody@example.test', 'whatever-password');
  const wrong = await loginRequest(VICTIM_EMAIL, 'definitely-wrong-pw');
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  // Identical wording: the endpoint must not confirm which emails exist.
  assert.deepEqual(await unknown.json(), await wrong.json());
});

test('repeated-wrong-passwords-block-that-account-and-then-answer-429', async () => {
  await resetThrottle();
  for (let attempt = 0; attempt < Number(ACCOUNT_LIMIT); attempt += 1) {
    const res = await loginRequest(VICTIM_EMAIL, 'definitely-wrong-pw');
    assert.equal(res.status, 401, `attempt ${attempt + 1} should be a plain rejection`);
  }
  const blocked = await loginRequest(VICTIM_EMAIL, 'definitely-wrong-pw');
  assert.equal(blocked.status, 429);
  assert.ok((await blocked.json()).retryAfterSeconds > 0);

  // Even the correct password is refused while the lockout holds.
  const correct = await loginRequest(VICTIM_EMAIL, VICTIM_PASSWORD);
  assert.equal(correct.status, 429);
});

test('a-successful-login-clears-that-accounts-failure-count', async () => {
  await resetThrottle();
  for (let attempt = 0; attempt < Number(ACCOUNT_LIMIT) - 1; attempt += 1) {
    await loginRequest(VICTIM_EMAIL, 'definitely-wrong-pw');
  }
  const ok = await loginRequest(VICTIM_EMAIL, VICTIM_PASSWORD);
  assert.equal(ok.status, 200);
  const remaining = await db.query(
    "SELECT failures FROM login_attempts WHERE scope = 'account' AND key = $1",
    [VICTIM_EMAIL]
  );
  assert.equal(remaining.rowCount, 0, 'a success wipes the recorded failures');
});

test('one-bad-login-for-many-different-accounts-still-trips-the-address-limit', async () => {
  await resetThrottle();
  for (let attempt = 0; attempt < Number(ADDRESS_LIMIT); attempt += 1) {
    const res = await loginRequest(`spray-${attempt}@example.test`, 'definitely-wrong-pw');
    assert.equal(res.status, 401, `spray ${attempt + 1} should be a plain rejection`);
  }
  const blocked = await loginRequest('spray-final@example.test', 'definitely-wrong-pw');
  assert.equal(blocked.status, 429, 'a password spray is bounded by client address');
});

test('the-lockout-message-does-not-reveal-that-a-lockout-is-in-effect', async () => {
  await resetThrottle();
  for (let attempt = 0; attempt < Number(ACCOUNT_LIMIT); attempt += 1) {
    await loginRequest(VICTIM_EMAIL, 'definitely-wrong-pw');
  }
  const res = await loginRequest(VICTIM_EMAIL, 'definitely-wrong-pw');
  const message = (await res.json()).error;
  assert.doesNotMatch(message, /잠금|blocked|lockout/i);
});

test('an-operator-can-release-a-lockout-without-waiting-it-out', async () => {
  await resetThrottle();
  for (let attempt = 0; attempt < Number(ACCOUNT_LIMIT); attempt += 1) {
    await loginRequest(VICTIM_EMAIL, 'definitely-wrong-pw');
  }
  assert.equal((await loginRequest(VICTIM_EMAIL, VICTIM_PASSWORD)).status, 429);

  const admin = await loginRequest(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(admin.status, 200, 'the operator account itself is not locked out');
  const cookie = admin.headers.getSetCookie()[0].split(';')[0];

  const released = await fetch(`${BASE}/api/auth/login-lockouts`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ scope: 'account', key: VICTIM_EMAIL }),
  });
  assert.equal(released.status, 200);

  const back = await loginRequest(VICTIM_EMAIL, VICTIM_PASSWORD);
  assert.equal(back.status, 200, 'the operator is not locked out by the escape hatch');
});

test('the-release-endpoint-refuses-anonymous-and-non-operator-callers', async () => {
  const anonymous = await fetch(`${BASE}/api/auth/login-lockouts`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'account', key: VICTIM_EMAIL }),
  });
  assert.equal(anonymous.status, 403);

  const victim = await loginRequest(VICTIM_EMAIL, VICTIM_PASSWORD);
  const victimCookie = victim.headers.getSetCookie()[0].split(';')[0];
  const nonOperator = await fetch(`${BASE}/api/auth/login-lockouts`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', cookie: victimCookie },
    body: JSON.stringify({ scope: 'account', key: ADMIN_EMAIL }),
  });
  assert.equal(nonOperator.status, 403, 'a MANAGER must not release lockouts');
});

test('throttle-configuration-is-read-from-the-environment-with-safe-bounds', () => {
  const { throttleSettings } = require('../server/auth');
  const defaults = throttleSettings({});
  assert.equal(defaults.account.limit, 5);
  assert.equal(defaults.address.limit, 20);
  // Out-of-range or non-integer values fall back rather than disabling limits.
  assert.equal(throttleSettings({ EVENTOUCH_LOGIN_ACCOUNT_LIMIT: '0' }).account.limit, 5);
  assert.equal(throttleSettings({ EVENTOUCH_LOGIN_ACCOUNT_LIMIT: '99999' }).account.limit, 5);
  assert.equal(throttleSettings({ EVENTOUCH_LOGIN_ACCOUNT_LIMIT: 'abc' }).account.limit, 5);
  assert.equal(throttleSettings({ EVENTOUCH_LOGIN_ACCOUNT_LIMIT: '2' }).account.limit, 2);
});

test('login-still-works-when-the-throttle-tables-are-absent', async () => {
  // A stale schema must degrade to "no throttling", never to "no login".
  // Locking operators out of their own product is a worse failure than the
  // attack the throttle exists to prevent.
  const { createDatabaseAuth } = require('../server/auth');
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-c search_path=${STALE_SCHEMA}`);
  const stale = createDatabase({ connectionString: scoped.toString() });
  try {
    // Models a database migrated through 002 but not 003: accounts exist,
    // the throttle tables do not.
    await stale.query('CREATE SCHEMA IF NOT EXISTS ' + STALE_SCHEMA);
    await stale.query('SET search_path TO ' + STALE_SCHEMA);
    await stale.query('DROP TABLE IF EXISTS accounts, login_attempts, login_lockout_overrides CASCADE');
    await stale.query(`CREATE TABLE accounts (
      id text PRIMARY KEY, email text NOT NULL, name text NOT NULL,
      role text NOT NULL, password_hash text NOT NULL, active boolean NOT NULL DEFAULT true)`);
    const { hashPassword } = require('../server/auth');
    await stale.query(
      'INSERT INTO accounts (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)',
      ['stale-victim', 'stale@example.test', 'Stale', 'MANAGER', hashPassword('stale-account-pw')]
    );
    const auth = createDatabaseAuth(stale);
    const state = await auth.throttleState({ socket: { remoteAddress: '127.0.0.1' } }, 'someone@example.test');
    assert.equal(state.blocked, false, 'a missing throttle table must not block or throw');
    assert.equal(await auth.authenticate('stale@example.test', 'irrelevant-password'), null,
      'credential checking still works without the throttle tables');
    assert.equal((await auth.authenticate('stale@example.test', 'stale-account-pw')).email, 'stale@example.test',
      'a real login still succeeds without the throttle tables');
  } finally {
    await stale.close();
  }
});