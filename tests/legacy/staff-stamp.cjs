const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/persist.js', '../features/registration.js', '../features/booth.js', '../features/booths.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('STAFF mode shows staff-scan guidance instead of self controls', () => {
  const ETKO = fresh();
  ETKO.setEventBoothMode('STAFF', { acknowledge: true });
  ETKO.saveBooth({ name: '직원부스', capacity: 10, limit: 2, status: 'OPEN' });
  const person = ETKO.register({ name: '스태프참가', phone: '010-0000-0901' });
  const box = { innerHTML: '' };
  ETKO.renderStamps(box, person.id);
  assert.match(box.innerHTML, /직원에게 티켓을 보여주세요/);
  assert.doesNotMatch(box.innerHTML, /data-stamp-receive/);
  assert.doesNotMatch(box.innerHTML, /data-stamp-qr/);
  assert.match(box.innerHTML, /내 스탬프 0개/);
});

test('SELF mode keeps the QR input and receive control', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '셀프부스', capacity: 10, limit: 2, status: 'OPEN' });
  const person = ETKO.register({ name: '셀프참가', phone: '010-0000-0902' });
  const box = { innerHTML: '' };
  ETKO.renderStamps(box, person.id);
  assert.match(box.innerHTML, /data-stamp-qr/);
  assert.match(box.innerHTML, /data-stamp-receive/);
  assert.doesNotMatch(box.innerHTML, /직원에게 티켓을 보여주세요/);
});
