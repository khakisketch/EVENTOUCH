'use strict';

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership,
  insertAssignment, sessionCookie, requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { emptyWorkspace } = require('../server/state');

// The former suite described JSON/ETKO routes. Keep it in legacy/server-api.cjs
// as historical evidence. Current v9 semantics are checked here and in the
// producer suites: server-registration, server-operations and server-domain-commands.
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, {
  skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database',
}, fn);
let harness;
const cookies = {};
const ids = { agency: 'api-agency', manager: 'api-manager', staff: 'api-staff', event: 'api-event', other: 'api-other' };
const payload = (id, slug) => ({ id, slug, name: 'API 행사', date: '2026-11-20', start: '09:00', end: '17:00', stage: 'DRAFT', features: [], capacity: 10 });

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const role of ['agency', 'manager', 'staff']) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,  id: ids[role], role: role.toUpperCase(), name: role, email: `${role}@api.example.test` });
    cookies[role] = await sessionCookie(harness, ids[role]);
  }
  for (const id of [ids.event, ids.other]) {
    await insertEvent(harness.database, {orgId: LEGACY_ORG,  id, slug: id, payload: payload(id, id), workspace: emptyWorkspace() });
  }
  await insertMembership(harness.database, ids.manager, ids.event, ['all']);
  await insertAssignment(harness.database, { id: 'api-desk-assignment', accountId: ids.staff, eventId: ids.event, type: 'DESK', targetId: 'api-desk' });
});
after(async () => { if (harness) await harness.close(); });
const api = (route, options = {}) => requestJson(harness.baseUrl, route, options);
const command = (eventId, name, input, cookie = cookies.agency) => api(`/api/events/${eventId}/commands`, {
  cookie, method: 'POST', body: { commandId: `api-${crypto.randomUUID()}`, command: name, payload: input },
});
const createInput = extra => ({ name: '새 API 행사', slug: `api-${crypto.randomUUID()}`, date: '2026-11-20', start: '09:00', end: '17:00', capacity: 10, commandId: `api-${crypto.randomUUID()}`, ...extra });

test('api events require an authentic session', async () => {
  for (const cookie of [undefined, 'etko_session=forged']) {
    const response = await api('/api/events', { cookie });
    assert.equal(response.status, 401);
    assert.equal(JSON.stringify(response.json).includes('agency@'), false);
  }
});
test('api event creation rejects forged sessions without disclosing account data', async () => {
  const response = await api('/api/events', { cookie: 'etko_session=forged', method: 'POST', body: createInput() });
  assert.equal(response.status, 401);
  assert.equal(JSON.stringify(response.json).includes('agency@'), false);
  assert.equal(response.json.event, undefined);
});
test('api agency collection comes from PostgreSQL rather than seeded JSON', async () => {
  const response = await api('/api/events', { cookie: cookies.agency });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.events.map(event => event.id).sort(), [ids.event, ids.other].sort());
});
test('api manager collection is scoped to active memberships', async () => {
  const response = await api('/api/events', { cookie: cookies.manager });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.events.map(event => event.id), [ids.event]);
});
test('api staff collection is scoped to active assignments', async () => {
  const response = await api('/api/events', { cookie: cookies.staff });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.events.map(event => event.id), [ids.event]);
});
test('api event creation validates calendar and required v9 fields', async () => {
  for (const extra of [{ name: '' }, { date: '2026-02-30' }, { slug: 'Invalid Slug' }, { capacity: -1 }, { start: '17:00', end: '09:00' }]) {
    const response = await api('/api/events', { cookie: cookies.agency, method: 'POST', body: createInput(extra) });
    assert.equal(response.status, 400);
    assert.match(response.json.error, /[가-힣]/);
  }
});
test('api event creation denies manager and staff actors', async () => {
  for (const role of ['manager', 'staff']) {
    const response = await api('/api/events', { cookie: cookies[role], method: 'POST', body: createInput() });
    assert.equal(response.status, 403);
  }
});
test('api event create idempotency distinguishes matching retry from changed payload', async () => {
  const body = createInput();
  const first = await api('/api/events', { cookie: cookies.agency, method: 'POST', body });
  assert.equal(first.status, 201);
  assert.equal(first.json.event.stage, 'DRAFT');
  const replay = await api('/api/events', { cookie: cookies.agency, method: 'POST', body });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.event.id, first.json.event.id);
  const collision = await api('/api/events', { cookie: cookies.agency, method: 'POST', body: { ...body, name: '다른 요청' } });
  assert.equal(collision.status, 409);
});
test('api unknown command event fails closed with Korean error', async () => {
  for (const name of ['form.close', 'participant.create', 'check.scan', 'booth.visit', 'event.stage']) {
    const response = await command('not-an-event', name, {});
    assert.equal(response.status, 404, name);
    assert.match(response.json.error, /찾을 수 없습니다/, name);
  }
});
test('api stage mutation preserves monotonic v9 stage semantics', async () => {
  const forward = await command(ids.event, 'event.stage', { stage: 'READY' });
  assert.equal(forward.status, 200);
  const backward = await command(ids.event, 'event.stage', { stage: 'DRAFT' });
  assert.equal(backward.status, 409);
});
test('api manager command denies a different event', async () => {
  const response = await command(ids.other, 'form.close', {}, cookies.manager);
  assert.equal(response.status, 403);
});
test('api retired account creation requires invitation acceptance', async () => {
  const response = await api('/api/users', { cookie: cookies.agency, method: 'POST', body: { name: '퇴역 역할', role: 'CLIENT' } });
  assert.equal(response.status, 410);
  assert.match(response.json.error, /초대/);
});

// Retiring a route is a tested contract, not a bypass to JSON write/read state.
// Equivalent current semantics are exercised through commands/public tickets in
// server-registration.test.cjs, server-operations.test.cjs and server-domain-commands.test.cjs.
const retired = [
  ['GET', ''], ['GET', '/booth-mode'], ['GET', '/booths'], ['GET', '/poll'],
  ['GET', '/qna'], ['GET', '/photos'], ['POST', '/photos'],
  ['POST', '/photos/photo-id/approve'], ['POST', '/photos/photo-id/hide'],
  ['DELETE', '/program/program-id'], ['GET', '/reports'],
  ['PATCH', ''], ['PATCH', '/status'], ['GET', '/summary'], ['GET', '/workspace'],
  ['GET', '/participants'], ['POST', '/participants'], ['POST', '/checkin'],
  ['POST', '/sync'], ['POST', '/corrections'], ['PUT', '/booth-mode'],
  ['POST', '/booths'], ['POST', '/stamps'], ['PUT', '/poll'], ['POST', '/poll/votes'],
  ['POST', '/qna'], ['POST', '/draw'], ['POST', '/survey'], ['POST', '/program'],
  ['POST', '/notices'], ['PUT', '/venue'], ['POST', '/templates'], ['POST', '/campaigns'],
  ['POST', '/reports'],
];
for (const [method, suffix] of retired) {
  test(`api retired JSON route ${method} /events/:id${suffix || ' (event)'} cannot remain an alternate authority`, async () => {
    const response = await api(`/api/events/evt-1${suffix}`, {
      cookie: cookies.agency, method, ...(method === 'GET' ? {} : { body: {} }),
    });
    assert.equal(response.status, 410);
    assert.equal(response.json.workspace, undefined);
  });
}

test('api database mode never writes the retired JSON store', async () => {
  const summary = await api('/api/summary', { cookie: cookies.agency });
  assert.equal(summary.status, 410);
  assert.match(summary.json.error, /이전 저장 API/);
  const users = await api('/api/users', { cookie: cookies.agency, method: 'POST', body: { name: '퇴역', role: 'CLIENT' } });
  assert.equal(users.status, 410);
  const legacyEvent = await api('/api/events/evt-1', { cookie: cookies.agency });
  assert.equal(legacyEvent.status, 410);
  const files = fs.readdirSync(harness.dataDir).filter((name) => name.endsWith('.json'));
  assert.deepEqual(files, [], `JSON store files must not be created in database mode: ${files.join(', ')}`);
});
