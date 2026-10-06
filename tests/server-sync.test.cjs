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

test('pull-remote-store-populates-workspaces', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = BASE;
  await ETKO.remote.post('/api/auth/login', { id: 'admin', password: 'pw' });
  ETKO.store = { events: [], workspaces: {}, activeEventId: null };
  const pulled = await ETKO.pullRemoteStore();
  assert.ok(pulled.events >= 1);
  assert.ok(ETKO.store.workspaces['evt-1'].participants.length >= 5);
  assert.ok(ETKO.store.activeEventId);
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

test('replay-pending-skips-without-session', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = 'http://127.0.0.1:18999';
  ETKO.serverSession = false;
  const r = await ETKO.replayPending('evt-1', [{ code: 'EVT-1001', direction: 'IN' }]);
  assert.deepEqual(r, { applied: 0, duplicates: 0, skipped: true });
});

test('replay-pending-applies-once-on-server', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = BASE;
  await ETKO.remote.post('/api/auth/login', { id: 'admin', password: 'pw' });
  ETKO.serverSession = true;
  const created = await ETKO.remote.post('/api/events', { name: '재전송적용', date: '2026-12-11', venue: 'K홀' });
  const id = created.event.id;
  const person = await ETKO.remote.post(`/api/events/${id}/signup`, { name: '적용손님', phone: '010-2222-0001' });
  const r = await ETKO.replayPending(id, [
    { code: person.participant.code, direction: 'IN' },
    { code: person.participant.code, direction: 'IN' },
  ]);
  assert.equal(r.applied, 1);
  assert.equal(r.duplicates, 1);
  const summary = await ETKO.remote.get(`/api/events/${id}/summary`);
  assert.equal(summary.summary.inside, 1);
});

test('checkin-sync-replays-to-server', async () => {
  for (const m of ['../app.js', '../features/agency.js', '../features/checkin.js', '../features/server-sync.js']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  for (const m of ['../app.js', '../features/agency.js', '../features/checkin.js', '../features/server-sync.js']) {
    require(m);
  }
  const ETKO = globalThis.ETKO;
  ETKO.remote.base = BASE;
  await ETKO.remote.post('/api/auth/login', { id: 'admin', password: 'pw' });
  ETKO.serverSession = true;
  const created = await ETKO.remote.post('/api/events', { name: '동기화연동', date: '2026-12-12', venue: 'L홀' });
  const id = created.event.id;
  const person = await ETKO.remote.post(`/api/events/${id}/signup`, { name: '연동손님', phone: '010-3333-0001' });
  ETKO.store.activeEventId = id;
  const state = {
    people: [{ id: 'lx', code: person.participant.code, status: 'registered', cancelled: false }],
    queue: [],
  };
  const scanned = ETKO.scan({ code: person.participant.code, direction: 'IN', online: false, state });
  assert.equal(scanned.key, 'queued');
  let replayCalls = 0;
  const realReplay = ETKO.replayPending.bind(ETKO);
  ETKO.replayPending = async function (eventId, pending) {
    replayCalls += 1;
    return realReplay(eventId, pending);
  };
  const handlers = {};
  const container = {
    innerHTML: '',
    querySelector(sel) {
      if (sel === '[data-sync]') return { addEventListener: (t, fn) => { handlers.sync = fn; } };
      return null;
    },
    querySelectorAll() { return []; },
  };
  ETKO.renderCheckin(container, state);
  assert.ok(handlers.sync, 'sync control must be wired');
  await handlers.sync.call({});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state.queue.length, 0, 'local queue must drain');
  assert.equal(replayCalls, 1, 'sync must replay once');
  const summary = await ETKO.remote.get(`/api/events/${id}/summary`);
  assert.equal(summary.summary.inside, 1);
});

test('replay-outbox-reports-partial-failures', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = BASE;
  await ETKO.remote.post('/api/auth/login', { id: 'admin', password: 'pw' });
  ETKO.serverSession = true;
  const created = await ETKO.remote.post('/api/events', { name: '부분재전송', date: '2026-12-13', venue: 'M홀' });
  const id = created.event.id;
  const person = await ETKO.remote.post(`/api/events/${id}/signup`, { name: '부분손님', phone: '010-4444-0001' });
  const r = await ETKO.replayOutbox(id, [
    { code: person.participant.code, direction: 'IN' },
    { code: 'EVT-0000', direction: 'IN' },
  ]);
  assert.equal(r.applied, 1);
  assert.equal(r.duplicates, 0);
  assert.equal(r.failed, 1);
  assert.ok(Array.isArray(r.errors) && r.errors.length === 1);
});

test('apply-boot-mode-derives-session-flag', async () => {
  const ETKO = loadSync();
  let pulls = 0;
  ETKO.pullRemoteStore = async () => { pulls += 1; return { events: 0, pulled: 0 }; };
  assert.equal(await ETKO.applyBootMode({ mode: 'server', user: { id: 'a' } }), 'server');
  assert.equal(ETKO.serverSession, true);
  assert.equal(pulls, 1);
  assert.equal(await ETKO.applyBootMode({ mode: 'login-needed' }), 'login-needed');
  assert.equal(ETKO.serverSession, false);
  assert.equal(ETKO.remoteAuth, 'login-needed');
  assert.equal(await ETKO.applyBootMode({ mode: 'demo' }), 'demo');
  assert.equal(ETKO.serverSession, false);
});

test('server boot moves a role off the denied agency home', async () => {
  const ETKO = loadSync();
  for (const m of ['../app.js', '../features/agency.js']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  delete globalThis.ETKO2;
  globalThis.ETKO = ETKO;
  require('../app.js');
  require('../features/agency.js');
  const E2 = globalThis.ETKO;
  E2.remote = ETKO.remote;
  E2.pullRemoteStore = async () => ({ events: 0, pulled: 0 });
  E2.applyBootMode = ETKO.applyBootMode;
  E2.store.role = 'STAFF';
  E2.currentView = 'agency-home';
  assert.equal(await E2.applyBootMode({ mode: 'server', user: { id: 's', role: 'STAFF' } }), 'server');
  assert.equal(E2.currentView, 'overview');
  E2.store.role = 'AGENCY';
  E2.currentView = 'agency-home';
  assert.equal(await E2.applyBootMode({ mode: 'server', user: { id: 'a', role: 'AGENCY' } }), 'server');
  assert.equal(E2.currentView, 'agency-home');
});

test('pull-preserves-local-team-members', async () => {
  const ETKO = loadSync();
  ETKO.remote.base = BASE;
  await ETKO.remote.post('/api/auth/login', { id: 'admin', password: 'pw' });
  ETKO.store = {
    events: [{ id: 'evt-1' }],
    workspaces: { 'evt-1': { members: [{ id: 'm1', name: '로컬팀' }] } },
    activeEventId: 'evt-1',
  };
  await ETKO.pullRemoteStore();
  assert.deepEqual(ETKO.store.workspaces['evt-1'].members, [{ id: 'm1', name: '로컬팀' }]);
  assert.ok(ETKO.store.workspaces['evt-1'].participants.length >= 5);
});
