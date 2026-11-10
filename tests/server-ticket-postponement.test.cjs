'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { emptyWorkspace } = require('../server/state');
const { ticketHash } = require('../server/commands/shared.ts');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

test('postponing preserves only still-valid tickets atomically and does not revive other credentials', async () => {
  const h = await startApiHarness(); const realNow = Date.now;
  try {
    const id = `postpone-${crypto.randomUUID()}`, manager = `manager-${crypto.randomUUID()}`;
    const day = n => new Date(realNow() + n * 86400000).toISOString().slice(0, 10);
    const token = () => crypto.randomBytes(32).toString('base64url');
    const person = (id, extra = {}) => ({ id, name: `합성 ${id}`, phone: `0100000${id.padStart(4, '0')}`, status: 'APPROVED',
      paymentStatus: 'FREE', ticket: token(), ticketRevision: 0, revoked: false, ticketExpiresAt: new Date(realNow() + 5 * 86400000).toISOString(), ...extra });
    const w = emptyWorkspace(); w.desks = [{ id: 'in', name: '입장', action: 'IN', open: true }];
    w.participants = [person('1'), person('2'), person('3', { ticketExpiresAt: new Date(realNow() - 60000).toISOString() }),
      person('4', { revoked: true }), person('5', { status: 'CANCELLED', revoked: true }), person('6', { ticket: 'bad-token' }),
      person('7', { ticketExpiresAt: new Date(realNow() + 500 * 86400000).toISOString() }),
      person('8', { cancelled: true })];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id, slug: id, orgId: LEGACY_ORG, payload: { id, slug: id, name: '연기 검증', date: day(1), start: '09:00', end: '17:00', capacity: 100, stage: 'LIVE', features: [] }, workspace: w });
    await insertMembership(h.database, manager, id, ['all']);
    const cookie = await sessionCookie(h, manager);
    const sessionHash = crypto.randomBytes(32).toString('hex');
    await h.database.query('INSERT INTO attendee_sessions (token_hash,grants,expires_at) VALUES ($1,$2::jsonb,$3::timestamptz)',
      [sessionHash, JSON.stringify([{ eventId: id, participantId: '1', phone: w.participants[0].phone }]), new Date(realNow() + 86400000).toISOString()]);
    const sessionBefore = (await h.database.query('SELECT grants,expires_at FROM attendee_sessions WHERE token_hash=$1', [sessionHash])).rows[0];
    await h.database.query('INSERT INTO tickets (participant_id,event_id,ticket_hash,revoked,expires_at) VALUES ($1,$2,NULL,false,$3::timestamptz)', ['1', id, w.participants[0].ticketExpiresAt]);
    const send = (command, payload, commandId = crypto.randomUUID()) => requestJson(h.baseUrl, `/api/events/${id}/commands`, { method: 'POST', cookie, body: { commandId, command, payload } });
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
    const update = date => ({ name: '연기 검증', date, start: '09:00', end: '17:00', capacity: 100 });
    const receipt = crypto.randomUUID(); const res = await send('event.update', update(day(180)), receipt);
    assert.equal(res.status, 200, JSON.stringify(res.json)); assert.deepEqual(res.json.ticketImpact, { extended: 2, review: 4 });
    const after = await read();
    const sessionAfter = (await h.database.query('SELECT grants,expires_at FROM attendee_sessions WHERE token_hash=$1', [sessionHash])).rows[0];
    assert.deepEqual(sessionAfter, sessionBefore, 'postponement does not extend or revive attendee sessions');
    for (const i of [0, 1]) { assert.equal(after.participants[i].ticket, w.participants[i].ticket); assert.equal(after.participants[i].ticketRevision, 0); assert.ok(Date.parse(after.participants[i].ticketExpiresAt) > Date.parse(`${day(180)}T09:00:00+09:00`)); }
    for (const i of [2, 3, 4, 5, 6, 7]) assert.deepEqual(after.participants[i], w.participants[i]);
    const rows = (await h.database.query('SELECT participant_id,ticket_hash,revoked,expires_at FROM tickets WHERE event_id=$1 ORDER BY participant_id', [id])).rows;
    assert.equal(rows.length, 2); assert.equal(rows[0].ticket_hash, ticketHash(w.participants[0].ticket)); assert.equal(rows[1].ticket_hash, ticketHash(w.participants[1].ticket));
    assert.equal(new Date(rows[0].expires_at).toISOString(), after.participants[0].ticketExpiresAt);
    const replay = await send('event.update', update(day(180)), receipt); assert.equal(replay.status, 200); assert.deepEqual(replay.json.ticketImpact, res.json.ticketImpact);
    Date.now = () => Date.parse(`${day(180)}T09:00:00+09:00`);
    const attendee = await requestJson(h.baseUrl, `/api/public/events/${id}/ticket`, { bearer: w.participants[0].ticket });
    const scan = await send('check.scan', { deskId: 'in', ticket: w.participants[0].ticket, expectedAction: 'IN' });
    Date.now = realNow; assert.equal(attendee.status, 200, JSON.stringify(attendee.json)); assert.equal(attendee.json.participant.id, w.participants[0].id);
    assert.equal(scan.status, 200, JSON.stringify(scan.json));
    const back = await send('event.update', update(day(90))); assert.equal(back.status, 200); assert.equal((await read()).participants[0].ticketExpiresAt, after.participants[0].ticketExpiresAt);
    const bootstrap = await requestJson(h.baseUrl, `/api/events/${id}/bootstrap`, { cookie });
    const review = bootstrap.json.state.workspaces[id].participants.map(p => p.ticketReview);
    assert.deepEqual(review, ['valid', 'valid', 'expired', 'revoked', 'cancelled', 'unavailable', 'valid', 'cancelled']);
    const beforeReissue = await read();
    const inconsistent = await send('ticket.reissue-reviewed', { id: '8', expectedTicketRevision: 0 });
    assert.equal(inconsistent.status, 409);
    assert.equal(inconsistent.json.code, 'TICKET_STATUS_CONFLICT');
    assert.deepEqual(await read(), beforeReissue, 'a conflicting cancellation must not mint a ticket');
    const missingReview = await send('ticket.reissue-reviewed', { id: '8' });
    assert.equal(missingReview.status, 400, 'the reviewed command requires the observed revision');
    assert.deepEqual(await read(), beforeReissue);
    const reviewedId = crypto.randomUUID();
    const reviewed = await send('ticket.reissue-reviewed', { id: '7', expectedTicketRevision: 0 }, reviewedId);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
    const replayReviewed = await send('ticket.reissue-reviewed', { id: '7', expectedTicketRevision: 0 }, reviewedId);
    assert.equal(replayReviewed.status, 200);
    assert.equal(replayReviewed.json.participant.ticket, reviewed.json.participant.ticket);
    const wrongTarget = await send('ticket.reissue-reviewed', { id: '1', expectedTicketRevision: 0 }, reviewedId);
    assert.equal(wrongTarget.status, 409);
    assert.equal(wrongTarget.json.code, 'TICKET_REVIEW_MISMATCH');
    const wrongRevision = await send('ticket.reissue-reviewed', { id: '7', expectedTicketRevision: 1 }, reviewedId);
    assert.equal(wrongRevision.status, 409);
    assert.equal(wrongRevision.json.code, 'TICKET_REVIEW_MISMATCH');
    const reader = `reader-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: reader, role: 'MANAGER', name: '읽기 전용', email: `${reader}@example.test`, orgId: LEGACY_ORG });
    await insertMembership(h.database, reader, id, []);
    const readerCookie = await sessionCookie(h, reader);
    const forbidden = await requestJson(h.baseUrl, `/api/events/${id}/commands`, { method: 'POST', cookie: readerCookie,
      body: { commandId: crypto.randomUUID(), command: 'ticket.reissue-reviewed', payload: { id: '1', expectedTicketRevision: 0 } } });
    assert.equal(forbidden.status, 403, 'reviewed reissue keeps the participant write grant');
    const otherActorReplay = await requestJson(h.baseUrl, `/api/events/${id}/commands`, { method: 'POST', cookie: readerCookie,
      body: { commandId: reviewedId, command: 'ticket.reissue-reviewed', payload: { id: '7', expectedTicketRevision: 0 } } });
    assert.equal(otherActorReplay.status, 409, 'another actor cannot claim a receipt');
    await h.database.query('UPDATE tickets SET ticket_hash=$2 WHERE participant_id=$1', ['2', token()]);
    const beforeConflict = await read(); const conflict = await send('event.update', update(day(400)));
    assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'TICKET_PROJECTION_CONFLICT'); assert.deepEqual(await read(), beforeConflict);
    const legacyInconsistent = await send('ticket.reissue', { id: '8' });
    assert.equal(legacyInconsistent.status, 409, 'the old command must not mint an unusable ticket');
    assert.equal(legacyInconsistent.json.code, 'TICKET_STATUS_CONFLICT');
    assert.deepEqual(await read(), beforeConflict, 'the rejected legacy operation preserves the workspace');
    const cancel = await send('participant.status', { ids: ['7'], status: 'CANCELLED' });
    assert.equal(cancel.status, 200);
    const staleReplay = await send('ticket.reissue-reviewed', { id: '7', expectedTicketRevision: 0 }, reviewedId);
    assert.equal(staleReplay.status, 409);
    assert.equal(staleReplay.json.code, 'TICKET_RESULT_SUPERSEDED');
    assert.equal(staleReplay.json.participant, undefined);
  } finally { Date.now = realNow; await h.close(); }
});

nodeTest('ticket expiration uses Korean time regardless of server TZ', () => {
  const source = "console.log(require('./server/ticket-lifetime').ticketExpiry({date:'2027-05-05'}, Date.parse('2026-01-01T00:00:00Z')))";
  const out = ['UTC', 'Asia/Seoul'].map(TZ => { const result = spawnSync(process.execPath, ['-e', source], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, TZ }, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); });
  assert.equal(out[0], '2027-08-03T14:59:00.000Z'); assert.equal(out[0], out[1]);
});
