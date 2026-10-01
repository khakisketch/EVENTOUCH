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

function resetEngagement() {
  ETKO.switchEvent('evt-1');
  var ws = ETKO.workspace();
  ws.poll = { title: '만족도 투표', options: ['만족', '보통'], votes: [], status: 'CLOSED' };
  ws.quiz = { title: '퀴즈', answer: '정답', answers: [], status: 'CLOSED' };
}

// Step 1 (brief): unknown participant cannot vote.
resetEngagement();
ETKO.setPollStatus('OPEN');
assert.throws(() => ETKO.vote('ghost', 0), /참가자를 찾을 수 없습니다/);

const { test } = require('node:test');

test('poll status toggles OPEN and CLOSED', () => {
  resetEngagement();
  assert.equal(ETKO.setPollStatus('OPEN'), 'OPEN');
  assert.equal(ETKO.workspace().poll.status, 'OPEN');
  assert.equal(ETKO.setPollStatus('CLOSED'), 'CLOSED');
  assert.equal(ETKO.workspace().poll.status, 'CLOSED');
});

test('voting on a closed poll throws', () => {
  resetEngagement();
  assert.throws(() => ETKO.vote('p1', 0), /투표가 마감되었습니다/);
});

test('one participant votes once; repeat throws', () => {
  resetEngagement();
  ETKO.setPollStatus('OPEN');
  ETKO.vote('p1', 0);
  assert.throws(() => ETKO.vote('p1', 1), /이미 투표했습니다/);
});

test('invalid option throws', () => {
  resetEngagement();
  ETKO.setPollStatus('OPEN');
  assert.throws(() => ETKO.vote('p1', 9), /선택지를 확인하세요/);
});

test('pollCounts tallies per option', () => {
  resetEngagement();
  ETKO.setPollStatus('OPEN');
  ETKO.vote('p1', 0);
  ETKO.vote('p2', 1);
  ETKO.vote('p3', 0);
  const result = ETKO.pollCounts();
  assert.deepEqual(result.counts, [2, 1]);
  assert.equal(result.total, 3);
});

test('quiz status toggles OPEN and CLOSED', () => {
  resetEngagement();
  assert.equal(ETKO.setQuizStatus('OPEN'), 'OPEN');
  assert.equal(ETKO.workspace().quiz.status, 'OPEN');
  assert.equal(ETKO.setQuizStatus('CLOSED'), 'CLOSED');
});

test('answering a closed quiz throws', () => {
  resetEngagement();
  assert.throws(() => ETKO.answerQuiz('p1', '정답'), /퀴즈가 마감되었습니다/);
});

test('quiz answer validates empty and 200-char limit', () => {
  resetEngagement();
  ETKO.setQuizStatus('OPEN');
  assert.throws(() => ETKO.answerQuiz('p1', '   '), /답변을 입력하세요/);
  assert.throws(() => ETKO.answerQuiz('p1', '가'.repeat(201)), /200자/);
});

test('quiz repeat answer throws', () => {
  resetEngagement();
  ETKO.setQuizStatus('OPEN');
  ETKO.answerQuiz('p1', '정답');
  assert.throws(() => ETKO.answerQuiz('p1', '정답'), /이미 답변했습니다/);
});

test('quiz unknown participant throws', () => {
  resetEngagement();
  ETKO.setQuizStatus('OPEN');
  assert.throws(() => ETKO.answerQuiz('ghost', '정답'), /참가자를 찾을 수 없습니다/);
});

test('revealQuiz closes the quiz and reveals the answer', () => {
  resetEngagement();
  ETKO.setQuizStatus('OPEN');
  ETKO.answerQuiz('p1', '오답');
  const answer = ETKO.revealQuiz();
  assert.equal(answer, '정답');
  assert.equal(ETKO.workspace().quiz.status, 'CLOSED');
  assert.throws(() => ETKO.answerQuiz('p2', '정답'), /퀴즈가 마감되었습니다/);
});
