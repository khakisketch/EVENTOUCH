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
