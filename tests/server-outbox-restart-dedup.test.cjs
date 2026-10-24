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
} = require('./helpers/postgres-api-server.cjs');
const { drainMessageOutbox } = require('../server/message-outbox');

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
      return { ok: true, messages: {} };
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
  await insertEvent(harness.database, {
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
    await insertAccount(harness.database, {
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
