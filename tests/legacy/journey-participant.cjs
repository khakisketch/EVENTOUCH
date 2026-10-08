const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/booth.js', '../features/registration.js', '../features/results.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('participant journey: register, scan IN with Korean copy, next action flips, duplicate warns', () => {
  const ETKO = fresh();
  const id = ETKO.createEvent({ name: '참가자여정', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id);
  const p = ETKO.register({ name: '박참가', phone: '010-0000-0009' });
  assert.equal(ETKO.nextAction(p.status), '부스 QR을 스캔해주세요');
  const first = ETKO.scan({ code: p.code });
  assert.equal(first.key, 'success');
  assert.match(ETKO.checkinMessage(first.key).title, /처리/);
  const entered = ETKO.workspace().participants.find((x) => x.id === p.id);
  assert.equal(ETKO.nextAction(entered.status), '입장이 완료되었습니다');
  const dup = ETKO.scan({ code: p.code });
  assert.equal(dup.key, 'duplicate');
  assert.match(ETKO.checkinMessage(dup.key).title, /이미 처리/);
  const summary = ETKO.eventSummary();
  assert.equal(summary.inside, 1);
  assert.equal(summary.checked, 1);
});
