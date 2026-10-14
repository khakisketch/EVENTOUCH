'use strict';

// Outbox contract: a dispatch intent queued in the command transaction must
// never be lost between commit and the provider call, and must never be
// sent twice once its outcome is recorded.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  sessionCookie,
  requestJson,
} = require('./helpers/postgres-api-server.cjs');
const { drainMessageOutbox } = require('../server/message-outbox');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const accountIds = { agency: `outbox-agency-${suffix}`, manager: `outbox-manager-${suffix}` };
let harness;
let cookies = {};
let fixtureNumber = 0;
let fakeEndpoint;
let fakeEndpointMode = 'ok';
let fakeEndpointCalls = 0;

function commandId() {
  return `outbox-${crypto.randomUUID()}`;
}

function startFakeProvider() {
  return new Promise((resolve) => {
    fakeEndpoint = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        fakeEndpointCalls += 1;
        if (fakeEndpointMode === 'provider-error') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: '공급사 점검 중' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: `PROV-${fakeEndpointCalls}` }));
      });
    });
    fakeEndpoint.listen(0, '127.0.0.1', () => resolve(fakeEndpoint.address().port));
  });
}

async function createFixture({ participants = [] } = {}) {
  fixtureNumber += 1;
  const id = `outbox-${fixtureNumber}-${suffix}`;
  const slug = `outbox-${fixtureNumber}-${suffix}`;
  await insertEvent(harness.database, {
    id,
    slug,
    payload: {
      id, slug, name: '발송 검증 행사', clientId: null,
      date: '2026-12-01', start: '09:00', end: '17:00',
      capacity: 100, stage: 'READY', features: [],
    },
    workspace: {
      participants,
      fields: [], publishedFields: [], formVersion: 1, publishedVersion: 0,
      registrationOpen: false, approvalRequired: false, consentText: '', consentVersion: 1,
      notices: [], program: [], venue: {}, groups: ['일반'],
      desks: [], booths: [], assignments: [], checks: [], visits: [],
      modules: [], responses: [], questions: [], photos: [], posts: [],
      messages: [], reports: [], payments: [], rewards: [], audit: [],
      display: { type: 'idle', moduleId: null }, branding: {},
      stampMode: 'STAFF', allowReentry: true, price: 0,
    },
  });
  await insertMembership(harness.database, accountIds.manager, id, ['all']);
  return { id, slug };
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

function operator(eventId, command, payload, { id = commandId() } = {}) {
  return requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie: cookies.manager,
    body: { commandId: id, command, payload },
  });
}

async function readWorkspace(eventId) {
  const result = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]
  );
  return result.rows[0].payload;
}

async function outboxRows() {
  const result = await harness.database.query(
    'SELECT message_id, event_id, status, attempts FROM message_outbox ORDER BY message_id'
  );
  return result.rows;
}

before(async () => {
  if (!databaseUrl) return;
  const port = await startFakeProvider();
  process.env.EVENTOUCH_MESSAGING_ENDPOINT = `http://127.0.0.1:${port}/send`;
  process.env.EVENTOUCH_MESSAGING_TOKEN = 'test-token';
  process.env.EVENTOUCH_MESSAGING_SENDER = '01000000000';
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '운영사 관리자'],
    ['manager', 'MANAGER', '행사 매니저'],
  ]) {
    await insertAccount(harness.database, {
      id: accountIds[key], role, name, email: `${accountIds[key]}@example.test`,
    });
    cookies[key] = await sessionCookie(harness, accountIds[key]);
  }
});

after(async () => {
  delete process.env.EVENTOUCH_MESSAGING_ENDPOINT;
  delete process.env.EVENTOUCH_MESSAGING_TOKEN;
  delete process.env.EVENTOUCH_MESSAGING_SENDER;
  if (fakeEndpoint) await new Promise((resolve) => fakeEndpoint.close(resolve));
  if (harness) await harness.close();
});

test('retry-with-a-working-provider-sends-and-settles-the-outbox-row', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '수신자');
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [event.id, JSON.stringify(state)]);

  const created = await operator(event.id, 'message.create', {
    ids: [person.id], title: '발송 검증', channel: 'SMS', body: '{{이름}}님 안내입니다.',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const messageId = created.json.message.id;

  const retried = await operator(event.id, 'message.retry', { id: messageId });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.message.status, 'SENT');
  assert.equal(fakeEndpointCalls > 0, true);

  // The outcome is recorded, so no work may be left queued.
  assert.deepEqual(await outboxRows(), []);
  const health = await requestJson(harness.baseUrl, '/api/health');
  assert.equal(health.json.outboxPending, 0);
});

test('retry-with-a-rejecting-provider-records-failure-and-leaves-no-queued-work', async () => {
  fakeEndpointMode = 'provider-error';
  try {
    const event = await createFixture();
    const person = makeParticipant(event.id, '수신자');
    const state = await readWorkspace(event.id);
    state.participants.push(person);
    await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
      [event.id, JSON.stringify(state)]);

    const created = await operator(event.id, 'message.create', {
      ids: [person.id], title: '거부 검증', channel: 'SMS', body: '안내입니다.',
    });
    const retried = await operator(event.id, 'message.retry', { id: created.json.message.id });
    assert.equal(retried.status, 200, JSON.stringify(retried.json));
    assert.equal(retried.json.message.status, 'FAILED');

    // A recorded outcome settles the row even though nothing was delivered.
    assert.deepEqual(await outboxRows(), []);
  } finally {
    fakeEndpointMode = 'ok';
  }
});

test('drain-replays-a-send-left-hanging-by-a-crash', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '수신자');
  const messageId = `outbox-crash-${suffix}`;
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  // Exactly what the transaction held at the crash moment: SENDING in the
  // workspace, intent still queued.
  state.messages.unshift({
    id: messageId, title: '중단된 발송', body: '{{이름}}님 안내입니다.', channel: 'SMS',
    recipientIds: [person.id],
    recipientSnapshot: [{ id: person.id, name: person.name, phone: person.phone }],
    status: 'SENDING', attempts: 1,
    deliveries: [{ participantId: person.id, name: person.name, status: 'SENDING', at: new Date().toISOString() }],
  });
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [event.id, JSON.stringify(state)]);
  await harness.database.query(
    `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'PENDING', 0, now())`,
    [messageId, event.id]
  );

  let sends = 0;
  const result = await drainMessageOutbox(harness.database, {
    state: { connected: true },
    send: async () => { sends += 1; return { delivered: true, providerId: 'P-9' }; },
  });
  assert.equal(result.dispatched, 1);
  assert.equal(sends, 1);

  const after = await readWorkspace(event.id);
  const message = after.messages.find((item) => item.id === messageId);
  assert.equal(message.status, 'SENT');
  assert.deepEqual(await outboxRows(), []);
});

test('drain-settles-a-leftover-row-without-resending-a-recorded-outcome', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '수신자');
  const messageId = `outbox-stale-${suffix}`;
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  state.messages.unshift({
    id: messageId, title: '이미 끝난 발송', body: '안내입니다.', channel: 'SMS',
    recipientIds: [person.id],
    recipientSnapshot: [{ id: person.id, name: person.name, phone: person.phone }],
    status: 'SENT', attempts: 1, deliveredCount: 1,
    deliveries: [{ participantId: person.id, name: person.name, status: 'SENT', at: new Date().toISOString() }],
  });
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [event.id, JSON.stringify(state)]);
  await harness.database.query(
    `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'PENDING', 0, now())`,
    [messageId, event.id]
  );

  let sends = 0;
  const result = await drainMessageOutbox(harness.database, {
    state: { connected: true },
    send: async () => { sends += 1; return { delivered: true }; },
  });
  assert.equal(result.settled, 1);
  assert.equal(sends, 0, 'a recorded outcome must never be re-sent');
  assert.deepEqual(await outboxRows(), []);
});

test('drain-skips-queued-work-while-the-provider-is-disconnected', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '수신자');
  const messageId = `outbox-offline-${suffix}`;
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  state.messages.unshift({
    id: messageId, title: '미연동 발송', body: '안내입니다.', channel: 'SMS',
    recipientIds: [person.id],
    recipientSnapshot: [{ id: person.id, name: person.name, phone: person.phone }],
    status: 'SENDING', attempts: 1,
    deliveries: [{ participantId: person.id, name: person.name, status: 'SENDING', at: new Date().toISOString() }],
  });
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [event.id, JSON.stringify(state)]);
  await harness.database.query(
    `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'PENDING', 0, now())`,
    [messageId, event.id]
  );

  let sends = 0;
  const result = await drainMessageOutbox(harness.database, {
    state: { connected: false },
    send: async () => { sends += 1; return { delivered: true }; },
  });
  assert.deepEqual(result, { skipped: true, reason: 'NOT_CONNECTED' });
  assert.equal(sends, 0);
  assert.equal((await outboxRows()).length, 1, 'the intent stays queued until a provider exists');
  const after = await readWorkspace(event.id);
  assert.equal(after.messages.find((item) => item.id === messageId).status, 'SENDING');
});
