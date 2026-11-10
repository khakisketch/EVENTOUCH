'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

test('status changes do not report approval or another active state for a participant with a cancellation flag', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `status-conflict-${suffix}`, manager = `manager-${suffix}`;
    const make = (id, status, cancelled) => ({ id, name: `합성 ${id}`, phone: `010${id === 'valid' ? '11112222' : '22223333'}`, status, cancelled, paymentStatus: 'FREE', inside: false, everIn: false, revoked: false });
    const w = emptyWorkspace(); w.participants = [make('valid', 'PENDING', false), make('conflict', 'PENDING', true), make('cancelled', 'CANCELLED', true)];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace: w });
    await insertMembership(h.database, manager, eventId, ['participants']);
    const cookie = await sessionCookie(h, manager);
    const send = payload => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie,
      body: { commandId: crypto.randomUUID(), command: 'participant.status', payload } });
    const read = async () => (await h.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    const before = await read();
    for (const payload of [
      { id: 'conflict', status: 'APPROVED', expectedStatus: 'PENDING' },
      { ids: ['valid', 'conflict'], status: 'APPROVED', expectedStatus: 'PENDING' },
      { id: 'conflict', status: 'WAITLIST', expectedStatus: 'PENDING' },
      { id: 'cancelled', status: 'APPROVED', expectedStatus: 'CANCELLED' },
    ]) {
      const res = await send(payload);
      assert.equal(res.status, 409, JSON.stringify(res.json));
      assert.equal(res.json.code, 'TICKET_STATUS_CONFLICT');
      assert.deepEqual(await read(), before, 'the entire request remains unchanged');
    }
    assert.equal((await send({ id: 'valid', status: 'APPROVED', expectedStatus: 'PENDING' })).status, 200);
    assert.equal((await send({ id: 'conflict', status: 'CANCELLED', expectedStatus: 'PENDING' })).status, 200, 'a deliberate cancellation remains possible');
  } finally { await h.close(); }
});

test('contradictory cancellation cannot issue usable access or silently operate a participant', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `cancel-conflict-${suffix}`, manager = `manager-${suffix}`, staff = `staff-${suffix}`;
    const make = (id, extra = {}) => ({ id, name: `합성 ${id}`, company: `합성 ${id}`, phone: `010${id === 'entry' ? '11112222' : id === 'inside' ? '22223333' : '33334444'}`,
      status: 'APPROVED', paymentStatus: 'FREE', revoked: false, inside: false, everIn: false,
      ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`, ticketRevision: 0,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString(), ...extra });
    const entry = make('entry', { cancelled: true });
    const inside = make('inside', { cancelled: true, inside: true, everIn: true });
    const valid = make('valid');
    const duplicate = make('duplicate');
    const pending = make('pending', { status: 'PENDING' });
    const w = emptyWorkspace(); Object.assign(w, { participants: [entry, inside, valid, duplicate, { ...duplicate }, pending], registrationOpen: true, allowReentry: false, stampMode: 'STAFF',
      desks: [{ id: 'in', name: '입장', action: 'IN', open: true }, { id: 'out', name: '퇴장', action: 'OUT', open: true }],
      booths: [{ id: 'booth', name: '합성 부스', status: 'OPEN', used: 0, capacity: 0, limit: 2 }],
      rewards: [{ id: 'reward', name: '합성 경품', participantId: inside.id, status: 'READY', method: 'ONSITE' },
        { id: 'pending-reward', name: '합성 미지정 경품', participantId: '', status: 'PENDING', method: 'ONSITE' },
        { id: 'valid-reward', name: '합성 정상 경품', participantId: valid.id, status: 'READY', method: 'ONSITE' },
        { id: 'unapproved-reward', name: '합성 미확정 경품', participantId: pending.id, status: 'READY', method: 'ONSITE' },
        { id: 'duplicate-reward', name: '합성 중복 경품', participantId: duplicate.id, status: 'READY', method: 'ONSITE' },
        { id: 'missing-reward', name: '합성 누락 경품', participantId: 'missing', status: 'READY', method: 'ONSITE' }] });
    for (const [id, role] of [[manager, 'MANAGER'], [staff, 'STAFF']]) await insertAccount(h.database, { id, role, name: '합성 운영자', email: `${id}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '취소 충돌 검증', stage: 'LIVE', features: ['stamp', 'reward', 'draw'], capacity: 100 }, workspace: w });
    await insertMembership(h.database, manager, eventId, ['all']);
    for (const [id, type, targetId] of [['staff-in', 'DESK', 'in'], ['staff-out', 'DESK', 'out'], ['staff-booth', 'BOOTH', 'booth']]) await insertAssignment(h.database, { id, accountId: staff, eventId, type, targetId });
    const managerCookie = await sessionCookie(h, manager), staffCookie = await sessionCookie(h, staff);
    const send = (command, payload, { cookie = managerCookie, bearer, assignmentId, id = crypto.randomUUID() } = {}) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie: bearer ? undefined : cookie, bearer, body: { commandId: id, command, payload, ...(assignmentId ? { assignmentId } : {}) },
    });
    const read = async () => (await h.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    const before = await read();
    assert.equal((await requestJson(h.baseUrl, `/api/public/events/${eventId}/ticket`, { bearer: entry.ticket })).status, 404, 'bearer ticket read must agree with the cancellation flag');
    const bootstrap = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie: managerCookie });
    assert.equal(bootstrap.json.state.workspaces[eventId].participants.find(p => p.id === entry.id).ticketReview, 'cancelled');
    for (const [cookie, assignmentId] of [[managerCookie, undefined], [staffCookie, 'staff-in']]) {
      for (const input of [{ ticket: entry.ticket }, { participantId: entry.id, expectedIdentity: { name: entry.name, company: entry.company } }]) {
        const res = await send('check.scan', { deskId: 'in', expectedAction: 'IN', ...input }, { cookie, assignmentId });
        assert.equal(res.status, 409, `entry should be refused: ${JSON.stringify(res.json)}`);
      }
    }
    const exit = await send('check.scan', { deskId: 'out', expectedAction: 'OUT', ticket: inside.ticket }, { cookie: staffCookie, assignmentId: 'staff-out' });
    assert.equal(exit.status, 409); assert.equal(exit.json.code, 'CHECK_OUT_REVIEW_REQUIRED', 'an already-inside person must be routed to reviewed exit');
    for (const [cookie, assignmentId] of [[managerCookie, undefined], [staffCookie, 'staff-booth']]) {
      const res = await send('booth.visit', { boothId: 'booth', ticket: inside.ticket }, { cookie, assignmentId });
      assert.equal(res.status, 409, 'inconsistent participant cannot get a new booth stamp');
    }
    assert.equal((await send('booth.visit', { code: `ET:BOOTH:${eventId}:booth` }, { bearer: inside.ticket })).status, 404);
    assert.equal((await send('reward.lookup', { ticket: inside.ticket }, { cookie: staffCookie, assignmentId: 'staff-out' })).status, 409);
    assert.equal((await send('reward.collect', { id: 'reward' })).status, 409, 'manager cannot issue an inconsistent participant a prize');
    assert.equal((await send('reward.collect', { id: 'unapproved-reward' })).status, 409, 'manager cannot hand out to an unapproved participant');
    assert.equal((await send('reward.create', { participantId: inside.id, name: '합성 경품', method: 'ONSITE' })).status, 404, 'an inconsistent participant cannot receive a new entitlement');
    assert.equal((await send('reward.assign', { id: 'pending-reward', participantId: inside.id })).status, 404, 'an inconsistent participant cannot be assigned a pending entitlement');
    assert.equal((await send('reward.create', { participantId: duplicate.id, name: '합성 경품', method: 'ONSITE' })).status, 404, 'duplicate participant identifiers cannot receive a new entitlement');
    assert.equal((await send('reward.assign', { id: 'pending-reward', participantId: duplicate.id })).status, 404);
    for (const id of ['duplicate-reward', 'missing-reward']) {
      assert.equal((await send('reward.collect', { id })).status, 409, 'a direct collection must identify exactly one participant');
      const invalid = await send('reward.fulfill', { id });
      assert.equal(invalid.status, 409); assert.equal(invalid.json.code, 'REWARD_PARTICIPANT_CHANGED');
    }
    const fulfill = await send('reward.fulfill', { id: 'reward' });
    assert.equal(fulfill.status, 409, 'operator fulfillment cannot bypass participant validation');
    assert.equal(fulfill.json.code, 'REWARD_PARTICIPANT_CHANGED');
    assert.equal((await send('lucky.preassign', { participantIds: [entry.id] })).status, 404, 'a conflicting participant cannot receive a lucky number');
    assert.equal((await send('participant.self-update', { name: '변경 이름' }, { bearer: entry.ticket })).status, 404);
    assert.equal((await send('question.submit', {}, { bearer: entry.ticket })).status, 404, 'participant content must not bypass the invalid ticket');
    const originalId = crypto.randomUUID();
    const inconsistent = await send('ticket.reissue', { id: entry.id }, { id: originalId });
    assert.equal(inconsistent.status, 409); assert.equal(inconsistent.json.code, 'TICKET_STATUS_CONFLICT');
    for (const command of ['ticket.reissue', 'ticket.reissue-reviewed']) {
      const guarded = await send(command, { id: entry.id, expectedTicketRevision: 0 });
      assert.equal(guarded.status, 409); assert.equal(guarded.json.code, 'TICKET_STATUS_CONFLICT');
    }
    assert.deepEqual(await read(), before, 'rejected operations preserve the entire workspace and its revision');
    const missing = await h.database.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [originalId]);
    assert.equal(missing.rowCount, 0, 'denied issuance never creates a success receipt');
    assert.equal((await requestJson(h.baseUrl, `/api/public/events/${eventId}/ticket`, { bearer: valid.ticket })).status, 200, 'normal tickets still work');
    const entryId = crypto.randomUUID();
    const admitted = await send('check.scan', { deskId: 'in', expectedAction: 'IN', ticket: valid.ticket }, { cookie: staffCookie, assignmentId: 'staff-in', id: entryId });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.json));
    assert.equal((await send('check.scan', { deskId: 'in', expectedAction: 'IN', ticket: valid.ticket }, { cookie: staffCookie, assignmentId: 'staff-in', id: entryId })).status, 200, 'an unchanged scan still replays');
    const fulfilledId = crypto.randomUUID();
    assert.equal((await send('reward.fulfill', { id: 'valid-reward' }, { id: fulfilledId })).status, 200);
    const state = await read(); state.payload.participants.find(p => p.id === valid.id).cancelled = true;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb,revision=revision+1 WHERE event_id=$1', [eventId, JSON.stringify(state.payload)]);
    const retry = await send('check.scan', { deskId: 'in', expectedAction: 'IN', ticket: valid.ticket }, { cookie: staffCookie, assignmentId: 'staff-in', id: entryId });
    assert.equal(retry.status, 200, 'the committed entry remains idempotent');
    assert.equal(retry.json.recordStatus, 'PARTICIPANT_CHANGED', 'a committed receipt must not imply the conflicting participant is currently eligible');
    const fulfilledReplay = await send('reward.fulfill', { id: 'valid-reward' }, { id: fulfilledId });
    assert.equal(fulfilledReplay.status, 200, 'a completed reward receipt remains recoverable');
    assert.equal(fulfilledReplay.json.reward.status, 'RECEIVED');
  } finally { await h.close(); }
});

test('legacy ticket receipt remains idempotent but cannot reveal a different or cancelled target after access is revoked', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `legacy-ticket-${suffix}`, manager = `manager-${suffix}`;
    const make = id => ({ id, name: `합성 ${id}`, phone: id === 'a' ? '01010101010' : '01020202020', status: 'APPROVED', paymentStatus: 'FREE', revoked: false,
      inside: false, everIn: false, ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`, ticketRevision: 0,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() });
    const w = emptyWorkspace(); w.participants = [make('a'), make('b')];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 관리자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace: w });
    await insertMembership(h.database, manager, eventId, ['participants']);
    const cookie = await sessionCookie(h, manager), id = crypto.randomUUID();
    const send = (target = 'a') => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie,
      body: { commandId: id, command: 'ticket.reissue', payload: { id: target } } });
    const issued = await send(); assert.equal(issued.status, 200, JSON.stringify(issued.json));
    assert.equal((await send()).json.participant.ticket, issued.json.participant.ticket, 'unchanged old clients recover the original ticket');
    const mismatch = await send('b'); assert.equal(mismatch.status, 409); assert.equal(mismatch.json.code, 'TICKET_REISSUE_MISMATCH');
    await h.database.query("UPDATE memberships SET write_permissions='[]'::jsonb WHERE account_id=$1 AND event_id=$2", [manager, eventId]);
    const forbidden = await send(); assert.equal(forbidden.status, 403, 'a revoked write grant cannot retrieve a bearer ticket');
    assert.equal(forbidden.json.participant, undefined);
    await h.database.query("UPDATE memberships SET write_permissions='[\"participants\"]'::jsonb WHERE account_id=$1 AND event_id=$2", [manager, eventId]);
    const row = (await h.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    row.payload.participants[0].cancelled = true;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb,revision=revision+1 WHERE event_id=$1', [eventId, JSON.stringify(row.payload)]);
    const beforeRetry = (await h.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    const stale = await send(); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'TICKET_RESULT_SUPERSEDED');
    assert.equal(stale.json.participant, undefined);
    assert.equal((await requestJson(h.baseUrl, `/api/public/events/${eventId}/ticket`, { bearer: issued.json.participant.ticket })).status, 404);
    assert.deepEqual((await h.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0], beforeRetry);
  } finally { await h.close(); }
});

test('a cancellation conflict invalidates guest and prize proofs without erasing earlier committed work', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `cancel-proof-${suffix}`, staff = `staff-${suffix}`;
    const person = { id: 'person', name: '합성 참가자', company: '합성 회사', phone: '01012345678', status: 'APPROVED', paymentStatus: 'FREE',
      inside: true, everIn: true, revoked: false, ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() };
    const w = emptyWorkspace(); Object.assign(w, { participants: [person], stampMode: 'SELF',
      desks: [{ id: 'out', name: '퇴장', action: 'OUT', open: true }],
      booths: [{ id: 'booth', name: '합성 부스', status: 'OPEN', used: 0, capacity: 0, limit: 2 }],
      rewards: [{ id: 'reward', name: '합성 경품', participantId: person.id, status: 'READY', method: 'ONSITE' }],
      modules: [{ id: 'qa', type: 'qa', title: '합성 질문', status: 'OPEN', published: true }] });
    await insertAccount(h.database, { id: staff, role: 'STAFF', name: '합성 스태프', email: `${staff}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: ['stamp', 'reward', 'qa'], capacity: 100 }, workspace: w });
    await insertAssignment(h.database, { id: 'staff-out', accountId: staff, eventId, type: 'DESK', targetId: 'out' });
    const cookie = await sessionCookie(h, staff), boothId = crypto.randomUUID(), questionId = crypto.randomUUID(), rewardId = crypto.randomUUID();
    const guest = (command, payload, id) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', bearer: person.ticket, body: { command, payload, commandId: id } });
    const staffSend = (command, payload, id) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie,
      body: { command, payload, commandId: id, assignmentId: 'staff-out' } });
    const booth = { code: `ET:BOOTH:${eventId}:booth` }, question = { moduleId: 'qa', text: '합성 질문입니다' };
    const visited = await guest('booth.visit', booth, boothId); assert.equal(visited.status, 201, JSON.stringify(visited.json));
    assert.equal((await guest('booth.visit', booth, boothId)).status, 200);
    const submitted = await guest('question.submit', question, questionId); assert.equal(submitted.status, 201, JSON.stringify(submitted.json));
    assert.equal((await guest('question.submit', question, questionId)).status, 200);
    const lookup = await staffSend('reward.lookup', { ticket: person.ticket }, rewardId); assert.equal(lookup.status, 200, JSON.stringify(lookup.json));
    const receipt = `/api/events/${eventId}/command-receipts/${boothId}`;
    assert.equal((await requestJson(h.baseUrl, receipt, { bearer: person.ticket })).json.status, 'APPLIED');
    const current = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    current.payload.participants[0].cancelled = true;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb,revision=revision+1 WHERE event_id=$1', [eventId, JSON.stringify(current.payload)]);
    const before = (await h.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    assert.equal((await requestJson(h.baseUrl, receipt, { bearer: person.ticket })).status, 404, 'a conflicting ticket cannot inspect its receipt');
    assert.equal((await guest('booth.visit', booth, boothId)).status, 404, 'a guest cannot replay a booth receipt with an invalid ticket');
    assert.equal((await guest('question.submit', question, questionId)).status, 404, 'a guest cannot replay content with an invalid ticket');
    const collect = await staffSend('reward.collect', { id: 'reward', verificationId: lookup.json.rewardVerificationId }, crypto.randomUUID());
    assert.equal(collect.status, 409); assert.equal(collect.json.code, 'REWARD_VERIFICATION_CHANGED');
    const after = (await h.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    assert.deepEqual(after, before, 'later refusals must not delete the original visit, question, or reward');
    assert.equal(after.payload.visits.length, 1); assert.equal(after.payload.questions.length, 1); assert.equal(after.payload.rewards[0].status, 'READY');
  } finally { await h.close(); }
});

test('legacy numeric reward targets remain usable only when they identify one approved person', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `legacy-reward-${suffix}`, manager = `manager-${suffix}`;
    const person = { id: 42, name: '합성 이전 참가자', phone: '01011112222', status: 'APPROVED', paymentStatus: 'FREE', inside: false, everIn: false, revoked: false };
    const w = emptyWorkspace(); w.participants = [person];
    w.rewards = ['fulfill', 'collect', 'ambiguous'].map(id => ({ id, name: `합성 ${id}`, participantId: 42, status: 'READY', method: 'ONSITE' }));
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: ['reward'], capacity: 100 }, workspace: w });
    await insertMembership(h.database, manager, eventId, ['all']);
    const cookie = await sessionCookie(h, manager);
    const send = (command, id) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId: crypto.randomUUID(), command, payload: { id } } });
    assert.equal((await send('reward.fulfill', 'fulfill')).status, 200, 'the legacy numeric target remains supported');
    assert.equal((await send('reward.collect', 'collect')).status, 200, 'the prior numeric collection behavior remains supported');
    const current = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0];
    current.payload.participants.push({ ...person, id: '42', name: '합성 중복 참가자' });
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(current.payload)]);
    assert.equal((await send('reward.fulfill', 'ambiguous')).status, 409, 'numeric and string forms of the same identifier are ambiguous');
    assert.equal((await send('reward.collect', 'ambiguous')).status, 409);
    assert.equal((await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload.rewards.find(r => r.id === 'ambiguous').status, 'READY');
  } finally { await h.close(); }
});
