'use strict';

// Real-PostgreSQL concurrency for the message worker paths. Memory fakes can
// emulate logic but cannot stand in for row locks, so these tests run two
// workers against the same isolated database on separate connections and
// assert a single supplier acceptance, an intact workspace, and a cancel
// that lands mid-consult.
//
// Serial execution only (shared database): run through the targeted files,
// never in parallel with the rest of the suite.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { drainMessageOutbox } = require('../server/message-outbox');
const { resolveDelivery } = require('../server/messaging');
const { runMessageMaintenance } = require('../server/message-maintenance');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const accountIds = { manager: `conc-manager-${suffix}` };
let harness;
let fixtureNumber = 0;
let sendBatchCalls = 0;
let groupQueryCalls = 0;

function batchProvider({ consult } = {}) {
  return {
    state: { connected: true },
    async sendBatch(recipients) {
      sendBatchCalls += 1;
      return {
        accepted: true,
        rejected: [],
        registered: recipients.map((recipient) => ({
          participantId: recipient.participantId,
          accepted: true,
          type: 'SMS',
        })),
        groupId: 'SUPPLIER-G-1',
        deliveryUnconfirmed: true,
      };
    },
    async groupMessages(groupId) {
      groupQueryCalls += 1;
      if (consult) return consult(groupId);
      return { ok: true, messages: {} };
    },
    async pollResults(ids) {
      return {
        ok: true,
        results: Object.fromEntries(ids.map((id) => [id, { state: 'DELIVERED', type: 'SMS' }])),
      };
    },
  };
}

function makeParticipant(eventId) {
  return {
    id: `person-${crypto.randomUUID()}`,
    name: '수신자',
    phone: `010${String(crypto.randomInt(10000000, 99999999))}`,
    email: '', company: '', group: '일반', status: 'APPROVED',
    inside: false, everIn: false, revoked: false,
    ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
    ticketExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
    paymentStatus: 'FREE', answers: {}, consent: null,
    createdAt: new Date().toISOString(),
  };
}

async function createCampaignFixture({ status, scheduled, providerGroupId }) {
  fixtureNumber += 1;
  const id = `conc-${fixtureNumber}-${suffix}`;
  const person = makeParticipant(id);
  const messageId = `conc-message-${fixtureNumber}-${suffix}`;
  const message = {
    id: messageId, title: '동시성 검증', body: '안내입니다.', channel: 'SMS',
    recipientIds: [person.id],
    recipientSnapshot: [{ id: person.id, name: person.name, phone: person.phone }],
    status,
    attempts: status === 'SCHEDULED' ? 0 : 1,
    ...(scheduled ? { scheduled } : {}),
    ...(providerGroupId ? { providerGroupId, dispatchedAt: new Date().toISOString(), deliveryUnconfirmed: true } : {}),
    deliveries: [{
      participantId: person.id, name: person.name,
      status: status === 'SCHEDULED' ? 'WAITING' : 'SENDING',
      at: new Date().toISOString(),
    }],
  };
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id,
    slug: id,
    payload: {
      id, slug: id, name: '동시성 검증 행사', clientId: null,
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
      messages: [message], reports: [], payments: [], rewards: [], audit: [],
      display: { type: 'idle', moduleId: null }, branding: {},
      stampMode: 'STAFF', allowReentry: true, price: 0,
    },
  });
  await harness.database.query(
    `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'PENDING', 0, now())`,
    [messageId, id]
  );
  return { id, messageId, person };
}

async function readMessage(eventId, messageId) {
  const result = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]
  );
  return result.rows[0].payload.messages.find((item) => item.id === messageId);
}

async function readWorkspace(eventId) {
  const result = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]
  );
  return result.rows[0].payload;
}

async function outboxCount() {
  const result = await harness.database.query('SELECT COUNT(*)::int AS n FROM message_outbox');
  return result.rows[0].n;
}

// A second connection to the same isolated schema: the harness scopes every
// run to a random schema via search_path, so a raw client must reproduce it
// or it lands in an empty namespace.
async function peerClient() {
  const current = await harness.database.query('SELECT current_schema() AS schema');
  const schema = current.rows[0].schema;
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const peer = new Client({ connectionString: url.toString() });
  await peer.connect();
  return peer;
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: accountIds.manager, role: 'MANAGER', name: '행사 매니저',
    email: `${accountIds.manager}@example.test`,
  });
});

after(async () => {
  if (harness) await harness.close();
});

test('two-concurrent-maintenance-runs-accept-once-on-real-postgres', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  sendBatchCalls = 0;
  groupQueryCalls = 0;
  const past = new Date(Date.now() - 60000).toISOString();
  const fixture = await createCampaignFixture({ status: 'SCHEDULED', scheduled: past });
  const provider = batchProvider({
    consult: (groupId) => {
      // No stale group exists here (fresh enqueue); the post-send id mapping
      // names the acceptance so the same pass can resolve it.
      if (groupId === 'SUPPLIER-G-1') {
        return { ok: true, messages: { M7: { messageId: 'M7', to: fixture.person.phone.replace(/[^0-9]/g, '') } } };
      }
      return { ok: false, reason: 'NOT_FOUND' };
    },
  });
  const options = {
    enabled: true, autoSendDue: true, now: new Date().toISOString(), eventIds: [fixture.id],
  };
  const [first, second] = await Promise.all([
    runMessageMaintenance(harness.database, provider, options),
    runMessageMaintenance(harness.database, provider, options),
  ]);
  assert.equal(first.enqueued + second.enqueued, 1, 'one worker wins the enqueue');
  assert.equal(sendBatchCalls, 1, 'one supplier acceptance across both workers');
  assert.equal(await outboxCount(), 0);

  const message = await readMessage(fixture.id, fixture.messageId);
  assert.equal(message.attempts, 1, 'enqueued exactly once');
  assert.equal(message.status, 'SENT', 'the same pass resolved the delivery');
  assert.equal(message.providerGroupId, 'SUPPLIER-G-1');
  assert.equal(message.deliveries.length, 1);
  assert.equal(message.deliveries[0].status, 'SENT');

  // The workspace is otherwise intact: one campaign, one participant, one
  // maintenance audit entry from the winning worker.
  const workspace = await readWorkspace(fixture.id);
  assert.equal(workspace.messages.length, 1);
  assert.equal(workspace.participants.length, 1);
  assert.equal(workspace.participants[0].id, fixture.person.id);
  const maintenanceAudits = workspace.audit.filter((entry) => entry.maintenance === true);
  assert.equal(maintenanceAudits.length, 1);
});

test('two-concurrent-drains-reconcile-once-on-real-postgres', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  sendBatchCalls = 0;
  groupQueryCalls = 0;
  const fixture = await createCampaignFixture({ status: 'SENDING', providerGroupId: 'SUPPLIER-G-1' });
  const provider = batchProvider({
    consult: () => ({ ok: true, messages: { M1: { messageId: 'M1', to: '01000000000' } } }),
  });
  const [first, second] = await Promise.all([
    drainMessageOutbox(harness.database, provider),
    drainMessageOutbox(harness.database, provider),
  ]);
  assert.equal(first.reconciled + second.reconciled, 1, 'one worker settles the held group');
  assert.equal(sendBatchCalls, 0, 'a held group is never re-sent');
  assert.equal(await outboxCount(), 0);
  const message = await readMessage(fixture.id, fixture.messageId);
  assert.equal(message.status, 'SENDING');
  assert.equal(message.providerGroupId, 'SUPPLIER-G-1');
});

test('cancel-from-a-second-connection-mid-consult-is-not-resent', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  sendBatchCalls = 0;
  groupQueryCalls = 0;
  const fixture = await createCampaignFixture({ status: 'SENDING', providerGroupId: 'SUPPLIER-G-1' });
  const peer = await peerClient();
  try {
    const provider = batchProvider({
      consult: async () => {
        // The operator cancels on a separate connection while this drain's
        // supplier consult is in flight. The drain holds no event lock here,
        // so the cancel commits; the drain's fresh re-check must see it.
        const current = await peer.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [fixture.id]);
        const workspace = current.rows[0].payload;
        const message = workspace.messages.find((item) => item.id === fixture.messageId);
        message.status = 'CANCELLED';
        for (const delivery of message.deliveries) delivery.status = 'CANCELLED';
        await peer.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
          [fixture.id, JSON.stringify(workspace)]);
        return { ok: true, messages: { M1: { messageId: 'M1', to: '01000000000' } } };
      },
    });
    const result = await drainMessageOutbox(harness.database, provider);
    assert.equal(sendBatchCalls, 0, 'a cancelled campaign is never re-sent');
    assert.equal(result.dispatched, 0);
    assert.equal(await outboxCount(), 0, 'the recorded outcome settles the row');
    const message = await readMessage(fixture.id, fixture.messageId);
    assert.equal(message.status, 'CANCELLED', 'the cancel is not clobbered');
    assert.ok(message.deliveries.every((delivery) => delivery.status === 'CANCELLED'));
  } finally {
    await peer.end();
  }
});

test('stale-manual-poll-does-not-overwrite-a-newer-drive-on-real-postgres', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const fixture = await createCampaignFixture({ status: 'SENDING', providerGroupId: 'G-OLD' });
  // Seed the campaign as observed by the stale reader.
  const seed = await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [fixture.id]);
  const seeded = seed.rows[0].payload;
  const seededMessage = seeded.messages.find((item) => item.id === fixture.messageId);
  seededMessage.deliveries[0].solapiMessageId = 'M-OLD';
  seededMessage.dispatchedAt = '2026-10-24T00:00:00.000Z';
  seededMessage.attempts = 1;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [fixture.id, JSON.stringify(seeded)]);

  const provider = {
    state: { connected: true },
    async pollResults() {
      // A retry re-drives the campaign on a separate connection mid-poll.
      const peer = await peerClient();
      try {
        const current = await peer.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [fixture.id]);
        const workspace = current.rows[0].payload;
        const message = workspace.messages.find((item) => item.id === fixture.messageId);
        message.providerGroupId = 'G-NEW';
        message.dispatchedAt = '2026-10-24T00:01:00.000Z';
        message.attempts = 2;
        message.deliveries = [{ participantId: fixture.person.id, name: fixture.person.name, status: 'SENDING', at: new Date().toISOString() }];
        await peer.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
          [fixture.id, JSON.stringify(workspace)]);
      } finally {
        await peer.end();
      }
      return { ok: true, results: { 'M-OLD': { state: 'DELIVERED', type: 'SMS' } } };
    },
  };
  const result = await resolveDelivery(harness.database, provider, fixture.id);
  assert.equal(result.resolved, 0, 'the stale outcome resolves nothing');
  assert.equal(result.pending, 1);
  const message = await readMessage(fixture.id, fixture.messageId);
  assert.equal(message.status, 'SENDING');
  assert.equal(message.providerGroupId, 'G-NEW', 'the newer drive wins');
  assert.equal(message.attempts, 2);
  assert.equal(message.deliveries.length, 1);
  assert.equal(message.deliveries[0].status, 'SENDING');
  assert.equal(message.deliveries[0].solapiMessageId, undefined, 'no stale id is written back');
});
