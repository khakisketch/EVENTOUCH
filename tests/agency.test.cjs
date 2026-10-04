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

test('agency validation errors expose stable field identifiers without changing messages', () => {
  const cases = [
    ['event name', () => ETKO.createEvent({ name: '', date: '2026-10-10', venue: 'A홀' }), 'name', /행사 이름/],
    ['event date', () => ETKO.createEvent({ name: '날짜', date: '2026-02-30', venue: 'A홀' }), 'date', /날짜/],
    ['event venue', () => ETKO.createEvent({ name: '장소', date: '2026-10-10', venue: '' }), 'venue', /행사 장소/],
    ['client email', () => ETKO.saveClient({ name: '고객사', email: 'invalid' }), 'email', /이메일/],
    ['member role', () => ETKO.saveMember({ name: '담당자', email: 'person@example.kr', role: 'INVALID' }), 'role', /역할/],
  ];

  for (const [label, operation, field, message] of cases) {
    let error;
    try {
      operation();
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, label + ' must reject invalid input');
    assert.match(error.message, message, label + ' keeps the existing message');
    assert.equal(error.field, field, label + ' error must expose a stable field');
  }
});
