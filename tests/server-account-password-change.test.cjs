'use strict';

// Self-service password change (/api/auth/password) and the session ceiling.
// Runs against an isolated PostgreSQL test database only.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  sessionCookie,
  requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const CURRENT = 'not-a-real-test-password';
let harness = null;
let counter = 0;

function commandId() {
  return `cmd-${crypto.randomUUID().replace(/-/g, '')}`;
}

function change(cookie, body) {
  return requestJson(harness.baseUrl, '/api/auth/password', { cookie, method: 'POST', body });
}

function login(email, password) {
  return requestJson(harness.baseUrl, '/api/auth/login', { method: 'POST', body: { email, password } });
}

async function freshAccount(role = 'MANAGER') {
  counter += 1;
  const id = `pw-user-${counter}`;
  const email = `${id}@example.test`;
  await insertAccount(harness.database, { orgId: LEGACY_ORG, id, role, name: `계정${counter}`, email });
  return { id, email };
}

function hashOf(cookie) {
  const token = decodeURIComponent(/^etko_session=(.+)$/.exec(cookie)[1]);
  return crypto.createHash('sha256').update(token).digest('hex');
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  // Login reports "setup required" instead of 401 until an agency account exists.
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'pw-agency', role: 'AGENCY', name: '조직 관리자', email: 'pw-agency@example.test',
  });
});

after(async () => {
  if (harness) await harness.close();
});

test('a holder changes the password: new works, old does not, other sessions end, this one stays', async () => {
  const account = await freshAccount();
  const here = await sessionCookie(harness, account.id);
  const other = await sessionCookie(harness, account.id);
  const res = await change(here, { currentPassword: CURRENT, newPassword: 'brand-new-secret-1', commandId: commandId() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.sessionsRevoked, 1);
  assert.equal((await requestJson(harness.baseUrl, '/api/auth/me', { cookie: here })).status, 200);
  assert.equal((await requestJson(harness.baseUrl, '/api/auth/me', { cookie: other })).status, 401);
  assert.equal((await login(account.email, 'brand-new-secret-1')).status, 200);
  assert.equal((await login(account.email, CURRENT)).status, 401);
});

test('the response and the audit receipt never carry a password value', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  const id = commandId();
  const res = await change(cookie, { currentPassword: CURRENT, newPassword: 'secret-never-logged-9', commandId: id });
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.json).includes('secret-never-logged-9'));
  const receipt = await harness.database.query('SELECT actor_id, result FROM command_receipts WHERE command_id = $1', [id]);
  assert.equal(receipt.rowCount, 1);
  assert.equal(receipt.rows[0].actor_id, account.id);
  assert.equal(receipt.rows[0].result.command, 'account.password-change');
  const raw = JSON.stringify(receipt.rows[0].result);
  assert.ok(!raw.includes('secret-never-logged-9') && !raw.includes(CURRENT));
});

test('a wrong current password is refused with a field and changes nothing', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  const other = await sessionCookie(harness, account.id);
  const res = await change(cookie, { currentPassword: 'definitely-wrong-1', newPassword: 'brand-new-secret-2', commandId: commandId() });
  assert.equal(res.status, 401);
  assert.equal(res.json.field, 'currentPassword');
  assert.equal(res.json.code, undefined);
  assert.equal((await login(account.email, CURRENT)).status, 200);
  assert.equal((await requestJson(harness.baseUrl, '/api/auth/me', { cookie: other })).status, 200);
});

test('the existing password rule applies and the new password must differ', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  const short = await change(cookie, { currentPassword: CURRENT, newPassword: 'short', commandId: commandId() });
  assert.equal(short.status, 400);
  assert.equal(short.json.field, 'newPassword');
  const long = await change(cookie, { currentPassword: CURRENT, newPassword: 'x'.repeat(201), commandId: commandId() });
  assert.equal(long.status, 400);
  const same = await change(cookie, { currentPassword: CURRENT, newPassword: CURRENT, commandId: commandId() });
  assert.equal(same.status, 400);
  assert.equal(same.json.field, 'newPassword');
  const missingCommand = await change(cookie, { currentPassword: CURRENT, newPassword: 'brand-new-secret-3' });
  assert.equal(missingCommand.status, 400);
  assert.equal(missingCommand.json.field, 'commandId');
});

test('a signed-out request is refused', async () => {
  const res = await change(undefined, { currentPassword: CURRENT, newPassword: 'brand-new-secret-4', commandId: commandId() });
  assert.equal(res.status, 401);
});

test('the same command id replays once and refuses a different new password', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  const id = commandId();
  const first = await change(cookie, { currentPassword: CURRENT, newPassword: 'brand-new-secret-5', commandId: id });
  assert.equal(first.status, 200);
  assert.equal(first.json.replayed, false);
  // A retry after a lost response still carries the OLD current password.
  const replay = await change(cookie, { currentPassword: CURRENT, newPassword: 'brand-new-secret-5', commandId: id });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  const conflict = await change(cookie, { currentPassword: 'brand-new-secret-5', newPassword: 'another-secret-55', commandId: id });
  assert.equal(conflict.status, 409);
  assert.equal((await login(account.email, 'brand-new-secret-5')).status, 200);
});

test('another account cannot replay a command id', async () => {
  const a = await freshAccount();
  const b = await freshAccount();
  const id = commandId();
  assert.equal((await change(await sessionCookie(harness, a.id), { currentPassword: CURRENT, newPassword: 'brand-new-secret-6', commandId: id })).status, 200);
  const res = await change(await sessionCookie(harness, b.id), { currentPassword: CURRENT, newPassword: 'brand-new-secret-6', commandId: id });
  assert.equal(res.status, 409);
  assert.equal((await login(b.email, CURRENT)).status, 200);
});

test('repeated wrong current passwords are throttled like login, without locking login', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  let blocked = null;
  for (let attempt = 0; attempt < 8 && !blocked; attempt += 1) {
    const res = await change(cookie, { currentPassword: `wrong-password-${attempt}`, newPassword: 'brand-new-secret-7', commandId: commandId() });
    if (res.status === 429) blocked = res;
    else assert.equal(res.status, 401);
  }
  assert.ok(blocked, 'five failures must block further attempts');
  assert.ok(blocked.json.retryAfterSeconds > 0);
  // Even the right password is refused while blocked.
  const refused = await change(cookie, { currentPassword: CURRENT, newPassword: 'brand-new-secret-7', commandId: commandId() });
  assert.equal(refused.status, 429);
  // The login form for the same account is a separate counter.
  assert.equal((await login(account.email, CURRENT)).status, 200);
});

test('a success clears the failure counter', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await change(cookie, { currentPassword: `wrong-password-${attempt}`, newPassword: 'brand-new-secret-8', commandId: commandId() })).status, 401);
  }
  assert.equal((await change(cookie, { currentPassword: CURRENT, newPassword: 'brand-new-secret-8', commandId: commandId() })).status, 200);
  const rows = await harness.database.query("SELECT 1 FROM login_attempts WHERE key = $1", [`pw:${account.id}`]);
  assert.equal(rows.rowCount, 0);
});

test('outstanding recovery proofs are retired by a password change', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  await harness.database.query(
    `INSERT INTO account_email_proofs (id, account_id, email, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, 'RECOVER', $4, now() + interval '1 hour')`,
    [`proof-${account.id}`, account.id, account.email, crypto.randomBytes(16).toString('hex')]
  ).catch(async () => {
    await harness.database.query(
      `INSERT INTO account_email_proofs (id, account_id, email, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, 'VERIFY', $4, now() + interval '1 hour')`,
      [`proof-${account.id}`, account.id, account.email, crypto.randomBytes(16).toString('hex')]
    );
  });
  assert.equal((await change(cookie, { currentPassword: CURRENT, newPassword: 'brand-new-secret-9', commandId: commandId() })).status, 200);
  const live = await harness.database.query('SELECT 1 FROM account_email_proofs WHERE account_id = $1 AND consumed_at IS NULL', [account.id]);
  assert.equal(live.rowCount, 0);
});

// ---- Absolute session ceiling (SESSION_MAX_DAYS, default 14) ----

async function ageSession(cookie, { createdAgo, expiresIn }) {
  await harness.database.query(
    `UPDATE sessions SET created_at = now() - $2::interval, expires_at = now() + $3::interval WHERE token_hash = $1`,
    [hashOf(cookie), createdAgo, expiresIn]
  );
}

test('sliding renewal never passes created_at + 14 days, and the cookie matches the clipped lifetime', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  await ageSession(cookie, { createdAgo: '13 days 23 hours 50 minutes', expiresIn: '5 minutes' });
  const me = await requestJson(harness.baseUrl, '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  const setCookie = me.headers.get('set-cookie') || '';
  const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
  assert.ok(maxAge > 400 && maxAge <= 600, `cookie Max-Age must follow the ceiling, got ${maxAge}`);
  const row = await harness.database.query(
    `SELECT EXTRACT(EPOCH FROM (expires_at - (created_at + interval '14 days')))::float8 AS over FROM sessions WHERE token_hash = $1`,
    [hashOf(cookie)]
  );
  assert.ok(Number(row.rows[0].over) <= 0.001, 'expires_at must not exceed the ceiling');
});

test('a session at its ceiling is not renewed again and sends no cookie refresh', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  await harness.database.query(
    `UPDATE sessions SET created_at = now() - interval '13 days 23 hours 50 minutes',
            expires_at = created_at + interval '14 days' WHERE token_hash = $1`,
    [hashOf(cookie)]
  );
  const before = await harness.database.query('SELECT expires_at FROM sessions WHERE token_hash = $1', [hashOf(cookie)]);
  const me = await requestJson(harness.baseUrl, '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('set-cookie'), null);
  const after = await harness.database.query('SELECT expires_at FROM sessions WHERE token_hash = $1', [hashOf(cookie)]);
  assert.equal(String(after.rows[0].expires_at), String(before.rows[0].expires_at));
});

test('a session older than 14 days stops authenticating even if its expiry is later', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  await ageSession(cookie, { createdAgo: '14 days 1 minute', expiresIn: '6 hours' });
  assert.equal((await requestJson(harness.baseUrl, '/api/auth/me', { cookie })).status, 401);
  // Signing in again starts a fresh session.
  assert.equal((await login(account.email, CURRENT)).status, 200);
});

test('a young session is renewed to a full lifetime as before', async () => {
  const account = await freshAccount();
  const cookie = await sessionCookie(harness, account.id);
  await ageSession(cookie, { createdAgo: '2 days', expiresIn: '10 minutes' });
  const me = await requestJson(harness.baseUrl, '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  const maxAge = Number(/Max-Age=(\d+)/.exec(me.headers.get('set-cookie') || '')?.[1]);
  assert.ok(maxAge > 12 * 3600 - 60 && maxAge <= 12 * 3600, `expected a full default TTL, got ${maxAge}`);
});
