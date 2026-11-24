'use strict';

// Event-relative reservations ("행사 1일 전 18:00") store the absolute instant
// that dispatch already understands, plus the rule that produced it. When the
// event date changes, only reservations that have provably not been handed to
// a provider are re-derived from that rule. Everything else keeps its time.

const KOREA_OFFSET = '+09:00';
const ANCHOR_KIND = 'EVENT_DATE';
const MAX_ANCHOR_DAYS = 30;

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return day.toISOString().slice(0, 10) === value;
}

// Returns a clean { kind, days, time } or null when the shape is not valid.
function normalizeScheduleAnchor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.kind !== ANCHOR_KIND) return null;
  const days = value.days;
  if (!Number.isInteger(days) || days < -MAX_ANCHOR_DAYS || days > MAX_ANCHOR_DAYS) return null;
  if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return null;
  return { kind: ANCHOR_KIND, days, time: value.time };
}

// The ISO instant (UTC, millisecond precision) for the anchor on an event
// date, or '' when the date is not a calendar date. Korea wall-clock time.
function anchorInstant(eventDate, anchor) {
  const clean = normalizeScheduleAnchor(anchor);
  if (!clean || !isCalendarDate(eventDate)) return '';
  const [y, m, d] = eventDate.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d - clean.days)).toISOString().slice(0, 10);
  const instant = new Date(`${day}T${clean.time}:00${KOREA_OFFSET}`);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : '';
}

// A reservation may be moved only while nothing says it reached a provider.
function untouchedReservation(message) {
  return Boolean(message) && message.status === 'SCHEDULED' && message.attempts === 0 &&
    !message.providerSubmission && !message.providerGroupId && !message.deliveryUnconfirmed &&
    !message.genericSubmissionUnconfirmed && !message.genericAttemptActive && !message.dispatchedAt &&
    (message.acceptedCount == null || message.acceptedCount === 0);
}

// Mutates workspace.messages in place for a new event date. Moved: the stored
// instant now follows the date. Cancelled: the new instant is not in the
// future, and a past-due reservation must never turn into an immediate send,
// so it is cancelled (recipients and text stay in history to recreate it).
function followEventDate(workspace, eventDate, { now = Date.now(), at = new Date(now).toISOString() } = {}) {
  const result = { moved: 0, cancelled: 0, ids: [] };
  const messages = Array.isArray(workspace && workspace.messages) ? workspace.messages : [];
  for (const message of messages) {
    if (!message || !message.scheduleAnchor || !untouchedReservation(message)) continue;
    const next = anchorInstant(eventDate, message.scheduleAnchor);
    if (!next) continue;
    if (Date.parse(next) === Date.parse(message.scheduled)) continue;
    if (Date.parse(next) <= now) {
      message.status = 'CANCELLED';
      message.scheduleFollow = { outcome: 'CANCELLED_PAST', previous: message.scheduled, attempted: next, at };
      for (const delivery of Array.isArray(message.deliveries) ? message.deliveries : []) delivery.status = 'CANCELLED';
      result.cancelled += 1;
    } else {
      message.scheduleFollow = { outcome: 'MOVED', previous: message.scheduled, at };
      message.scheduled = next;
      result.moved += 1;
    }
    result.ids.push(message.id);
  }
  return result;
}

module.exports = { ANCHOR_KIND, anchorInstant, followEventDate, normalizeScheduleAnchor, untouchedReservation };
