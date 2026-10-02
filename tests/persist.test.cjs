const { test } = require('node:test');
const assert = require('node:assert/strict');

function memoryBackend() {
  let saved = null;
  return {
    get() { return saved; },
    set(v) { saved = String(v); },
    peek() { return saved; },
  };
}

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/persist.js', '../features/registration.js', '../features/booths.js', '../features/booth.js', '../features/checkin.js', '../features/desks.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('mutations auto-persist through the memory backend', () => {
  const ETKO = fresh();
  const backend = memoryBackend();
  ETKO.storeBackend = backend;
  const person = ETKO.registerSelf({ name: '보존참가', phone: '010-0000-0701' });
  const booth = ETKO.saveBooth({ name: '보존부스', capacity: 10, limit: 2, status: 'OPEN' });
  ETKO.stampSelf({ boothId: booth.id, participantId: person.id });
  const raw = backend.peek();
  assert.ok(raw, 'backend must hold a snapshot after mutations');
  const snap = JSON.parse(raw);
  assert.equal(snap.version, 1);
  assert.equal(snap.store.activeEventId, ETKO.store.activeEventId);
  assert.ok(snap.store.workspaces[ETKO.store.activeEventId].participants.some((p) => p.id === person.id));
  assert.equal(snap.store.workspaces[ETKO.store.activeEventId].visits.length, 1);
});

test('restore brings back participants, booths, visits, and bindings', () => {
  const ETKO = fresh();
  const backend = memoryBackend();
  ETKO.storeBackend = backend;
  const person = ETKO.registerSelf({ name: '복원참가', phone: '010-0000-0702' });
  const booth = ETKO.saveBooth({ name: '복원부스', capacity: 10, limit: 2, status: 'OPEN' });
  ETKO.stampSelf({ boothId: booth.id, participantId: person.id });
  ETKO.homeParticipantId = person.id;
  ETKO.touchStore();
  const raw = backend.peek();

  const ETKO2 = fresh();
  ETKO2.storeBackend = memoryBackend();
  assert.equal(ETKO2.restoreStore(raw), true);
  const ws = ETKO2.workspace();
  assert.ok(ws.participants.some((p) => p.name === '복원참가'));
  assert.ok(ws.booths.some((b) => b.name === '복원부스'));
  assert.equal(ws.visits.length, 1);
  assert.equal(ETKO2.homeParticipantId, person.id);
});

test('restore refuses corrupt or foreign snapshots', () => {
  const ETKO = fresh();
  ETKO.storeBackend = memoryBackend();
  const before = ETKO.store.activeEventId;
  assert.equal(ETKO.restoreStore('not-json{{{'), false);
  assert.equal(ETKO.restoreStore(JSON.stringify({ version: 1 })), false);
  assert.equal(ETKO.restoreStore(JSON.stringify({ version: 1, store: { events: [], workspaces: {}, activeEventId: 'evt-x' } })), false);
  assert.equal(ETKO.store.activeEventId, before);
});

test('check-in scans and desk records persist', () => {
  const ETKO = fresh();
  const backend = memoryBackend();
  ETKO.storeBackend = backend;
  const person = ETKO.registerSelf({ name: '스캔참가', phone: '010-0000-0703' });
  ETKO.scan({ code: person.code, direction: 'IN', online: true });
  const unit = ETKO.saveUnit({ name: '입구', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(unit.id);
  const snap = JSON.parse(backend.peek());
  const ws = snap.store.workspaces[ETKO.store.activeEventId];
  assert.ok(ws.participants.some((p) => p.id === person.id && p.status === 'IN'));
  assert.equal(snap.ui.activeUnitId, unit.id);
});
