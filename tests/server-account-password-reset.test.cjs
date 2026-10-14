'use strict';

// Account password reset: AGENCY-only, idempotent by commandId, revokes other
// sessions. Covers the forgotten-password path for invitation-only accounts.

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

let harness = null;
let cookies = null;

function commandId() {
  return `cmd-${crypto.randomUUID().replace(/-/g, '')}`;
}

async function resetPassword(cookie, accountId, body) {
  return requestJson(harness.baseUrl, `/api/auth/accounts/${encodeURIComponent(accountId)}/password`, {
    cookie,
    method: 'POST',
    body,
  });
}

async function login(email, password) {
  return requestJson(harness.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    id: 'agency-owner', role: 'AGENCY', name: '운영사', email: 'agency-owner@example.test',
  });
  await insertAccount(harness.database, {
    id: 'team-manager', role: 'MANAGER', name: '매니저', email: 'team-manager@example.test',
  });
  cookies = {
    agency: await sessionCookie(harness, 'agency-owner'),
    manager: await sessionCookie(harness, 'team-manager'),
  };
});

after(async () => {
  if (harness) await harness.close();
});

test('agency resets a password and the new password logs in', async () => {
  const first = await resetPassword(cookies.agency, 'team-manager', {
    commandId: commandId(), password: 'reset-password-1',
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.account.id, 'team-manager');
  const ok = await login('team-manager@example.test', 'reset-password-1');
  assert.equal(ok.status, 200);
  const stale = await login('team-manager@example.test', 'not-a-real-test-password');
  assert.equal(stale.status, 401);
});

test('reset replays the same command id without changing the receipt', async () => {
  const id = commandId();
  const first = await resetPassword(cookies.agency, 'team-manager', {
    commandId: id, password: 'reset-password-2',
  });
  assert.equal(first.status, 200);
  const replay = await resetPassword(cookies.agency, 'team-manager', {
    commandId: id, password: 'reset-password-2',
  });
  assert.equal(replay.status, 200);
  const other = await resetPassword(cookies.agency, 'team-manager', {
    commandId: id, password: 'reset-password-3',
  });
  assert.equal(other.status, 409);
});

test('reset validates the password and the target', async () => {
  const short = await resetPassword(cookies.agency, 'team-manager', {
    commandId: commandId(), password: 'short',
  });
  assert.equal(short.status, 400);
  const missing = await resetPassword(cookies.agency, 'acct-missing', {
    commandId: commandId(), password: 'reset-password-4',
  });
  assert.equal(missing.status, 404);
});

test('reset requires login and the agency role', async () => {
  const anonymous = await resetPassword(null, 'team-manager', {
    commandId: commandId(), password: 'reset-password-5',
  });
  assert.equal(anonymous.status, 401);
  // Earlier resets revoked this session; log in again with the current password.
  const relogin = await login('team-manager@example.test', 'reset-password-2');
  assert.equal(relogin.status, 200);
  const managerCookie = relogin.headers.getSetCookie()[0].split(';')[0];
  const manager = await resetPassword(managerCookie, 'team-manager', {
    commandId: commandId(), password: 'reset-password-6',
  });
  assert.equal(manager.status, 403);
});

test('reset revokes the other sessions of the account', async () => {
  const extra = await sessionCookie(harness, 'team-manager');
  assert.ok(extra);
  const res = await resetPassword(cookies.agency, 'team-manager', {
    commandId: commandId(), password: 'reset-password-7',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.sessionsRevoked >= 1, true);
  const me = await requestJson(harness.baseUrl, '/api/auth/me', { cookie: extra });
  assert.equal(me.status, 401);
});
