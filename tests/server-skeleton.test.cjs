const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const PORT = 18776;
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

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
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => {
  if (child) child.kill();
});

test('health-returns-ok', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: 1 });
});

test('static-serves-index', async () => {
  const res = await fetch(`${BASE}/index.html`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /이벤터치 운영/);
});

test('unknown-api-404-korean', async () => {
  const res = await fetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error || '', /[가-힣]/);
});
