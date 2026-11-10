'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

test('reviewed cancellation conflict preserves history, invalidates the old ticket and binds the receipt to the actual review', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `conflict-review-${suffix}`, manager = `manager-${suffix}`, viewer = `viewer-${suffix}`;
    const person = { id: 'person', name: '합성 참가자', company: '합성 회사', phone: '01012345678', status: 'APPROVED', cancelled: true, paymentStatus: 'FREE', inside: false, everIn: false, revoked: false,
      ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`, ticketRevision: 2, ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() };
    const workspace = emptyWorkspace(); workspace.participants = [person];
    for (const account of [manager, viewer]) await insertAccount(h.database, { id: account, role: 'MANAGER', name: '합성 운영자', email: `${account}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace });
    await insertMembership(h.database, manager, eventId, ['participants']); await insertMembership(h.database, viewer, eventId, []);
    const cookie = await sessionCookie(h, manager), viewerCookie = await sessionCookie(h, viewer);
    const sessionHash = crypto.randomBytes(32).toString('hex');
    await h.database.query('INSERT INTO attendee_sessions (token_hash,grants,expires_at) VALUES ($1,$2::jsonb,$3::timestamptz)', [sessionHash,
      JSON.stringify([{ eventId, participantId: person.id, phone: person.phone }, { eventId: 'other-event', participantId: 'other', phone: '01000001111' }]), new Date(Date.now() + 86400000).toISOString()]);
    await h.database.query("INSERT INTO attendee_challenges (id,event_id,phone,purpose,code_hash,expires_at) VALUES ($1,$2,$3,'RECOVER',$4,$5::timestamptz)",
      ['old-recovery', eventId, person.phone, crypto.randomBytes(32).toString('hex'), new Date(Date.now() + 600000).toISOString()]);
    const read = async () => (await h.database.query('SELECT payload, revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    const bootstrap = async () => (await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie })).json.state.workspaces[eventId].participants[0];
    const send = (payload, commandId = crypto.randomUUID(), auth = cookie) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie: auth,
      body: { commandId, command: 'participant.resolve-cancellation-conflict', payload } });
    const initial = await bootstrap();
    assert.match(initial.cancellationConflictReview, /^[a-f0-9]{64}$/);
    const reviewed = { id: person.id, fingerprint: initial.cancellationConflictReview, reason: '참가자에게 직접 확인', confirmed: true };
    assert.equal((await send(reviewed, crypto.randomUUID(), viewerCookie)).status, 403);
    assert.equal((await send({ ...reviewed, confirmed: false })).status, 400);
    assert.equal((await send({ ...reviewed, reason: '  ' })).status, 400);
    const stale = await read(); stale.payload.participants[0].company = '변경된 소속';
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb,revision=revision+1 WHERE event_id=$1', [eventId, JSON.stringify(stale.payload)]);
    const beforeStale = await read();
    const conflict = await send(reviewed); assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'CANCELLATION_CONFLICT_REVIEW_CHANGED');
    assert.deepEqual(await read(), beforeStale);
    reviewed.fingerprint = (await bootstrap()).cancellationConflictReview;
    const requestId = crypto.randomUUID(), result = await send(reviewed, requestId);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.deepEqual(result.json.review, { participantId: person.id, resolutionId: requestId, status: 'APPROVED', ticketRevoked: true,
      reviewedName: person.name, reviewedCompany: '변경된 소속', reviewedMaskedPhone: '010-****-5678' });
    const after = await read(), saved = after.payload.participants[0];
    assert.equal(saved.cancelled, false); assert.equal(saved.status, 'APPROVED'); assert.equal(saved.revoked, true);
    assert.equal(saved.ticket, person.ticket); assert.equal(saved.ticketRevision, 3);
    assert.equal(after.payload.audit[0].id, requestId); assert.equal(after.payload.audit[0].detail, `${person.name} · ${reviewed.reason}`);
    assert.equal(after.payload.audit[0].cancellationResolution.reason, reviewed.reason);
    assert.equal(after.payload.audit[0].cancellationResolution.participantId, person.id);
    const ticket = await h.database.query('SELECT revoked FROM tickets WHERE participant_id=$1', [person.id]);
    assert.equal(ticket.rows[0].revoked, true);
    const grants = (await h.database.query('SELECT grants FROM attendee_sessions WHERE token_hash=$1', [sessionHash])).rows[0].grants;
    assert.deepEqual(grants, [{ eventId: 'other-event', participantId: 'other', phone: '01000001111' }]);
    assert.ok((await h.database.query("SELECT consumed_at FROM attendee_challenges WHERE id='old-recovery'")).rows[0].consumed_at);
    assert.equal((await requestJson(h.baseUrl, `/api/public/events/${eventId}/ticket`, { bearer: person.ticket })).status, 404);
    assert.deepEqual((await send(reviewed, requestId)).json, result.json);
    const receiptPath = `/api/events/${eventId}/command-receipts/${requestId}?view=cancellation-review`;
    const recovery = await requestJson(h.baseUrl, receiptPath, { cookie });
    assert.equal(recovery.json.status, 'APPLIED'); assert.equal(recovery.json.cancellationReview.participantId, person.id);
    assert.equal(recovery.json.cancellationReview.reviewedName, person.name);
    assert.equal(recovery.json.cancellationReview.maskedPhone, '010-****-5678'); assert.equal(recovery.json.cancellationReview.currentTicketReview, 'revoked');
    assert.equal(JSON.stringify(recovery.json).includes(person.ticket), false); assert.equal(JSON.stringify(recovery.json).includes(person.phone), false);
    assert.equal((await requestJson(h.baseUrl, receiptPath, { cookie: viewerCookie })).json.status, 'UNCONFIRMED');
    const changedName = await read(); changedName.payload.participants[0].name = '변경된 이름';
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb,revision=revision+1 WHERE event_id=$1', [eventId, JSON.stringify(changedName.payload)]);
    const laterRecovery = (await requestJson(h.baseUrl, receiptPath, { cookie })).json.cancellationReview;
    assert.equal(laterRecovery.reviewedName, person.name); assert.equal(laterRecovery.name, '변경된 이름', 'original and current identity remain distinct');
    const mismatch = await send({ ...reviewed, reason: '다른 확인' }, requestId); assert.equal(mismatch.status, 409); assert.equal(mismatch.json.code, 'CANCELLATION_CONFLICT_RECEIPT_MISMATCH');
    assert.equal((await read()).payload.audit.length, 1, 'retry never duplicates the audit');
    await h.database.query("UPDATE memberships SET write_permissions='[]'::jsonb WHERE account_id=$1 AND event_id=$2", [manager, eventId]);
    assert.equal((await send(reviewed, requestId)).status, 403, 'receipt replay rechecks current write access');
    assert.equal((await requestJson(h.baseUrl, receiptPath, { cookie })).json.cancellationReview, undefined, 'target lookup requires the current participant grant');
  } finally { await h.close(); }
});

test('review refuses uncertain presence, duplicate active contacts, refunds, full capacity and corrupted audit data', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `conflict-unavailable-${suffix}`, manager = `manager-${suffix}`;
    const base = { id: 'person', name: '합성 참가자', phone: '01012345678', status: 'APPROVED', cancelled: true, paymentStatus: 'FREE', inside: false, revoked: false,
      ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`, ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() };
    const workspace = emptyWorkspace(); workspace.participants = [base];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 1 }, workspace });
    await insertMembership(h.database, manager, eventId, ['participants']);
    const cookie = await sessionCookie(h, manager);
    const write = async state => h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(state)]);
    const read = async () => (await h.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    const attempt = async () => {
      const state = (await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie })).json.state.workspaces[eventId];
      const fingerprint = state.participants.find(p => p.id === 'person').cancellationConflictReview;
      if (!fingerprint) return null;
      return requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId: crypto.randomUUID(), command: 'participant.resolve-cancellation-conflict', payload: { id: 'person', fingerprint, reason: '확인', confirmed: true } } });
    };
    for (const change of [
      state => { state.participants[0].inside = true; },
      state => { state.participants[0].inside = 'unknown'; },
      state => { state.participants.push({ ...base, id: 'other', cancelled: false, status: 'PENDING' }); },
      state => { state.participants.push({ ...base, id: 'other', phone: '01099995678', status: 'CANCELLED' }); },
      state => { state.payments = [{ id: 'pay', participantId: 'person', status: 'REFUND_REQUESTED' }]; },
      state => { state.participants.push({ ...base, id: 'other', phone: '01098765432', cancelled: false }); },
    ]) {
      const state = structuredClone(workspace); change(state); await write(state); const before = await read();
      const result = await attempt(); assert.equal(result.status, 409, JSON.stringify(result.json)); assert.equal(result.json.code, 'CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE');
      assert.deepEqual(await read(), before);
    }
    const malformed = structuredClone(workspace); malformed.audit = 'invalid'; await write(malformed); assert.equal(await attempt(), null);
  } finally { await h.close(); }
});

test('approval after a reviewed cancellation conflict does not silently reactivate a ticket', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `conflict-pending-${suffix}`, manager = `manager-${suffix}`;
    const person = { id: 'person', name: '합성 참가자', phone: '01012345678', status: 'PENDING', cancelled: true, paymentStatus: 'FREE', inside: false, everIn: false, revoked: false,
      ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`, ticketRevision: 0, ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() };
    const workspace = emptyWorkspace(); workspace.participants = [person];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace });
    await insertMembership(h.database, manager, eventId, ['participants']);
    const cookie = await sessionCookie(h, manager);
    const send = (command, payload) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId: crypto.randomUUID(), command, payload } });
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload.participants[0];
    const fingerprint = (await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie })).json.state.workspaces[eventId].participants[0].cancellationConflictReview;
    assert.equal((await send('participant.resolve-cancellation-conflict', { id: person.id, fingerprint, reason: '참가 의사 확인', confirmed: true })).status, 200);
    const resolved = await read(); assert.equal(resolved.revoked, true); assert.equal(resolved.ticket, person.ticket);
    assert.equal((await send('participant.status', { id: person.id, status: 'APPROVED', expectedStatus: 'PENDING' })).status, 200);
    const approved = await read(); assert.equal(approved.status, 'APPROVED'); assert.equal(approved.revoked, true, 'approval must not reactivate an old ticket or silently issue a replacement');
    assert.equal(approved.ticket, person.ticket); assert.equal(approved.ticketRevision, resolved.ticketRevision);
    assert.equal((await requestJson(h.baseUrl, `/api/public/events/${eventId}/ticket`, { bearer: person.ticket })).status, 404);
    const reissued = await send('ticket.reissue-reviewed', { id: person.id, expectedTicketRevision: approved.ticketRevision });
    assert.equal(reissued.status, 200, JSON.stringify(reissued.json));
    assert.notEqual(reissued.json.participant.ticket, person.ticket);
    assert.equal((await read()).revoked, false);
    assert.equal((await read()).ticketNeedsExplicitReissue, false);
  } finally { await h.close(); }
});
