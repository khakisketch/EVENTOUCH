const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/registration.js', '../features/results.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('event setup journey: create empty, configure, register, reject duplicate and over-capacity', () => {
  const ETKO = fresh();
  const id = ETKO.createEvent({ name: '여정행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id);
  assert.equal(ETKO.peopleCounts().total, 0);
  ETKO.updateEvent({ capacity: 1 });
  const p = ETKO.register({ name: '김여정', phone: '010-0000-0001' });
  assert.ok(p.id);
  assert.throws(() => ETKO.register({ name: '김여정', phone: '010-0000-0001' }), /이미 등록/);
  assert.throws(() => ETKO.register({ name: '이여정', phone: '010-0000-0002' }), /마감/);
  assert.equal(ETKO.peopleCounts().total, 1);
  assert.equal(ETKO.eventSummary().total, 1);
  // Form versioning stays visible to the signup flow.
  const v1 = ETKO.workspace().formVersion;
  ETKO.setFields(ETKO.formFields().concat([{ id: 'memo', label: '메모', type: 'text', required: false, options: [] }]));
  assert.ok(ETKO.workspace().formVersion > v1);
  // Back on the seed event, the journey data must not leak.
  ETKO.switchEvent('evt-1');
  assert.ok(!ETKO.workspace().participants.some((x) => x && x.name === '김여정'));
});
