const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18777;
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;
let dataDir = null;

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-auth-'));
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: 'admin-test-pw',
    },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => {
  if (child) child.kill();
});

async function login(password) {
  return fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'admin', password }),
  });
}

function sessionCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  const match = /etko_session=([^;]+)/.exec(raw);
  return match ? `etko_session=${match[1]}` : '';
}

test('login-seeds-admin-and-sets-cookie', async () => {
  const res = await login('admin-test-pw');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.id, 'admin');
  assert.equal(body.user.role, 'AGENCY');
  assert.ok(sessionCookie(res), 'login must set a session cookie');
  assert.ok(!('hash' in body.user), 'user payload must not leak the hash');
});

test('login-rejects-bad-password-korean', async () => {
  const res = await login('wrong-pw');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error || '', /[가-힣]/);
});

test('me-needs-session', async () => {
  const anon = await fetch(`${BASE}/api/auth/me`);
  assert.equal(anon.status, 401);
  const cookie = sessionCookie(await login('admin-test-pw'));
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.id, 'admin');
});

test('logout-clears-session', async () => {
  const cookie = sessionCookie(await login('admin-test-pw'));
  const out = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 401);
});

test('tampered-cookie-rejected', async () => {
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: 'etko_session=deadbeef' } });
  assert.equal(me.status, 401);
});

test('expired-session-rejected', async () => {
  const cookie = sessionCookie(await login('admin-test-pw'));
  const sid = /^etko_session=(.+)$/.exec(cookie)[1];
  const file = path.join(dataDir, 'sessions.json');
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(sessions[sid], 'session must be stored server-side');
  sessions[sid].expiresAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(sessions));
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 401);
});

test('no-default-admin-without-env', () => {
  const auth = require('../server/auth.js');
  const store = require('../server/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-noadmin-'));
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ALLOW_DEV_DEFAULT_ADMIN;
  auth.ensureSeed(store.openStore(dir));
  const users = store.openStore(dir).read('users');
  assert.ok(!users.admin, 'no usable default admin without explicit opt-in');
});
