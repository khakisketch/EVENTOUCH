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
const uniqueId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
let harness;

before(async () => {
  if (databaseUrl) harness = await startApiHarness();
});
after(async () => {
  if (harness) await harness.close();
});

async function account(role, orgId = LEGACY_ORG) {
  const id = uniqueId('member');
  await insertAccount(harness.database, { orgId, id, role, name: 'Synthetic member', email: `${id}@example.test` });
  return id;
}

const api = (url, options) => requestJson(harness.baseUrl, url, options);
const memberPath = (orgId, accountId) => `/api/auth/organizations/${orgId}/members/${accountId}`;
async function snapshot(orgId, accountId) {
  const result = await harness.database.query(
    `SELECT m.role, m.active, m.revision, o.context_version
     FROM organization_memberships m JOIN organizations o ON o.id = m.org_id
     WHERE m.org_id = $1 AND m.account_id = $2`, [orgId, accountId]
  );
  return result.rows[0];
}

for (const field of ['active', 'role']) {
  for (const withRevision of [false, true]) {
    test(`successful no-op ${field} replays after an intervening change ${withRevision ? 'with' : 'without'} target revision`, async () => {
      const ownerId = await account('AGENCY');
      const targetId = await account('STAFF');
      const cookie = await sessionCookie(harness, ownerId);
      const before = await snapshot(LEGACY_ORG, targetId);
      const commandId = uniqueId('noop');
      const input = {
        commandId,
        [field]: field === 'active' ? true : 'STAFF',
        ...(withRevision ? { expectedContextVersion: Number(before.revision) } : {}),
      };
      const first = await api(memberPath(LEGACY_ORG, targetId), { method: 'POST', cookie, body: input });
      assert.equal(first.status, 200);
      assert.equal(first.json.replayed, false);
      assert.deepEqual(first.json.membership, {
        orgId: LEGACY_ORG, accountId: targetId, role: 'STAFF', active: true, contextVersion: Number(before.revision),
      });
      assert.deepEqual(first.json.previous, { role: 'STAFF', active: true });
      assert.deepEqual(await snapshot(LEGACY_ORG, targetId), before, 'a no-op bumps neither the member nor the organization revision');

      const changed = await api(memberPath(LEGACY_ORG, targetId), {
        method: 'POST', cookie,
        body: { commandId: uniqueId('change'), active: false, role: 'MANAGER', expectedContextVersion: Number(before.revision) },
      });
      assert.equal(changed.status, 200);
      const intervening = await snapshot(LEGACY_ORG, targetId);
      assert.equal(intervening.active, false);
      assert.equal(intervening.role, 'MANAGER');
      assert.equal(Number(intervening.revision), Number(before.revision) + 1);

      const replay = await api(memberPath(LEGACY_ORG, targetId), { method: 'POST', cookie, body: input });
      assert.equal(replay.status, 200, 'the original target revision must not block a successful receipt replay');
      assert.equal(replay.json.replayed, true, 'the no-op command is already committed, not a fresh mutation');
      assert.deepEqual(replay.json, { ...first.json, replayed: true });
      assert.deepEqual(await snapshot(LEGACY_ORG, targetId), intervening, 'a retry never reverses a newer activation or role change');

      const receipt = await harness.database.query(
        'SELECT actor_id, org_id, event_id, result FROM command_receipts WHERE command_id = $1', [commandId]
      );
      assert.equal(receipt.rowCount, 1);
      assert.equal(receipt.rows[0].actor_id, ownerId);
      assert.equal(receipt.rows[0].org_id, LEGACY_ORG);
      assert.equal(receipt.rows[0].event_id, null);
      assert.deepEqual(receipt.rows[0].result, {
        command: 'organization.membership.set',
        request: { accountId: targetId, active: field === 'active' ? true : null, role: field === 'role' ? 'STAFF' : null },
        response: { membership: first.json.membership, previous: first.json.previous },
      });
    });
  }
}
