const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/desks.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('desk mount lists newest-first history with correction entries', () => {
  const ETKO = fresh();
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: u.id });
  const box = { innerHTML: '' };
  ETKO.renderDesks(box);
  assert.match(box.innerHTML, /A게이트/);
  assert.match(box.innerHTML, /data-correct-log/);
  assert.match(box.innerHTML, /data-correct-reason/);
});

test('correction click restores status, invalid reason surfaces Korean alert', () => {
  const ETKO = fresh();
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: u.id });
  const log = ETKO.history()[0];
  assert.throws(() => ETKO.correctLog(log.id, '짧'), /5자/);
  ETKO.correctLog(log.id, '잘못된 입장 정정입니다');
  const box = { innerHTML: '' };
  ETKO.renderDesks(box);
  assert.match(box.innerHTML, /정정됨/);
  assert.equal(ETKO.workspace().participants.find((x) => x.id === p.id).status, log.before);
});
