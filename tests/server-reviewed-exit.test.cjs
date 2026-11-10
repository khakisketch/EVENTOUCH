'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('reviewed exit records the actual departure without approving, issuing a ticket or giving a reward', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `review-exit-${suffix}`, manager = `manager-${suffix}`;
    const restricted = `restricted-${suffix}`, staff = `staff-${suffix}`, onsite = `onsite-${suffix}`;
    const person = { id: 'person-a', name: '합성 참가자', company: '합성 소속', phone: '01055556666', status: 'PENDING',
      inside: true, everIn: true, revoked: false, ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
      ticketExpiresAt: '2020-01-01T00:00:00.000Z', ticketRevision: 1, paymentStatus: 'PENDING', answers: {} };
    const other = { ...person, id: 'person-b', name: '다른 참가자', phone: '01055557777', status: 'APPROVED', inside: false };
    const entry = { id: `entry-${suffix}`, participantId: person.id, name: person.name, action: 'IN', deskId: 'desk-in', actor: manager,
      at: '2026-11-07T01:00:00.000Z', before: { inside: false, everIn: false }, corrected: false };
    const workspace = emptyWorkspace(); workspace.participants = [person, other]; workspace.checks = [entry];
    workspace.desks = [{ id: 'desk-out', name: '퇴장 데스크', action: 'OUT', mode: 'desk', open: true }];
    workspace.rewards = [{ id: 'reward-a', participantId: person.id, name: '합성 경품', status: 'READY', method: 'ONSITE' }];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertAccount(h.database, { id: restricted, role: 'MANAGER', name: '명단 담당자', email: `${restricted}@example.test`, orgId: LEGACY_ORG });
    await insertAccount(h.database, { id: staff, role: 'STAFF', name: '현장 스태프', email: `${staff}@example.test`, orgId: LEGACY_ORG });
    await insertAccount(h.database, { id: onsite, role: 'MANAGER', name: '현장 담당자', email: `${onsite}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: ['reward'], capacity: 1 }, workspace });
    await insertMembership(h.database, manager, eventId, ['all']);
    await insertMembership(h.database, restricted, eventId, ['participants']);
    await insertMembership(h.database, onsite, eventId, ['onsite']);
    const assignment = `assignment-${suffix}`;
    await insertAssignment(h.database, { id: assignment, accountId: staff, eventId, type: 'DESK', targetId: 'desk-out' });
    const cookie = await sessionCookie(h, manager);
    const restrictedCookie = await sessionCookie(h, restricted), staffCookie = await sessionCookie(h, staff);
    const onsiteCookie = await sessionCookie(h, onsite);
    const send = (command, payload, commandId = crypto.randomUUID()) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`,
      { method: 'POST', cookie, body: { commandId, command, payload } });
    assert.equal((await send('participant.status', { id: person.id, status: 'APPROVED' })).status, 409);
    const blockedExit = await send('check.scan', { deskId: 'desk-out', ticket: person.ticket, expectedAction: 'OUT' });
    assert.equal(blockedExit.status, 409); assert.equal(blockedExit.json.code, 'CHECK_OUT_REVIEW_REQUIRED');
    assert.match(blockedExit.json.error, /현장 책임자/);
    const expected = { name: person.name, company: person.company, phone: person.phone, status: person.status,
      paymentStatus: person.paymentStatus, revoked: person.revoked, ticketExpiresAt: person.ticketExpiresAt, ticketRevision: person.ticketRevision };
    const payload = { participantId: person.id, entryId: entry.id, expected,
      expectedEntry: { at: entry.at, name: entry.name, deskId: entry.deskId }, reason: '현장 책임자가 실제 퇴장을 확인', confirmed: true };
    for (const payloadCase of [{ ...payload, confirmed: false }, { ...payload, reason: '' }, { ...payload, reason: '가'.repeat(301) }]) {
      assert.equal((await send('check.reviewed-exit', payloadCase)).status, 400);
    }
    for (const payloadCase of [{ ...payload, entryId: 'wrong-entry' }, { ...payload, expected: { ...expected, phone: '01000000000' } },
      { ...payload, expectedEntry: { ...payload.expectedEntry, name: '다른 입장 이름' } }]) {
      const conflict = await send('check.reviewed-exit', payloadCase);
      assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'REVIEWED_EXIT_CHANGED');
    }
    const duplicateState = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    duplicateState.participants.push({ ...person, id: 'ambiguous', phone: '01012346666', status: 'CANCELLED', inside: false });
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(duplicateState)]);
    const ambiguous = await send('check.reviewed-exit', payload);
    assert.equal(ambiguous.status, 409); assert.equal(ambiguous.json.code, 'REVIEWED_EXIT_AMBIGUOUS');
    duplicateState.participants.pop();
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(duplicateState)]);
    for (const [actorCookie, assignmentId] of [[restrictedCookie, undefined], [staffCookie, assignment]]) {
      const denied = await requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
        method: 'POST', cookie: actorCookie,
        body: { commandId: crypto.randomUUID(), command: 'check.reviewed-exit', assignmentId, payload },
      });
      assert.equal(denied.status, 403);
    }
    const commandId = crypto.randomUUID();
    const result = await send('check.reviewed-exit', payload, commandId);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.deepEqual(result.json.exitReview, { participantId: person.id, entryId: entry.id, exitId: commandId, action: 'OUT' });
    const row = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    assert.equal(row.participants[0].inside, false); assert.equal(row.participants[0].status, 'PENDING');
    assert.equal(row.participants[0].ticket, person.ticket); assert.equal(row.participants[0].paymentStatus, 'PENDING');
    assert.equal(row.rewards[0].status, 'READY');
    assert.equal(row.checks[0].action, 'OUT'); assert.equal(row.checks[0].source, 'REVIEWED_EXIT');
    assert.equal(row.checks[0].entryId, entry.id); assert.equal(row.checks[0].reason, payload.reason);
    const projected = await h.database.query('SELECT action,participant_id FROM checkin_records WHERE id=$1', [commandId]);
    assert.deepEqual(projected.rows[0], { action: 'OUT', participant_id: person.id });
    const replay = await send('check.reviewed-exit', payload, commandId);
    assert.equal(replay.status, 200); assert.deepEqual(replay.json.exitReview, result.json.exitReview);
    await h.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}', '\"ENDED\"'::jsonb) WHERE id=$1", [eventId]);
    assert.equal((await send('check.reviewed-exit', payload, commandId)).status, 200, 'receipt replay remains available after the event ends');
    assert.equal((await send('check.reviewed-exit', payload)).status, 409, 'a new reviewed exit cannot be created after the event ends');
    await h.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}', '\"LIVE\"'::jsonb) WHERE id=$1", [eventId]);
    const altered = await send('check.reviewed-exit', { ...payload, participantId: other.id }, commandId);
    assert.equal(altered.status, 409);
    const differentReason = await send('check.reviewed-exit', { ...payload, reason: '다른 사유' }, commandId);
    assert.equal(differentReason.status, 409); assert.equal(differentReason.json.code, 'REVIEWED_EXIT_RECEIPT_MISMATCH');
    const receipt = (await h.database.query('SELECT result FROM command_receipts WHERE command_id=$1', [commandId])).rows[0].result;
    assert.equal(JSON.stringify(receipt).includes(person.phone), false);
    assert.equal(JSON.stringify(receipt).includes(payload.reason), false);
    assert.equal(Object.hasOwn(receipt, 'rewardVerification'), false);
    assert.equal(Object.hasOwn(result.json, 'rewards'), false);
    assert.equal(row.audit[0].detail, payload.reason);

    // A different request racing with the same verified entry cannot append
    // a second exit. The workspace lock serializes both decisions.
    const state = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    state.participants[1].inside = true; state.participants[1].everIn = false; state.participants[1].revoked = true;
    state.checks.unshift({ ...entry, id: `entry-b-${suffix}`, participantId: other.id, name: other.name });
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(state)]);
    const otherPayload = { ...payload, participantId: other.id, entryId: `entry-b-${suffix}`,
      expected: { ...expected, name: other.name, phone: other.phone, status: other.status, revoked: true }, expectedEntry: { ...payload.expectedEntry, name: other.name } };
    const racing = await Promise.all([send('check.reviewed-exit', otherPayload), requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie: onsiteCookie, body: { commandId: crypto.randomUUID(), command: 'check.reviewed-exit', payload: otherPayload },
    })]);
    assert.deepEqual(racing.map(result => result.status).sort(), [200, 409]);
    const final = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    assert.equal(final.checks.filter(check => check.participantId === other.id && check.source === 'REVIEWED_EXIT').length, 1);
    assert.equal(final.participants[1].everIn, true, 'the verified entry preserves re-entry policy');
    assert.equal(final.participants[1].revoked, true, 'reviewed exit never restores the ticket');
  } finally { await h.close(); }
});
