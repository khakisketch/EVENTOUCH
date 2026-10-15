'use strict';

// Organization tenancy step 1: the 008 tables exist and enforce their own
// keys, but no existing path reads or writes them — behavior is unchanged.
// (Mapping, scoping, and constraints are later MULTI-TENANCY.md steps.)

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  sessionCookie,
  requestJson,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const agencyId = `org-agency-${suffix}`;
const orgId = `org-${suffix}`;
let harness;
let cookie;

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    id: agencyId,
    role: 'AGENCY',
    name: 'Org Schema Agency',
    email: `org-schema-${suffix}@example.test`,
  });
  cookie = await sessionCookie(harness, agencyId);
});

after(async () => {
  if (harness) await harness.close();
});

test('organization tables exist with their keys and checks', async () => {
  const tables = await harness.database.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()
     AND tablename IN ('organizations', 'organization_memberships')`
  );
  assert.deepEqual(
    tables.rows.map((row) => row.tablename).sort(),
    ['organization_memberships', 'organizations']
  );

  await harness.database.query(
    'INSERT INTO organizations (id, name) VALUES ($1, $2)',
    [orgId, 'Schema Org']
  );
  await harness.database.query(
    `INSERT INTO organization_memberships (org_id, account_id, role)
     VALUES ($1, $2, 'AGENCY')`,
    [orgId, agencyId]
  );

  // Same account twice in one org is one membership.
  await assert.rejects(
    harness.database.query(
      `INSERT INTO organization_memberships (org_id, account_id, role)
       VALUES ($1, $2, 'MANAGER')`,
      [orgId, agencyId]
    )
  );
  // Unknown accounts and unknown roles stay out.
  await assert.rejects(
    harness.database.query(
      `INSERT INTO organization_memberships (org_id, account_id, role)
       VALUES ($1, $2, 'AGENCY')`,
      [orgId, `nobody-${suffix}`]
    )
  );
  await assert.rejects(
    harness.database.query(
      'INSERT INTO organizations (id, name) VALUES ($1, $2)',
      [`org-bad-${suffix}`, '']
    )
  );
});

test('existing paths ignore organization rows', async () => {
  // With org rows present, the org-agnostic endpoints answer as before.
  const created = await requestJson(harness.baseUrl, '/api/clients', {
    cookie,
    method: 'POST',
    body: { commandId: `org-client-${suffix}`, name: `Org Schema Client ${suffix}` },
  });
  assert.equal(created.status, 201);

  const boot = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie });
  assert.equal(boot.status, 200);
  assert.ok(Array.isArray(boot.json.state.events));

  const memberships = await harness.database.query(
    'SELECT COUNT(*)::int AS n FROM organization_memberships WHERE org_id = $1',
    [orgId]
  );
  assert.equal(memberships.rows[0].n, 1);
});
