const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  delete require.cache[require.resolve('../app.js')];
  delete require.cache[require.resolve('../features/agency.js')];
  delete require.cache[require.resolve('../features/participants.js')];
  delete require.cache[require.resolve('../features/checkin.js')];
  delete globalThis.ETKO;
  globalThis.window = undefined;
  require('../app.js');
  require('../features/agency.js');
  require('../features/participants.js');
  require('../features/checkin.js');
  return globalThis.ETKO;
}

test('empty second event shows empty directory, not seed sample', () => {
  const ETKO = fresh();
  ETKO.sample = { participants: [{ id: 'sx', name: '샘플', email: 's@x.kr', ticket: 'GENERAL', status: 'registered', code: 'EVT-9' }] };
  const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  assert.equal(ETKO.workspace().participants.length, 0);
  assert.equal(ETKO.peopleCounts().total, 0);
  assert.equal(ETKO.filterPeople({}).length, 0);
});

test('bulk check-in marks everIn for summary consistency', () => {
  const ETKO = fresh();
  ETKO.switchEvent('evt-1');
  ETKO.selectedIds.clear();
  ETKO.selectedIds.add('p1');
  ETKO.bulkCheckIn();
  const p = ETKO.workspace().participants.find((x) => x.id === 'p1');
  assert.equal(p.status, 'IN');
  assert.equal(p.everIn, true);
});
