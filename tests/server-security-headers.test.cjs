const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../server/db');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');
const { contentSecurityPolicy } = require('../server/http');

const PORT = 18791;
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

async function startServer(env = {}) {
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DATABASE_URL: databaseUrl, ...env },
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
  db = createDatabase({ connectionString: databaseUrl });
  await db.migrate();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-headers-'));
  await startServer();
});

after(async () => {
  await stopServer();
  if (db) await db.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// The Node server is API-only; document and asset security for the product
// UI is audited against the running Next build (scripts/web-audit.cjs).
// These tests pin the API server's own headers without requiring the
// retired static shell.
test('every-api-response-carries-the-baseline-security-headers', async () => {
  for (const target of ['/api/health', '/api/nope', '/missing-file']) {
    const res = await fetch(`${BASE}${target}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${target} nosniff`);
    // SAMEORIGIN, not DENY: the participant-page preview frames the product's
    // own attendee route. Cross-origin framing stays blocked.
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', `${target} frame`);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', `${target} referrer`);
    assert.ok(res.headers.get('permissions-policy'), `${target} permissions-policy`);
    assert.ok(res.headers.get('content-security-policy'), `${target} csp`);
  }
});

test('the-405-method-rejection-also-carries-security-headers', async () => {
  const res = await fetch(`${BASE}/missing-file`, { method: 'DELETE' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(res.headers.get('content-security-policy'));
});

test('the-api-csp-locks-framing-base-uri-and-objects', async () => {
  const res = await fetch(`${BASE}/api/health`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp, /frame-ancestors \*|frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  // script-src must never fall back to unsafe-inline.
  assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});

test('each-api-response-issues-a-distinct-nonce', async () => {
  const first = await fetch(`${BASE}/api/health`);
  const second = await fetch(`${BASE}/api/health`);
  const nonceOf = (res) => /nonce-([^']+)'/.exec(res.headers.get('content-security-policy'))[1];
  assert.notEqual(nonceOf(first), nonceOf(second));
});

test('hsts-is-absent-on-http-and-present-under-cookie-secure', async () => {
  const insecure = await fetch(`${BASE}/api/health`);
  assert.equal(insecure.headers.get('strict-transport-security'), null);

  await stopServer();
  await startServer({ COOKIE_SECURE: '1' });
  const secure = await fetch(`${BASE}/api/health`);
  assert.match(secure.headers.get('strict-transport-security'), /max-age=31536000/);
});

test('csp-can-be-held-in-report-only-without-dropping-other-headers', async () => {
  await stopServer();
  await startServer({ EVENTOUCH_CSP_REPORT_ONLY: '1' });
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.headers.get('content-security-policy'), null);
  assert.ok(res.headers.get('content-security-policy-report-only'));
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  await stopServer();
  await startServer();
});

test('the-policy-builder-keeps-inline-style-but-never-inline-script', () => {
  const policy = contentSecurityPolicy('TESTNONCE');
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  assert.match(policy, /script-src 'self' 'nonce-TESTNONCE'/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
});