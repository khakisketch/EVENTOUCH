'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

test('ticket reissue recovery is scoped, minimal, and refuses a superseded cancellation', async () => {
  const h = await startApiHarness();
  try {
    const eventId = `resume-${crypto.randomUUID()}`, manager = `manager-${crypto.randomUUID()}`, other = `other-${crypto.randomUUID()}`;
    const personId = `person-${crypto.randomUUID()}`, ticket = `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`;
    const workspace = emptyWorkspace(); workspace.participants = [{ id: personId, name: '합성 참가자', company: '합성 회사', phone: '01012345678', status: 'APPROVED', paymentStatus: 'FREE', ticket, ticketRevision: 0, revoked: false, inside: false, ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() }];
    for (const id of [manager, other]) await insertAccount(h.database, { id, role: 'MANAGER', name: '운영자', email: `${id}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', date: '2027-01-01', stage: 'LIVE', features: [] }, workspace });
    for (const id of [manager, other]) await insertMembership(h.database, id, eventId, ['participants']);
    const cookie = await sessionCookie(h, manager), otherCookie = await sessionCookie(h, other), commandId = crypto.randomUUID();
    const payload = { id: personId, expectedTicketRevision: 0 };
    const send = () => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId, command: 'ticket.reissue-reviewed', payload } });
    const issued = await send(); assert.equal(issued.status, 200, JSON.stringify(issued.json));
    const url = `/api/events/${eventId}/command-receipts/${commandId}`;
    const ordinary = await requestJson(h.baseUrl, url, { cookie });
    assert.deepEqual(ordinary.json, { status: 'APPLIED', command: 'ticket.reissue-reviewed' });
    const detail = await requestJson(h.baseUrl, `${url}?view=ticket-reissue`, { cookie });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.ticketReissue, { participantId: personId, name: '합성 참가자', company: '합성 회사', maskedPhone: '010-****-5678', eventSlug: eventId, expectedTicketRevision: 0 });
    assert.equal(JSON.stringify(detail.json).includes(issued.json.participant.ticket), false, 'status GET never exposes bearer tickets');
    assert.equal(JSON.stringify(detail.json).includes('01012345678'), false, 'status GET never exposes the full phone');
    assert.deepEqual((await requestJson(h.baseUrl, `${url}?view=ticket-reissue`, { cookie: otherCookie })).json, { status: 'UNCONFIRMED' });
    assert.equal((await requestJson(h.baseUrl, `${url}?view=ticket-reissue`)).status, 401);
    assert.deepEqual((await requestJson(h.baseUrl, `${url}?view=ticket-reissue`, { bearer: issued.json.participant.ticket })).json, { status: 'UNCONFIRMED' }, 'a ticket bearer cannot inspect an operator receipt');
    await h.database.query("UPDATE memberships SET write_permissions='[]'::jsonb WHERE account_id=$1 AND event_id=$2", [manager, eventId]);
    const restricted = await requestJson(h.baseUrl, `${url}?view=ticket-reissue`, { cookie });
    assert.deepEqual(restricted.json, { status: 'APPLIED', command: 'ticket.reissue-reviewed' });
    const revokedReplay = await send(); assert.equal(revokedReplay.status, 403, 'a user without the current write grant cannot retrieve a bearer via receipt replay');
    await h.database.query("UPDATE memberships SET write_permissions='[\"participants\"]'::jsonb WHERE account_id=$1 AND event_id=$2", [manager, eventId]);
    const row = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    row.payload.participants[0].cancelled = true;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb,revision=revision+1 WHERE event_id=$1', [eventId, JSON.stringify(row.payload)]);
    const superseded = await send(); assert.equal(superseded.status, 409); assert.equal(superseded.json.code, 'TICKET_RESULT_SUPERSEDED');
    assert.equal(superseded.json.participant, undefined);
  } finally { await h.close(); }
});
