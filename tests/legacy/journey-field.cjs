const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/desks.js', '../features/results.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('field journey: unit setup, IN/OUT, offline queue sync, correction restores summary', () => {
  const ETKO = fresh();
  ETKO.switchEvent('evt-1');
  const target = ETKO.workspace().participants.find((p) => p.status !== 'IN');
  const inUnit = ETKO.saveUnit({ name: 'A게이트 입장', action: 'IN', mode: 'desk' });
  const outUnit = ETKO.saveUnit({ name: 'A게이트 퇴장', action: 'OUT', mode: 'desk' });
  const logIn = ETKO.recordScan({ participantId: target.id, action: 'IN', unitId: inUnit.id });
  assert.equal(ETKO.workspace().participants.find((p) => p.id === target.id).status, 'IN');
  assert.throws(() => ETKO.recordScan({ participantId: target.id, action: 'IN', unitId: inUnit.id }), /이미 처리/);
  const logOut = ETKO.recordScan({ participantId: target.id, action: 'OUT', unitId: outUnit.id });
  assert.equal(ETKO.workspace().participants.find((p) => p.id === target.id).status !== 'IN', true);
  // Only the latest log per participant can be corrected.
  assert.throws(() => ETKO.correctLog(logIn.id, '잘못된 정정 시도입니다'), /가장 최근/);
  ETKO.correctLog(logOut.id, '퇴장 기록 정정입니다');
  assert.equal(ETKO.workspace().participants.find((p) => p.id === target.id).status, 'IN');
  // Offline scan queues without mutating; sync applies exactly once.
  const other = ETKO.workspace().participants.find((p) => p.id !== target.id && p.status !== 'IN');
  const queued = ETKO.scan({ code: other.code, direction: 'IN', online: false });
  assert.equal(queued.key, 'queued');
  assert.equal(ETKO.workspace().participants.find((p) => p.id === other.id).status !== 'IN', true);
  ETKO.syncQueue();
  assert.equal(ETKO.workspace().participants.find((p) => p.id === other.id).status, 'IN');
  const summary = ETKO.eventSummary();
  assert.equal(summary.total, ETKO.peopleCounts().total);
});
