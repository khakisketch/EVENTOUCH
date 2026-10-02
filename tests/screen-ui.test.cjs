const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/stage.js', '../features/engagement.js', '../features/media.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('screen mount projects program output without controls or contacts', () => {
  const ETKO = fresh();
  ETKO.stageState = { preview: 'LOGO', program: 'HOLD', disclose: [true, true], confirm: [true, true] };
  const box = { innerHTML: '' };
  ETKO.renderScreen(box);
  assert.match(box.innerHTML, /잠시 대기해주세요/);
  assert.doesNotMatch(box.innerHTML, /<button/);
  assert.doesNotMatch(box.innerHTML, /<input/);
  assert.doesNotMatch(box.innerHTML, /<select/);
  assert.doesNotMatch(box.innerHTML, /<textarea/);
  assert.doesNotMatch(box.innerHTML, /<form/);
  assert.doesNotMatch(box.innerHTML, /<a[\s>]/);
  assert.doesNotMatch(box.innerHTML, /@/);
});

test('screen mount reflects take changes, selected question and photo count', () => {
  const ETKO = fresh();
  ETKO.stageState = { preview: 'BLACK', program: 'LOGO', disclose: [true, true], confirm: [true, true] };
  const q = ETKO.ask('p1', '내일 일정 질문입니다');
  ETKO.approveQna(q.id, true);
  ETKO.uploadPhoto('p1', { caption: '현장', data: 'data:image/png;base64,iVBORw0KGgo=' });
  const before = { innerHTML: '' };
  ETKO.renderScreen(before);
  assert.match(before.innerHTML, /선택된 질문이 없습니다/);
  ETKO.selectQna(q.id);
  ETKO.stageState.preview = 'BLACK';
  ETKO.applyTake(ETKO.stageState);
  ETKO.moderatePhotos(ETKO.workspace().photos.map((p) => p.id), 'APPROVED');
  const after = { innerHTML: '' };
  ETKO.renderScreen(after);
  assert.match(after.innerHTML, /암전 중입니다/);
  assert.doesNotMatch(after.innerHTML, /내일 일정 질문입니다/);
  assert.doesNotMatch(after.innerHTML, /공개 사진/);
});

test('unapproved selected question never projects', () => {
  const ETKO = fresh();
  ETKO.stageState = { preview: 'LOGO', program: 'LOGO', disclose: [true, true], confirm: [true, true] };
  ETKO.workspace().qna.push({ id: 'qx', participantId: 'p1', question: '주입된 질문', approved: false, selected: true });
  const box = { innerHTML: '' };
  ETKO.renderScreen(box);
  assert.match(box.innerHTML, /선택된 질문이 없습니다/);
  assert.doesNotMatch(box.innerHTML, /주입된 질문/);
});

test('screen renders safely without stage state or workspace', () => {
  const ETKO = fresh();
  delete ETKO.stageState;
  const box = { innerHTML: '' };
  ETKO.renderScreen(box);
  assert.match(box.innerHTML, /로고를 표시하고 있습니다/);
});
