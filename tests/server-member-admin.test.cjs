'use strict';

// Team administration ran entirely in the browser store, so in server mode
// saving organisation permissions or an event assignment silently failed.
// These routes make both real, with the same permission ceiling the console
// already enforces.

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
  agency: `member-agency-${suffix}`,
  manager: `member-manager-${suffix}`,
  event: `member-event-${suffix}`,
};
let harness;
let cookie;

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    id: ids.agency,
    role: 'AGENCY',
    name: '조직 소유자',
    email: `${ids.agency}@example.test`,
  });
  await insertAccount(harness.database, {
    id: ids.manager,
    role: 'MANAGER',
    name: '행사 매니저',
    email: `${ids.manager}@example.test`,
  });
  await insertEvent(harness.database, { id: ids.event, slug: ids.event, payload: { id: ids.event, name: '권한 검증 행사', slug: ids.event, date: '2026-12-01', start: '10:00', end: '17:00', capacity: 50, stage: 'DRAFT', features: [] }, workspace: {} });
  cookie = await sessionCookie(harness, ids.agency);
});

after(async () => {
  if (!harness) return;
  await deleteFixtureRows(harness.database, { eventIds: [ids.event], accountIds: [ids.agency, ids.manager] });
  await harness.close();
});

test('organisation permissions are stored, replayable and bounded to the known vocabulary', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');

  const commandId = `org-permissions-${suffix}`;
  const saved = await requestJson(harness.baseUrl, `/api/accounts/${ids.manager}/org-permissions`, {
    method: 'POST',
    cookie,
    body: { orgPermissions: ['clients.manage', 'team.manage'], commandId },
  });
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.json.account.orgPermissions, ['clients.manage', 'team.manage']);

  const stored = await harness.database.query('SELECT org_permissions FROM accounts WHERE id = $1', [ids.manager]);
  assert.deepEqual(stored.rows[0].org_permissions, ['clients.manage', 'team.manage']);

  const replay = await requestJson(harness.baseUrl, `/api/accounts/${ids.manager}/org-permissions`, {
    method: 'POST',
    cookie,
    body: { orgPermissions: ['clients.manage', 'team.manage'], commandId },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json.account.orgPermissions, ['clients.manage', 'team.manage']);

  const unknown = await requestJson(harness.baseUrl, `/api/accounts/${ids.manager}/org-permissions`, {
    method: 'POST',
    cookie,
    body: { orgPermissions: ['billing.manage'], commandId: `org-unknown-${suffix}` },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.field, 'orgPermissions');

  // The organisation owner's own scope is not editable through this route.
  const owner = await requestJson(harness.baseUrl, `/api/accounts/${ids.agency}/org-permissions`, {
    method: 'POST',
    cookie,
    body: { orgPermissions: [], commandId: `org-owner-${suffix}` },
  });
  assert.equal(owner.status, 403);
});

test('event assignment grants and revokes a manager membership', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');

  const granted = await requestJson(harness.baseUrl, `/api/events/${ids.event}/members`, {
    method: 'POST',
    cookie,
    body: { accountId: ids.manager, enabled: true, write: ['onsite', 'participants'], commandId: `member-grant-${suffix}` },
  });
  assert.equal(granted.status, 201);
  const rows = await harness.database.query('SELECT write_permissions FROM memberships WHERE account_id = $1 AND event_id = $2', [ids.manager, ids.event]);
  assert.equal(rows.rowCount, 1);
  assert.deepEqual(rows.rows[0].write_permissions, ['onsite', 'participants']);

  // The membership is what lets a manager reach the event at all.
  const managerCookie = await sessionCookie(harness, ids.manager);
  const allowed = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: managerCookie });
  assert.equal(allowed.status, 200);
  assert.ok(allowed.json.state.events.some((item) => item.id === ids.event));

  const unknown = await requestJson(harness.baseUrl, `/api/events/${ids.event}/members`, {
    method: 'POST',
    cookie,
    body: { accountId: ids.manager, enabled: true, write: ['billing'], commandId: `member-unknown-${suffix}` },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.field, 'write');

  const revoked = await requestJson(harness.baseUrl, `/api/events/${ids.event}/members`, {
    method: 'POST',
    cookie,
    body: { accountId: ids.manager, enabled: false, write: [], commandId: `member-revoke-${suffix}` },
  });
  assert.equal(revoked.status, 201);
  const after = await harness.database.query('SELECT 1 FROM memberships WHERE account_id = $1 AND event_id = $2', [ids.manager, ids.event]);
  assert.equal(after.rowCount, 0);

  const denied = await requestJson(harness.baseUrl, `/api/events/${ids.event}/members`, {
    method: 'POST',
    cookie: managerCookie,
    body: { accountId: ids.agency, enabled: true, write: [], commandId: `member-denied-${suffix}` },
  });
  assert.equal(denied.status, 403);
});
