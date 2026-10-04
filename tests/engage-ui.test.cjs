const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/engagement.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('engagement mount renders poll management in Korean', () => {
  const ETKO = fresh();
  ETKO.workspace().poll = { title: '만족도 투표', options: ['좋다', '보통'], votes: [{ participantId: 'p1', option: 0 }], status: 'OPEN' };
  const box = { innerHTML: '' };
  ETKO.renderEngagement(box);
  assert.match(box.innerHTML, /만족도 투표/);
  assert.match(box.innerHTML, /진행 중/);
  assert.match(box.innerHTML, /data-poll-close/);
  assert.match(box.innerHTML, /좋다/);
});

test('poll and quiz statuses use distinct visible status cues', () => {
  const ETKO = fresh();
  ETKO.workspace().poll = { title: '만족도 투표', options: ['좋다'], votes: [], status: 'OPEN' };
  ETKO.workspace().quiz = { title: '오늘의 퀴즈', answer: '정답', answers: [], status: 'CLOSED' };
  const box = { innerHTML: '' };
  ETKO.renderEngagement(box);
  assert.match(box.innerHTML, /data-engagement-status="open"[^>]*>진행 중/);
  assert.match(box.innerHTML, /data-engagement-status="closed"[^>]*>마감/);
});

test('engagement mount renders quiz management with reveal', () => {
  const ETKO = fresh();
  ETKO.workspace().quiz = { title: '오늘의 퀴즈', answer: '정답', answers: [], status: 'OPEN' };
  const box = { innerHTML: '' };
  ETKO.renderEngagement(box);
  assert.match(box.innerHTML, /오늘의 퀴즈/);
  assert.match(box.innerHTML, /data-quiz-reveal/);
  ETKO.setQuizStatus('CLOSED');
  const box2 = { innerHTML: '' };
  ETKO.renderEngagement(box2);
  assert.match(box2.innerHTML, /마감/);
});

test('draw start leaves a candidate pending until resolve', () => {
  const ETKO = fresh();
  ETKO.startDraw();
  assert.equal(ETKO.workspace().draw.phase, 'READY');
  assert.equal(ETKO.workspace().draw.result, null);
  const box = { innerHTML: '' };
  ETKO.renderEngagement(box);
  assert.match(box.innerHTML, /당첨 후보: 미정/);
  assert.match(box.innerHTML, /data-draw-resolve/);
  ETKO.resolveDraw(0);
  const box2 = { innerHTML: '' };
  ETKO.renderEngagement(box2);
  assert.doesNotMatch(box2.innerHTML, /당첨 후보: 미정/);
});

test('survey toggle is role-gated and denial surfaces as alert', () => {
  const ETKO = fresh();
  ETKO.setRole('VIEWER');
  assert.throws(() => ETKO.setSurveyOpen(true), /권한/);
  ETKO.setRole('AGENCY');
  ETKO.lastEngageError = '설문이 마감되었습니다';
  const box = { innerHTML: '' };
  ETKO.renderEngagement(box);
  assert.match(box.innerHTML, /role="alert"/);
  assert.match(box.innerHTML, /설문이 마감되었습니다/);
});

test('poll toggle clicks flip status through wired handlers', () => {
  const ETKO = fresh();
  const handlers = {};
  const box = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel === '[data-poll-open]') return [{ addEventListener(t, fn) { handlers.open = fn; } }];
      if (sel === '[data-poll-close]') return [{ addEventListener(t, fn) { handlers.close = fn; } }];
      return [];
    },
    querySelector() { return null; },
  };
  ETKO.renderEngagement(box);
  assert.ok(handlers.open && handlers.close, 'poll handlers must wire');
  handlers.open();
  assert.equal(ETKO.workspace().poll.status, 'OPEN');
});
