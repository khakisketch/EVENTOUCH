'use strict';

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  sessionCookie,
  requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
const commandId = () => `context-${crypto.randomUUID()}`;
const ownerId = `owner-${crypto.randomUUID()}`;
const targetId = `target-${crypto.randomUUID()}`;
let harness;
let cookie;
let orgB;
const headers = (orgId, version) => ({
  'x-eventouch-organization-id': orgId,
  'x-eventouch-context-version': String(version),
});

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: ownerId, role: 'AGENCY', name: 'Context owner', email: `${ownerId}@example.test`,
  });
  cookie = await sessionCookie(harness, ownerId);
  const created = await requestJson(harness.baseUrl, '/api/auth/organizations', {
    method: 'POST', cookie, body: { commandId: commandId(), name: 'Context org B' },
  });
  assert.equal(created.status, 201, 'single-membership legacy creation still works without headers');
  orgB = created.json.organization.id;
  await insertAccount(harness.database, {
    orgId: orgB, id: targetId, role: 'STAFF', name: 'Context member', email: `${targetId}@example.test`,
  });
  await harness.database.query(
    `INSERT INTO organization_memberships (org_id, account_id, role) VALUES ($1, $2, 'MANAGER')`,
    [LEGACY_ORG, targetId]
  );
});

after(async () => {
  if (harness) await harness.close();
});

async function targetState() {
  return (await harness.database.query(
    'SELECT org_id, role, active, revision FROM organization_memberships WHERE account_id = $1 ORDER BY org_id', [targetId]
  )).rows;
}

test('explicit membership endpoint checks URL-org ownership without selecting that org', async () => {
  const beforeState = await targetState();
  const key = commandId();
  const path = `/api/auth/organizations/${orgB}/members/${targetId}`;
  const body = { commandId: key, active: false, expectedContextVersion: 0 };
  const changed = await requestJson(harness.baseUrl, path, { method: 'POST', cookie, body });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.membership.orgId, orgB);
  assert.equal(changed.json.membership.active, false);
  const afterState = await targetState();
  assert.deepEqual(afterState.find((row) => row.org_id === LEGACY_ORG), beforeState.find((row) => row.org_id === LEGACY_ORG));
  assert.equal(afterState.find((row) => row.org_id === orgB).active, false);
  const replay = await requestJson(harness.baseUrl, path, { method: 'POST', cookie, body });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, { ...changed.json, replayed: true });
  const me = await requestJson(harness.baseUrl, '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.organizationId, LEGACY_ORG, 'an explicit member URL never switches the actor session');
  assert.equal(me.json.user.contextVersion, 0);
});

test('selected-org agency role cannot authorize an explicit URL in another org', async () => {
  for (const otherRole of [null, 'STAFF']) {
    const actorId = `actor-${crypto.randomUUID()}`;
    await insertAccount(harness.database, {
      orgId: LEGACY_ORG, id: actorId, role: 'AGENCY', name: 'Limited owner', email: `${actorId}@example.test`,
    });
    const actorCookie = await sessionCookie(harness, actorId);
    if (otherRole) {
      await harness.database.query(
        'INSERT INTO organization_memberships (org_id, account_id, role) VALUES ($1, $2, $3)', [orgB, actorId, otherRole]
      );
    }
    const beforeState = await targetState();
    const key = commandId();
    const denied = await requestJson(harness.baseUrl, `/api/auth/organizations/${orgB}/members/${targetId}`, {
      method: 'POST', cookie: actorCookie, body: { commandId: key, active: true },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await targetState(), beforeState);
    const receipt = await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id = $1', [key]);
    assert.equal(receipt.rowCount, 0);
  }
});

test('context-guarded organization creation rejects missing, malformed, stale and mismatched headers', async () => {
  const beforeOrgs = (await harness.database.query('SELECT id FROM organizations ORDER BY id')).rows;
  const cases = [
    { headers: undefined, status: 409 },
    { headers: { 'x-eventouch-organization-id': LEGACY_ORG }, status: 409 },
    { headers: { 'x-eventouch-context-version': '0' }, status: 409 },
    { headers: headers('invalid/org', 0), status: 400 },
    { headers: headers(LEGACY_ORG, 'not-a-version'), status: 400 },
    { headers: headers(LEGACY_ORG, 1), status: 409 },
    { headers: headers(orgB, 0), status: 409 },
  ];
  for (const entry of cases) {
    const key = commandId();
    const denied = await requestJson(harness.baseUrl, '/api/auth/organizations', {
      method: 'POST', cookie, headers: entry.headers, body: { commandId: key, name: 'Must not create' },
    });
    assert.equal(denied.status, entry.status, JSON.stringify(entry));
    if (entry.status === 409) assert.equal(denied.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
    const receipt = await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id = $1', [key]);
    assert.equal(receipt.rowCount, 0);
  }
  assert.deepEqual((await harness.database.query('SELECT id FROM organizations ORDER BY id')).rows, beforeOrgs);
});

test('a multi-org session without selection cannot use explicit membership or contextual writes', async () => {
  const unselectedCookie = await sessionCookie(harness, ownerId);
  const beforeState = await targetState();
  for (const path of [`/api/auth/organizations/${orgB}/members/${targetId}`, '/api/auth/organizations']) {
    const key = commandId();
    const denied = await requestJson(harness.baseUrl, path, {
      method: 'POST', cookie: unselectedCookie, headers: headers(orgB, 0),
      body: { commandId: key, active: true, name: 'Must not create' },
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
    const receipt = await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id = $1', [key]);
    assert.equal(receipt.rowCount, 0);
  }
  assert.deepEqual(await targetState(), beforeState);
});
