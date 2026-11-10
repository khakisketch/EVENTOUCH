'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('an attendee inside cannot lose approval before a successful exit', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `presence-${suffix}`, accountId = `manager-${suffix}`;
    const person = { id: 'person-a', name: '합성 참가자', phone: '01055556666', company: '합성 회사', status: 'APPROVED',
      inside: false, everIn: false, revoked: false, ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString(), paymentStatus: 'FREE', answers: {} };
    const other = { ...person, id: 'person-b', phone: '01055557777', ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}` };
    const workspace = emptyWorkspace(); workspace.participants = [person, other];
    workspace.desks = [{ id: 'in-desk', name: '입장', action: 'IN', mode: 'desk', open: true }, { id: 'out-desk', name: '퇴장', action: 'OUT', mode: 'desk', open: true }];
    await insertAccount(h.database, { id: accountId, role: 'MANAGER', name: '합성 운영자', email: `${accountId}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace });
    await insertMembership(h.database, accountId, eventId, ['all']);
    const cookie = await sessionCookie(h, accountId);
    const send = (command, payload, commandId = crypto.randomUUID()) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`,
      { method: 'POST', cookie, body: { commandId, command, payload } });
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const enter = await send('check.scan', { deskId: 'in-desk', ticket: person.ticket, expectedAction: 'IN' });
    assert.equal(enter.status, 200, JSON.stringify(enter.json));
    const change = await send('participant.status', { id: person.id, status: 'PENDING', expectedStatus: 'APPROVED' });
    assert.equal(change.status, 409, JSON.stringify(change.json));
    assert.equal(change.json.code, 'PARTICIPANT_INSIDE');
    const cancelInside = await send('participant.status', { id: person.id, status: 'CANCELLED', expectedStatus: 'APPROVED' });
    assert.equal(cancelInside.status, 409); assert.equal(cancelInside.json.code, 'PARTICIPANT_INSIDE');
    const batch = await send('participant.status', { ids: [other.id, person.id], status: 'WAITLIST', expectedStatus: 'APPROVED' });
    assert.equal(batch.status, 409); assert.equal(batch.json.code, 'PARTICIPANT_INSIDE');
    const current = await read();
    assert.equal(current.participants[0].status, 'APPROVED');
    assert.equal(current.participants[0].inside, true);
    assert.equal(current.participants[1].status, 'APPROVED', 'batch failure rolls back earlier participants');
    const exit = await send('check.scan', { deskId: 'out-desk', ticket: person.ticket, expectedAction: 'OUT' });
    assert.equal(exit.status, 200, JSON.stringify(exit.json));
    const requestId = crypto.randomUUID();
    const pendingPayload = { id: person.id, status: 'PENDING', expectedStatus: 'APPROVED' };
    const after = await send('participant.status', pendingPayload, requestId);
    assert.equal(after.status, 200, JSON.stringify(after.json));
    assert.equal((await read()).participants[0].inside, false);
    assert.equal((await send('participant.status', { id: person.id, status: 'APPROVED', expectedStatus: 'PENDING' })).status, 200);
    const reenter = await read();
    // Re-entry is permitted in this isolated fixture so a previously
    // committed receipt can be replayed after the presence state changes.
    reenter.allowReentry = true;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(reenter)]);
    assert.equal((await send('check.scan', { deskId: 'in-desk', ticket: person.ticket, expectedAction: 'IN' })).status, 200);
    const replay = await send('participant.status', pendingPayload, requestId);
    assert.equal(replay.status, 200); assert.deepEqual(replay.json, after.json);
    assert.equal((await read()).participants[0].status, 'APPROVED', 'replay did not apply again');

    const damaged = await read(); damaged.participants[1].inside = null;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(damaged)]);
    const unknown = await send('participant.status', { id: other.id, status: 'WAITLIST', expectedStatus: 'APPROVED' });
    assert.equal(unknown.status, 409); assert.equal(unknown.json.code, 'PARTICIPANT_PRESENCE_UNKNOWN');
    const unknownCancel = await send('participant.status', { id: other.id, status: 'CANCELLED', expectedStatus: 'APPROVED' });
    assert.equal(unknownCancel.status, 409); assert.equal(unknownCancel.json.code, 'PARTICIPANT_PRESENCE_UNKNOWN');
    assert.equal((await read()).participants[1].status, 'APPROVED');
    const legacy = await read(); delete legacy.participants[1].inside;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(legacy)]);
    assert.equal((await send('participant.status', { id: other.id, status: 'WAITLIST', expectedStatus: 'APPROVED' })).status, 200);
    assert.equal((await send('participant.status', { id: other.id, status: 'APPROVED', expectedStatus: 'WAITLIST' })).status, 200);
    const [racingEntry, racingStatus] = await Promise.all([
      send('check.scan', { deskId: 'in-desk', ticket: other.ticket, expectedAction: 'IN' }),
      send('participant.status', { id: other.id, status: 'WAITLIST', expectedStatus: 'APPROVED' }),
    ]);
    assert.ok((racingEntry.status === 200 && racingStatus.status === 409) ||
      (racingEntry.status === 409 && racingStatus.status === 200), 'one conflicting operation wins under the event lock');
    const raced = (await read()).participants.find(p => p.id === other.id);
    assert.equal(raced.inside && raced.status !== 'APPROVED', false, 'concurrency cannot strand an attendee');

    const broken = await read(); broken.participants[0].status = 'PENDING';
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(broken)]);
    assert.equal((await send('participant.status', { id: person.id, status: 'APPROVED', expectedStatus: 'PENDING' })).status, 200, 'approval can repair already inconsistent records');
    assert.equal((await send('check.scan', { deskId: 'out-desk', ticket: person.ticket, expectedAction: 'OUT' })).status, 200);
  } finally { await h.close(); }
});
