const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/desks.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('desk section lists units with add and select', () => {
  const ETKO = fresh();
  ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  const box = { innerHTML: '' };
  ETKO.renderDesks(box);
  assert.match(box.innerHTML, /A게이트/);
  assert.match(box.innerHTML, /data-unit-add/);
  assert.match(box.innerHTML, /data-unit-select/);
});

test('active unit selection validates existence', () => {
  const ETKO = fresh();
  assert.throws(() => ETKO.setActiveUnit('u-999'), /데스크를 찾을 수 없습니다/);
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  assert.equal(ETKO.setActiveUnit(u.id), u.id);
  assert.equal(ETKO.activeUnitId, u.id);
});

test('ticket submit prefers the active unit record', () => {
  const ETKO = fresh();
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(u.id);
  const r = ETKO.submitTicket(p.code, 'IN');
  assert.equal(r.key, 'success');
  assert.equal(ETKO.history().length, 1);
  assert.equal(ETKO.history()[0].unitId, u.id);
});

test('wrong-direction unit names the desk instead of claiming no record', () => {
  const ETKO = fresh();
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  const u = ETKO.saveUnit({ name: '퇴장게이트', action: 'OUT', mode: 'desk' });
  ETKO.setActiveUnit(u.id);
  const r = ETKO.submitTicket(p.code, 'IN');
  assert.equal(r.key, 'wrong-desk');
  assert.equal(r.unitName, '퇴장게이트');
  assert.match(ETKO.checkinMessage(r.key).title, /데스크/);
});

test('offline intake queues even with an active unit; deleted unit falls back to scan', () => {
  const ETKO = fresh();
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(u.id);
  ETKO.setOnline(false);
  const queued = ETKO.submitTicket(p.code, 'IN');
  assert.equal(queued.key, 'queued');
  ETKO.setOnline(true);
  ETKO.syncQueue();
  assert.equal(ETKO.workspace().participants.find((x) => x.id === p.id).status, 'IN');
  ETKO.workspace().units = [];
  const fallback = ETKO.submitTicket(p.code, 'OUT');
  assert.equal(fallback.key, 'success');
  assert.equal(ETKO.history().length, 0);
});

test('event switch clears the active unit', () => {
  const ETKO = fresh();
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(u.id);
  const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  assert.equal(ETKO.activeUnitId, null);
});

test('permission denial surfaces its own result, not not-found', () => {
  const ETKO = fresh();
  ETKO.setRole('VIEWER');
  const p = ETKO.workspace().participants[0];
  const ws = ETKO.workspace();
  ws.units.push({ id: 'u9', name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.activeUnitId = 'u9';
  const r = ETKO.submitTicket(p.code, 'IN');
  assert.equal(r.key, 'no-permission');
  assert.match(ETKO.checkinMessage(r.key).title, /권한/);
  ETKO.setRole('AGENCY');
});
