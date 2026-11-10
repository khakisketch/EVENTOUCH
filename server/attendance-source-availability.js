'use strict';

const { reportSourceAvailability } = require('./report-source-availability');

// A record without its participant identifier cannot be attributed to anyone.
// Treating it as another person's history would be guessing; ignoring it could
// hide the latest entry and allow a duplicate. Absent legacy lists retain the
// existing empty-list meaning.
function attendanceSourceAvailability(raw) {
  const available = reportSourceAvailability(raw);
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const identified = (items, field) => !Object.hasOwn(source, items) ||
    (Array.isArray(source[items]) && source[items].every(item =>
      item && typeof item === 'object' && !Array.isArray(item) &&
      typeof item[field] === 'string' && item[field].trim() !== ''));
  return {
    participants: available.participants && identified('participants', 'id'),
    checks: available.checks && identified('checks', 'participantId'),
  };
}

module.exports = { attendanceSourceAvailability };
