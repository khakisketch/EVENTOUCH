'use strict';

// Read-only login protection overview for the organization owner: which
// accounts are counting failures and which overrides are fresh. Failure
// rows are counters, never an access log — successful logins are not
// recorded, so the endpoint must not be mistaken for one.

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

const suffix = crypto.randomUUID().replace(/-/g, '');
const ids = {
  agency: `security-agency-${suffix}`,
  manager: `security-manager-${suffix}`,
};
let harness;
let agencyCookie;
let managerCookie;

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {orgId: LEGACY_ORG,  id: ids.agency, role: 'AGENCY', name: '보안 관리자', email: `${ids.agency}@example.test` });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,  id: ids.manager, role: 'MANAGER', name: '행사 매니저', email: `${ids.manager}@example.test` });
  agencyCookie = await sessionCookie(harness, ids.agency);
  managerCookie = await sessionCookie(harness, ids.manager);
});

after(async () => {
  if (harness) await harness.close();
});

test('login protection overview is agency-only and honest about its shape', async () => {
  assert.equal((await requestJson(harness.baseUrl, '/api/auth/security', {})).status, 401);
  assert.equal((await requestJson(harness.baseUrl, '/api/auth/security', { cookie: managerCookie })).status, 403);

  const response = await requestJson(harness.baseUrl, '/api/auth/security', { cookie: agencyCookie });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.attempts));
  assert.ok(Array.isArray(response.json.overrides));
  for (const attempt of response.json.attempts) {
    assert.ok(['account', 'address'].includes(attempt.scope));
    assert.equal(typeof attempt.failures, 'number');
  }
});

test('failed logins surface as counters, never as access history', async () => {
  // Counters are attributable per-org member: an unknown email has no org to
  // show under, so the probe uses the manager member with a wrong password.
  const probe = `${ids.manager}@example.test`;
  const failed = await requestJson(harness.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: probe, password: 'wrong-password' },
  });
  assert.equal(failed.status, 401);

  const response = await requestJson(harness.baseUrl, '/api/auth/security', { cookie: agencyCookie });
  assert.equal(response.status, 200);
  const entry = response.json.attempts.find(
    (attempt) => attempt.scope === 'account' && attempt.key === probe
  );
  assert.ok(entry, 'the failed account is counted');
  assert.ok(entry.failures >= 1);
  assert.ok(!('password' in entry) && !('token' in entry));
});
