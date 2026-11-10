'use strict';
const crypto = require('node:crypto');
const { attendanceNeedsReview, indexLatestChecks } = require('../apps/web/lib/attendance-state.cjs');
const { isCalendarDate } = require('./validation');

const array = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value : '';
const ownValue = (object, key) => Object.hasOwn(object, key) ? { present: true, value: object[key] } : { present: false };
function checkTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(string(value));
  return match && isCalendarDate(match[1]) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
}
function identityKey(person) {
  const phone = string(person.phone).replace(/\D/g, '');
  return JSON.stringify([string(person.name).trim().toLowerCase(), string(person.company).trim().toLowerCase(), phone.slice(0, 3), phone.slice(-4)]);
}

// Only a uniquely identifiable participant with a well-formed, unambiguous
// latest check can be reconciled. This never fabricates a new check-in.
function reconciliationIndex(workspace) {
  const people = array(workspace.participants).filter(person => person && typeof person === 'object' && !Array.isArray(person));
  const checks = array(workspace.checks), latest = indexLatestChecks(checks);
  const ids = new Map(), identities = new Map(), checkIds = new Map(), history = new Map(), desks = new Map();
  for (const desk of array(workspace.desks)) {
    if (!desk || typeof desk !== 'object' || Array.isArray(desk) || !string(desk.id)) continue;
    const id = string(desk.id), matching = desks.get(id) || [];
    matching.push(desk); desks.set(id, matching);
  }
  for (const person of people) {
    const id = string(person.id), identity = identityKey(person);
    ids.set(id, (ids.get(id) || 0) + 1); identities.set(identity, (identities.get(identity) || 0) + 1);
  }
  for (const check of checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) continue;
    const id = string(check.id), participantId = string(check.participantId);
    if (id) checkIds.set(id, (checkIds.get(id) || 0) + 1);
    if (participantId && check.corrected !== true) {
      if (!history.has(participantId)) history.set(participantId, []);
      history.get(participantId).push(check);
    }
  }
  return person => {
    if (!person || typeof person !== 'object' || Array.isArray(person)) return null;
    const id = string(person.id), check = latest.get(id), rows = history.get(id) || [];
    if (!id || id.length > 120 || ids.get(id) !== 1 || identities.get(identityKey(person)) !== 1 ||
        !string(person.name).trim() || !/^\d{9,15}$/.test(string(person.phone).replace(/\D/g, '')) ||
        (person.revoked !== undefined && typeof person.revoked !== 'boolean') ||
        (person.ticketRevision !== undefined && (!Number.isSafeInteger(person.ticketRevision) || person.ticketRevision < 0)) ||
        !attendanceNeedsReview(person, latest) || !check || !string(check.id) || string(check.id).length > 120 ||
        checkIds.get(check.id) !== 1 || !['IN', 'OUT'].includes(check.action) ||
        (check.corrected !== undefined && check.corrected !== false) || !Number.isFinite(checkTime(check.at))) return null;
    const at = checkTime(check.at);
    if (rows.some((row, index) => !string(row.id) || !['IN', 'OUT'].includes(row.action) ||
      (row.corrected !== undefined && row.corrected !== false) || !Number.isFinite(checkTime(row.at)) ||
      (index > 0 && checkTime(row.at) >= at))) return null;
    const matchingDesks = desks.get(string(check.deskId)) || [];
    if (matchingDesks.length > 1) return null;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
      1, id, person.name, person.company, person.phone, person.status, person.paymentStatus, person.revoked, person.ticketRevision, person.ticketExpiresAt,
      ownValue(person, 'inside'), ownValue(person, 'everIn'), check.id, check.action, check.at, check.name, check.deskId, check.corrected,
      matchingDesks.length ? { present: true, name: matchingDesks[0].name } : { present: false },
    ])).digest('hex');
    return { fingerprint, checkId: check.id, action: check.action, at: check.at, checkName: string(check.name), deskId: string(check.deskId) };
  };
}

module.exports = { reconciliationIndex, ownValue };
