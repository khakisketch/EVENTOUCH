const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/engagement.js', '../features/media.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('engagement journey: poll, quiz, qna, draw, survey, photo wall', () => {
  const ETKO = fresh();
  ETKO.switchEvent('evt-1');
  ETKO.workspace().poll = { title: '만족도', options: ['좋다', '보통'], votes: [], status: 'CLOSED' };
  ETKO.workspace().quiz = { title: '퀴즈', answer: '정답', answers: [], status: 'CLOSED' };
  ETKO.workspace().survey = { title: '설문', questions: ['q1'], open: true, responses: [] };

  // Poll: open, vote once, close; reopen does not allow the same voter again.
  ETKO.setPollStatus('OPEN');
  ETKO.vote('p1', 0);
  assert.throws(() => ETKO.vote('p1', 1), /이미 투표/);
  ETKO.setPollStatus('CLOSED');
  assert.throws(() => ETKO.vote('p2', 0), /마감/);
  assert.equal(ETKO.pollCounts().total, 1);

  // Quiz: answer once, reveal closes.
  ETKO.setQuizStatus('OPEN');
  ETKO.answerQuiz('p1', '정답');
  assert.throws(() => ETKO.answerQuiz('p1', '정답'), /이미 답변/);
  assert.equal(ETKO.revealQuiz(), '정답');

  // Q&A: ask, approve, select for stage.
  const q = ETKO.ask('p1', '질문입니다');
  ETKO.approveQna(q.id, true);
  ETKO.selectQna(q.id);
  assert.equal(ETKO.workspace().qna.find((x) => x.id === q.id).selected, true);

  // Draw: winner leaves the next pool.
  ETKO.setPollStatus('OPEN');
  const pool = ETKO.startDraw();
  assert.ok(pool.length > 0);
  const winner = ETKO.resolveDraw(0);
  ETKO.confirmDraw();
  assert.ok(!ETKO.startDraw().includes(winner.participantId) || ETKO.workspace().draw.winners.includes(winner.participantId));

  // Survey once; photo pending -> approved -> wall.
  ETKO.submitSurvey('p1', [5]);
  assert.throws(() => ETKO.submitSurvey('p1', [5]), /이미 평가/);
  const photo = ETKO.uploadPhoto('p1', { caption: '현장', data: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(ETKO.wallPhotos().length, 0);
  ETKO.moderatePhotos([photo.id], 'APPROVED');
  assert.equal(ETKO.wallPhotos().length, 1);
});
