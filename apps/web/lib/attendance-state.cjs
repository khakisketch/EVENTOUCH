'use strict';

// Missing flags are the original representation of a participant who has
// never entered. Explicit malformed flags and contradictory entry history
// must be surfaced instead of being silently treated as a clean absence.
function indexLatestChecks(checks) {
  const byParticipant = new Map();
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check || typeof check !== 'object' || check.corrected === true) continue;
    const id = String(check.participantId || '');
    if (id && !byParticipant.has(id)) byParticipant.set(id, check);
  }
  return byParticipant;
}

function attendanceNeedsReview(person, latestChecks) {
  // Restricted staff projections retain boolean fields for older clients,
  // with this extra signal to avoid hiding a malformed underlying record.
  if (person.attendanceReview === true) return true;
  const inside = Object.hasOwn(person, 'inside') ? person.inside : false;
  const everIn = Object.hasOwn(person, 'everIn') ? person.everIn : false;
  if (typeof inside !== 'boolean' || typeof everIn !== 'boolean' || (inside && !everIn)) return true;
  const latest = latestChecks instanceof Map ? latestChecks.get(String(person.id || '')) : null;
  return Boolean(latest && ((latest.corrected !== undefined && latest.corrected !== false) ||
    !['IN', 'OUT'].includes(latest.action) || everIn !== true || inside !== (latest.action === 'IN')));
}

function attendanceNotEntered(person) {
  return !attendanceNeedsReview(person) && person.inside !== true && person.everIn !== true;
}

module.exports = { attendanceNeedsReview, attendanceNotEntered, indexLatestChecks };
