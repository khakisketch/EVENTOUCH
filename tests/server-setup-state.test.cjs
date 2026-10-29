const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../server/db');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

const PORT = 18795;
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_SCHEMA = 'eventouch_setup_state_schema';
const databaseUrl = testDatabaseUrl();
let child = null;
let db = null;
let dataDir = null;
let storageDir = null;

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

// Scopes the connection at a schema that holds the product tables but no
// AGENCY account, which is exactly the state of a brand-new install that has
// been migrated but not yet configured.
function scopedUrl() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${SETUP_SCHEMA}`);
  return url.toString();
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
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
      STORAGE_DIR: storageDir,
      // The server must see the same schema the assertions query, otherwise
      // it reads a different accounts table entirely.
      DATABASE_URL: scopedUrl(),
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '',
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

before(async () => {
  if (!databaseUrl) return;
  db = createDatabase({ connectionString: scopedUrl() });
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${SETUP_SCHEMA}`);
  await db.migrate();
  // Make sure no AGENCY account exists in this schema: that is the
  // unconfigured state under test.
  await db.query("DELETE FROM accounts WHERE role = 'AGENCY'");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-setup-'));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-setup-storage-'));
  await startServer();
});

after(async () => {
  await stopServer();
  if (db) {
    await db.query(`DROP SCHEMA IF EXISTS ${SETUP_SCHEMA} CASCADE`);
    await db.close();
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
});

test('a-fresh-install-reports-that-it-has-no-administrator', async () => {
  const res = await fetch(`${BASE}/api/auth/setup-state`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ready: false, administratorConfigured: false });
  // No administrator exists yet, so there is no reset contact to publish.
  const help = await fetch(`${BASE}/api/auth/help`);
  assert.equal(help.status, 200);
  assert.deepEqual(await help.json(), { administrator: null });
});

test('the-setup-probe-requires-no-session', async () => {
  // It must be readable before login, or it cannot help anyone log in.
  const res = await fetch(`${BASE}/api/auth/setup-state`);
  assert.equal(res.status, 200, 'an anonymous client can read the install state');
});

test('a-login-attempt-on-an-unconfigured-install-says-what-is-actually-wrong', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'anyone@example.test', password: 'any-password' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.setupRequired, true);
  assert.match(body.error, /운영자 계정이 아직 설정되지 않았습니다/);
  // It must not read as a credential problem.
  assert.doesNotMatch(body.error, /비밀번호를 확인하세요/);
});

test('creating-the-administrator-flips-the-install-state', async () => {
  const { hashPassword } = require('../server/auth');
  // Earlier cases deliberately failed logins, so clear the throttle counters
  // before asserting that a good credential works again.
  await db.query('DELETE FROM login_attempts');
  await db.query(
    `INSERT INTO accounts (id, email, name, role, password_hash)
     VALUES ('setup-admin', 'owner@example.test', 'Owner', 'AGENCY', $1)`,
    [hashPassword('setup-admin-password')]
  );
  await db.query(
    `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
     VALUES ('org-legacy', 'setup-admin', 'AGENCY', true, '[]'::jsonb)
     ON CONFLICT (org_id, account_id) DO NOTHING`
  );
  const res = await fetch(`${BASE}/api/auth/setup-state`);
  assert.deepEqual(await res.json(), { ready: true, administratorConfigured: true });

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'setup-admin-password' }),
  });
  assert.equal(login.status, 200, 'a configured install logs in normally again');
});

test('a-wrong-password-on-a-configured-install-is-still-an-ordinary-rejection', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'wrong-password' }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.setupRequired, undefined);
  assert.match(body.error, /비밀번호를 확인하세요/);
});

test('the-next-login-form-surfaces-the-setup-failure-instead-of-a-credential-error', () => {
  // The retired vanilla server-presentation.js rendered an explicit setup
  // notice; the sole UI is apps/web now. The setup-required flag drives a
  // dedicated setup notice (never a wrong-password read), and credential or
  // transport failures use fixed actionable messages instead of rendering
  // server wording. The shared login posts to the same API and announces
  // failures via role=alert with focus moved to the summary.
  const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'app', 'login', 'LoginForm.tsx'), 'utf8');
  assert.match(source, /\/api\/auth\/login/);
  assert.match(source, /role="alert"/);
  assert.match(source, /data\?\.setupRequired === true/);
  assert.match(source, /이메일 또는 비밀번호가 일치하지 않습니다/);
  assert.doesNotMatch(source, /data\?\.error/, 'server wording is never rendered verbatim');
  assert.match(source, /\/api\/auth\/setup-state/);
  assert.match(source, /administratorConfigured === false/);
  assert.match(source, /설정 상태 다시 확인/);
  // The reset instruction is a disclosure: the contact appears only after
  // the operator asks for it, and the panel explains when none is configured.
  assert.match(source, /\/api\/auth\/help/);
  assert.match(source, /aria-expanded=\{resetOpen\}/);
  assert.match(source, /aria-controls="login-reset-help"/);
  assert.match(source, /재설정 요청/);
  assert.match(source, /mailto:\$\{administrator\.email\}/);
  assert.match(source, /등록된 관리자 연락처가 없습니다/);
  assert.match(source, /여러 조직에 속한 계정은 한 조직의 관리자가 재설정할 수 없습니다/);
});
