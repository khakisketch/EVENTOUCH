const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  for (const m of ['../app.js','../features/agency.js','../features/desks.js','../features/engagement.js']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  delete globalThis.ETKO;
  require('../app.js');
  require('../features/agency.js');
  require('../features/desks.js');
  require('../features/engagement.js');
  return globalThis.ETKO;
}

test('closed survey rejects submissions', () => {
  const ETKO = fresh();
  ETKO.switchEvent('evt-1');
  ETKO.workspace().survey = { title: '만족도', questions: ['q1'], open: false };
  assert.throws(() => ETKO.submitSurvey('p1', [4]), /마감|설문/);
});

test('first-entry correction clears everIn', () => {
  const ETKO = fresh();
  ETKO.switchEvent('evt-1');
  const unit = ETKO.saveUnit({ name: '데스크', action: 'IN', mode: 'desk' });
  const target = ETKO.workspace().participants.find((p) => p.status !== 'IN');
  const log = ETKO.recordScan({ participantId: target.id, action: 'IN', unitId: unit.id });
  assert.equal(ETKO.workspace().participants.find((p) => p.id === target.id).everIn, true);
  ETKO.correctLog(log.id, '잘못된 입장 정정입니다');
  const after = ETKO.workspace().participants.find((p) => p.id === target.id);
  assert.equal(after.status, log.before);
  assert.equal(after.everIn, false);
});

test('unapproving a selected question clears selection', () => {
  const ETKO = fresh();
  ETKO.switchEvent('evt-1');
  const q = ETKO.ask('p1', '감사 질문');
  ETKO.approveQna(q.id, true);
  ETKO.selectQna(q.id);
  ETKO.approveQna(q.id, false);
  assert.equal(ETKO.workspace().qna[0].selected, false);
});
