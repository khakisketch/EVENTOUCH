'use strict';

// dueScheduleGuards is the single pre-send gate shared by the operator path
// (message.retry) and the opt-in maintenance worker (enqueueDueScheduled).
// These pure unit tests pin its contract so neither caller can drift.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dueScheduleGuards, ticketLinkGuard } = require('../server/commands/content-results');

const NOW = Date.parse('2026-10-24T00:00:00.000Z');
const PAST = new Date(NOW - 60000).toISOString();
const FUTURE = new Date(NOW + 60000).toISOString();

function message(overrides = {}) {
  return {
    id: 'msg-1',
    body: '본문입니다.',
    recipientIds: ['p1'],
    ...overrides,
  };
}

const workspaceWith = (luckyNumbers = []) => ({ luckyNumbers });

test('a-due-campaign-passes', () => {
  assert.equal(dueScheduleGuards(message({ scheduled: PAST }), workspaceWith(), { now: NOW, origin: null }), null);
});

test('a-campaign-without-a-schedule-is-not-early', () => {
  assert.equal(dueScheduleGuards(message(), workspaceWith(), { now: NOW, origin: null }), null);
});

test('a-future-schedule-is-not-due', () => {
  assert.deepEqual(
    dueScheduleGuards(message({ scheduled: FUTURE }), workspaceWith(), { now: NOW, origin: null }),
    { reason: 'NOT_DUE', missing: 0 }
  );
});

test('a previous reservation cannot bypass its invalid time by changing status', () => {
  for (const status of ['NEEDS_CONNECTION', 'FAILED']) assert.deepEqual(
    dueScheduleGuards(message({ status, scheduled: '2026-10-24T09:00' }), workspaceWith(), { now: NOW, origin: null }),
    { reason: 'INVALID_SCHEDULE', missing: 0 }
  );
});

test('a reservation with an invalid or missing schedule cannot be dispatched', () => {
  for (const scheduled of ['', 'garbage', '2026-10-24T09:00', '2026-02-30T09:00:00+09:00', '2026-10-24T09:00:00+14:30']) assert.deepEqual(
    dueScheduleGuards(message({ status: 'SCHEDULED', scheduled }), workspaceWith(), { now: NOW, origin: null }),
    { reason: 'INVALID_SCHEDULE', missing: 0 }
  );
});

test('explicit offsets identify the same instant on every server', () => {
  for (const scheduled of ['2026-10-24T08:59:00+09:00', '2026-10-23T23:59:00Z', '2026-10-24T08:59+0900']) {
    assert.equal(dueScheduleGuards(message({ status: 'SCHEDULED', scheduled }), workspaceWith(), { now: NOW, origin: null }), null);
  }
});

test('a-ticket-link-without-an-origin-is-refused', () => {
  assert.deepEqual(
    dueScheduleGuards(message({ body: '{{티켓링크}} 안내' }), workspaceWith(), { now: NOW, origin: null }),
    { reason: 'NO_PUBLIC_ORIGIN', missing: 0 }
  );
});

test('a-ticket-link-with-an-origin-passes', () => {
  const person = { id: 'p1', status: 'APPROVED', ticket: 'A'.repeat(32), ticketExpiresAt: new Date(NOW + 60000).toISOString() };
  assert.equal(
    dueScheduleGuards(message({ body: '{{티켓링크}} 안내', recipientSnapshot: [{ id: 'p1' }] }), { participants: [person] }, { now: NOW, origin: 'https://example.test' }),
    null
  );
});

test('ticket links reject missing, expired, revoked and malformed participants', () => {
  const valid = { id: 'p1', status: 'APPROVED', ticket: 'A'.repeat(32), ticketExpiresAt: new Date(NOW + 60000).toISOString() };
  const body = message({ body: '{{티켓링크}} 안내', recipientSnapshot: [{ id: 'p1' }] });
  for (const person of [null, { ...valid, ticketExpiresAt: new Date(NOW).toISOString() }, { ...valid, revoked: true }, { ...valid, ticket: 'broken' }]) {
    assert.deepEqual(ticketLinkGuard(body, { participants: person ? [person] : [] }, { now: NOW }), { reason: 'TICKET_UNAVAILABLE', missing: 1 });
  }
  assert.deepEqual(dueScheduleGuards(message({ body: '{{티켓링크}}' }), workspaceWith(), { now: NOW, origin: 'https://example.test' }), { reason: 'TICKET_RECIPIENTS_UNAVAILABLE', missing: 0 });
  assert.equal(dueScheduleGuards({ ...body, simulate: true }, { participants: [] }, { now: NOW, origin: 'https://example.test' }), null);
});

test('a-campaign-without-placeholders-ignores-the-origin', () => {
  assert.equal(dueScheduleGuards(message(), workspaceWith(), { now: NOW, origin: null }), null);
});

test('missing-lucky-numbers-report-the-count', () => {
  assert.deepEqual(
    dueScheduleGuards(
      message({ body: '{{럭키번호}} 추첨', recipientIds: ['p1', 'p2'] }),
      workspaceWith([{ participantId: 'p1', number: 7 }]),
      { now: NOW, origin: null }
    ),
    { reason: 'LUCKY_NUMBER_MISSING', missing: 1 }
  );
});

test('fully-assigned-lucky-numbers-pass', () => {
  assert.equal(
    dueScheduleGuards(
      message({ body: '{{럭키번호}} 추첨', recipientIds: ['p1'] }),
      workspaceWith([{ participantId: 'p1', number: 7 }]),
      { now: NOW, origin: null }
    ),
    null
  );
});

test('non-integer-lucky-numbers-do-not-count', () => {
  const guard = dueScheduleGuards(
    message({ body: '{{럭키번호}} 추첨', recipientIds: ['p1'] }),
    workspaceWith([{ participantId: 'p1', number: '7' }]),
    { now: NOW, origin: null }
  );
  assert.equal(guard && guard.reason, 'LUCKY_NUMBER_MISSING');
});

test('guard-order-is-due-then-origin-then-lucky', () => {
  // A campaign violating every guard reports the earliest one, matching the
  // operator path's refusal order.
  const guard = dueScheduleGuards(
    message({ body: '{{티켓링크}} {{럭키번호}}', scheduled: FUTURE, recipientIds: ['p1'] }),
    workspaceWith(),
    { now: NOW, origin: null }
  );
  assert.equal(guard && guard.reason, 'NOT_DUE');
});
