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

test('session ends on event switch', () => {
  const ETKO = fresh();
  ETKO.saveMember({ name: '김인증', email: 'auth@example.kr', role: 'STAFF' });
  const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.login({ email: 'auth@example.kr' });
  assert.ok(ETKO.session());
  ETKO.switchEvent(id2);
  assert.equal(ETKO.session(), null);
});
