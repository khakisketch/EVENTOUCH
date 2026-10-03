const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/persist.js', '../features/registration.js', '../features/engagement.js', '../features/media.js', '../features/content.js', '../features/stage.js', '../features/scenes.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

const GROUPS = ['CORE', 'POLL', 'QUIZ', 'QNA', 'DRAW', 'PHOTO'];

test('scene library holds 28 coded scenes in six groups', () => {
  const ETKO = fresh();
  assert.equal(ETKO.SCENES.length, 28);
  const codes = ETKO.SCENES.map((s) => s.code);
  assert.equal(new Set(codes).size, 28);
  assert.deepEqual(codes.map((c, i) => 'ST-' + String(i + 1).padStart(2, '0')), codes);
  ETKO.SCENES.forEach((s) => {
    assert.ok(GROUPS.indexOf(s.group) !== -1, s.id + ' group');
    assert.ok(s.id && s.name);
  });
  assert.equal(ETKO.sceneById('poll-result').name, '실시간 결과');
  assert.equal(ETKO.sceneById('no-such-scene'), null);
});

test('take carries the preview scene, refusal keeps the program scene', () => {
  const ETKO = fresh();
  const gate = { preview: 'LOGO', program: 'LOGO', disclose: [true, true], confirm: [true, true], scenePreview: 'qna-selected', sceneProgram: null };
  assert.equal(ETKO.applyTake(gate), true);
  assert.equal(gate.sceneProgram, 'qna-selected');
  const refused = { preview: 'BLACK', program: 'LOGO', disclose: [true, false], confirm: [true, true], scenePreview: 'poll-result', sceneProgram: 'brand-idle' };
  assert.equal(ETKO.applyTake(refused), false);
  assert.equal(refused.program, 'LOGO');
  assert.equal(refused.sceneProgram, 'brand-idle');
});

test('setPreviewScene validates against the library', () => {
  const ETKO = fresh();
  ETKO.stageState = { preview: 'LOGO', program: 'LOGO' };
  assert.equal(ETKO.setPreviewScene('poll-result'), 'poll-result');
  assert.equal(ETKO.stageState.scenePreview, 'poll-result');
  assert.throws(() => ETKO.setPreviewScene('no-such-scene'), /장면/);
});

function seedShowcase(ETKO) {
  const ws = ETKO.workspace();
  ws.poll = { title: '만족도 투표', options: ['만족', '보통'], votes: [{ participantId: 'p1', option: 0 }], status: 'OPEN' };
  ws.quiz = { title: '퀴즈', answer: '정답', answers: [{ participantId: 'p1', answer: '정답' }], status: 'CLOSED' };
  ws.qna.push({ id: 'q1', participantId: 'p1', question: '선택된 질문입니다', approved: true, selected: true });
  ws.qna.push({ id: 'q2', participantId: 'p1', question: '승인 질문입니다', approved: true, selected: false });
  ws.draw.winners.push({ participantId: 'p1', name: '김당첨', at: '2026-10-01T00:00:00.000Z' });
  ws.photos.push({ id: 'ph1', participantId: 'p1', caption: '현장', data: 'data:image/png;base64,iVBORw0KGgo=', status: 'APPROVED' });
  ws.program.push({ title: '개회식', time: '09:00', end: '09:30', location: 'A홀' });
  ws.notices.push({ title: '공지', body: '우천 시 B홀' });
}

test('program scenes render live workspace data', () => {
  const ETKO = fresh();
  seedShowcase(ETKO);
  const show = (scene) => {
    const box = { innerHTML: '' };
    ETKO.renderScreen(box, { preview: 'LOGO', program: 'LOGO', sceneProgram: scene });
    return box.innerHTML;
  };
  assert.match(show('brand-idle'), /EVENTOUCH 운영 샘플/);
  assert.match(show('poll-result'), /만족도 투표/);
  assert.match(show('poll-result'), /1표/);
  assert.match(show('quiz-answer'), /정답/);
  assert.match(show('qna-selected'), /선택된 질문입니다/);
  assert.match(show('qna-wall'), /승인 질문입니다/);
  assert.match(show('draw-winners'), /김당첨/);
  assert.match(show('photo-grid'), /<img/);
  assert.match(show('now-playing'), /개회식/);
  assert.match(show('announcement'), /우천 시 B홀/);
});

test('unknown scene program falls back to the legacy composite', () => {
  const ETKO = fresh();
  seedShowcase(ETKO);
  const box = { innerHTML: '' };
  ETKO.renderScreen(box, { preview: 'LOGO', program: 'LOGO', sceneProgram: 'no-such-scene' });
  assert.match(box.innerHTML, /선택된 질문입니다/);
  assert.match(box.innerHTML, /공개 사진 1장/);
});

test('stage controls offer the scene library', () => {
  const ETKO = fresh();
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.renderStage(box, { preview: 'LOGO', program: 'LOGO', disclose: [false, false], confirm: [false, false] });
  assert.match(box.innerHTML, /data-scene="poll-result"/);
  assert.match(box.innerHTML, /data-scene="draw-winner"/);
  assert.match(box.innerHTML, /ST-10/);
});
