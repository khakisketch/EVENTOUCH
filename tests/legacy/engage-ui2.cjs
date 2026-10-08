const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/engagement.js', '../features/media.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('engagement mount renders Q&A moderation with approve and stage actions', () => {
  const ETKO = fresh();
  const q = ETKO.ask('p1', '음향 질문입니다');
  const box = { innerHTML: '' };
  ETKO.renderEngagement(box);
  assert.match(box.innerHTML, /음향 질문입니다/);
  assert.match(box.innerHTML, /data-qna-approve/);
  assert.match(box.innerHTML, /data-qna-stage/);
  assert.ok(q.id);
});

test('engagement mount renders draw, survey and photo moderation', () => {
  const ETKO = fresh();
  ETKO.workspace().survey = { title: '만족도', questions: ['q1'], open: true, responses: [] };
  const photo = ETKO.uploadPhoto('p1', { caption: '현장', data: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.ok(photo.id);
  const box = { innerHTML: '' };
  ETKO.renderEngagement(box);
  assert.match(box.innerHTML, /data-draw-start/);
  assert.match(box.innerHTML, /data-survey-toggle/);
  assert.match(box.innerHTML, /data-photo-approve/);
});

test('Q&A, draw, survey and photo sections expose state cues without replacing their actions', () => {
  const ETKO = fresh();
  ETKO.ask('p1', '음향 질문입니다');
  ETKO.workspace().survey = { title: '만족도', questions: ['q1'], open: true, responses: [] };
  ETKO.uploadPhoto('p1', { caption: '현장', data: 'data:image/png;base64,iVBORw0KGgo=' });
  const box = { innerHTML: '' };
  ETKO.renderEngagement(box);
  assert.match(box.innerHTML, /aria-label="질문과 답변 관리"[\s\S]*?data-engagement-status=/);
  assert.match(box.innerHTML, /aria-label="럭키드로우 관리"[\s\S]*?data-engagement-status=/);
  assert.match(box.innerHTML, /aria-label="만족도 관리"[\s\S]*?data-engagement-status=/);
  assert.match(box.innerHTML, /aria-label="사진 검토"[\s\S]*?data-engagement-status=/);
  assert.match(box.innerHTML, /data-qna-approve/);
  assert.match(box.innerHTML, /data-survey-toggle/);
  assert.match(box.innerHTML, /data-photo-approve/);
});
