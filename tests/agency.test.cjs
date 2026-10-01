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
