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
