const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
globalThis.ETKO = globalThis.ETKO || {};
try {
  globalThis.ETKO.sample = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'sample.json'), 'utf8')
  );
} catch (err) {}
require('../features/agency.js');
require('../features/engagement.js');

const ETKO = globalThis.ETKO;

// Step 1 (brief): no confirmed draw result exists on a fresh workspace.
assert.throws(() => ETKO.confirmDraw(), /확정할 당첨 결과/);

const { test } = require('node:test');

function resetEngagement2() {
  ETKO.switchEvent('evt-1');
  var ws = ETKO.workspace();
  ws.qna = [];
  ws.draw = { phase: 'IDLE', result: null, history: [], winners: [] };
  ws.survey = { title: '만족도 조사', questions: ['진행', '내용', '시설'], open: true };
  ws.responses = [];
  ws.participants.forEach(function (p) {
    if (!p) return;
    p.status = p.id === 'p3' || p.id === 'p4' ? 'IN' : 'registered';
  });
}

test('ask stores a question for a known participant', () => {
  resetEngagement2();
  var q = ETKO.ask('p1', '다음 세션 주제가 무엇인가요?');
  assert.equal(q.participantId, 'p1');
  assert.equal(q.question, '다음 세션 주제가 무엇인가요?');
  assert.equal(q.approved, false);
  assert.equal(ETKO.workspace().qna.length, 1);
});

test('ask validates participant, empty and 600-char limit', () => {
  resetEngagement2();
  assert.throws(() => ETKO.ask('ghost', '질문'), /참가자를 찾을 수 없습니다/);
  assert.throws(() => ETKO.ask('p1', '   '), /질문을 입력하세요/);
  assert.throws(() => ETKO.ask('p1', '가'.repeat(601)), /600자/);
});

test('selectQna requires approval first', () => {
  resetEngagement2();
  var q = ETKO.ask('p1', '질문입니다');
  assert.throws(() => ETKO.selectQna(q.id), /공개 승인한 질문만 선택할 수 있습니다/);
  ETKO.approveQna(q.id, true);
  var picked = ETKO.selectQna(q.id);
  assert.equal(picked.selected, true);
});

test('approveQna on unknown question throws', () => {
  resetEngagement2();
  assert.throws(() => ETKO.approveQna('q9', true), /질문을 찾을 수 없습니다/);
  assert.throws(() => ETKO.selectQna('q9'), /질문을 찾을 수 없습니다/);
});

test('startDraw pools IN participants only and throws when empty', () => {
  resetEngagement2();
  // Case-insensitive entered check: lowercase 'in' counts as entered.
  ETKO.workspace().participants.forEach(function (p) {
    if (p && p.id === 'p3') p.status = 'in';
  });
  var pool = ETKO.startDraw();
  assert.deepEqual(pool.slice().sort(), ['p3', 'p4']);
  ETKO.workspace().participants.forEach(function (p) {
    if (p) p.status = 'registered';
  });
  assert.throws(() => ETKO.startDraw(), /추첨 대상이 없습니다/);
});

test('resolveDraw uses injectable randomInt; confirmDraw records the winner', () => {
  resetEngagement2();
  ETKO.startDraw();
  var picked = ETKO.resolveDraw(function () {
    return 0;
  });
  assert.equal(picked.participantId, 'p3');
  var done = ETKO.confirmDraw();
  assert.equal(done.participantId, 'p3');
  var draw = ETKO.workspace().draw;
  assert.deepEqual(draw.winners, ['p3']);
  assert.equal(draw.history.length, 1);
  assert.equal(draw.result, null);
  assert.throws(() => ETKO.confirmDraw(), /확정할 당첨 결과/);
});

test('a confirmed winner leaves the next draw pool', () => {
  resetEngagement2();
  ETKO.startDraw();
  ETKO.resolveDraw(function () {
    return 0;
  });
  ETKO.confirmDraw();
  var pool = ETKO.startDraw();
  assert.deepEqual(pool, ['p4']);
});

test('submitSurvey validates length, range and repeat', () => {
  resetEngagement2();
  assert.throws(() => ETKO.submitSurvey('ghost', [5, 5, 5]), /참가자를 찾을 수 없습니다/);
  assert.throws(() => ETKO.submitSurvey('p1', [5, 5]), /문항/);
  assert.throws(() => ETKO.submitSurvey('p1', [5, 5, 6]), /점수/);
  assert.throws(() => ETKO.submitSurvey('p1', [5, 5, 2.5]), /점수/);
  var saved = ETKO.submitSurvey('p1', [5, 4, 3]);
  assert.deepEqual(saved.scores, [5, 4, 3]);
  assert.throws(() => ETKO.submitSurvey('p1', [5, 5, 5]), /이미 평가를 제출했습니다/);
});
