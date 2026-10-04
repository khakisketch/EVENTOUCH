const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
globalThis.ETKO = globalThis.ETKO || {};
try {
  globalThis.ETKO.sample = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'sample.json'), 'utf8')
  );
} catch (err) {}
require('../features/agency.js');

const ETKO = globalThis.ETKO;

test('unknown event switch throws a Korean error', () => {
  assert.throws(() => ETKO.switchEvent('nope'), /행사를 찾을 수 없습니다/);
});

test('role route table gates write routes', () => {
  assert.equal(ETKO.canRoute('VIEWER', 'checkin'), false);
  assert.equal(ETKO.canRoute('AGENCY', 'checkin'), true);
});

test('cross-event isolation: second event starts empty, first untouched', () => {
  const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  assert.deepEqual(ETKO.workspace().participants, []);
  ETKO.switchEvent('evt-1');
  assert.ok(ETKO.workspace().participants.length > 0);
});

test('event creation accepts only real YYYY-MM-DD calendar dates', () => {
  const before = ETKO.store.events.length;
  for (const date of ['2026-02-30', '2026-13-01', '2026-2-03', '20260228', '0000-01-01']) {
    assert.throws(
      () => ETKO.createEvent({ name: '날짜 검증', date, venue: 'A홀' }),
      /날짜/,
      `${date} must be rejected`
    );
  }
  assert.equal(ETKO.store.events.length, before, 'invalid dates must not create events');

  const leap = ETKO.createEvent({ name: '윤년', date: '2028-02-29', venue: 'B홀' });
  const nonLeap = ETKO.createEvent({ name: '평년', date: '2027-02-28', venue: 'C홀' });
  assert.equal(ETKO.store.events.find((event) => event.id === leap).date, '2028-02-29');
  assert.equal(ETKO.store.events.find((event) => event.id === nonLeap).date, '2027-02-28');
});
