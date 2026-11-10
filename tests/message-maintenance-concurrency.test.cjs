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
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { createDomainCommands } = require('../server/commands/domain');
const { drainMessageOutbox } = require('../server/message-outbox');
const { resolveDelivery } = require('../server/messaging');
const { runMessageMaintenance, enqueueDueScheduled } = require('../server/message-maintenance');
const { emptyWorkspace } = require('../server/state');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('automatic scheduling rotates past a full batch and leaves legacy reservations manual', async () => {
  const isolated = await startApiHarness();
  try {
    for (let index = 0; index < 52; index += 1) {
      const id = index === 51 ? 'z-due' : `a-${String(index).padStart(2, '0')}`;
      const workspace = emptyWorkspace();
      workspace.messages = [{ id: `message-${id}`, title: '합성 예약', body: '본문', status: 'SCHEDULED',
        scheduled: index < 50 ? '2999-01-01T00:00:00Z' : '2020-01-01T00:00:00Z',
        ...(index === 50 ? {} : { scheduleMode: 'AUTO', autoScheduleIntent: 'confirmed-v1' }), simulate: false, deliveries: [], recipientIds: [] }];
      await insertEvent(isolated.database, { id, slug: id, orgId: LEGACY_ORG,
        payload: { id, slug: id, name: '합성 행사', stage: 'LIVE' }, workspace });
    }
    const cursor = { afterId: '' };
    const first = await enqueueDueScheduled(isolated.database, { now: '2026-11-01T00:00:00Z', limit: 50, cursor });
    assert.equal(first.enqueued, 0);
    assert.notEqual(cursor.afterId, '');
    const second = await enqueueDueScheduled(isolated.database, { now: '2026-11-01T00:00:00Z', limit: 50, cursor });
    assert.equal(second.enqueued, 1);
    const legacy = await isolated.database.query("SELECT payload FROM event_workspaces WHERE event_id='a-50'");
    assert.equal(legacy.rows[0].payload.messages[0].status, 'SCHEDULED');
    assert.equal(cursor.afterId, '');
  } finally { await isolated.close(); }
});

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
    ...(status === 'SCHEDULED' ? { scheduleMode: 'AUTO', autoScheduleIntent: 'confirmed-v1' } : {}),
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
  // Both statements must take their snapshot before either can enqueue.
  const gate = await peerClient();
  const pids = [];
  const database = {
    ...harness.database,
    transaction: work => harness.database.transaction(async client => {
      if (pids.length < 2) {
        const result = await client.query('SELECT pg_backend_pid() AS pid');
        pids.push(result.rows[0].pid);
      }
      return work(client);
    }),
  };
  let runs;
  let waiting = 0;
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [fixture.id]);
    runs = Promise.allSettled([
      runMessageMaintenance(database, provider, options),
      runMessageMaintenance(database, provider, options),
    ]);
    const deadline = Date.now() + 5000;
    while (waiting < 2 && Date.now() < deadline) {
      const state = await harness.database.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'",
        [pids]
      );
      waiting = state.rows[0].waiting;
      if (waiting < 2) await delay(20);
    }
  } finally {
    await gate.query('ROLLBACK').finally(() => gate.end());
  }
  const [first, second] = (await runs).map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  assert.equal(waiting, 2, 'both workers reached the locked event before the gate opened');
  assert.equal(first.enqueued + second.enqueued, 1, `one worker wins the enqueue (${sendBatchCalls} mock supplier submissions)`);
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

test('mixed rejection and confirmed arrival resolve accurately on real Postgres', async () => {
  const fixture = await createCampaignFixture({ status: 'SENDING', providerGroupId: 'G-MIXED' });
  const workspace = await readWorkspace(fixture.id);
  const message = workspace.messages.find(item => item.id === fixture.messageId);
  message.deliveries = [
    { participantId: fixture.person.id, name: fixture.person.name, status: 'SENDING', solapiMessageId: 'M1' },
    { participantId: 'rejected-person', name: '합성 수신자', status: 'FAILED', error: '접수 거부' },
  ];
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.id, JSON.stringify(workspace)]);
  const result = await resolveDelivery(harness.database, { async pollResults(ids) {
    assert.deepEqual(ids, ['M1']);
    return { ok: true, results: { M1: { state: 'DELIVERED', type: 'SMS' } } };
  } }, fixture.id);
  assert.equal(result.resolved, 1);
  const stored = await readMessage(fixture.id, fixture.messageId);
  assert.equal(stored.status, 'PARTIAL');
  assert.equal(stored.deliveredCount, 1);
  assert.equal(stored.failedCount, 1);
  assert.equal(stored.deliveries[1].error, '접수 거부');
});

test('manual delivery lookup and receipt replay stay scoped to the selected campaign', async () => {
  const fixture = await createCampaignFixture({ status: 'SENDING', providerGroupId: 'G-SELECTED' });
  await insertMembership(harness.database, accountIds.manager, fixture.id, ['messages']);
  const workspace = await readWorkspace(fixture.id);
  const selected = workspace.messages[0];
  selected.deliveries[0].solapiMessageId = 'M-SELECTED';
  const other = structuredClone(selected);
  other.id = 'other-campaign';
  other.providerGroupId = 'G-OTHER';
  other.deliveries[0].solapiMessageId = 'M-OTHER';
  workspace.messages.push(other);
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.id, JSON.stringify(workspace)]);
  const polls = [];
  const domain = createDomainCommands(harness.database, { messaging: {
    async pollResults(ids) {
      polls.push(ids);
      return { ok: true, results: Object.fromEntries(ids.map(id => [id, { state: 'DELIVERED' }])) };
    },
  } });
  const account = { id: accountIds.manager, organizationId: LEGACY_ORG, sessionRevision: 0, sessionOrgVersion: 0 };
  const sync = (payload, commandId = crypto.randomUUID()) => domain.execute({
    eventId: fixture.id, command: 'message.sync', commandId, payload, account,
  });
  const invalidCommandId = crypto.randomUUID();
  await assert.rejects(sync({ id: 'missing-campaign' }, invalidCommandId), { status: 404, field: 'id' });
  assert.deepEqual(polls, []);
  assert.equal((await harness.database.query('SELECT command_id FROM command_receipts WHERE command_id=$1', [invalidCommandId])).rowCount, 0);

  const commandId = crypto.randomUUID();
  const result = await sync({ id: selected.id }, commandId);
  assert.equal(result.body.message.id, selected.id);
  assert.equal(result.body.message.status, 'SENT');
  assert.deepEqual(result.body.sync, { resolved: 1, pending: 0, total: 1 });
  assert.deepEqual(polls, [['M-SELECTED']]);
  assert.equal((await readMessage(fixture.id, other.id)).status, 'SENDING');
  await sync({ id: selected.id });
  const replay = await sync({ id: selected.id }, commandId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.message.id, selected.id);
  await assert.rejects(sync({ id: other.id }, commandId), { status: 409, field: 'id' });
  assert.deepEqual(polls, [['M-SELECTED']]);

  const legacy = await sync({});
  assert.equal(legacy.body.message.id, other.id);
  assert.equal(legacy.body.message.status, 'SENT');
  assert.deepEqual(polls, [['M-SELECTED'], ['M-OTHER']]);
});

test('same-drive concurrent polls cannot overwrite newer delivery results on real Postgres', async () => {
  const fixture = await createCampaignFixture({ status: 'SENDING', providerGroupId: 'G-POLL-RACE' });
  const seeded = await readWorkspace(fixture.id);
  const message = seeded.messages.find(item => item.id === fixture.messageId);
  message.deliveries = [
    { participantId: fixture.person.id, status: 'SENDING', solapiMessageId: 'M1' },
    { participantId: 'person-2', status: 'SENDING', solapiMessageId: 'M2' },
  ];
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.id, JSON.stringify(seeded)]);
  const result = await resolveDelivery(harness.database, { async pollResults() {
    const peer = await peerClient();
    try {
      const current = (await peer.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.id])).rows[0].payload;
      const updated = current.messages.find(item => item.id === fixture.messageId);
      updated.deliveries[0].status = 'SENT';
      updated.deliveredCount = 1;
      await peer.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.id, JSON.stringify(current)]);
    } finally { await peer.end(); }
    return { ok: true, results: { M1: { state: 'PENDING' }, M2: { state: 'DELIVERED' } } };
  } }, fixture.id);
  const stored = await readMessage(fixture.id, fixture.messageId);
  assert.deepEqual(stored.deliveries.map(item => item.status), ['SENT', 'SENDING']);
  assert.equal(stored.deliveredCount, 1);
  assert.deepEqual(result.messages, []);
  assert.equal(result.pending, 1);
});
