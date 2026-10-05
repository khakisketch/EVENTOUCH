const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18780;
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

function loadSync() {
  delete require.cache[require.resolve('../features/server-sync.js')];
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  require('../features/server-sync.js');
  return globalThis.ETKO;
}

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-sync-data-'));
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: 'pw' },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => {
  if (child) child.kill();
});

test('adapter-attaches-session', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = BASE;
  const login = await ETKO.remote.post('/api/auth/login', { id: 'admin', password: 'pw' });
  assert.equal(login.user.id, 'admin');
  const me = await ETKO.remote.get('/api/auth/me');
  assert.equal(me.user.role, 'AGENCY');
});

test('queue-replay-dedupes', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = BASE;
  await ETKO.remote.post('/api/auth/login', { id: 'admin', password: 'pw' });
  const created = await ETKO.remote.post('/api/events', { name: '재전송행사', date: '2026-12-07', venue: 'H홀' });
  const id = created.event.id;
  const person = await ETKO.remote.post(`/api/events/${id}/signup`, { name: '재전송손님', phone: '010-9999-0001' });
  const result = await ETKO.replayOutbox(id, [
    { code: person.participant.code, direction: 'IN' },
    { code: person.participant.code, direction: 'IN' },
  ]);
  assert.equal(result.applied, 1);
  assert.equal(result.duplicates, 1);
  const summary = await ETKO.remote.get(`/api/events/${id}/summary`);
  assert.equal(summary.summary.inside, 1);
});

test('unreachable-keeps-demo', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = 'http://127.0.0.1:18999';
  const mode = await ETKO.bootRemote();
  assert.equal(mode.mode, 'demo');
});

test('login-card-renders-and-submits', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = BASE;
  const fields = {};
  const handlers = {};
  const container = {
    innerHTML: '',
    querySelector(sel) {
      if (sel === '[data-login-id]') return fields.id;
      if (sel === '[data-login-password]') return fields.password;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-login-submit]') {
        return [
          { addEventListener: (t, fn) => { handlers.submit = fn; } },
        ];
      }
      return [];
    },
  };
  fields.id = { value: 'admin' };
  fields.password = { value: 'pw' };
  let done = null;
  ETKO.renderLoginInto(container, (user) => { done = user; });
  assert.match(container.innerHTML, /data-login-submit/);
  assert.match(container.innerHTML, /data-login-id/);
  await handlers.submit.call({});
  assert.equal(done && done.id, 'admin');
});
