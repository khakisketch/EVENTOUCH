'use strict';

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  sessionCookie,
  requestJson,
  deleteFixtureRows,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const ids = {
  agency: `event-create-agency-${suffix}`,
  listedEvent: `event-list-${suffix}`,
};
const slugs = {
  createdEvent: `event-create-${suffix}`,
  listedEvent: `event-list-${suffix}`,
};
let harness;
let cookie;

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    id: ids.agency,
    role: 'AGENCY',
    name: '행사 생성 관리자',
    email: `${ids.agency}@example.test`,
  });
  cookie = await sessionCookie(harness, ids.agency);
});

after(async () => {
  if (!harness) return;
  await deleteFixtureRows(harness.database, {
    eventIds: [ids.createdEvent, ids.listedEvent].filter(Boolean),
    accountIds: [ids.agency],
  });
  await harness.close();
});

test('agency event creation persists the event and workspace in PostgreSQL', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');

  const response = await requestJson(harness.baseUrl, '/api/events', {
    method: 'POST',
    cookie,
    body: {
      name: 'PostgreSQL 행사 생성',
      slug: slugs.createdEvent,
      date: '2026-11-15',
      start: '10:00',
      end: '17:00',
      capacity: 120,
      clientId: null,
      commandId: `event-create-command-${suffix}`,
    },
  });

  assert.equal(response.status, 201);
  ids.createdEvent = response.json.event.id;
  assert.equal(response.json.event.slug, slugs.createdEvent);
  const replay = await requestJson(harness.baseUrl, '/api/events', {
    method: 'POST',
    cookie,
    body: {
      name: 'PostgreSQL 행사 생성',
      slug: slugs.createdEvent,
      date: '2026-11-15',
      start: '10:00',
      end: '17:00',
      capacity: 120,
      clientId: null,
      commandId: `event-create-command-${suffix}`,
    },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.event.id, ids.createdEvent);
  const event = await harness.database.query('SELECT payload FROM events WHERE id = $1', [ids.createdEvent]);
  const workspace = await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [ids.createdEvent]);
  assert.equal(event.rowCount, 1);
  assert.equal(event.rows[0].payload.name, 'PostgreSQL 행사 생성');
  assert.equal(workspace.rowCount, 1);
  assert.deepEqual(workspace.rows[0].payload.participants, []);

  const bootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie });
  assert.equal(bootstrap.status, 200);
  assert.ok(bootstrap.json.state.events.some((item) => item.id === ids.createdEvent));
});

test('agency event collection reads PostgreSQL instead of the JSON demo store', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');

  await insertEvent(harness.database, {
    id: ids.listedEvent,
    slug: slugs.listedEvent,
    payload: {
      id: ids.listedEvent,
      slug: slugs.listedEvent,
      name: 'PostgreSQL 목록 행사',
      date: '2026-11-20',
      start: '09:00',
      end: '17:00',
      capacity: 25,
      stage: 'DRAFT',
      features: [],
    },
    workspace: {},
  });

  const response = await requestJson(harness.baseUrl, '/api/events', { cookie });

  assert.equal(response.status, 200);
  assert.ok(response.json.events.some((item) => item.id === ids.listedEvent));
  assert.equal(response.json.events.some((item) => item.id === 'demo-conference'), false);
});

test('legacy JSON participant writes are closed when the PostgreSQL authority is active', async () => {
  const response = await requestJson(harness.baseUrl, '/api/events/evt-1/participants', {
    cookie, method: 'POST', body: { name: '차단 참가자', phone: '01011223344' },
  });
  assert.equal(response.status, 410);
});

test('numeric demo signup cannot fall back to JSON storage in PostgreSQL mode', async () => {
  const response = await requestJson(harness.baseUrl, '/api/events/evt-1/signup', {
    method: 'POST', body: { name: '차단 참가자', phone: '01022334455' },
  });
  assert.equal(response.status, 404);
});

test('legacy JSON workspace reads do not expose a competing operational state', async () => {
  const response = await requestJson(harness.baseUrl, '/api/events/evt-1/workspace', { cookie });
  assert.equal(response.status, 410);
  assert.equal(response.json.workspace, undefined);
});
