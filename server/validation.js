'use strict';

// Shared calendar-date + capacity validation for server call sites.
// Error messages stay at the call sites on purpose: legacy pins assert
// byte-identical wording per route/command, so this helper is pure
// predicate + number conversion and never throws or formats messages.
function isCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value === undefined || value === null ? '' : value));
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[mo - 1];
}

function toCapacityNumber(value) {
  return Number(value);
}

// Legacy file-store event routes accept any non-negative finite number.
function isFiniteCapacity(cap) {
  return Number.isFinite(cap) && cap >= 0;
}

// Preparation event.update accepts any non-negative integer.
function isIntegerCapacity(cap) {
  return Number.isInteger(cap) && cap >= 0;
}

// Postgres event.create accepts non-negative safe integers only.
function isSafeIntegerCapacity(cap) {
  return Number.isSafeInteger(cap) && cap >= 0;
}

module.exports = {
  isCalendarDate,
  toCapacityNumber,
  isFiniteCapacity,
  isIntegerCapacity,
  isSafeIntegerCapacity,
};
