const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/booth.js', '../features/content.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('participant mount renders next action, schedule and ticket', () => {
  const ETKO = fresh();
  ETKO.saveProgram({ title: '개회식', time: '09:00', end: '09:30', location: 'A홀' });
  const box = { innerHTML: '' };
  ETKO.renderParticipant(box);
  assert.match(box.innerHTML, /data-home-cta/);
  assert.match(box.innerHTML, /개회식/);
  assert.match(box.innerHTML, /내 티켓/);
  assert.match(box.innerHTML, /EVT-1001/);
  assert.doesNotMatch(box.innerHTML, /minjun\.kim@example\.kr.*seoyeon|seoyeon\.lee@example\.kr.*minjun/);
});

test('empty roster shows signup guidance, stale detail falls back', () => {
  const ETKO = fresh();
  const id2 = ETKO.createEvent({ name: '빈행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  const box = { innerHTML: '' };
  ETKO.renderParticipant(box);
  assert.match(box.innerHTML, /참가 신청/);
  ETKO.homeParticipantId = 'ghost';
  const box2 = { innerHTML: '' };
  ETKO.renderParticipant(box2);
  assert.match(box2.innerHTML, /참가 신청/);
});
