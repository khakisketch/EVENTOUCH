'use strict';

// Task7 invitation management backend: AGENCY-only create/revoke with one-time
// bearer contract. TDD suite against the ephemeral PostgreSQL API harness.
// Secure-link rule: the raw bearer appears ONLY in the 201 creation response;
// the database, receipts, bootstrap and all other responses carry token_hash
// or public metadata exclusively.

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
} = require('./helpers/postgres-api-server.cjs');
const { emptyWorkspace } = require('../server/state');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

let harness = null;
let cookies = null;
let eventId = null;
let archivedEventId = null;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function uniqueEmail(prefix) {
  return `${prefix}-${crypto.randomUUID()}@example.test`;
}

function commandId() {
  return `cmd-${crypto.randomUUID().replace(/-/g, '')}`;
}

async function createInvitation(cookie, body) {
  return requestJson(harness.baseUrl, '/api/auth/invitations', {
    cookie,
    method: 'POST',
    body,
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
  await insertAccount(harness.database, {
    id: 'field-staff', role: 'STAFF', name: '스태프', email: 'field-staff@example.test',
  });
  eventId = `evt-${crypto.randomUUID()}`;
  await insertEvent(harness.database, {
    id: eventId,
    slug: `slug-${crypto.randomUUID()}`,
    payload: { name: '테스트 행사', stage: 'DRAFT' },
    workspace: emptyWorkspace(),
  });
  archivedEventId = `evt-${crypto.randomUUID()}`;
  await insertEvent(harness.database, {
    id: archivedEventId,
    slug: `slug-${crypto.randomUUID()}`,
    payload: { name: '보관 행사', stage: 'ARCHIVED' },
    workspace: emptyWorkspace(),
  });
  cookies = {
    agency: await sessionCookie(harness, 'agency-owner'),
    manager: await sessionCookie(harness, 'team-manager'),
    staff: await sessionCookie(harness, 'field-staff'),
  };
});

after(async () => {
  if (harness) await harness.close();
});

test('invitation creation and revocation require login', async () => {
  const created = await createInvitation(null, {
    commandId: commandId(), name: '홍길동', email: uniqueEmail('anon'), role: 'MANAGER',
  });
  assert.equal(created.status, 401);
  const revoked = await requestJson(harness.baseUrl, '/api/auth/invitations/inv-missing/revoke', {
    method: 'POST',
    body: { commandId: commandId() },
  });
  assert.equal(revoked.status, 401);
});

test('manager and staff cannot create or revoke invitations', async () => {
  for (const cookie of [cookies.manager, cookies.staff]) {
    const created = await createInvitation(cookie, {
      commandId: commandId(), name: '홍길동', email: uniqueEmail('denied'), role: 'STAFF',
    });
    assert.equal(created.status, 403);
    const revoked = await requestJson(harness.baseUrl, '/api/auth/invitations/inv-missing/revoke', {
      cookie,
      method: 'POST',
      body: { commandId: commandId() },
    });
    assert.equal(revoked.status, 403);
  }
});

test('invitation creation validates role, email, event and command identity', async () => {
  const badRole = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '홍길동', email: uniqueEmail('role'), role: 'AGENCY',
  });
  assert.equal(badRole.status, 400);

  const badEmail = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '홍길동', email: 'not-an-email', role: 'STAFF',
  });
  assert.equal(badEmail.status, 400);

  const missingEvent = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '홍길동', email: uniqueEmail('event'), role: 'MANAGER', eventId: 'evt-missing',
  });
  assert.equal(missingEvent.status, 404);

  const archivedEvent = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '홍길동', email: uniqueEmail('archived'), role: 'MANAGER', eventId: archivedEventId,
  });
  assert.equal(archivedEvent.status, 409);

  const badCommand = await createInvitation(cookies.agency, {
    commandId: 'short', name: '홍길동', email: uniqueEmail('cmd'), role: 'STAFF',
  });
  assert.equal(badCommand.status, 400);
  assert.equal(badCommand.json.field, 'commandId');

  const missingCommand = await createInvitation(cookies.agency, {
    name: '홍길동', email: uniqueEmail('nocmd'), role: 'STAFF',
  });
  assert.equal(missingCommand.status, 400);

  const emptyName = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '  ', email: uniqueEmail('name'), role: 'STAFF',
  });
  assert.equal(emptyName.status, 400);

  const stored = await harness.database.query(
    "SELECT count(*)::int AS count FROM invitations WHERE email LIKE '%@example.test' AND name = '홍길동'"
  );
  assert.equal(stored.rows[0].count, 0);
});

test('agency creates a manager invitation and the full accept flow grants event membership', async () => {
  const email = uniqueEmail('mgr');
  const created = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '초대 매니저', email, role: 'MANAGER', eventId,
  });
  assert.equal(created.status, 201);
  const { invitation, token } = created.json;
  assert.match(token, /^[A-Za-z0-9_-]{40,128}$/);
  assert.deepEqual(
    { email: invitation.email, name: invitation.name, role: invitation.role, eventId: invitation.eventId, status: invitation.status },
    { email, name: '초대 매니저', role: 'MANAGER', eventId, status: 'PENDING' }
  );
  assert.ok(invitation.expiresAt);
  assert.equal(JSON.stringify(created.json).includes('token_hash'), false);

  const stored = await harness.database.query('SELECT * FROM invitations WHERE id = $1', [invitation.id]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].token_hash, sha256(token));
  assert.equal(JSON.stringify(stored.rows[0]).includes(token), false);

  const receipt = await harness.database.query('SELECT result FROM command_receipts WHERE event_id = $1', [eventId]);
  assert.ok(receipt.rowCount >= 1);
  assert.equal(JSON.stringify(receipt.rows).includes(token), false);

  const lookup = await requestJson(harness.baseUrl, `/api/auth/invitations/${token}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.json.invitation.id, invitation.id);
  assert.equal(JSON.stringify(lookup.json).includes('token_hash'), false);

  const password = 'manager-accept-password';
  const accepted = await requestJson(harness.baseUrl, `/api/auth/invitations/${token}/accept`, {
    method: 'POST',
    body: { password },
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.json.account.email, email);
  assert.equal(accepted.json.account.role, 'MANAGER');

  const hashRow = await harness.database.query('SELECT password_hash FROM accounts WHERE id = $1', [accepted.json.account.id]);
  assert.match(hashRow.rows[0].password_hash, /^scrypt:/);

  const membership = await harness.database.query(
    'SELECT account_id FROM memberships WHERE account_id = $1 AND event_id = $2',
    [accepted.json.account.id, eventId]
  );
  assert.equal(membership.rowCount, 1);

  const login = await requestJson(harness.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'MANAGER');
});

test('staff invitation without an event accepts but grants no membership', async () => {
  const email = uniqueEmail('stf');
  const created = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '초대 스태프', email, role: 'STAFF',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.invitation.eventId, null);

  const accepted = await requestJson(harness.baseUrl, `/api/auth/invitations/${created.json.token}/accept`, {
    method: 'POST',
    body: { password: 'staff-accept-password' },
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.json.account.role, 'STAFF');

  const membership = await harness.database.query(
    'SELECT 1 FROM memberships WHERE account_id = $1', [accepted.json.account.id]
  );
  assert.equal(membership.rowCount, 0);
});

test('revoked invitations are denied by lookup and accept; revocation is idempotent', async () => {
  const email = uniqueEmail('rev');
  const created = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '철회 대상', email, role: 'STAFF',
  });
  assert.equal(created.status, 201);

  const revokeId = created.json.invitation.id;
  const first = await requestJson(harness.baseUrl, `/api/auth/invitations/${revokeId}/revoke`, {
    cookie: cookies.agency,
    method: 'POST',
    body: { commandId: commandId() },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.invitation.status, 'REVOKED');

  const retry = await requestJson(harness.baseUrl, `/api/auth/invitations/${revokeId}/revoke`, {
    cookie: cookies.agency,
    method: 'POST',
    body: { commandId: commandId() },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.invitation.status, 'REVOKED');

  const missing = await requestJson(harness.baseUrl, '/api/auth/invitations/inv-missing/revoke', {
    cookie: cookies.agency,
    method: 'POST',
    body: { commandId: commandId() },
  });
  assert.equal(missing.status, 404);

  const lookup = await requestJson(harness.baseUrl, `/api/auth/invitations/${created.json.token}`);
  assert.equal(lookup.status, 409);

  const accepted = await requestJson(harness.baseUrl, `/api/auth/invitations/${created.json.token}/accept`, {
    method: 'POST',
    body: { password: 'revoked-accept-password' },
  });
  assert.equal(accepted.status, 409);
});

test('pending duplicates and existing active accounts are rejected', async () => {
  const email = uniqueEmail('dup');
  const first = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '중복 초대', email, role: 'STAFF',
  });
  assert.equal(first.status, 201);

  const duplicate = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '중복 초대', email: email.toUpperCase(), role: 'STAFF',
  });
  assert.equal(duplicate.status, 409);

  const taken = uniqueEmail('taken');
  await insertAccount(harness.database, {
    id: `acct-${crypto.randomUUID()}`, role: 'STAFF', name: '기존 계정', email: taken,
  });
  const existing = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '기존 계정', email: taken, role: 'STAFF',
  });
  assert.equal(existing.status, 409);
});

test('stable commandId never reissues the bearer link', async () => {
  const stable = commandId();
  const payload = { commandId: stable, name: '안정 초대', email: uniqueEmail('stable'), role: 'STAFF' };
  const first = await createInvitation(cookies.agency, payload);
  assert.equal(first.status, 201);

  const replay = await createInvitation(cookies.agency, payload);
  assert.equal(replay.status, 409);
  assert.equal(replay.json.code, 'INVITATION_LINK_UNAVAILABLE');
  assert.match(replay.json.error || '', /[가-힣]/);

  const conflict = await createInvitation(cookies.agency, {
    commandId: stable, name: '다른 초대', email: uniqueEmail('conflict'), role: 'STAFF',
  });
  assert.equal(conflict.status, 409);

  const rows = await harness.database.query('SELECT count(*)::int AS count FROM invitations WHERE email = $1', [payload.email]);
  assert.equal(rows.rows[0].count, 1);
});

test('concurrent creation yields exactly one pending invitation', async () => {
  const email = uniqueEmail('race');
  const results = await Promise.all([createInvitation(cookies.agency, {
    commandId: commandId(), name: '동시 초대', email, role: 'STAFF',
  }), createInvitation(cookies.agency, {
    commandId: commandId(), name: '동시 초대', email, role: 'STAFF',
  })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const rows = await harness.database.query(
    "SELECT count(*)::int AS count FROM invitations WHERE lower(email) = $1 AND status = 'PENDING'",
    [email]
  );
  assert.equal(rows.rows[0].count, 1);

  const shared = commandId();
  const sharedBody = { name: '동시 식별자', email: uniqueEmail('racecmd'), role: 'STAFF' };
  const sharedResults = await Promise.all([
    createInvitation(cookies.agency, { ...sharedBody, commandId: shared }),
    createInvitation(cookies.agency, { ...sharedBody, commandId: shared }),
  ]);
  assert.deepEqual(sharedResults.map((result) => result.status).sort(), [201, 409]);
  const sharedRows = await harness.database.query(
    "SELECT count(*)::int AS count FROM invitations WHERE lower(email) = $1 AND status = 'PENDING'",
    [sharedBody.email]
  );
  assert.equal(sharedRows.rows[0].count, 1);
});

test('token material never leaks into bootstrap, receipts or public payloads', async () => {
  const email = uniqueEmail('leak');
  const created = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '유출 검사', email, role: 'STAFF',
  });
  assert.equal(created.status, 201);
  const token = created.json.token;

  const bootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookies.agency });
  assert.equal(bootstrap.status, 200);
  const serialized = JSON.stringify(bootstrap.json);
  assert.equal(serialized.includes('token_hash'), false);
  assert.equal(serialized.includes(token), false);
  const projected = bootstrap.json.state.invitations.find((item) => item.email === email);
  assert.ok(projected);
  assert.equal(projected.status, 'PENDING');
});

test('short accept passwords are rejected without consuming the invitation', async () => {
  const email = uniqueEmail('weakpw');
  const created = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '약한 비밀번호', email, role: 'STAFF',
  });
  assert.equal(created.status, 201);

  const rejected = await requestJson(harness.baseUrl, `/api/auth/invitations/${created.json.token}/accept`, {
    method: 'POST',
    body: { password: 'short' },
  });
  assert.equal(rejected.status, 400);

  const lookup = await requestJson(harness.baseUrl, `/api/auth/invitations/${created.json.token}`);
  assert.equal(lookup.status, 200);
});
