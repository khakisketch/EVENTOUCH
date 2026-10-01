const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/integrations.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('demo login issues a token bound to the member record', () => {
  const ETKO = fresh();
  ETKO.saveMember({ name: '김인증', email: 'auth@example.kr', role: 'STAFF' });
  const s = ETKO.login({ email: 'auth@example.kr' });
  assert.match(s.token, /^DEMO-/);
  assert.equal(s.role, 'STAFF');
  assert.equal(s.demo, true);
  assert.deepEqual(ETKO.session().email, 'auth@example.kr');
});

test('unknown email and role mismatch are rejected in Korean', () => {
  const ETKO = fresh();
  assert.throws(() => ETKO.login({ email: 'nobody@example.kr' }), /등록된 구성원/);
  ETKO.saveMember({ name: '김인증', email: 'auth@example.kr', role: 'STAFF' });
  assert.throws(() => ETKO.login({ email: 'auth@example.kr', role: 'AGENCY' }), /권한/);
  ETKO.logout();
  assert.equal(ETKO.session(), null);
});
