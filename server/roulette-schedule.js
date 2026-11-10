'use strict';

// A boundary without an offset is not a stable instant. Keep absent legacy
// boundaries unlimited, but never infer an invalid value from the host zone.
function scheduleInstant(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) return NaN;
  const [, y, m, d, h, minute, second, , offset] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(h) > 23 || Number(minute) > 59 || (second && Number(second) > 59)) return NaN;
  if (offset.toUpperCase() !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return NaN;
  }
  return Date.parse(value);
}

function rouletteSchedule(config) {
  const start = scheduleInstant(config.startsAt), end = scheduleInstant(config.endsAt);
  const valid = (start === null || Number.isFinite(start)) && (end === null || Number.isFinite(end)) &&
    (start === null || end === null || start < end);
  return { start, end, valid };
}

module.exports = { scheduleInstant, rouletteSchedule };
