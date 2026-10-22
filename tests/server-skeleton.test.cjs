const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../server/db');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

const PORT = 18776;
const BASE = `http://127.0.0.1:${PORT}`;
const databaseUrl = testDatabaseUrl();
const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
let child = null;
let db = null;
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
  if (!databaseUrl) return;
  db = createDatabase({ connectionString: databaseUrl });
  await db.migrate();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-skel-'));
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  if (db) await db.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health-returns-ok', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, 1);
  // The probe reports whether outbound messaging is actually connected, so an
  // operator can tell without sending a test message. With no provider
  // configured it must say false rather than implying a working integration.
  assert.equal(body.messaging, false);
});

test('readiness-checks-the-database-not-just-the-process', async () => {
  const res = await fetch(`${BASE}/api/readyz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, db: true });
});

test('unknown-api-404-korean', async () => {
  const res = await fetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error || '', /[가-힣]/);
});

// The Node server is API-only: the Next app (apps/web) is the sole UI.
// These paths must never serve repository or secret content, whether the
// retired static shell is still on disk or already deleted.
test('api-server-never-serves-repo-or-secret-files', async () => {
  for (const p of ['/server/auth.js', '/.git/config', '/Dockerfile', '/docker-compose.yml', '/vercel.json', '/.env', '/data/server/sessions.json']) {
    const res = await fetch(`${BASE}${p}`);
    assert.notEqual(res.status, 200, `${p} must not be served`);
  }
  // API errors stay JSON with Korean messages, never an HTML shell.
  const res = await fetch(`${BASE}/api/nope`);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
});

// The single bounded non-API exception: the old origin's /sw.js answers the
// retirement worker (same worker ships at apps/web/public/sw.js for the Next
// origin). It deletes only eventouch-shell-* caches and never caches again.
test('the-only-non-api-route-is-the-worker-retirement', async () => {
  const res = await fetch(`${BASE}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  const body = await res.text();
  assert.match(body, /eventouch-shell-/);
  assert.doesNotMatch(body, /addEventListener\('fetch'/);
});
