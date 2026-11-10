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
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { drainMessageOutbox } = require('../server/message-outbox');
const { enqueueDueScheduled } = require('../server/message-maintenance');
const { createDomainCommands } = require('../server/commands/domain');
const { emptyWorkspace } = require('../server/state');
const { isolatedTestEnvironment } = require('./helpers/test-provider-env.cjs');

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
const fakeEndpointBodies = [];
let heldResponse = null;
let heldArrived = null;
let dropNumber = null;

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
        fakeEndpointBodies.push(JSON.parse(body));
        if (fakeEndpointMode === 'partial-loss' && JSON.parse(body).to === dropNumber) { res.socket.destroy(); return; }
        if (fakeEndpointMode === 'hold') {
          heldResponse = res;
          if (heldArrived) heldArrived();
          return;
        }
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
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
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
  const env = { ...isolatedTestEnvironment(process.env),
    EVENTOUCH_MESSAGING_ENDPOINT: `http://127.0.0.1:${port}/send`,
    EVENTOUCH_MESSAGING_TOKEN: 'test-token', EVENTOUCH_MESSAGING_SENDER: '01000000000' };
  harness = await startApiHarness({ env });
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '운영사 관리자'],
    ['manager', 'MANAGER', '행사 매니저'],
  ]) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,
      id: accountIds[key], role, name, email: `${accountIds[key]}@example.test`,
    });
    cookies[key] = await sessionCookie(harness, accountIds[key]);
  }
});

after(async () => {
  if (fakeEndpoint) await new Promise((resolve) => fakeEndpoint.close(resolve));
  if (harness) await harness.close();
});

test('immediate create sends once after commit and its receipt never resends', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '수신자');
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [event.id, JSON.stringify(state)]);

  const id = commandId();
  const payload = {
    ids: [person.id], title: '발송 검증', channel: 'SMS', body: '{{이름}}님 안내입니다.',
  };
  const beforeCalls = fakeEndpointCalls;
  const created = await operator(event.id, 'message.create', payload, { id });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.message.status, 'ACCEPTED');
  assert.equal(created.json.message.deliveredCount, 0);
  assert.equal(fakeEndpointCalls - beforeCalls, 1);
  const replayed = await operator(event.id, 'message.create', payload, { id });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.json));
  assert.equal(replayed.json.message.id, id);
  assert.equal(fakeEndpointCalls - beforeCalls, 1, 'a lost response can be retried without a second supplier submission');
  assert.equal((await readWorkspace(event.id)).messages.filter(message => message.id === id).length, 1);

  // The outcome is recorded, so no work may be left queued.
  assert.deepEqual(await outboxRows(), []);
  const health = await requestJson(harness.baseUrl, '/api/health');
  assert.equal(Object.hasOwn(health.json, 'outboxPending'), false, 'public health never reports tenant queue activity');
});

test('generic provider receives each recipient rendered variables and blocks expired ticket links', async () => {
  const event = await createFixture();
  const first = makeParticipant(event.id, '합성 첫째');
  const second = makeParticipant(event.id, '합성 둘째');
  const state = await readWorkspace(event.id);
  state.participants.push(first, second);
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(state)]);
  const previousOrigin = process.env.EVENTOUCH_PUBLIC_URL;
  process.env.EVENTOUCH_PUBLIC_URL = 'https://example.test';
  try {
    const start = fakeEndpointBodies.length;
    const payload = { ids: [first.id, second.id], title: '합성 개인화', channel: 'SMS', body: '{{이름}} / {{행사일}} / {{티켓링크}}' };
    const originalId = commandId();
    const sent = await operator(event.id, 'message.create', payload, { id: originalId });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    const calls = fakeEndpointBodies.slice(start);
    assert.equal(calls.length, 2);
    for (const [index, person] of [first, second].entries()) {
      assert.ok(calls[index].text.includes(person.name));
      assert.ok(calls[index].text.includes('2026-12-01'));
      assert.ok(calls[index].text.includes(encodeURIComponent(person.ticket)));
      assert.doesNotMatch(calls[index].text, /\{\{/);
      assert.equal(calls[index].text.includes(encodeURIComponent(index ? first.ticket : second.ticket)), false);
      assert.equal(calls[index].channel, 'LMS', 'classification uses expanded ticket link length');
    }
    const latest = await readWorkspace(event.id);
    latest.participants.find(person => person.id === second.id).ticketExpiresAt = '2020-01-01T00:00:00.000Z';
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(latest)]);
    const before = fakeEndpointCalls;
    const replayed = await operator(event.id, 'message.create', payload, { id: originalId });
    assert.equal(replayed.status, 200, 'the original committed receipt remains recoverable after expiry');
    assert.equal(fakeEndpointCalls, before, 'receipt lookup never submits again');
    const blocked = await operator(event.id, 'message.create', payload);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, 'TICKET_UNAVAILABLE');
    assert.equal(fakeEndpointCalls, before);
  } finally {
    if (previousOrigin === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
    else process.env.EVENTOUCH_PUBLIC_URL = previousOrigin;
  }
});

test('generic provider classifies each rendered text and never sends oversized text or image-less MMS', async () => {
  const event = await createFixture();
  const short = makeParticipant(event.id, '가');
  const long = makeParticipant(event.id, '나'.repeat(60));
  const state = await readWorkspace(event.id);
  state.participants.push(short, long);
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(state)]);
  const start = fakeEndpointBodies.length;
  const sent = await operator(event.id, 'message.create', { ids: [short.id, long.id], title: '길이 검증', channel: 'SMS', body: '안내 {{이름}}' });
  assert.equal(sent.status, 201);
  assert.deepEqual(fakeEndpointBodies.slice(start).map(item => item.channel), ['SMS', 'LMS']);
  const previousOrigin = process.env.EVENTOUCH_PUBLIC_URL;
  process.env.EVENTOUCH_PUBLIC_URL = `https://example.test/${'a'.repeat(2000)}`;
  try {
    const before = fakeEndpointCalls;
    const oversized = await operator(event.id, 'message.create', { ids: [short.id], title: '초과 검증', channel: 'SMS', body: '{{티켓링크}}' });
    assert.equal(oversized.status, 201);
    assert.equal(oversized.json.message.status, 'FAILED');
    assert.equal(oversized.json.message.personalizedTextTooLongCount, 1);
    assert.equal(fakeEndpointCalls, before);
  } finally {
    if (previousOrigin === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
    else process.env.EVENTOUCH_PUBLIC_URL = previousOrigin;
  }
  const fileId = `fixture-image-${crypto.randomUUID()}`;
  await harness.database.query("INSERT INTO stored_files (id,event_id,storage_key,original_name,content_type,size_bytes,created_by) VALUES ($1,$2,$3,'fixture.jpg','image/jpeg',12,$4)", [fileId, event.id, `fixture-${fileId}`, accountIds.manager]);
  const beforeMms = fakeEndpointCalls;
  const mms = await operator(event.id, 'message.create', { ids: [short.id], title: '사진 검증', channel: 'MMS', body: '사진 안내', imageFileId: fileId });
  assert.equal(mms.status, 201, JSON.stringify(mms.json));
  assert.equal(mms.json.message.status, 'FAILED');
  assert.equal(mms.json.message.mmsUnsupported, true);
  assert.equal(fakeEndpointCalls, beforeMms, 'image-less generic transport must not send');
});

test('generic provider does not submit alimtalk without an approved-template transport', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '합성 수신자');
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(state)]);
  const template = await operator(event.id, 'template.save', { name: '합성 알림톡', channel: 'ALIMTALK', body: '{{이름}}님 안내입니다.', solapiTemplateId: 'fixture-template' });
  assert.equal(template.status, 200, JSON.stringify(template.json));
  const before = fakeEndpointCalls;
  const result = await operator(event.id, 'message.create', { ids: [person.id], title: '합성 알림톡', channel: 'ALIMTALK', templateId: template.json.template.id, body: '{{이름}}님 안내입니다.' });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(result.json.message.status, 'FAILED');
  assert.equal(result.json.message.alimtalkUnsupported, true);
  assert.equal(fakeEndpointCalls, before, 'generic adapter must not claim approval or call the provider');
});

test('immediate create blocks missing lucky numbers or public origin before storing or sending', async () => {
  const person = makeParticipant('unused', '합성 수신자');
  const event = await createFixture({ participants: [person] });
  const callsBefore = fakeEndpointCalls;
  const previousOrigin = process.env.EVENTOUCH_PUBLIC_URL;
  try {
    delete process.env.EVENTOUCH_PUBLIC_URL;
    for (const [body, error] of [
      ['럭키번호 {{럭키번호}} 안내', /럭키번호/],
      ['티켓 {{티켓링크}} 안내', /공개 주소/],
    ]) {
      const id = commandId();
      const result = await operator(event.id, 'message.create', { ids: [person.id], title: '발송 검증', channel: 'SMS', body }, { id });
      assert.equal(result.status, 409, JSON.stringify(result.json));
      assert.match(result.json.error, error);
      assert.equal((await readWorkspace(event.id)).messages.some(message => message.id === id), false);
      assert.equal((await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [id])).rowCount, 0);
    }
    assert.equal(fakeEndpointCalls, callsBefore);
    assert.deepEqual(await outboxRows(), []);
  } finally {
    if (previousOrigin === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
    else process.env.EVENTOUCH_PUBLIC_URL = previousOrigin;
  }
});

test('disconnected, simulation, future reservation and another organization do not submit immediately', async () => {
  const person = makeParticipant('unused', '합성 수신자');
  const event = await createFixture({ participants: [person] });
  const payload = { ids: [person.id], title: '합성 검증', channel: 'SMS', body: '안내입니다.' };
  const callsBefore = fakeEndpointCalls;
  const disconnected = createDomainCommands(harness.database, { messaging: { state: { connected: false } } });
  const waiting = await disconnected.execute({ eventId: event.id, commandId: commandId(), command: 'message.create', payload,
    account: { id: accountIds.manager, orgId: LEGACY_ORG } });
  assert.equal(waiting.body.message.status, 'NEEDS_CONNECTION');
  const simulated = await operator(event.id, 'message.create', { ...payload, simulate: true });
  assert.equal(simulated.json.message.status, 'SIMULATED');
  const reserved = await operator(event.id, 'message.create', { ...payload, scheduled: new Date(Date.now() + 60000).toISOString() });
  assert.equal(reserved.json.message.status, 'SCHEDULED');

  const orgId = `org-message-isolation-${suffix}`;
  const actorId = `isolated-message-agency-${suffix}`;
  const isolatedEvent = `isolated-message-event-${suffix}`;
  await harness.database.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '합성 다른 운영사']);
  await insertAccount(harness.database, { id: actorId, role: 'AGENCY', name: '합성 운영자', email: `${actorId}@example.test`, orgId });
  const workspace = emptyWorkspace();
  workspace.participants = [person];
  await insertEvent(harness.database, { id: isolatedEvent, slug: isolatedEvent, orgId,
    payload: { id: isolatedEvent, slug: isolatedEvent, name: '합성 행사', stage: 'READY' }, workspace });
  const otherCookie = await sessionCookie(harness, actorId);
  const other = await requestJson(harness.baseUrl, `/api/events/${isolatedEvent}/commands`, {
    method: 'POST', cookie: otherCookie,
    body: { commandId: commandId(), command: 'message.create', payload },
  });
  assert.equal(other.status, 201, JSON.stringify(other.json));
  assert.equal(other.json.message.status, 'NEEDS_CONNECTION');
  assert.equal(fakeEndpointCalls, callsBefore);
  assert.deepEqual(await outboxRows(), []);
});

test('new reservations require a valid unambiguous instant', async () => {
  const person = makeParticipant('unused', '합성 수신자');
  const event = await createFixture({ participants: [person] });
  const payload = { ids: [person.id], title: '예약 검증', channel: 'SMS', body: '합성 안내' };
  const callsBefore = fakeEndpointCalls;
  for (const scheduled of ['2999-01-01T09:00', '2999-02-30T09:00:00+09:00', '2999-01-01T09:00:00+14:30', ' ', false, 123]) {
    const result = await operator(event.id, 'message.create', { ...payload, scheduled });
    assert.equal(result.status, 400, JSON.stringify(result.json));
    assert.equal(result.json.field, 'scheduled');
  }
  const valid = await operator(event.id, 'message.create', { ...payload, scheduled: '2999-01-01T09:00:00+09:00' });
  assert.equal(valid.status, 201, JSON.stringify(valid.json));
  assert.equal(valid.json.message.scheduled, '2999-01-01T09:00:00+09:00');
  assert.equal((await readWorkspace(event.id)).messages.length, 1);
  assert.equal(fakeEndpointCalls, callsBefore);
});

test('a connection-needed legacy reservation with an unknown timezone cannot retry', async () => {
  const person = makeParticipant('unused', '합성 수신자');
  const event = await createFixture({ participants: [person] });
  const created = await operator(event.id, 'message.create', {
    ids: [person.id], title: '예약 검증', channel: 'SMS', body: '합성 안내',
    scheduled: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(created.status, 201);
  const workspace = await readWorkspace(event.id);
  workspace.messages[0].status = 'NEEDS_CONNECTION';
  workspace.messages[0].scheduled = '2020-01-01T09:00';
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(workspace)]);
  const callsBefore = fakeEndpointCalls;
  const retried = await operator(event.id, 'message.retry', { id: created.json.message.id });
  assert.equal(retried.status, 409, JSON.stringify(retried.json));
  assert.match(retried.json.error, /예약 시각/);
  assert.equal(fakeEndpointCalls, callsBefore);
  const saved = (await readWorkspace(event.id)).messages[0];
  assert.equal(saved.status, 'NEEDS_CONNECTION');
  assert.equal(saved.scheduled, '2020-01-01T09:00');
  assert.equal(saved.attempts, 0);
  assert.deepEqual(await outboxRows(), []);
});

test('a due manual reservation executes once and the retry receipt does not resend', async () => {
  const person = makeParticipant('unused', '합성 수신자');
  const event = await createFixture({ participants: [person] });
  const callsBefore = fakeEndpointCalls;
  const created = await operator(event.id, 'message.create', {
    ids: [person.id], title: '예약 검증', channel: 'SMS', body: '안내입니다.',
    scheduled: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(created.status, 201);
  assert.equal(fakeEndpointCalls, callsBefore);
  await harness.database.query(
    "UPDATE event_workspaces SET payload = jsonb_set(payload, '{messages,0,scheduled}', to_jsonb($2::text)) WHERE event_id = $1",
    [event.id, new Date(Date.now() - 60000).toISOString()]
  );
  const id = commandId();
  const retried = await operator(event.id, 'message.retry', { id: created.json.message.id }, { id });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.message.status, 'ACCEPTED');
  const replayed = await operator(event.id, 'message.retry', { id: created.json.message.id }, { id });
  assert.equal(replayed.status, 200);
  assert.equal(fakeEndpointCalls - callsBefore, 1);
  assert.deepEqual(await outboxRows(), []);
});

test('an overdue reservation cannot send to a changed contact', async () => {
  const person = makeParticipant('unused', '합성 수신자');
  const event = await createFixture({ participants: [person] });
  const scheduled = new Date(Date.now() + 60_000).toISOString();
  const created = await operator(event.id, 'message.create', {
    ids: [person.id], title: '연락처 변경 검증', channel: 'SMS', body: '예약 안내입니다.', scheduled,
  });
  assert.equal(created.status, 201);
  const messageId = created.json.message.id;
  const updated = await operator(event.id, 'participant.update', {
    id: person.id, phone: person.phone === '01000000001' ? '01000000002' : '01000000001',
  });
  assert.equal(updated.status, 200);
  await harness.database.query(
    "UPDATE event_workspaces SET payload = jsonb_set(payload, '{messages,0,scheduled}', to_jsonb($2::text)) WHERE event_id = $1",
    [event.id, new Date(Date.now() - 60_000).toISOString()]
  );
  const callsBefore = fakeEndpointCalls;
  const retried = await operator(event.id, 'message.retry', { id: messageId });
  assert.equal(fakeEndpointCalls - callsBefore, 0, 'supplier submissions');
  assert.equal(retried.status, 409);
  assert.equal(retried.json.field, 'recipientChange');
  const [stored] = (await readWorkspace(event.id)).messages;
  assert.equal(stored.status, 'SCHEDULED');
  assert.equal(stored.attempts, 0);
  assert.deepEqual(await outboxRows(), []);
});

test('a reserved personalized name is rechecked before provider submission', async () => {
  const person = makeParticipant('unused', '합성 이전 이름');
  const event = await createFixture({ participants: [person] });
  const scheduled = new Date(Date.now() + 60000).toISOString();
  const reserve = async body => {
    const response = await operator(event.id, 'message.create', { ids: [person.id], title: '합성 이름 안내', channel: 'SMS', body, scheduled });
    assert.equal(response.status, 201);
    return response.json.message.id;
  };
  const personalized = await reserve('{{이름}}님, 합성 안내입니다.');
  const generic = await reserve('합성 안내입니다.');
  assert.equal((await operator(event.id, 'participant.update', { id: person.id, name: '합성 현재 이름' })).status, 200);
  const changed = await readWorkspace(event.id);
  for (const message of changed.messages) message.scheduled = new Date(Date.now() - 60000).toISOString();
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(changed)]);
  const beforeCalls = fakeEndpointCalls;
  const rejected = await operator(event.id, 'message.retry', { id: personalized });
  assert.equal(fakeEndpointCalls, beforeCalls, 'the changed name must not reach the provider');
  assert.equal(rejected.status, 409, 'a changed substituted name must require another review');
  assert.equal(rejected.json.field, 'recipientChange');
  const unchangedContent = await operator(event.id, 'message.retry', { id: generic });
  assert.equal(unchangedContent.status, 200, 'an unrelated name edit does not block a message without name substitution');
  assert.equal(fakeEndpointCalls, beforeCalls + 1);
  assert.equal((await operator(event.id, 'participant.update', { id: person.id, name: person.name })).status, 200);
  const requestId = commandId();
  assert.equal((await operator(event.id, 'message.retry', { id: personalized }, { id: requestId })).status, 200);
  assert.equal((await operator(event.id, 'message.retry', { id: personalized }, { id: requestId })).status, 200);
  assert.equal(fakeEndpointCalls, beforeCalls + 2, 'a confirmed retry sends once');
  assert.match(fakeEndpointBodies.at(-1).text, /^합성 이전 이름님/);
});

test('automatic and already queued personalized messages recheck renamed recipients', async () => {
  const changed = makeParticipant('unused', '합성 예약 대상');
  const queued = makeParticipant('unused', '합성 대기열 대상');
  const event = await createFixture({ participants: [changed, queued] });
  const scheduled = new Date(Date.now() + 60000).toISOString();
  const reserve = async person => {
    const response = await operator(event.id, 'message.create', { ids: [person.id], title: '합성 예약', channel: 'SMS', body: '{{이름}}님 안내', scheduled, scheduleMode: 'AUTO' });
    assert.equal(response.status, 201); return response.json.message.id;
  };
  const blockedId = await reserve(changed), queuedId = await reserve(queued);
  assert.equal((await operator(event.id, 'participant.update', { id: changed.id, name: '합성 변경 대상' })).status, 200);
  const enqueued = await enqueueDueScheduled(harness.database, { now: new Date(Date.parse(scheduled) + 1).toISOString(), eventIds: [event.id] });
  assert.deepEqual(enqueued.skippedDue, [{ messageId: blockedId, reason: 'RECIPIENT_CHANGED' }]);
  assert.equal(enqueued.enqueued, 1);
  assert.equal((await operator(event.id, 'participant.update', { id: queued.id, name: '합성 변경 대기열' })).status, 200);
  let submits = 0;
  await drainMessageOutbox(harness.database, { state: { connected: true }, sendBatch: async () => { submits++; return { accepted: false }; } });
  assert.equal(submits, 0, 'a name changed after enqueue never reaches the provider');
  const ws = await readWorkspace(event.id);
  assert.equal(ws.messages.find(item => item.id === blockedId).status, 'SCHEDULED');
  assert.equal(ws.messages.find(item => item.id === queuedId).status, 'FAILED');
  assert.equal(ws.messages.find(item => item.id === queuedId).recipientChangeCount, 1);
  assert.deepEqual(await outboxRows(), []);
});

test('reviewed reservations stop for status or group changes before manual, automatic, and queued sends', async () => {
  const people = ['상태 변경', '그룹 변경', '대기열 이후 변경'].map(name => makeParticipant('unused', name));
  const event = await createFixture({ participants: people });
  assert.equal((await operator(event.id, 'group.save', { name: 'VIP' })).status, 201);
  const scheduled = new Date(Date.now() + 60000).toISOString();
  const reserve = async (person, mode) => {
    const result = await operator(event.id, 'message.create', { ids: [person.id], title: `합성 ${person.name}`, channel: 'SMS', body: '합성 안내', scheduled, scheduleMode: mode });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    assert.equal(result.json.message.recipientRoutingReviewVersion, 1);
    return result.json.message.id;
  };
  const manual = await reserve(people[0], 'MANUAL');
  const automatic = await reserve(people[1], 'AUTO');
  const queued = await reserve(people[2], 'AUTO');
  const calls = fakeEndpointCalls;
  assert.equal((await operator(event.id, 'participant.status', { ids: [people[0].id], status: 'WAITLIST' })).status, 200);
  assert.equal((await operator(event.id, 'group.assign', { ids: [people[1].id], group: 'VIP' })).status, 200);
  let ws = await readWorkspace(event.id);
  ws.messages.find(message => message.id === manual).scheduled = new Date(Date.now() - 60000).toISOString();
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(ws)]);
  const denied = await operator(event.id, 'message.retry', { id: manual });
  assert.equal(denied.status, 409); assert.equal(denied.json.field, 'recipientChange');
  const enqueued = await enqueueDueScheduled(harness.database, { now: new Date(Date.parse(scheduled) + 1).toISOString(), eventIds: [event.id] });
  assert.deepEqual(enqueued.skippedDue, [{ messageId: automatic, reason: 'RECIPIENT_CHANGED' }]);
  assert.equal(enqueued.enqueued, 1);
  assert.equal((await operator(event.id, 'group.assign', { ids: [people[2].id], group: 'VIP' })).status, 200);
  let submits = 0;
  await drainMessageOutbox(harness.database, { state: { connected: true }, sendBatch: async () => { submits++; return { accepted: false }; } });
  assert.equal(submits, 0); assert.equal(fakeEndpointCalls, calls);
  ws = await readWorkspace(event.id);
  assert.equal(ws.messages.find(message => message.id === manual).status, 'SCHEDULED');
  assert.equal(ws.messages.find(message => message.id === automatic).status, 'SCHEDULED');
  assert.equal(ws.messages.find(message => message.id === queued).status, 'FAILED');
  assert.equal(ws.messages.find(message => message.id === queued).recipientChangeCount, 1);
  assert.deepEqual(await outboxRows(), []);
  const legacy = structuredClone(ws.messages.find(message => message.id === manual));
  delete legacy.recipientRoutingReviewVersion; delete legacy.recipientSnapshot[0].routingVersion;
  assert.equal(require('../server/commands/content-results').messageRecipientChangeCount(legacy, ws), 0, 'legacy reservations retain their existing status/group behavior');
  const incomplete = structuredClone(ws.messages.find(message => message.id === manual));
  delete incomplete.recipientSnapshot[0].routingVersion;
  assert.equal(require('../server/commands/content-results').messageRecipientChangeCount(incomplete, ws), 1, 'new incomplete review proof fails closed');
});

test('automatic reservations and queued dispatches recheck the stored recipients', async () => {
  const changed = makeParticipant('unused', '변경 대상');
  const unchanged = makeParticipant('unused', '정상 대상');
  const event = await createFixture({ participants: [changed, unchanged] });
  const scheduled = new Date(Date.now() + 60_000).toISOString();
  const reserve = async (person, title) => {
    const result = await operator(event.id, 'message.create', {
      ids: [person.id], title, channel: 'SMS', body: '예약 안내입니다.', scheduled, scheduleMode: 'AUTO',
    });
    assert.equal(result.status, 201);
    return result.json.message.id;
  };
  const blockedId = await reserve(changed, '취소된 참가자 예약');
  const queuedId = await reserve(unchanged, '저장 이후 바뀐 예약');
  const futureNow = new Date(Date.parse(scheduled) + 1).toISOString();
  assert.equal((await operator(event.id, 'participant.status', { ids: [changed.id], status: 'CANCELLED' })).status, 200);
  const outcome = await enqueueDueScheduled(harness.database, { now: futureNow, eventIds: [event.id] });
  assert.equal(outcome.enqueued, 1);
  assert.deepEqual(outcome.skippedDue, [{ messageId: blockedId, reason: 'RECIPIENT_CHANGED' }]);
  assert.deepEqual((await outboxRows()).map(row => row.message_id), [queuedId]);
  assert.equal((await operator(event.id, 'participant.update', {
    id: unchanged.id, phone: unchanged.phone === '01000000001' ? '01000000002' : '01000000001',
  })).status, 200);
  const damaged = await readWorkspace(event.id);
  damaged.rewards = { preserved: '손상된 원본 경품' };
  damaged.venue = null;
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(damaged)]);
  let submits = 0;
  const provider = { state: { connected: true }, sendBatch: async () => { submits += 1; return { accepted: false }; } };
  const drain = await drainMessageOutbox(harness.database, provider);
  assert.equal(submits, 0);
  assert.equal(drain.settled, 1);
  assert.equal(drain.dispatched, 0);
  const storedAfterDrain = await readWorkspace(event.id);
  assert.deepEqual(storedAfterDrain.rewards, damaged.rewards, 'blocked dispatch preserves unrelated malformed rewards');
  assert.equal(storedAfterDrain.venue, null, 'blocked dispatch preserves unrelated malformed venue');
  const { messages } = storedAfterDrain;
  const blocked = messages.find(message => message.id === blockedId);
  const queued = messages.find(message => message.id === queuedId);
  assert.equal(blocked.status, 'SCHEDULED');
  assert.equal(blocked.attempts, 0);
  assert.equal(queued.status, 'FAILED');
  assert.equal(queued.recipientChangeCount, 1);
  assert.equal(queued.acceptedCount, 0);
  assert.equal(queued.deliveries[0].status, 'FAILED');
  assert.deepEqual(await outboxRows(), []);

  const unresolvedId = commandId();
  await harness.database.query(
    "UPDATE event_workspaces SET payload = jsonb_set(payload, '{messages}', (payload->'messages') || $2::jsonb) WHERE event_id = $1",
    [event.id, JSON.stringify([{ ...queued, id: unresolvedId, status: 'SENDING', acceptedCount: null, deliveries: [] }])]
  );
  await harness.database.query(
    "INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at) VALUES ($1, $2, 'SENDING', 1, now())",
    [unresolvedId, event.id]
  );
  assert.equal((await drainMessageOutbox(harness.database, provider)).settled, 1);
  assert.equal(submits, 0);
  const unresolved = (await readWorkspace(event.id)).messages.find(message => message.id === unresolvedId);
  assert.equal(unresolved.status, 'SENDING');
  assert.equal(unresolved.acceptedCount, null);
  assert.equal(unresolved.deliveryUnconfirmed, true);
  assert.deepEqual(await outboxRows(), []);
});

test('scheduled dispatch preserves a damaged audit trail and waits for it to be repaired', async () => {
  const person = makeParticipant('unused', '합성 수신자');
  const event = await createFixture({ participants: [person] });
  const scheduled = new Date(Date.now() + 60_000).toISOString();
  const created = await operator(event.id, 'message.create', { ids: [person.id], title: '합성 예약', channel: 'SMS', body: '안내입니다.', scheduled, scheduleMode: 'AUTO' });
  assert.equal(created.status, 201);
  const damaged = await readWorkspace(event.id);
  damaged.audit = { preserved: '손상된 감사 이력' };
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(damaged)]);
  const boot = await requestJson(harness.baseUrl, `/api/events/${event.id}/bootstrap`, { cookie: cookies.manager });
  assert.equal(boot.status, 200);
  assert.deepEqual(boot.json.state.messageSchedule.blocked.find(item => item.id === created.json.message.id), { id: created.json.message.id, reason: 'AUDIT_UNAVAILABLE' });
  const future = new Date(Date.parse(scheduled) + 1).toISOString();
  const skipped = await enqueueDueScheduled(harness.database, { now: future, eventIds: [event.id] });
  assert.equal(skipped.enqueued, 0);
  assert.deepEqual(skipped.skippedDue, [{ messageId: created.json.message.id, reason: 'AUDIT_UNAVAILABLE' }]);
  assert.deepEqual(await readWorkspace(event.id), damaged);
  assert.deepEqual(await outboxRows(), []);
  damaged.audit = [];
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(damaged)]);
  const recoveredBoot = await requestJson(harness.baseUrl, `/api/events/${event.id}/bootstrap`, { cookie: cookies.manager });
  assert.equal(recoveredBoot.json.state.messageSchedule.blocked.some(item => item.id === created.json.message.id), false);
  assert.equal((await enqueueDueScheduled(harness.database, { now: future, eventIds: [event.id] })).enqueued, 1);
  await harness.database.query('DELETE FROM message_outbox WHERE event_id=$1', [event.id]);
});

test('ticket expiry blocks manual and automatic reservations and queued sends without claiming prior outcome', async () => {
  const previousOrigin = process.env.EVENTOUCH_PUBLIC_URL;
  process.env.EVENTOUCH_PUBLIC_URL = 'https://example.test';
  try {
    const person = makeParticipant('unused', '합성 수신자');
    const event = await createFixture({ participants: [person] });
    const scheduled = new Date(Date.now() + 60_000).toISOString();
    const reserve = async mode => {
      const result = await operator(event.id, 'message.create', { ids: [person.id], title: '합성 예약', channel: 'SMS', body: '티켓 {{티켓링크}}', scheduled, scheduleMode: mode });
      assert.equal(result.status, 201, JSON.stringify(result.json));
      return result.json.message.id;
    };
    const manual = await reserve('MANUAL'), automatic = await reserve('AUTO'), queued = await reserve('AUTO'), uncertain = await reserve('AUTO');
    const ws = await readWorkspace(event.id);
    ws.participants[0].ticketExpiresAt = '2020-01-01T00:00:00.000Z';
    for (const item of ws.messages) item.scheduled = new Date(Date.now() - 60_000).toISOString();
    for (const id of [queued, uncertain]) {
      const item = ws.messages.find(value => value.id === id);
      item.status = 'SENDING';
      item.acceptedCount = null;
    }
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(ws)]);
    const before = fakeEndpointCalls;
    const retried = await operator(event.id, 'message.retry', { id: manual });
    assert.equal(retried.status, 409);
    assert.equal(retried.json.code, 'TICKET_UNAVAILABLE');
    const outcome = await enqueueDueScheduled(harness.database, { now: new Date().toISOString(), eventIds: [event.id] });
    assert.equal(outcome.enqueued, 0);
    assert.deepEqual(outcome.skippedDue, [{ messageId: automatic, reason: 'TICKET_UNAVAILABLE' }]);
    await harness.database.query("INSERT INTO message_outbox (message_id,event_id,status,attempts,next_attempt_at) VALUES ($1,$2,'PENDING',0,now()),($3,$2,'SENDING',1,now())", [queued, event.id, uncertain]);
    let submits = 0;
    const drained = await drainMessageOutbox(harness.database, { state: { connected: true }, sendBatch: async () => { submits++; return { accepted: false }; } });
    assert.equal(submits, 0);
    assert.equal(fakeEndpointCalls, before);
    assert.equal(drained.settled, 2);
    const saved = await readWorkspace(event.id);
    assert.equal(saved.messages.find(value => value.id === manual).status, 'SCHEDULED');
    assert.equal(saved.messages.find(value => value.id === automatic).status, 'SCHEDULED');
    const neverSent = saved.messages.find(value => value.id === queued);
    assert.equal(neverSent.status, 'FAILED');
    assert.equal(neverSent.ticketLinkProblemCount, 1);
    const unknown = saved.messages.find(value => value.id === uncertain);
    assert.equal(unknown.status, 'SENDING');
    assert.equal(unknown.deliveryUnconfirmed, true);
    assert.equal(unknown.acceptedCount, null);
    assert.equal(unknown.ticketLinkProblemCount, 1);
  } finally {
    if (previousOrigin === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
    else process.env.EVENTOUCH_PUBLIC_URL = previousOrigin;
  }
});

test('a slow live generic sender cannot be resolved or continue after an outbox stop', async () => {
  const event = await createFixture();
  const first = makeParticipant(event.id, '첫 수신자'), second = makeParticipant(event.id, '둘째 수신자');
  const ws = await readWorkspace(event.id);
  ws.participants.push(first, second);
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(ws)]);
  const arrived = new Promise(resolve => { heldArrived = resolve; });
  fakeEndpointMode = 'hold';
  const id = commandId();
  const pending = operator(event.id, 'message.create', { ids: [first.id, second.id], title: '느린 발송', channel: 'SMS', body: '합성 안내' }, { id });
  try {
    await arrived;
    const inFlight = (await readWorkspace(event.id)).messages.find(message => message.id === id);
    assert.equal(inFlight.genericAttemptActive, true);
    const lease = await harness.database.query("SELECT next_attempt_at > now() + interval '4 minutes' AS renewed FROM message_outbox WHERE message_id=$1", [id]);
    assert.equal(lease.rows[0].renewed, true, 'a live sender renews its lease before the provider call');
    const submissionId = inFlight.providerSubmission.id;
    const check = { id, participantId: first.id, expectedSubmissionId: submissionId, outcome: 'NOT_ACCEPTED' };
    const early = await operator(event.id, 'message.record-provider-check', check);
    assert.equal(early.status, 409);
    assert.equal(early.json.code, 'PROVIDER_ATTEMPT_ACTIVE');
    await harness.database.query('UPDATE message_outbox SET next_attempt_at=now() WHERE message_id=$1', [id]);
    let duplicateSends = 0;
    const drained = await drainMessageOutbox(harness.database, { state: { connected: true }, send: async () => { duplicateSends++; return { delivered: true }; } });
    assert.equal(drained.dispatched, 0);
    assert.equal(duplicateSends, 0);
    assert.equal((await readWorkspace(event.id)).messages.find(message => message.id === id).genericStopRequested, true);
    heldResponse.writeHead(200, { 'content-type': 'application/json' }); heldResponse.end('{"ok":true,"id":"fixture"}'); heldResponse = null;
    const result = await pending;
    assert.equal(result.status, 201);
    assert.equal(result.json.message.status, 'SENDING');
    assert.equal(result.json.message.genericAttemptActive, false);
    assert.deepEqual(result.json.message.deliveries.map(delivery => delivery.status), ['ACCEPTED', 'SENDING']);
    const secondCheck = { id, participantId: second.id, expectedSubmissionId: submissionId, outcome: 'NOT_ACCEPTED' };
    const recordId = commandId();
    const recorded = await operator(event.id, 'message.record-provider-check', secondCheck, { id: recordId });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
    assert.equal(recorded.json.providerCheck.outcome, 'NOT_ACCEPTED');
    assert.equal(recorded.json.message.status, 'ACCEPTED');
    assert.equal(recorded.json.message.deliveredCount, 0);
    assert.equal((await operator(event.id, 'message.record-provider-check', secondCheck, { id: recordId })).status, 200);
    const different = await operator(event.id, 'message.record-provider-check', { ...secondCheck, outcome: 'ACCEPTED' }, { id: recordId });
    assert.equal(different.status, 409);
  } finally {
    fakeEndpointMode = 'ok'; heldArrived = null;
    if (heldResponse) { heldResponse.destroy(); heldResponse = null; }
    await pending.catch(() => {});
  }
});

test('partial generic HTTP response loss preserves each provider outcome and cannot auto resend', async () => {
  const event = await createFixture();
  const first = makeParticipant(event.id, '접수된 참가자'), second = makeParticipant(event.id, '미확인 참가자');
  const ws = await readWorkspace(event.id);
  ws.participants.push(first, second);
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(ws)]);
  const id = commandId();
  const payload = { ids: [first.id, second.id], title: '응답 유실 합성', channel: 'SMS', body: '합성 안내' };
  fakeEndpointMode = 'partial-loss'; dropNumber = second.phone;
  try {
    const start = fakeEndpointCalls;
    const result = await operator(event.id, 'message.create', payload, { id });
    assert.equal(result.status, 201);
    assert.equal(result.json.message.status, 'SENDING');
    assert.equal(result.json.message.genericAttemptActive, false);
    assert.equal(result.json.message.genericSubmissionUnconfirmed, true);
    assert.equal(result.json.message.deliveredCount, 0);
    assert.deepEqual(result.json.message.deliveries.map(delivery => delivery.status), ['ACCEPTED', 'SENDING']);
    assert.equal(fakeEndpointCalls - start, 2);
    const replayed = await operator(event.id, 'message.create', payload, { id });
    assert.equal(replayed.status, 200);
    assert.equal(fakeEndpointCalls - start, 2, 'receipt replay never re-sends');
    assert.deepEqual(await outboxRows(), []);
    await drainMessageOutbox(harness.database, { state: { connected: true }, send: async () => { throw new Error('must not resend'); } });
    assert.equal(fakeEndpointCalls - start, 2);
  } finally { fakeEndpointMode = 'ok'; dropNumber = null; }
});

test('legacy sending outbox without provider lookup is held unconfirmed after restart', async () => {
  const person = makeParticipant('unused', '합성 수신자');
  const event = await createFixture({ participants: [person] });
  const ws = await readWorkspace(event.id);
  const id = commandId();
  ws.messages.unshift({ id, title: '이전 발송', body: '합성 안내', channel: 'SMS', status: 'SENDING', recipientIds: [person.id], recipientSnapshot: [{ id: person.id, name: person.name, phone: person.phone }], deliveries: [{ participantId: person.id, name: person.name, status: 'SENDING' }] });
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(ws)]);
  await harness.database.query("INSERT INTO message_outbox (message_id,event_id,status,attempts,next_attempt_at) VALUES ($1,$2,'SENDING',1,now())", [id, event.id]);
  let calls = 0;
  const result = await drainMessageOutbox(harness.database, { state: { connected: true }, send: async () => { calls++; return { delivered: true }; } });
  assert.equal(result.dispatched, 0);
  assert.equal(calls, 0);
  const saved = (await readWorkspace(event.id)).messages[0];
  assert.equal(saved.status, 'SENDING');
  assert.equal(saved.genericSubmissionUnconfirmed, true);
  assert.notEqual(saved.genericAttemptActive, false, 'legacy termination cannot be inferred');
  assert.equal((await operator(event.id, 'message.record-provider-check', { id, participantId: person.id, expectedSubmissionId: null, outcome: 'NOT_ACCEPTED' })).status, 409);
});

test('retry-with-a-provider-server-error-preserves-unknown-acceptance-without-requeue', async () => {
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
      scheduled: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(created.status, 201);
    await harness.database.query(
      "UPDATE event_workspaces SET payload = jsonb_set(payload, '{messages,0,scheduled}', to_jsonb($2::text)) WHERE event_id = $1",
      [event.id, new Date(Date.now() - 60000).toISOString()]
    );
    const retried = await operator(event.id, 'message.retry', { id: created.json.message.id });
    assert.equal(retried.status, 200, JSON.stringify(retried.json));
    assert.equal(retried.json.message.status, 'SENDING');
    assert.equal(retried.json.message.genericSubmissionUnconfirmed, true);

    // The unresolved outcome remains in the message; automatic replay stops.
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
  assert.equal(message.status, 'ACCEPTED');
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

test('a conflicting cancellation blocks new messages, automatic reservations and queued provider calls', async () => {
  const changed = makeParticipant('unused', '합성 취소 충돌');
  const queued = makeParticipant('unused', '합성 출고 대기');
  const event = await createFixture({ participants: [changed, queued] });
  const schedule = new Date(Date.now() + 60_000).toISOString();
  const reserve = async person => {
    const result = await operator(event.id, 'message.create', { ids: [person.id], title: '합성 안내', channel: 'SMS', body: '예약 안내입니다.', scheduled: schedule, scheduleMode: 'AUTO' });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    return result.json.message.id;
  };
  const blockedId = await reserve(changed), queuedId = await reserve(queued);
  const state = await readWorkspace(event.id);
  state.participants.find(person => person.id === changed.id).cancelled = true;
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(state)]);
  const { recipientReviewVersion } = require('../server/commands/content-results');
  for (const command of ['message.create', 'message.create-reviewed']) {
    const payload = { ids: [changed.id], title: '합성 안내', channel: 'SMS', body: '일반 안내', simulate: true,
      ...(command === 'message.create-reviewed' ? { expectedRecipientVersions: [recipientReviewVersion(changed)] } : {}) };
    const rejected = await operator(event.id, command, payload);
    assert.equal(rejected.status, 409, `an inconsistent recipient must be rejected: ${command}`);
  }
  const future = new Date(Date.parse(schedule) + 1).toISOString();
  const outcome = await enqueueDueScheduled(harness.database, { now: future, eventIds: [event.id] });
  assert.equal(outcome.enqueued, 1);
  assert.deepEqual(outcome.skippedDue, [{ messageId: blockedId, reason: 'RECIPIENT_CHANGED' }]);
  const afterEnqueue = await readWorkspace(event.id);
  afterEnqueue.participants.find(person => person.id === queued.id).cancelled = true;
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [event.id, JSON.stringify(afterEnqueue)]);
  const submittedRecipients = [];
  const provider = { state: { connected: true }, sendBatch: async recipients => { submittedRecipients.push(...recipients.map(person => person.participantId)); return { accepted: false }; } };
  await drainMessageOutbox(harness.database, provider);
  assert.equal(submittedRecipients.includes(queued.id), false, 'a conflict discovered after enqueue never reaches the provider');
  assert.equal(submittedRecipients.includes(changed.id), false, 'a conflict found before enqueue never reaches the provider');
  const final = await readWorkspace(event.id);
  const blocked = final.messages.find(message => message.id === blockedId), output = final.messages.find(message => message.id === queuedId);
  assert.equal(blocked.status, 'SCHEDULED'); assert.equal(blocked.attempts, 0);
  assert.equal(output.status, 'FAILED'); assert.equal(output.recipientChangeCount, 1); assert.equal(output.acceptedCount, 0);
});
