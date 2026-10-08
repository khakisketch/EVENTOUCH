const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/stage.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function seedAudience(ETKO) {
  const ws = ETKO.workspace();
  ws.qna.push({ id: 'q1', question: '내일 점심은 무엇입니까', approved: true, selected: true });
  ws.photos.push({ id: 'ph1', status: 'APPROVED' });
}

test('BLACK program shows only the blackout notice', () => {
  const ETKO = fresh();
  seedAudience(ETKO);
  const box = { innerHTML: '' };
  ETKO.renderScreen(box, { preview: 'BLACK', program: 'BLACK' });
  assert.match(box.innerHTML, /암전 중입니다/);
  assert.doesNotMatch(box.innerHTML, /내일 점심은 무엇입니까/);
  assert.doesNotMatch(box.innerHTML, /공개 사진/);
});

test('LOGO program keeps the selected question and photo count', () => {
  const ETKO = fresh();
  seedAudience(ETKO);
  const box = { innerHTML: '' };
  ETKO.renderScreen(box, { preview: 'LOGO', program: 'LOGO' });
  assert.match(box.innerHTML, /내일 점심은 무엇입니까/);
  assert.match(box.innerHTML, /공개 사진 1장/);
});
