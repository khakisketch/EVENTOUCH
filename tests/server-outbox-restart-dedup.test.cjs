'use strict';

// Outbox restart deduplication: a campaign the supplier already accepted must
// not be sent again when its outbox row survives a restart (crash between
// supplier acceptance and the local settle). The drain reconciles a SENDING
// campaign that carries a providerGroupId against the supplier first and
// settles the row without another send; only a group the supplier does not
// know is re-sent.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { drainMessageOutbox } = require('../server/message-outbox');
const { resolveDelivery } = require('../server/messaging');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const accountIds = { agency: `dedup-agency-${suffix}`, manager: `dedup-manager-${suffix}` };
let harness;
let fixtureNumber = 0;
let sendBatchCalls = 0;
let groupQueryCalls = 0;
let supplierKnowsGroup = true;

function batchProvider() {
  return {
    state: { connected: true },
    sendBatch: async (recipients) => {
      sendBatchCalls += 1;
      return {
        accepted: true,
        rejected: [],
        registered: recipients.map((recipient) => ({
          participantId: recipient.participantId,
          accepted: true,
          type: 'SMS',
        })),
        groupId: 'SUPPLIER-GROUP-1',
      };
    },
    groupMessages: async (groupId) => {
      groupQueryCalls += 1;
      assert.equal(groupId, 'SUPPLIER-GROUP-1');
      if (!supplierKnowsGroup) return { ok: false, reason: 'NOT_FOUND' };
      // The supplier demonstrably holds the acceptance: its listing names
      // the message. (An empty ok:true listing is not holding evidence and
      // would hold the row instead — see message-outbox-triage.)
      return { ok: true, messages: { M1: { messageId: 'M1', to: '01000000000' } } };
    },
  };
}

function makeParticipant(eventId, name) {
  return {
    id: `person-${crypto.randomUUID()}`,
    name,
    phone: `010${String(crypto.randomInt(10000000, 99999999))}`,
    email: '', company: '', group: '일반', status: 'APPROVED',
    inside: false, everIn: false, revoked: false,
    ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
    ticketExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
    paymentStatus: 'FREE', answers: {}, consent: null,
    createdAt: new Date().toISOString(),
  };
}

async function createRestartFixture({ withGroupId = false } = {}) {
  fixtureNumber += 1;
  const id = `dedup-${fixtureNumber}-${suffix}`;
  const person = makeParticipant(id, '수신자');
  const messageId = `dedup-message-${fixtureNumber}-${suffix}`;
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id,
    slug: id,
    payload: {
      id, slug: id, name: '중복 방지 행사', clientId: null,
      date: '2026-12-01', start: '09:00', end: '17:00',
      capacity: 100, stage: 'READY', features: [],
    },
    workspace: {
      participants: [person],
      fields: [], publishedFields: [], formVersion: 1, publishedVersion: 0,
      registrationOpen: false, approvalRequired: false, consentText: '', consentVersion: 1,
      notices: [], program: [], venue: {}, groups: ['일반'],
      desks: [], booths: [], assignments: [], checks: [], visits: [],
      modules: [], responses: [], questions: [], photos: [], posts: [],
      messages: [
        {
          id: messageId, title: '재시작 검증', body: '안내입니다.', channel: 'SMS',
          recipientIds: [person.id],
          recipientSnapshot: [{ id: person.id, name: person.name, phone: person.phone }],
          status: 'SENDING', attempts: 1,
          ...(withGroupId
            ? { providerGroupId: 'SUPPLIER-GROUP-1', dispatchedAt: new Date().toISOString(), deliveryUnconfirmed: true }
            : {}),
          deliveries: [{
            participantId: person.id, name: person.name, status: 'SENDING', at: new Date().toISOString(),
          }],
        },
      ],
      reports: [], payments: [], rewards: [], audit: [],
      display: { type: 'idle', moduleId: null }, branding: {},
      stampMode: 'STAFF', allowReentry: true, price: 0,
    },
  });
  await insertMembership(harness.database, accountIds.manager, id, ['all']);
  await harness.database.query(
    `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'PENDING', 0, now())`,
    [messageId, id]
  );
  return { id, messageId };
}

async function readMessage(eventId, messageId) {
  const result = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]
  );
  return result.rows[0].payload.messages.find((item) => item.id === messageId);
}

async function outboxCount() {
  const result = await harness.database.query('SELECT COUNT(*)::int AS n FROM message_outbox');
  return result.rows[0].n;
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '운영사 관리자'],
    ['manager', 'MANAGER', '행사 매니저'],
  ]) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,
      id: accountIds[key], role, name, email: `${accountIds[key]}@example.test`,
    });
  }
});

after(async () => {
  if (harness) await harness.close();
});

test('same row drained twice sends once: restart reconciles the accepted group', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  sendBatchCalls = 0;
  groupQueryCalls = 0;
  supplierKnowsGroup = true;
  const provider = batchProvider();

  // First boot: the row was queued before any supplier contact, so the drain
  // sends exactly once and records the supplier group.
  const fixture = await createRestartFixture({ withGroupId: false });
  const first = await drainMessageOutbox(harness.database, provider);
  assert.equal(first.dispatched, 1, JSON.stringify(first));
  assert.equal(sendBatchCalls, 1, 'first drain sends once');
  assert.equal(await outboxCount(), 0);
  const sent = await readMessage(fixture.id, fixture.messageId);
  assert.equal(sent.providerGroupId, 'SUPPLIER-GROUP-1');

  // The process restarts after acceptance but before the settle, so the same
  // row is queued again with the same message still SENDING.
  await harness.database.query(
    `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'PENDING', 0, now())`,
    [fixture.messageId, fixture.id]
  );
  const second = await drainMessageOutbox(harness.database, provider);
  assert.equal(second.dispatched, 0, JSON.stringify(second));
  assert.ok(second.reconciled >= 1, JSON.stringify(second));
  assert.equal(sendBatchCalls, 1, 'restart must not send the accepted campaign again');
  assert.ok(groupQueryCalls >= 1, 'restart consults the supplier before deciding');
  assert.equal(await outboxCount(), 0);

  // The campaign itself is untouched: still in flight for the on-demand
  // delivery resolver, still pointing at the same supplier group.
  const kept = await readMessage(fixture.id, fixture.messageId);
  assert.equal(kept.status, 'SENDING');
  assert.equal(kept.providerGroupId, 'SUPPLIER-GROUP-1');
});

test('a group the supplier does not know is still re-sent', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  sendBatchCalls = 0;
  groupQueryCalls = 0;
  supplierKnowsGroup = false;
  try {
    const provider = batchProvider();
    // A stale group id the supplier never saw (or already purged): the drain
    // must fall through to a real send instead of dropping the campaign.
    const fixture = await createRestartFixture({ withGroupId: true });
    const result = await drainMessageOutbox(harness.database, provider);
    assert.equal(result.dispatched, 1, JSON.stringify(result));
    assert.equal(sendBatchCalls, 1, 'unknown group must be re-sent');
    assert.equal(await outboxCount(), 0);
  } finally {
    supplierKnowsGroup = true;
  }
});

test('a-rate-limited-group-read-holds-the-row-for-a-later-drain', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  sendBatchCalls = 0;
  groupQueryCalls = 0;
  // 429 says nothing about whether the supplier holds the group, so the
  // drain must send nothing, settle nothing, and keep the row queued on its
  // backoff for a later drain.
  const limited = batchProvider();
  limited.groupMessages = async () => {
    groupQueryCalls += 1;
    return { ok: false, reason: 'RATE_LIMITED', status: 429 };
  };
  const fixture = await createRestartFixture({ withGroupId: true });
  const held = await drainMessageOutbox(harness.database, limited);
  assert.equal(held.dispatched, 0, JSON.stringify(held));
  assert.equal(held.deferred, 1, JSON.stringify(held));
  assert.equal(sendBatchCalls, 0, 'an unknown lookup must not send');
  assert.equal(await outboxCount(), 1, 'the row stays queued');
  const row = await harness.database.query(
    'SELECT attempts, next_attempt_at FROM message_outbox WHERE message_id = $1', [fixture.messageId]
  );
  assert.equal(row.rows[0].attempts, 1);
  assert.ok(Date.parse(row.rows[0].next_attempt_at) > Date.now(), 'the claim pushed the next attempt into the future');

  // The limit lifts and the backoff expires: the next drain reconciles the
  // held group without a send.
  await harness.database.query(
    "UPDATE message_outbox SET next_attempt_at = now() WHERE message_id = $1", [fixture.messageId]
  );
  const recovered = batchProvider();
  const second = await drainMessageOutbox(harness.database, recovered);
  assert.ok(second.reconciled >= 1, JSON.stringify(second));
  assert.equal(sendBatchCalls, 0, 'the held campaign is reconciled, not duplicated');
  assert.equal(await outboxCount(), 0);
  const kept = await readMessage(fixture.id, fixture.messageId);
  assert.equal(kept.status, 'SENDING');
  assert.equal(kept.providerGroupId, 'SUPPLIER-GROUP-1');
});

test('a lost batch acceptance stays unresolved across replay and recovers by its persisted token', async () => {
  const fixture = await createRestartFixture();
  const initial = await readMessage(fixture.id, fixture.messageId);
  const phone = initial.recipientSnapshot[0].phone;
  const accepted = { groupId: 'G-CORRELATED', messageId: 'M-CORRELATED', to: phone };
  let submissions = 0;
  let token;
  let supplierVisible = false;
  const provider = {
    state: { connected: true },
    async sendBatch(_recipients, { submissionId }) {
      submissions += 1;
      token = submissionId;
      assert.equal((await readMessage(fixture.id, fixture.messageId)).providerSubmission.id, token);
      throw new Error('response connection lost');
    },
    async findSubmission({ id }) {
      assert.equal(id, token);
      return supplierVisible ? { ok: true, groupId: accepted.groupId, messages: { [accepted.messageId]: accepted } } : { ok: false };
    },
    async pollResults(ids) {
      assert.deepEqual(ids, [accepted.messageId]);
      return { ok: true, results: { [accepted.messageId]: { state: 'DELIVERED', type: 'SMS' } } };
    },
  };
  await drainMessageOutbox(harness.database, provider);
  assert.ok(token);
  const pending = await readMessage(fixture.id, fixture.messageId);
  assert.equal(pending.status, 'SENDING');
  assert.equal(pending.deliveryUnconfirmed, true);
  assert.equal(pending.deliveries[0].status, 'SENDING');
  await harness.database.query(
    `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'PENDING', 0, now())`,
    [fixture.messageId, fixture.id]
  );
  assert.equal((await drainMessageOutbox(harness.database, provider)).dispatched, 0);
  assert.equal((await resolveDelivery(harness.database, provider, fixture.id)).pending, 1);
  assert.equal((await readMessage(fixture.id, fixture.messageId)).providerSubmission.id, token);
  supplierVisible = true;
  assert.equal((await resolveDelivery(harness.database, provider, fixture.id)).resolved, 1);
  const resolved = await readMessage(fixture.id, fixture.messageId);
  assert.equal(resolved.status, 'SENT');
  assert.equal(resolved.providerGroupId, accepted.groupId);
  assert.equal(resolved.providerSubmission, undefined);
  assert.equal(resolved.deliveries[0].solapiMessageId, accepted.messageId);
  assert.equal(submissions, 1);
});

test('one supplier receipt cannot confirm two legacy recipients', async () => {
  const fixture = await createRestartFixture({ withGroupId: true });
  const { rows } = await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.id]);
  const workspace = rows[0].payload;
  const campaign = workspace.messages[0];
  const first = campaign.recipientSnapshot[0];
  const second = { ...first, id: 'shared-phone-recipient', name: '다른 합성 참가자' };
  const third = { ...first, id: 'unique-phone-recipient', phone: '01000000000', name: '별도 연락처 참가자' };
  campaign.recipientSnapshot.push(second, third);
  campaign.deliveries.push(...[second, third].map(person => ({
    participantId: person.id, name: person.name, status: 'SENDING',
  })));
  const provider = {
    async groupMessages() {
      return { ok: true, messages: {
        shared: { messageId: 'M-SHARED', to: first.phone },
        unique: { messageId: 'M-UNIQUE', to: third.phone },
      } };
    },
    async pollResults(ids) {
      return { ok: true, results: Object.fromEntries(ids.map(id => [id, { state: 'DELIVERED', type: 'SMS' }])) };
    },
  };
  // Check both a group lookup and data from an earlier build that saved the
  // same supplier message ID against two deliveries.
  for (const storedIds of [false, true]) {
    if (storedIds) campaign.deliveries.slice(0, 2).forEach(delivery => { delivery.solapiMessageId = 'M-SHARED'; });
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',
      [fixture.id, JSON.stringify(workspace)]);
    await resolveDelivery(harness.database, provider, fixture.id);
    const saved = await readMessage(fixture.id, fixture.messageId);
    assert.deepEqual(saved.deliveries.map(delivery => delivery.status), ['SENDING', 'SENDING', 'SENT']);
    assert.deepEqual(saved.deliveries.map(delivery => delivery.resultMatchUnconfirmed === true), [true, true, false]);
    assert.equal(saved.deliveredCount, 1);
    assert.equal(saved.status, 'SENDING');
  }
  // A later lookup can fix a duplicate association when the two recipients
  // have distinct snapshot numbers and distinct supplier records.
  second.phone = '01000000001';
  provider.groupMessages = async () => ({ ok: true, messages: {
    first: { messageId: 'M-FIRST', to: first.phone },
    second: { messageId: 'M-SECOND', to: second.phone },
    third: { messageId: 'M-UNIQUE', to: third.phone },
  } });
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',
    [fixture.id, JSON.stringify(workspace)]);
  await resolveDelivery(harness.database, provider, fixture.id);
  const corrected = await readMessage(fixture.id, fixture.messageId);
  assert.deepEqual(corrected.deliveries.map(delivery => delivery.solapiMessageId), ['M-FIRST', 'M-SECOND', 'M-UNIQUE']);
  assert.deepEqual(corrected.deliveries.map(delivery => delivery.status), ['SENT', 'SENT', 'SENT']);
  assert.ok(corrected.deliveries.every(delivery => !delivery.resultMatchUnconfirmed));
  await harness.database.query('DELETE FROM message_outbox WHERE message_id=$1', [fixture.messageId]);
});
