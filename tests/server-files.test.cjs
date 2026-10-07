const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../server/db');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

const PORT = 18779;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'eventouch-auth-admin@example.test';
const databaseUrl = testDatabaseUrl();
const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
let child = null;
let dataDir = null;
let storageDir = null;
let adminCookie = '';
let db = null;

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-files-data-'));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-files-store-'));
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      STORAGE_DIR: storageDir,
      DATABASE_URL: databaseUrl,
      ADMIN_EMAIL,
      ADMIN_PASSWORD: 'admin-test-pw',
    },
    stdio: 'ignore',
  });
  await waitForHealth();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: 'admin-test-pw' }),
  });
  assert.equal(res.status, 200);
  const match = /etko_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
  assert.ok(match, 'admin login must work');
  adminCookie = `etko_session=${match[1]}`;
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  if (db) await db.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
});

async function upload(eventId, name, buffer, type, cookie) {
  return fetch(`${BASE}/api/events/${eventId}/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': type, ...(cookie ? { cookie } : {}) },
    body: buffer,
  });
}

test('upload-roundtrip', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  const up = await upload('evt-1', 'qr.png', png, 'image/png', adminCookie);
  assert.equal(up.status, 201);
  const meta = await up.json();
  assert.ok(meta.file && meta.file.key, 'upload must return a key');
  assert.ok(!meta.file.key.includes('..'), 'key must be traversal-free');
  const down = await fetch(`${BASE}/api/events/evt-1/files/${encodeURIComponent(meta.file.name)}`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await down.arrayBuffer()), png);
});

test('upload-rejects-oversize', async () => {
  const big = Buffer.alloc(9 * 1024 * 1024, 1);
  const up = await upload('evt-1', 'big.png', big, 'image/png', adminCookie);
  assert.equal(up.status, 413);
});

test('upload-rejects-traversal', async () => {
  const png = Buffer.from([1, 2, 3]);
  const up = await upload('evt-1', '../../evil.png', png, 'image/png', adminCookie);
  assert.ok([400, 201].includes(up.status));
  if (up.status === 201) {
    const meta = await up.json();
    assert.ok(!meta.file.key.includes('..'), 'stored key must stay inside storage');
    const stored = path.join(storageDir, meta.file.key);
    assert.ok(
      path.normalize(stored).startsWith(path.normalize(storageDir) + path.sep),
      'file must land inside STORAGE_DIR'
    );
  }
});

test('download-needs-session', async () => {
  const down = await fetch(`${BASE}/api/events/evt-1/files/nope.png`);
  assert.equal(down.status, 401);
});
