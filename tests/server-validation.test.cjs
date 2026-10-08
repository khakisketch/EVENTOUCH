'use strict';

// Failing-first unit for the shared server validation helper (P2-4 cleanup).
// Pins the single canonical calendar-date check plus the capacity predicates
// that preserve each legacy call site's exact accept/reject behavior.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isCalendarDate,
  toCapacityNumber,
  isFiniteCapacity,
  isIntegerCapacity,
  isSafeIntegerCapacity,
} = require('../server/validation');

test('isCalendarDate accepts only real YYYY-MM-DD calendar dates', () => {
  assert.equal(isCalendarDate('2026-11-20'), true);
  assert.equal(isCalendarDate('2024-02-29'), true);
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2023-02-29'), false);
  assert.equal(isCalendarDate('2026-13-01'), false);
  assert.equal(isCalendarDate('2026-00-10'), false);
  assert.equal(isCalendarDate('2026-01-00'), false);
  assert.equal(isCalendarDate('2026-1-1'), false);
  assert.equal(isCalendarDate(''), false);
  assert.equal(isCalendarDate(undefined), false);
  assert.equal(isCalendarDate(null), false);
});

test('capacity predicates preserve per-call-site accept rules', () => {
  assert.equal(isFiniteCapacity(toCapacityNumber('10')), true);
  assert.equal(isFiniteCapacity(toCapacityNumber(1.5)), true);
  assert.equal(isFiniteCapacity(toCapacityNumber(-1)), false);
  assert.equal(isFiniteCapacity(toCapacityNumber('abc')), false);
  assert.equal(isIntegerCapacity(toCapacityNumber(1.5)), false);
  assert.equal(isIntegerCapacity(toCapacityNumber(3)), true);
  assert.equal(isIntegerCapacity(toCapacityNumber(-1)), false);
  assert.equal(isSafeIntegerCapacity(toCapacityNumber(3)), true);
  assert.equal(isSafeIntegerCapacity(toCapacityNumber(2 ** 53)), false);
  assert.equal(isSafeIntegerCapacity(toCapacityNumber(-1)), false);
});
