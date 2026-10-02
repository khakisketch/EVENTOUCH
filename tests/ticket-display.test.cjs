const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/registration.js', '../features/booth.js', '../features/booths.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('participant ticket names the check-in code, event, and desk guidance', () => {
  const ETKO = fresh();
  const person = ETKO.registerSelf({ name: '티켓참가', phone: '010-0000-0301' });
  ETKO.homeParticipantId = person.id;
  const box = { innerHTML: '', querySelector() { return null; } };
  ETKO.renderParticipant(box);
  assert.match(box.innerHTML, /체크인 QR 코드/);
  assert.match(box.innerHTML, new RegExp(person.code));
  assert.match(box.innerHTML, /EVENTOUCH 운영 샘플/);
  assert.match(box.innerHTML, /입장 데스크에서 보여주세요/);
});

test('signup success names the check-in code and desk guidance', () => {
  const ETKO = fresh();
  ETKO.lastSignupTicket = 'EVT-1001';
  const box = { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
  ETKO.renderSignup(box);
  assert.match(box.innerHTML, /EVT-1001/);
  assert.match(box.innerHTML, /입장 데스크에서 보여주세요/);
  ETKO.lastSignupTicket = null;
});
