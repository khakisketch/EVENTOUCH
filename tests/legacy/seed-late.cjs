const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('seed event refills from late sample, new events stay empty', () => {
  const ETKO = fresh();
  // Simulate browser: seed workspace emptied before sample arrived.
  ETKO.switchEvent('evt-1');
  ETKO.workspace().participants = [];
  ETKO.workspace().seeded = false;
  ETKO.workspace().seedFromSample = true;
  ETKO.sample = { participants: [{ id: 's1', name: '샘플', email: 's@x.kr', ticket: 'GENERAL', status: 'IN', code: 'EVT-9' }] };
  ETKO.ensureSeeded();
  const filled = ETKO.workspace().participants;
  assert.equal(filled.length, 1);
  assert.equal(filled[0].everIn, true);
  // New events never seed from sample.
  const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  ETKO.ensureSeeded();
  assert.equal(ETKO.workspace().participants.length, 0);
});

test('workspace() auto-fills a flagged workspace without explicit call', () => {
  const ETKO = fresh();
  ETKO.switchEvent('evt-1');
  ETKO.workspace().participants = [];
  ETKO.workspace().seeded = false;
  ETKO.workspace().seedFromSample = true;
  ETKO.sample = { participants: [{ id: 's1', name: '샘플', email: 's@x.kr', ticket: 'GENERAL', status: 'registered', code: 'EVT-9' }] };
  assert.equal(ETKO.workspace().participants.length, 1);
  assert.equal(ETKO.workspace().participants.length, 1);
});
