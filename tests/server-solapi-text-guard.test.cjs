'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { emptyWorkspace } = require('../server/state');
const { COMMANDS } = require('../server/commands/domain');
const { createDomainCommands } = require('../server/commands/domain');
const { recipientReviewVersion } = require('../server/commands/content-results');
const { enqueueDueScheduled } = require('../server/message-maintenance');
const { drainMessageOutbox } = require('../server/message-outbox');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

test('reviewed Solapi writes, schedules and final queue protect the whole campaign', async () => {
  const requests = [];
  const fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { requests.push({ path: req.url, body: raw ? JSON.parse(raw) : null }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.method === 'GET' ? { messageList: {} } : { groupInfo: { groupId: 'synthetic' }, failedMessageList: [] })); });
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const h = await startApiHarness({ env: { SOLAPI_API_KEY: 'synthetic', SOLAPI_API_SECRET: 'synthetic', SOLAPI_SENDER: '01011112222', SOLAPI_KAKAO_PFID: 'synthetic', SOLAPI_API_HOST: `http://127.0.0.1:${fake.address().port}` } });
  const createCommand = 'message.create-charset-reviewed';
  try {
    const eventId = `charset-${crypto.randomUUID()}`, manager = `manager-${crypto.randomUUID()}`;
    const workspace = emptyWorkspace();
    workspace.participants = ['a', 'b'].map((id, index) => ({ id, name: `합성 ${id}`, phone: `0100000000${index}`, status: 'APPROVED', ticket: `synthetic-ticket-${id}` }));
    workspace.templates = [{ id: 'template', name: '합성 알림톡', channel: 'ALIMTALK', body: '안내 🎉', solapiTemplateId: 'synthetic', archived: false }];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', date: '2027-01-16', stage: 'READY', features: [] }, workspace });
    await insertMembership(h.database, manager, eventId, ['all']);
    const cookie = await sessionCookie(h, manager);
    const send = (command, payload, commandId = crypto.randomUUID()) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId, command, payload } });
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const save = async value => h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(value)]);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const payload = { ids: ['a', 'b'], expectedRecipientVersions: workspace.participants.map(recipientReviewVersion), channel: 'SMS', title: '안내', body: '{{이름}}님 환영합니다', scheduled: future };
    const oldId = crypto.randomUUID();
    COMMANDS.delete(createCommand);
    const old = await send(createCommand, payload, oldId);
    assert.equal(old.status, 400); assert.equal(old.json.field, 'command');
    assert.equal((await read()).messages.length, 0);
    COMMANDS.add(createCommand);
    const rejected = await send(createCommand, { ...payload, body: '안내 🎉' });
    assert.equal(rejected.status, 409); assert.equal(rejected.json.code, 'SMS_CHARSET_UNSUPPORTED'); assert.equal(rejected.json.field, 'body');
    const immediateRejected = await send(createCommand, { ...payload, scheduled: '', body: '안내 🎉' });
    assert.equal(immediateRejected.status, 409); assert.equal(immediateRejected.json.code, 'SMS_CHARSET_UNSUPPORTED');
    assert.equal(requests.length, 0, 'neither immediate nor future invalid requests may call the provider');
    assert.equal((await read()).messages.length, 0, 'even a future schedule is rejected before recording an invalid request');
    const saved = await send(createCommand, payload, oldId);
    assert.equal(saved.status, 201, JSON.stringify(saved.json)); assert.equal(saved.json.messageCharsetPolicyVersion, 1);
    assert.equal(JSON.stringify(saved.json.message).includes('synthetic-ticket-'), false, 'ticket bearers must not be persisted in campaign or receipt');
    assert.deepEqual((await send(createCommand, payload, oldId)).json, saved.json, 'same request replays the original receipt');
    const mismatch = await send(createCommand, { ...payload, body: '다른 내용' }, oldId);
    assert.equal(mismatch.status, 409); assert.equal(mismatch.json.code, 'MESSAGE_RECEIPT_MISMATCH');
    const fallbackBase = { ...payload, channel: 'ALIMTALK', templateId: 'template', body: '안내 🎉' };
    assert.equal((await send(createCommand, fallbackBase)).json.field, 'smsFallback');
    assert.equal((await send(createCommand, { ...fallbackBase, smsFallback: true })).json.code, 'SMS_CHARSET_UNSUPPORTED');
    const noFallback = await send(createCommand, { ...fallbackBase, smsFallback: false });
    assert.equal(noFallback.status, 201); assert.equal(noFallback.json.message.smsFallback, false);
    const immediateAlimtalk = await send(createCommand, { ...fallbackBase, scheduled: '', smsFallback: false });
    assert.equal(immediateAlimtalk.status, 201, JSON.stringify(immediateAlimtalk.json));
    const providerSend = requests.find(item => item.path === '/messages/v4/send-many/detail');
    assert.ok(providerSend); assert.equal(providerSend.body.messages[0].kakaoOptions.disableSms, true);
    assert.equal(providerSend.body.messages[0].text, '안내 🎉', 'Alimtalk content is not rewritten');

    const simulated = await send(createCommand, { ...payload, body: '모의 🎉', simulate: true });
    assert.equal(simulated.status, 201, 'synthetic sends are not represented as Solapi submissions');
    const scheduledSimulated = await send(createCommand, { ...payload, simulate: true });
    assert.equal(scheduledSimulated.status, 201);
    const retryId = crypto.randomUUID(), retryCommand = 'message.retry-charset-reviewed';
    const forRetry = await read();
    forRetry.messages.find(message => message.id === scheduledSimulated.json.message.id).scheduled = new Date(Date.now() - 1000).toISOString();
    await save(forRetry);
    COMMANDS.delete(retryCommand);
    assert.equal((await send(retryCommand, { id: scheduledSimulated.json.message.id }, retryId)).status, 400);
    COMMANDS.add(retryCommand);
    const retried = await send(retryCommand, { id: scheduledSimulated.json.message.id }, retryId);
    assert.equal(retried.status, 200); assert.equal(retried.json.messageCharsetPolicyVersion, 1);
    assert.deepEqual((await send(retryCommand, { id: scheduledSimulated.json.message.id }, retryId)).json, retried.json);
    assert.equal((await send(retryCommand, { id: noFallback.json.message.id }, retryId)).json.code, 'MESSAGE_RECEIPT_MISMATCH');

    const changed = await read();
    changed.participants.find(person => person.id === 'b').name = '합성 🎉';
    const scheduled = changed.messages.find(message => message.id === oldId);
    scheduled.scheduled = new Date(Date.now() - 1000).toISOString();
    scheduled.scheduleMode = 'AUTO'; scheduled.autoScheduleIntent = 'confirmed-v1';
    await save(changed);
    const bootstrap = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap?messageRecipientReview=1`, { cookie });
    assert.equal(bootstrap.status, 200);
    assert.ok(bootstrap.json.state.messageSchedule.blocked.some(item => item.id === oldId && item.reason === 'SMS_CHARSET_UNSUPPORTED' && item.missing === 1 && item.field === 'ids'));
    const retry = await send('message.retry-charset-reviewed', { id: oldId });
    assert.equal(retry.status, 409); assert.equal(retry.json.code, 'SMS_CHARSET_UNSUPPORTED'); assert.equal(retry.json.field, 'ids');
    const queued = await enqueueDueScheduled(h.database, { now: new Date().toISOString(), eventIds: [eventId], providerKind: 'solapi' });
    assert.ok(queued.skippedDue.some(item => item.messageId === oldId && item.reason === 'SMS_CHARSET_UNSUPPORTED'));
    assert.equal((await read()).messages.find(message => message.id === oldId).status, 'SCHEDULED');
    assert.equal((await h.database.query('SELECT message_id FROM message_outbox WHERE message_id=$1', [oldId])).rowCount, 0);

    // Cancelling a blocked reservation must leave a safely usable route back
    // to the composer, but never classify ambiguous historical sends as safe.
    const forCancel = await read();
    const blockedReservation = forCancel.messages.find(message => message.id === oldId);
    const safeCancelId = crypto.randomUUID();
    const unsafeCases = [
      { attempts: 1 }, { providerSubmission: { id: 'prior' } }, { providerGroupId: 'prior' },
      { deliveryUnconfirmed: true }, { genericSubmissionUnconfirmed: true },
      { acceptedCount: 1 }, { deliveries: blockedReservation.deliveries.map((item, index) => index ? item : { ...item, status: 'SENT' }) },
      { recipientSnapshot: [{ id: '' }, { id: 'b' }], recipientIds: ['', 'b'], deliveries: [{ participantId: '', status: 'WAITING' }, { participantId: 'b', status: 'WAITING' }] },
      { recipientIds: ['a', 'missing'] }, { recipientIds: ['a', 'a'] },
      { deliveries: [{ participantId: 'a', status: 'WAITING' }, { participantId: 'missing', status: 'WAITING' }] },
    ];
    const unsafeIds = unsafeCases.map(() => crypto.randomUUID());
    forCancel.messages.unshift({ ...blockedReservation, id: safeCancelId },
      ...unsafeCases.map((item, index) => ({ ...blockedReservation, ...item, id: unsafeIds[index] })));
    await save(forCancel);
    const cancelId = crypto.randomUUID();
    const cancelled = await send('message.cancel', { id: safeCancelId }, cancelId);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.message.status, 'CANCELLED');
    assert.equal(cancelled.json.message.smsTextReloadSafe, true);
    assert.equal(cancelled.json.message.smsTextProblemCount, 1);
    assert.equal(cancelled.json.message.smsTextProblemField, 'ids');
    assert.equal(JSON.stringify(cancelled.json.message).includes('synthetic-ticket-'), false);
    assert.deepEqual((await send('message.cancel', { id: safeCancelId }, cancelId)).json, cancelled.json, 'same cancellation receipt must be replayed');
    for (const id of unsafeIds) {
      const result = await send('message.cancel', { id });
      assert.equal(result.status, 200);
      assert.notEqual(result.json.message.smsTextReloadSafe, true, 'unknown or prior acceptance is never made safe to reload');
    }
    assert.equal(requests.filter(item => item.path === '/messages/v4/send-many/detail').length, 1, 'cancellation must never send');

    const withLegacy = await read();
    const legacyId = crypto.randomUUID();
    const legacy = { ...withLegacy.messages.find(message => message.id === noFallback.json.message.id), id: legacyId, scheduled: new Date(Date.now() - 1000).toISOString() };
    delete legacy.smsFallback;
    withLegacy.messages.unshift(legacy);
    await save(withLegacy);
    const legacyRetry = await send('message.retry', { id: legacyId });
    assert.equal(legacyRetry.status, 409); assert.equal(legacyRetry.json.code, 'SMS_CHARSET_UNSUPPORTED', 'legacy Alimtalk keeps fallback on and is not silently changed');

    // A new unsupported name appears after an older valid request was queued.
    const beforeDrain = await read();
    const lateId = crypto.randomUUID(), unknownId = crypto.randomUUID(), acceptedId = crypto.randomUUID();
    const late = { ...beforeDrain.messages.find(message => message.id === oldId), id: lateId, status: 'SENDING', scheduled: '', attempts: 1, deliveries: workspace.participants.map(person => ({ participantId: person.id, status: 'SENDING' })) };
    beforeDrain.messages.unshift(late, { ...late, id: unknownId, providerSubmission: { id: 'old-attempt', at: new Date().toISOString() }, deliveryUnconfirmed: true },
      { ...late, id: acceptedId, providerGroupId: 'prior-group', deliveryUnconfirmed: true });
    await save(beforeDrain);
    for (const id of [lateId, unknownId, acceptedId]) await h.database.query("INSERT INTO message_outbox (message_id,event_id,status,attempts,next_attempt_at) VALUES ($1,$2,'PENDING',0,now())", [id,eventId]);
    let calls = 0;
    const provider = { state: { connected: true, provider: 'solapi' }, sendBatch: async () => { calls += 1; throw new Error('unexpected provider call'); },
      groupMessages: async () => ({ ok: true, messages: { 'existing-id': { to: '01000000000' } } }) };
    await drainMessageOutbox(h.database, provider);
    const after = await read();
    assert.equal(calls, 0, 'no recipient is submitted after a personalized text issue');
    const blocked = after.messages.find(message => message.id === lateId);
    assert.equal(blocked.status, 'FAILED'); assert.equal(blocked.acceptedCount, 0); assert.equal(blocked.smsTextProblemCount, 1); assert.equal(blocked.smsTextProblemField, 'ids');
    const unknown = after.messages.find(message => message.id === unknownId);
    assert.equal(unknown.status, 'SENDING'); assert.equal(unknown.providerSubmission.id, 'old-attempt'); assert.equal(unknown.deliveryUnconfirmed, true);
    const previouslyAccepted = after.messages.find(message => message.id === acceptedId);
    assert.equal(previouslyAccepted.status, 'SENDING'); assert.equal(previouslyAccepted.providerGroupId, 'prior-group');

    // A structurally incomplete legacy row cannot establish that the set
    // being sent is the same as the reviewed set, even if the one remaining
    // recipient's text happens to be valid. Never send a partial campaign.
    const corrupt = await read();
    const mismatchBase = { ...late, body: '합성 안내', providerGroupId: null, providerSubmission: null, deliveryUnconfirmed: false };
    const mismatchCases = [
      { recipientSnapshot: [mismatchBase.recipientSnapshot[0]] },
      { recipientIds: ['a', 'a'] },
      { deliveries: [mismatchBase.deliveries[0]] },
      { deliveries: [{ participantId: 'a', status: 'SENDING' }, { participantId: 'other', status: 'SENDING' }] },
      // Alimtalk with fallback off still must not send a different recipient
      // set than the one the operator reviewed.
      { channel: 'ALIMTALK', smsFallback: false, recipientSnapshot: [mismatchBase.recipientSnapshot[0]] },
    ];
    const mismatchIds = mismatchCases.map(() => crypto.randomUUID());
    corrupt.messages.unshift(...mismatchCases.map((change, index) => ({ ...mismatchBase, ...change, id: mismatchIds[index] })));
    await save(corrupt);
    for (const id of mismatchIds) await h.database.query("INSERT INTO message_outbox (message_id,event_id,status,attempts,next_attempt_at) VALUES ($1,$2,'PENDING',0,now())", [id,eventId]);
    await drainMessageOutbox(h.database, provider);
    const corruptAfter = await read();
    for (const id of mismatchIds) {
      const message = corruptAfter.messages.find(item => item.id === id);
      assert.equal(message.status, 'FAILED');
      assert.equal(message.acceptedCount, 0);
      assert.equal(message.smsTextProblemUnknown, true);
    }
    assert.equal(calls, 0, 'mismatched recipient records never call the provider');

    const genericCalls = [];
    const generic = createDomainCommands(h.database, { messaging: { state: { connected: true }, send: async input => { genericCalls.push(input); return { delivered: true }; } } });
    const currentPeople = (await read()).participants;
    const genericResult = await generic.execute({ eventId, commandId: crypto.randomUUID(), command: createCommand,
      payload: { ...payload, scheduled: '', body: '일반 HTTP 🎉', expectedRecipientVersions: currentPeople.map(recipientReviewVersion) },
      account: { id: manager, orgId: LEGACY_ORG } });
    assert.equal(genericResult.body.message.status, 'ACCEPTED');
    assert.equal(genericCalls.length, 2); assert.equal(genericCalls[0].text, '일반 HTTP 🎉');
  } finally { COMMANDS.add(createCommand); COMMANDS.add('message.retry-charset-reviewed'); await h.close(); await new Promise(resolve => fake.close(resolve)); }
});
