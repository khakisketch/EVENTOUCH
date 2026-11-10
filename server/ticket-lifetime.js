'use strict';

const TICKET_TOKEN = /^(?:[A-Za-z0-9_-]{32,128}|ET:[A-Za-z0-9_-]{1,80}:T-[A-Za-z0-9_-]{32,128})$/;

// Event dates are Korean local calendar dates. Do not let the host TZ change
// how long a newly issued or extended bearer remains usable.
function ticketExpiry(event, nowMs) {
  const date = typeof event?.date === 'string' ? event.date.slice(0, 32) : '';
  const eventEnd = Date.parse(`${date}T23:59:00+09:00`);
  return new Date(Math.max(nowMs, Number.isFinite(eventEnd) ? eventEnd : nowMs) + 90 * 86400000).toISOString();
}

function ticketReviewState(person, nowMs = Date.now()) {
  if (!person || typeof person !== 'object' || Array.isArray(person)) return 'unavailable';
  if (String(person.status || '').toUpperCase() === 'CANCELLED' || person.cancelled === true) return 'cancelled';
  if (person.revoked === true) return 'revoked';
  if (!['APPROVED', 'PENDING', 'WAITLIST'].includes(person.status) ||
      (person.revoked !== undefined && person.revoked !== false) ||
      typeof person.id !== 'string' || !person.id || typeof person.ticket !== 'string' || !TICKET_TOKEN.test(person.ticket)) return 'unavailable';
  const expires = Date.parse(person.ticketExpiresAt);
  if (!Number.isFinite(expires)) return 'unavailable';
  return expires <= nowMs ? 'expired' : 'valid';
}

module.exports = { ticketExpiry, ticketReviewState, TICKET_TOKEN };
