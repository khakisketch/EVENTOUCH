'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attendanceNeedsReview, attendanceNotEntered, indexLatestChecks } = require('../apps/web/lib/attendance-state.cjs');

test('attendance classification preserves legacy absence and exposes ambiguous records', () => {
  const cases = [
    [{}, false, true],
    [{ inside: false, everIn: false }, false, true],
    [{ inside: false, everIn: true }, false, false],
    [{ inside: true, everIn: true }, false, false],
    [{ inside: null, everIn: false }, true, false],
    [{ inside: false, everIn: null }, true, false],
    [{ inside: true, everIn: false }, true, false],
    [{ inside: true }, true, false],
    [{ inside: 'false', everIn: false }, true, false],
    [{ inside: false, everIn: false, attendanceReview: true }, true, false],
  ];
  for (const [person, review, notEntered] of cases) {
    assert.equal(attendanceNeedsReview(person), review, JSON.stringify(person));
    assert.equal(attendanceNotEntered(person), notEntered, JSON.stringify(person));
  }
});

test('latest uncorrected history exposes contradictions without inferring missing history', () => {
  const person = { id: 'a', inside: false, everIn: true };
  const latest = indexLatestChecks([
    { participantId: 'a', action: 'IN', corrected: true },
    { participantId: 'a', action: 'IN', corrected: false },
    { participantId: 'a', action: 'OUT', corrected: false },
  ]);
  assert.equal(attendanceNeedsReview(person, latest), true);
  assert.equal(attendanceNeedsReview({ ...person, inside: true }, latest), false);
  assert.equal(attendanceNeedsReview(person, indexLatestChecks([])), false);
  assert.equal(attendanceNeedsReview(person, indexLatestChecks([{ participantId: 'a', action: 'OUT', corrected: null }])), true);
  assert.equal(attendanceNeedsReview({ ...person, everIn: false }, indexLatestChecks([{ participantId: 'a', action: 'OUT' }])), true);
});
