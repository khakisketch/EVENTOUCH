const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDatabase } = require('../server/db');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

const PORT = 18777;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'eventouch-auth-admin@example.test';
const databaseUrl = testDatabaseUrl();
let child = null;
let dataDir = null;
let db = null;
const integrationTest = databaseUrl
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

before(async () => {
  if (!databaseUrl) return;
  db = createDatabase({ connectionString: databaseUrl });
  await db.migrate();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-auth-'));
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      ADMIN_EMAIL,
      ADMIN_PASSWORD: 'admin-test-pw',
      COOKIE_SECURE: '1',
      SESSION_TTL_HOURS: '1',
    },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(async () => {
  if (child) child.kill();
  if (db) await db.close();
});

async function login(emailOrPassword, maybePassword) {
  const email = maybePassword === undefined ? ADMIN_EMAIL : emailOrPassword;
  const password = maybePassword === undefined ? emailOrPassword : maybePassword;
  return fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function sessionCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  const match = /etko_session=([^;]+)/.exec(raw);
  return match ? `etko_session=${match[1]}` : '';
}

integrationTest('email-login-uses-case-insensitive-account-and-hashed-database-session', async (t) => {
  if (!db) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL.toUpperCase(), password: 'admin-test-pw' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.user, {
    id: 'admin', email: ADMIN_EMAIL, name: '관리자', role: 'AGENCY',
  });
  const cookie = res.headers.get('set-cookie') || '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /; Secure/i);
  const token = /etko_session=([^;]+)/.exec(cookie)?.[1];
  assert.ok(token && token.length >= 40, 'session cookie contains an opaque high-entropy token');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const stored = await db.query('SELECT token_hash FROM sessions WHERE token_hash = $1', [tokenHash]);
  assert.equal(stored.rowCount, 1);
  assert.notEqual(stored.rows[0].token_hash, token);
  const passwordHash = await db.query('SELECT password_hash FROM accounts WHERE id = $1', ['admin']);
  assert.match(passwordHash.rows[0].password_hash, /^scrypt:/);
  assert.equal(JSON.stringify(body).includes('password_hash'), false);
});

integrationTest('invitation-link-acceptance-creates-manager-once-and-hides-token-hash', async () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const eventId = `invite-event-${crypto.randomUUID()}`;
  const email = `invite-${crypto.randomUUID()}@example.test`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.query(
    'INSERT INTO events (id, slug, payload) VALUES ($1, $2, $3::jsonb)',
    [eventId, `invite-${crypto.randomUUID()}`, JSON.stringify({ name: '테스트 행사' })]
  );
  await db.query(
    `INSERT INTO invitations (id, token_hash, email, name, role, event_id, payload, status, expires_at)
     VALUES ($1, $2, $3, $4, 'MANAGER', $5, '{}'::jsonb, 'PENDING', now() + interval '1 day')`,
    [`inv-${crypto.randomUUID()}`, tokenHash, email, '초대 매니저', eventId]
  );

  const lookup = await fetch(`${BASE}/api/auth/invitations/${token}`);
  assert.equal(lookup.status, 200);
  const invitation = (await lookup.json()).invitation;
  assert.deepEqual(
    { email: invitation.email, name: invitation.name, role: invitation.role, eventId: invitation.eventId },
    { email, name: '초대 매니저', role: 'MANAGER', eventId }
  );
  assert.equal(JSON.stringify(invitation).includes('token_hash'), false);

  const accepts = await Promise.all([1, 2].map(() => fetch(`${BASE}/api/auth/invitations/${token}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'invite-test-password' }),
  })));
  assert.deepEqual(accepts.map((response) => response.status).sort(), [201, 409]);
  const accepted = accepts.find((response) => response.status === 201);
  const replay = accepts.find((response) => response.status === 409);
  assert.equal(accepted.status, 201);
  const account = (await accepted.json()).account;
  assert.deepEqual(
    { email: account.email, name: account.name, role: account.role },
    { email, name: '초대 매니저', role: 'MANAGER' }
  );
  assert.equal(JSON.stringify(account).includes('password_hash'), false);
  const membership = await db.query(
    'SELECT account_id FROM memberships WHERE account_id = $1 AND event_id = $2',
    [account.id, eventId]
  );
  assert.equal(membership.rowCount, 1);
  assert.equal(replay.status, 409);
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'invite-test-password' }),
  });
  assert.equal(login.status, 200);
});

integrationTest('expired-invitation-cannot-be-looked-up-or-accepted', async () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.query(
    `INSERT INTO invitations (id, token_hash, email, name, role, payload, status, expires_at)
     VALUES ($1, $2, $3, '만료 초대', 'STAFF', '{}'::jsonb, 'PENDING', now() - interval '1 minute')`,
    [`inv-${crypto.randomUUID()}`, tokenHash, `expired-${crypto.randomUUID()}@example.test`]
  );
  const lookup = await fetch(`${BASE}/api/auth/invitations/${token}`);
  assert.equal(lookup.status, 410);
  const accept = await fetch(`${BASE}/api/auth/invitations/${token}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'invite-test-password' }),
  });
  assert.equal(accept.status, 410);
});

integrationTest('login-seeds-admin-and-sets-cookie', async () => {
  const res = await login('admin-test-pw');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.id, 'admin');
  assert.equal(body.user.role, 'AGENCY');
  assert.ok(sessionCookie(res), 'login must set a session cookie');
  assert.ok(!('hash' in body.user), 'user payload must not leak the hash');
});

integrationTest('login-rejects-bad-password-korean', async () => {
  const res = await login('wrong-pw');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error || '', /[가-힣]/);
});

integrationTest('login-rejects-password-over-limit', async () => {
  const res = await login(ADMIN_EMAIL, 'x'.repeat(201));
  assert.equal(res.status, 401);
});

integrationTest('unknown-email-and-wrong-password-return-the-same-login-denial', async () => {
  const wrongPassword = await login(ADMIN_EMAIL, 'wrong-password');
  const unknownEmail = await login(`unknown-${crypto.randomUUID()}@example.test`, 'wrong-password');
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(await wrongPassword.json(), await unknownEmail.json());
});

integrationTest('disabled-account-cannot-login-or-use-an-existing-session', async () => {
  const { hashPassword } = require('../server/auth');
  const email = `disabled-${crypto.randomUUID()}@example.test`;
  const id = `acct-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO accounts (id, email, name, role, password_hash, active)
     VALUES ($1, $2, '비활성 계정', 'MANAGER', $3, true)`,
    [id, email, hashPassword('disabled-test-password')]
  );
  const cookie = sessionCookie(await login(email, 'disabled-test-password'));
  assert.ok(cookie);
  await db.query('UPDATE accounts SET active = false WHERE id = $1', [id]);
  const denied = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  assert.equal(denied.status, 401);
  const loginDenied = await login(email, 'disabled-test-password');
  assert.equal(loginDenied.status, 401);
});

integrationTest('me-needs-session', async () => {
  const anon = await fetch(`${BASE}/api/auth/me`);
  assert.equal(anon.status, 401);
  const cookie = sessionCookie(await login('admin-test-pw'));
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.id, 'admin');
});

integrationTest('logout-clears-session', async () => {
  const cookie = sessionCookie(await login('admin-test-pw'));
  const out = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 401);
});

integrationTest('tampered-cookie-rejected', async () => {
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: 'etko_session=deadbeef' } });
  assert.equal(me.status, 401);
});

integrationTest('malformed-cookie-is-rejected-without-a-server-error', async () => {
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: 'etko_session=%E0%A4%A' } });
  assert.equal(me.status, 401);
});

integrationTest('expired-session-rejected', async () => {
  const cookie = sessionCookie(await login('admin-test-pw'));
  const token = /^etko_session=(.+)$/.exec(cookie)[1];
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expired = await db.query(
    "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
    [tokenHash]
  );
  assert.equal(expired.rowCount, 1, 'session must be stored by its hash');
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 401);
});

integrationTest('admin-seeding-does-not-duplicate-an-existing-agency-account', async () => {
  const { createDatabaseAuth } = require('../server/auth');
  const before = await db.query("SELECT count(*)::int AS count FROM accounts WHERE role = 'AGENCY'");
  assert.equal(await createDatabaseAuth(db).seedAdmin({}), 'existing');
  const after = await db.query("SELECT count(*)::int AS count FROM accounts WHERE role = 'AGENCY'");
  assert.equal(after.rows[0].count, before.rows[0].count);
});

nodeTest('admin-is-not-created-without-explicit-environment-credentials', async () => {
  const { createDatabaseAuth } = require('../server/auth');
  const database = {
    async query() { return { rows: [], rowCount: 0 }; },
    async transaction() { throw new Error('an unconfigured seed must not write'); },
  };
  assert.equal(await createDatabaseAuth(database).seedAdmin({}), 'unconfigured');
});

integrationTest('malformed-admin-configuration-is-rejected', async () => {
  const { createDatabaseAuth } = require('../server/auth');
  await assert.rejects(
    createDatabaseAuth(db).seedAdmin({ ADMIN_EMAIL, ADMIN_PASSWORD: 'short' }),
    /ADMIN_EMAIL.*ADMIN_PASSWORD/
  );
});
