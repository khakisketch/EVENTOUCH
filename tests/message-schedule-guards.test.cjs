'use strict';

// dueScheduleGuards is the single pre-send gate shared by the operator path
// (message.retry) and the opt-in maintenance worker (enqueueDueScheduled).
// These pure unit tests pin its contract so neither caller can drift.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dueScheduleGuards } = require('../server/commands/content-results');

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

test('an-unparseable-schedule-is-not-treated-as-future', () => {
  assert.equal(dueScheduleGuards(message({ scheduled: 'garbage' }), workspaceWith(), { now: NOW, origin: null }), null);
});

test('a-ticket-link-without-an-origin-is-refused', () => {
  assert.deepEqual(
    dueScheduleGuards(message({ body: '{{티켓링크}} 안내' }), workspaceWith(), { now: NOW, origin: null }),
    { reason: 'NO_PUBLIC_ORIGIN', missing: 0 }
  );
});

test('a-ticket-link-with-an-origin-passes', () => {
  assert.equal(
    dueScheduleGuards(message({ body: '{{티켓링크}} 안내' }), workspaceWith(), { now: NOW, origin: 'https://example.test' }),
    null
  );
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
