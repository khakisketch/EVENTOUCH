'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');
const { createDatabase } = require('../server/db');
const { sendQueuedCampaign, drainMessageOutbox } = require('../server/message-outbox');
const { enqueueDueScheduled } = require('../server/message-maintenance');
const { resolveDelivery } = require('../server/messaging');

const now = '2026-11-10T00:00:00.000Z';
let admin;
let database;
let schema;
let storage;
let originalStorage;
let originalOrigin;

before(async () => {
  assert.ok(testDatabaseUrl(), 'EVENTOUCH_TEST_DATABASE_URL is required; missing DB is not a pass');
  schema = `message_submission_${randomUUID().replaceAll('-', '')}`;
  admin = createDatabase({ connectionString: testDatabaseUrl() });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(testDatabaseUrl());
  url.searchParams.set('options', `-c search_path=${schema}`);
  database = createDatabase({ connectionString: url.toString() });
  await database.migrate();
  storage = await fs.mkdtemp(path.join(os.tmpdir(), 'message-submission-'));
  originalStorage = process.env.STORAGE_DIR;
  originalOrigin = process.env.EVENTOUCH_PUBLIC_URL;
  process.env.STORAGE_DIR = storage;
  process.env.EVENTOUCH_PUBLIC_URL = 'https://synthetic.example.test';
});

after(async () => {
  if (originalStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = originalStorage;
  if (originalOrigin === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
  else process.env.EVENTOUCH_PUBLIC_URL = originalOrigin;
  if (database) await database.close();
  if (admin) {
    try { if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.close(); }
  }
  if (storage) await fs.rm(storage, { recursive: true, force: true });
});

afterEach(async () => {
  if (database) await database.query('DELETE FROM events');
});

async function fixture({ channel = 'SMS', body = 'Hello', stage = 'READY', status = 'SENDING' } = {}) {
  const eventId = `event-${randomUUID()}`;
  const messageId = `message-${randomUUID()}`;
  const participant = { id: 'p1', name: 'Attendee', phone: '01011112222', status: 'APPROVED',
    group: 'General', ticket: `ET:${eventId}:T-${'a'.repeat(43)}`, ticketExpiresAt: '2099-12-01T00:00:00Z', paymentStatus: 'FREE' };
  const message = { id: messageId, channel, body, title: 'Invitation', status, attempts: 1,
    recipientIds: ['p1'], recipientSnapshot: [{ id: 'p1', name: participant.name, phone: participant.phone }],
    deliveries: [{ participantId: 'p1', name: participant.name, status: status === 'SCHEDULED' ? 'WAITING' : 'SENDING' }],
    ...(status === 'SCHEDULED' ? { scheduled: '2026-01-01T00:00:00Z', scheduleMode: 'AUTO', autoScheduleIntent: 'confirmed-v1' } : {}) };
  if (channel === 'MMS') {
    const fileId = `image-${randomUUID()}`;
    message.image = { fileId };
    await fs.writeFile(path.join(storage, fileId), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  const event = { id: eventId, slug: eventId, name: 'Synthetic Event', stage, date: '2026-12-01' };
  await database.query('INSERT INTO events (id, slug, org_id, payload) VALUES ($1, $1, $2, $3::jsonb)',
    [eventId, 'org-legacy', JSON.stringify(event)]);
  await database.query('INSERT INTO event_workspaces (event_id, payload) VALUES ($1, $2::jsonb)',
    [eventId, JSON.stringify({ participants: [participant], messages: [message], audit: [], syntheticSentinel: { preserve: true } })]);
  if (message.image) {
    await database.query(`INSERT INTO stored_files (id, event_id, storage_key, original_name, content_type, size_bytes)
      VALUES ($1, $2, $1, 'synthetic.jpg', 'image/jpeg', 4)`, [message.image.fileId, eventId]);
  }
  return { eventId, messageId, participant };
}

async function editWorkspace(f, edit) {
  await database.transaction(async client => {
    const result = await client.query('SELECT payload FROM event_workspaces WHERE event_id=$1 FOR UPDATE', [f.eventId]);
    const workspace = result.rows[0].payload;
    edit(workspace, workspace.messages[0]);
    await client.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  });
}

async function archive(f) {
  await database.query("UPDATE events SET payload=jsonb_set(payload, '{stage}', '\"ARCHIVED\"'::jsonb) WHERE id=$1", [f.eventId]);
}

async function readMessage(f) {
  const row = await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId]);
  assert.deepEqual(row.rows[0].payload.syntheticSentinel, { preserve: true });
  return row.rows[0].payload.messages[0];
}

// Mutate through a separate committed transaction after dispatch construction's
// snapshot is released, before the final submission reservation can lock it.
function afterSnapshot(edit, snapshotNumber = 1) {
  let edited = false;
  let snapshots = 0;
  return {
    query: (...args) => database.query(...args),
    async transaction(fn) {
      let snapshotRead = false;
      const result = await database.transaction(client => fn({ query(sql, params) {
        if (/FROM events e JOIN event_workspaces/.test(sql)) snapshotRead = true;
        return client.query(sql, params);
      } }));
      if (snapshotRead && ++snapshots === snapshotNumber && !edited) {
        edited = true;
        await edit();
      }
      return result;
    },
  };
}

function providerFor(f, { upload, send, transport = 'batch' } = {}) {
  const submitted = [];
  const provider = {
    state: { connected: true, provider: 'solapi' },
    submitted,
    async uploadImage() {
      await assertNoEventLocks(f);
      if (upload) await upload();
      return { ok: true, imageId: 'IMAGE-ACCEPTED' };
    },
    async groupMessages() {
      await assertNoEventLocks(f);
      return { ok: true, messages: { M1: { messageId: 'M1', to: f.participant.phone } } };
    },
    async pollResults(ids) {
      return { ok: true, results: Object.fromEntries(ids.map(id => [id, { state: 'DELIVERED', type: 'SMS' }])) };
    },
  };
  if (transport === 'batch') provider.sendBatch = async (recipients, options) => {
    await assertNoEventLocks(f);
    submitted.push({ recipients, options });
    if (send) return send(recipients, options);
    return { accepted: true, groupId: 'GROUP-ACCEPTED', registered: recipients.map(r => ({ participantId: r.participantId, accepted: true, type: r.channel })), rejected: [] };
  };
  else provider.send = async recipient => {
    await assertNoEventLocks(f);
    submitted.push(recipient);
    if (send) return send(recipient);
    return { delivered: true, providerId: 'HTTP-ACCEPTED' };
  };
  return provider;
}

async function assertNoEventLocks(f) {
  await database.transaction(async client => {
    await client.query("SET LOCAL lock_timeout='200ms'");
    await client.query('SELECT id FROM events WHERE id=$1 FOR UPDATE NOWAIT', [f.eventId]);
    await client.query('SELECT event_id FROM event_workspaces WHERE event_id=$1 FOR UPDATE NOWAIT', [f.eventId]);
  });
}

for (const transport of ['batch', 'http']) {
  for (const [change, edit] of [
    ['phone', workspace => { workspace.participants[0].phone = '01099998888'; }],
    ['participant cancellation', workspace => { workspace.participants[0].status = 'CANCELLED'; }],
    ['ticket revocation', workspace => { workspace.participants[0].revoked = true; }],
    ['campaign cancellation', (_workspace, message) => { message.status = 'CANCELLED'; }],
  ]) {
    test(`${transport}: ${change} committed after snapshot prevents a new submission`, async () => {
      const f = await fixture();
      const provider = providerFor(f, { transport });
      if (transport === 'http') await database.query(
        "INSERT INTO message_outbox (message_id,event_id,status) VALUES ($1,$2,'SENDING')", [f.messageId, f.eventId]);
      const result = await sendQueuedCampaign(afterSnapshot(() => editWorkspace(f, edit)), provider, f, { now });
      assert.equal(provider.submitted.length, 0, 'no stale recipient reaches the supplier');
      assert.equal(result.attempted, false);
      const message = await readMessage(f);
      assert.equal(message.status, change === 'campaign cancellation' ? 'CANCELLED' : 'FAILED');
      assert.equal(message.providerSubmission, undefined);
    });
  }
}

test('ticket reissue after snapshot never submits the superseded bearer link', async () => {
  const f = await fixture({ body: 'Open {{티켓링크}}' });
  const provider = providerFor(f);
  const result = await sendQueuedCampaign(afterSnapshot(() => editWorkspace(f, workspace => {
    workspace.participants[0].ticket = `ET:${f.eventId}:T-${'b'.repeat(43)}`;
  })), provider, f, { now });
  assert.equal(provider.submitted.length, 0, 'changed dispatch variables need a fresh dispatch pass');
  assert.equal(result.attempted, false);
});

test('charset changes in event variables after snapshot block Solapi submission', async () => {
  const f = await fixture({ body: '{{행사명}}' });
  const provider = providerFor(f);
  const result = await sendQueuedCampaign(afterSnapshot(() => database.query(
    "UPDATE events SET payload=jsonb_set(payload, '{name}', to_jsonb($2::text)) WHERE id=$1", [f.eventId, 'Event \u{1f600}'])), provider, f, { now });
  assert.equal(provider.submitted.length, 0);
  assert.equal(result.attempted, false);
  assert.equal((await readMessage(f)).smsTextProblemCount, 1);
});

for (const change of ['phone', 'archive', 'ticket reissue']) {
  test(`MMS upload gap: ${change} prevents submitting the earlier snapshot`, async () => {
    const f = await fixture({ channel: 'MMS', body: change === 'ticket reissue' ? '{{티켓링크}}' : 'Hello' });
    let uploads = 0;
    const provider = providerFor(f, { upload: async () => {
      uploads += 1;
      if (change === 'archive') await archive(f);
      else await editWorkspace(f, workspace => {
        if (change === 'phone') workspace.participants[0].phone = '01099998888';
        else workspace.participants[0].ticket = `ET:${f.eventId}:T-${'b'.repeat(43)}`;
      });
    } });
    const result = await sendQueuedCampaign(database, provider, f, { now });
    assert.equal(uploads, 1);
    assert.equal(provider.submitted.length, 0);
    assert.equal(result.attempted, false);
  });
}

test('archived events keep due AUTO reservations scheduled without enqueueing', async () => {
  const f = await fixture({ stage: 'ARCHIVED', status: 'SCHEDULED' });
  const result = await enqueueDueScheduled(database, { now, eventIds: [f.eventId], providerKind: 'solapi' });
  assert.equal(result.enqueued, 0);
  assert.ok(result.skippedDue.some(item => item.messageId === f.messageId && item.reason === 'EVENT_ARCHIVED'));
  assert.equal((await readMessage(f)).status, 'SCHEDULED');
  const outbox = await database.query('SELECT * FROM message_outbox WHERE message_id=$1', [f.messageId]);
  assert.equal(outbox.rowCount, 0);
});

test('archive between enqueue and dispatch blocks unsubmitted outbox work', async () => {
  const f = await fixture({ status: 'SCHEDULED' });
  assert.equal((await enqueueDueScheduled(database, { now, eventIds: [f.eventId], providerKind: 'solapi' })).enqueued, 1);
  await archive(f);
  const provider = providerFor(f);
  const result = await drainMessageOutbox(database, provider, { now });
  assert.equal(provider.submitted.length, 0);
  assert.equal(result.dispatched, 0);
  assert.equal((await readMessage(f)).status, 'FAILED');
});

for (const transport of ['batch', 'http']) {
  test(`${transport}: archive after snapshot blocks the final new-submission reservation`, async () => {
    const f = await fixture();
    const provider = providerFor(f, { transport });
    if (transport === 'http') await database.query(
      "INSERT INTO message_outbox (message_id,event_id,status) VALUES ($1,$2,'SENDING')", [f.messageId, f.eventId]);
    const result = await sendQueuedCampaign(afterSnapshot(() => archive(f)), provider, f, { now });
    assert.equal(provider.submitted.length, 0);
    assert.equal(result.attempted, false);
  });
}

test('archive after supplier acceptance preserves correlation, restart reconciliation and delivery polling', async () => {
  const f = await fixture();
  const provider = providerFor(f, { send: async recipients => {
    await archive(f);
    await editWorkspace(f, workspace => { workspace.participants[0].phone = '01099998888'; });
    return { accepted: true, groupId: 'GROUP-ACCEPTED', registered: recipients.map(r => ({ participantId: r.participantId, accepted: true, type: 'SMS' })), rejected: [] };
  } });
  await sendQueuedCampaign(database, provider, f, { now });
  let message = await readMessage(f);
  assert.equal(message.providerGroupId, 'GROUP-ACCEPTED');
  assert.equal(message.deliveries[0].solapiMessageId, 'M1');
  await database.query("INSERT INTO message_outbox (message_id,event_id) VALUES ($1,$2)", [f.messageId, f.eventId]);
  const replay = await drainMessageOutbox(database, provider, { now });
  assert.equal(replay.reconciled, 1);
  assert.equal(provider.submitted.length, 1);
  assert.equal((await resolveDelivery(database, provider, f.eventId, { now })).resolved, 1);
  message = await readMessage(f);
  assert.equal(message.status, 'SENT');
  assert.equal(message.deliveries[0].solapiMessageId, 'M1');
});

test('archiving an uncertain accepted submission does not erase the persisted lookup token', async () => {
  const f = await fixture();
  let submissionId;
  const provider = providerFor(f, { send: async (_recipients, options) => {
    submissionId = options.submissionId;
    await archive(f);
    return { accepted: false, reason: 'TRANSPORT' };
  } });
  provider.findSubmission = async submission => {
    assert.equal(submission.id, submissionId);
    return { ok: true, groupId: 'GROUP-RECOVERED', messages: { M1: { messageId: 'M1', to: f.participant.phone } } };
  };
  await sendQueuedCampaign(database, provider, f, { now });
  assert.equal((await readMessage(f)).providerSubmission.id, submissionId);
  assert.equal((await sendQueuedCampaign(database, provider, f, { now })).attempted, false);
  assert.equal((await readMessage(f)).providerSubmission.id, submissionId);
  assert.equal(provider.submitted.length, 1);
  assert.equal((await resolveDelivery(database, provider, f.eventId, { now })).resolved, 1);
  const message = await readMessage(f);
  assert.equal(message.status, 'SENT');
  assert.equal(message.providerGroupId, 'GROUP-RECOVERED');
});

for (const change of ['phone', 'cancellation', 'archive', 'ticket reissue']) {
  test(`HTTP: ${change} while the first recipient is in flight stops new sends without losing acceptance`, async () => {
    const f = await fixture({ body: change === 'ticket reissue' ? '{{티켓링크}}' : 'Hello' });
    await editWorkspace(f, (workspace, message) => {
      const second = { ...workspace.participants[0], id: 'p2', name: 'Second Attendee', phone: '01033334444' };
      workspace.participants.push(second);
      message.recipientIds.push('p2');
      message.recipientSnapshot.push({ id: 'p2', name: second.name, phone: second.phone });
      message.deliveries.push({ participantId: 'p2', name: second.name, status: 'SENDING' });
    });
    await database.query("INSERT INTO message_outbox (message_id,event_id,status) VALUES ($1,$2,'SENDING')", [f.messageId, f.eventId]);
    const provider = providerFor(f, { transport: 'http', send: async () => {
      if (change === 'archive') await archive(f);
      else await editWorkspace(f, workspace => {
        const person = workspace.participants[1];
        if (change === 'phone') person.phone = '01099998888';
        if (change === 'cancellation') person.status = 'CANCELLED';
        if (change === 'ticket reissue') person.ticket = `ET:${f.eventId}:T-${'b'.repeat(43)}`;
      });
      return { delivered: true, providerId: 'HTTP-ACCEPTED' };
    } });
    await sendQueuedCampaign(database, provider, f, { now });
    assert.equal(provider.submitted.length, 1, 'the next recipient is not submitted after its authoritative state changes');
    const message = await readMessage(f);
    assert.equal(message.deliveries[0].status, 'ACCEPTED');
    assert.equal(message.deliveries[0].providerId, 'HTTP-ACCEPTED');
    assert.equal(message.acceptedCount, 1);
    assert.equal(message.status, 'ACCEPTED', 'known acceptance is distinct from an unattempted blocked remainder');
    assert.equal(message.deliveries[1].status, 'FAILED');
    assert.equal(message.deliveries[1].genericProviderResult, 'NOT_ACCEPTED');
    assert.equal(message.genericSubmissionUnconfirmed, false);
    assert.equal(message.providerSubmission, undefined);
  });
}

test('future archived reservations are not reported as already due', async () => {
  const f = await fixture({ stage: 'ARCHIVED', status: 'SCHEDULED' });
  await editWorkspace(f, (_workspace, message) => { message.scheduled = '2099-12-01T00:00:00Z'; });
  const result = await enqueueDueScheduled(database, { now, eventIds: [f.eventId], providerKind: 'solapi' });
  assert.equal(result.enqueued, 0);
  assert.equal(result.duePending, 0);
  assert.deepEqual(result.skippedDue, []);
});

test('ENDED is not ARCHIVED: post-event automatic messaging remains eligible', async () => {
  const f = await fixture({ stage: 'ENDED', status: 'SCHEDULED' });
  assert.equal((await enqueueDueScheduled(database, { now, eventIds: [f.eventId], providerKind: 'solapi' })).enqueued, 1);
  const provider = providerFor(f);
  assert.equal((await drainMessageOutbox(database, provider, { now })).dispatched, 1);
  assert.equal(provider.submitted.length, 1);
  assert.equal((await readMessage(f)).providerGroupId, 'GROUP-ACCEPTED');
});

test('a final recipient guard cannot convert previous unknown acceptance into a proven failure', async () => {
  const f = await fixture();
  const provider = providerFor(f);
  const result = await sendQueuedCampaign(afterSnapshot(() => editWorkspace(f, workspace => {
    workspace.participants[0].phone = '01099998888';
  })), provider, f, { now, previousAcceptanceUnknown: true });
  assert.equal(result.attempted, false);
  assert.equal(provider.submitted.length, 0);
  const message = await readMessage(f);
  assert.equal(message.status, 'SENDING');
  assert.equal(message.deliveryUnconfirmed, true);
  assert.equal(message.deliveries[0].status, 'SENDING');
});

test('MMS upload gap: ticket expiry is checked at submission time, not the attempt timestamp', async () => {
  const f = await fixture({ channel: 'MMS', body: '{{티켓링크}}' });
  let checkTime = Date.parse(now);
  await editWorkspace(f, workspace => { workspace.participants[0].ticketExpiresAt = '2026-11-10T00:00:01.000Z'; });
  let uploads = 0;
  const provider = providerFor(f, { upload: async () => {
    uploads += 1;
    checkTime += 2000;
  } });
  const result = await sendQueuedCampaign(database, provider, f, { now, clock: () => checkTime });
  assert.equal(uploads, 1);
  assert.equal(provider.submitted.length, 0, 'an unchanged bearer link must not bypass its elapsed expiry');
  assert.equal(result.attempted, false);
  const message = await readMessage(f);
  assert.equal(message.status, 'FAILED');
  assert.equal(message.ticketLinkProblemCount, 1);
  assert.equal(message.providerSubmission, undefined);
});

test('HTTP: ticket expiry between recipients stops the next provider call', async () => {
  const f = await fixture({ body: '{{티켓링크}}' });
  let checkTime = Date.parse(now);
  await editWorkspace(f, (workspace, message) => {
    const second = { ...workspace.participants[0], id: 'p2', name: 'Second Attendee', phone: '01033334444',
      ticketExpiresAt: '2026-11-10T00:00:01.000Z' };
    workspace.participants.push(second);
    message.recipientIds.push('p2');
    message.recipientSnapshot.push({ id: 'p2', name: second.name, phone: second.phone });
    message.deliveries.push({ participantId: 'p2', name: second.name, status: 'SENDING' });
  });
  await database.query("INSERT INTO message_outbox (message_id,event_id,status) VALUES ($1,$2,'SENDING')", [f.messageId, f.eventId]);
  const provider = providerFor(f, { transport: 'http', send: async () => {
    checkTime += 2000;
    return { delivered: true, providerId: 'HTTP-ACCEPTED' };
  } });
  await sendQueuedCampaign(database, provider, f, { now, clock: () => checkTime });
  assert.equal(provider.submitted.length, 1, 'expiry alone must stop an unchanged second recipient');
  const message = await readMessage(f);
  assert.equal(message.ticketLinkProblemCount, 1);
  assert.equal(message.deliveries[0].status, 'ACCEPTED');
  assert.equal(message.deliveries[0].providerId, 'HTTP-ACCEPTED');
  assert.equal(message.deliveries[0].at, now, 'the attempt timestamp is independent of the current guard clock');
});


for (const change of ['phone', 'ticket revocation', 'archive']) {
  test(`HTTP reservation gap: ${change} before the first provider call is definitively not accepted`, async () => {
    const f = await fixture({ body: change === 'ticket revocation' ? '{{티켓링크}}' : 'Hello' });
    await database.query("INSERT INTO message_outbox (message_id,event_id,status) VALUES ($1,$2,'SENDING')", [f.messageId, f.eventId]);
    const provider = providerFor(f, { transport: 'http' });
    const result = await sendQueuedCampaign(afterSnapshot(async () => {
      if (change === 'archive') await archive(f);
      else await editWorkspace(f, workspace => {
        if (change === 'phone') workspace.participants[0].phone = '01099998888';
        else workspace.participants[0].revoked = true;
      });
    }, 2), provider, f, { now });
    assert.equal(provider.submitted.length, 0);
    const message = await readMessage(f);
    assert.equal(message.status, 'FAILED', 'a reserved token is not evidence that a provider call happened');
    assert.equal(message.deliveries[0].status, 'FAILED');
    assert.equal(message.deliveries[0].genericProviderResult, 'NOT_ACCEPTED');
    assert.equal(message.acceptedCount, 0);
    assert.equal(message.deliveryUnconfirmed, false);
    assert.equal(message.genericSubmissionUnconfirmed, false);
    assert.equal(message.genericAttemptActive, false);
    assert.equal(message.providerSubmission, undefined);
    assert.equal(result.attempted, false);
  });
}

test('HTTP: a genuinely attempted unknown response survives blocking the unattempted remainder', async () => {
  const f = await fixture();
  await editWorkspace(f, (workspace, message) => {
    const second = { ...workspace.participants[0], id: 'p2', name: 'Second Attendee', phone: '01033334444' };
    workspace.participants.push(second);
    message.recipientIds.push('p2');
    message.recipientSnapshot.push({ id: 'p2', name: second.name, phone: second.phone });
    message.deliveries.push({ participantId: 'p2', name: second.name, status: 'SENDING' });
  });
  await database.query("INSERT INTO message_outbox (message_id,event_id,status) VALUES ($1,$2,'SENDING')", [f.messageId, f.eventId]);
  let submissionId;
  const provider = providerFor(f, { transport: 'http', send: async () => {
    submissionId = (await readMessage(f)).providerSubmission.id;
    await archive(f);
    throw new Error('synthetic response loss after request');
  } });
  const result = await sendQueuedCampaign(database, provider, f, { now });
  assert.equal(provider.submitted.length, 1);
  assert.equal(result.attempted, true);
  const message = await readMessage(f);
  assert.equal(message.status, 'SENDING');
  assert.equal(message.genericAttemptActive, false);
  assert.equal(message.genericSubmissionUnconfirmed, true);
  assert.equal(message.deliveryUnconfirmed, true);
  assert.equal(message.providerSubmission.id, submissionId);
  assert.equal(message.deliveries[0].status, 'SENDING');
  assert.equal(message.deliveries[0].genericProviderResult, 'UNKNOWN');
  assert.equal(message.deliveries[1].status, 'FAILED', "the unsent recipient does not inherit another recipient's uncertainty");
  assert.equal(message.deliveries[1].genericProviderResult, 'NOT_ACCEPTED');
  assert.equal(message.acceptedCount, 0);
});
