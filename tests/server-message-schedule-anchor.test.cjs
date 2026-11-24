'use strict';
// 행사 기준 예약(2026-11-24 결정): 예약은 절대 시각으로 저장하되 규칙(행사일 N일 전 HH:MM, 한국 시간)을 함께
// 보관하고, 행사 날짜가 바뀌면 제공자에게 넘어간 적 없는 예약만 규칙대로 다시 계산한다.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { anchorInstant, followEventDate, normalizeScheduleAnchor } = require('../server/message-schedule-anchor');
const { emptyWorkspace } = require('../server/state');
const { recipientReviewVersion } = require('../server/commands/content-results');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const dbTest = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

nodeTest('anchor rule validates and derives the Korea wall-clock instant', () => {
  assert.deepEqual(normalizeScheduleAnchor({ kind: 'EVENT_DATE', days: 1, time: '18:00', extra: 1 }), { kind: 'EVENT_DATE', days: 1, time: '18:00' });
  for (const bad of [null, [], {}, { kind: 'X', days: 1, time: '18:00' }, { kind: 'EVENT_DATE', days: 1.5, time: '18:00' },
    { kind: 'EVENT_DATE', days: 99, time: '18:00' }, { kind: 'EVENT_DATE', days: 1, time: '24:00' }, { kind: 'EVENT_DATE', days: '1', time: '18:00' }]) {
    assert.equal(normalizeScheduleAnchor(bad), null);
  }
  assert.equal(anchorInstant('2030-11-13', { kind: 'EVENT_DATE', days: 1, time: '18:00' }), '2030-11-12T09:00:00.000Z');
  assert.equal(anchorInstant('2030-11-13', { kind: 'EVENT_DATE', days: -1, time: '10:00' }), '2030-11-14T01:00:00.000Z');
  assert.equal(anchorInstant('2030-03-01', { kind: 'EVENT_DATE', days: 1, time: '00:30' }), '2030-02-27T15:30:00.000Z');
  assert.equal(anchorInstant('2030-02-30', { kind: 'EVENT_DATE', days: 1, time: '18:00' }), '');
});

nodeTest('followEventDate moves only reservations that never reached a provider and never turns a past time into a send', () => {
  const NOW = Date.parse('2030-11-01T00:00:00.000Z');
  const anchor = { kind: 'EVENT_DATE', days: 1, time: '18:00' };
  const reservation = (id, extra = {}) => ({ id, status: 'SCHEDULED', attempts: 0, scheduled: '2030-11-12T09:00:00.000Z', scheduleAnchor: anchor,
    deliveries: [{ participantId: 'p', status: 'WAITING' }], ...extra });
  const workspace = { messages: [
    reservation('later'),
    reservation('no-anchor', { scheduleAnchor: undefined }),
    reservation('attempted', { attempts: 1 }),
    reservation('submitted', { providerSubmission: { id: 's' } }),
    reservation('active', { genericAttemptActive: true }),
    reservation('sent', { status: 'SENT' }),
    reservation('same'),
  ] };
  const moved = followEventDate(workspace, '2030-11-20', { now: NOW });
  assert.equal(moved.moved, 2, 'later and same both re-derive for the new date');
  const byId = Object.fromEntries(workspace.messages.map(m => [m.id, m]));
  assert.equal(byId.later.scheduled, '2030-11-19T09:00:00.000Z');
  assert.equal(byId.later.scheduleFollow.outcome, 'MOVED');
  assert.equal(byId.later.scheduleFollow.previous, '2030-11-12T09:00:00.000Z');
  for (const id of ['no-anchor', 'attempted', 'submitted', 'active', 'sent']) assert.equal(byId[id].scheduled, '2030-11-12T09:00:00.000Z', id);
  assert.equal(byId.attempted.scheduleFollow, undefined);

  const past = { messages: [reservation('past')] };
  const cancelled = followEventDate(past, '2030-11-01', { now: NOW });
  assert.equal(cancelled.cancelled, 1); assert.equal(cancelled.moved, 0);
  assert.equal(past.messages[0].status, 'CANCELLED');
  assert.equal(past.messages[0].deliveries[0].status, 'CANCELLED');
  assert.equal(past.messages[0].scheduleFollow.outcome, 'CANCELLED_PAST');
});

dbTest('campaign stores its rule, rejects a stale one, and event date changes carry it', async () => {
  const h = await startApiHarness();
  try {
    const eventId = `anchor-${crypto.randomUUID()}`, manager = `manager-${crypto.randomUUID()}`;
    const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const base = { name: '합성 행사', slug: eventId, clientId: '', date: day(10), start: '09:00', end: '17:00', capacity: 100,
      price: 0, format: '', approvalRequired: false, allowReentry: true, verificationRequired: false };
    const workspace = emptyWorkspace();
    workspace.participants = [{ id: 'a', name: '합성 a', phone: '01000000000', status: 'APPROVED', ticket: 'synthetic-ticket-a' }];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, ...base, stage: 'READY', features: [] }, workspace });
    await insertMembership(h.database, manager, eventId, ['all']);
    const cookie = await sessionCookie(h, manager);
    const send = (command, payload) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId: crypto.randomUUID(), command, payload } });
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const anchor = { kind: 'EVENT_DATE', days: 1, time: '18:00' };
    const payload = { ids: ['a'], expectedRecipientVersions: workspace.participants.map(recipientReviewVersion), channel: 'SMS', title: '리마인드', body: '{{이름}}님 내일 뵙겠습니다', simulate: true,
      scheduled: anchorInstant(base.date, anchor), scheduleAnchor: anchor };
    const stale = await send('message.create-charset-reviewed', { ...payload, scheduled: anchorInstant(day(11), anchor) });
    assert.equal(stale.status, 409); assert.equal(stale.json.field, 'scheduleAnchor');
    const bad = await send('message.create-charset-reviewed', { ...payload, scheduleAnchor: { kind: 'EVENT_DATE', days: 1 } });
    assert.equal(bad.status, 400); assert.equal(bad.json.field, 'scheduleAnchor');
    const created = await send('message.create-charset-reviewed', payload);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.deepEqual(created.json.message.scheduleAnchor, anchor);

    const basics = date => ({ ...base, date, expectedBasics: base });
    const later = await send('event.basics.save', basics(day(20)));
    assert.equal(later.status, 200, JSON.stringify(later.json));
    assert.deepEqual(later.json.scheduleFollow, { moved: 1, cancelled: 0 });
    let message = (await read()).messages[0];
    assert.equal(message.scheduled, anchorInstant(day(20), anchor));
    assert.equal(message.status, 'SCHEDULED');
    assert.equal(message.scheduleFollow.outcome, 'MOVED');

    const sameDay = await send('event.basics.save', { ...base, date: day(20), start: '10:00', expectedBasics: { ...base, date: day(20) } });
    assert.equal(sameDay.status, 200);
    assert.equal(sameDay.json.scheduleFollow, undefined, 'a time-only change does not move date-anchored reservations');

    const past = await send('event.basics.save', { ...base, date: day(0), expectedBasics: { ...base, date: day(20), start: '10:00' } });
    assert.equal(past.status, 200, JSON.stringify(past.json));
    assert.deepEqual(past.json.scheduleFollow, { moved: 0, cancelled: 1 });
    message = (await read()).messages[0];
    assert.equal(message.status, 'CANCELLED');
    assert.equal(message.scheduleFollow.outcome, 'CANCELLED_PAST');
  } finally { await h.close(); }
});

nodeTest('composer sends the rule only for event-relative choices and settings reports what moved', () => {
  const fs = require('node:fs');
  const messages = fs.readFileSync('apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx', 'utf8');
  const settings = fs.readFileSync('apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx', 'utf8');
  assert.match(messages, /scheduled && effectiveScheduleChoice === "EVENT"\) payload\.scheduleAnchor/u);
  assert.match(messages, /campaign\.scheduleFollow === "CANCELLED_PAST" && campaign\.status === "CANCELLED"/u);
  assert.match(settings, /response\?\.scheduleFollow/u);
  assert.match(settings, /행사 기준 메시지 예약:/u);
});
