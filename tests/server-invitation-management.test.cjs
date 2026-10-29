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
  LEGACY_ORG,
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
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: 'agency-owner', role: 'AGENCY', name: '운영사', email: 'agency-owner@example.test',
  });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: 'team-manager', role: 'MANAGER', name: '매니저', email: 'team-manager@example.test',
  });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: 'field-staff', role: 'STAFF', name: '스태프', email: 'field-staff@example.test',
  });
  eventId = `evt-${crypto.randomUUID()}`;
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: eventId,
    slug: `slug-${crypto.randomUUID()}`,
    payload: { name: '테스트 행사', stage: 'DRAFT' },
    workspace: emptyWorkspace(),
  });
  archivedEventId = `evt-${crypto.randomUUID()}`;
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
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

test('invitation writes recheck the current agency role inside the transaction', async () => {
  const existing = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '철회 대상', email: uniqueEmail('race-existing'), role: 'STAFF',
  });
  assert.equal(existing.status, 201);
  for (const operation of ['create','revoke']) {
    const original = harness.database.transaction;
    let entered, release;
    const arrival = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    harness.database.transaction = async fn => {
      entered(); await gate; return original.call(harness.database, fn);
    };
    try {
      const pending = operation === 'create' ? createInvitation(cookies.agency, {
        commandId: commandId(), name: '권한 변경 후 초대', email: uniqueEmail('race-new'), role: 'STAFF',
      }) : requestJson(harness.baseUrl, `/api/auth/invitations/${existing.json.invitation.id}/revoke`, {
        cookie: cookies.agency, method: 'POST', body: { commandId: commandId() },
      });
      await arrival;
      // Membership is the authority (not accounts.role): a mid-flight demotion
      // inside this org must deny, while other orgs keep their own truth.
      await harness.database.query("UPDATE organization_memberships SET role='MANAGER' WHERE org_id='org-legacy' AND account_id='agency-owner'");
      release();
      assert.equal((await pending).status, 403);
      assert.equal((await harness.database.query('SELECT status FROM invitations WHERE id=$1',
        [existing.json.invitation.id])).rows[0].status, 'PENDING');
    } finally {
      release(); harness.database.transaction = original;
      await harness.database.query("UPDATE organization_memberships SET role='AGENCY' WHERE org_id='org-legacy' AND account_id='agency-owner'");
    }
  }
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
  // Owner invitations are org-scoped (owner-only, no event): allowed.
  const ownerInvite = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '새 소유자', email: uniqueEmail('owner'), role: 'AGENCY',
  });
  assert.equal(ownerInvite.status, 201);
  const ownerScoped = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '행사 소유자', email: uniqueEmail('owner-scoped'), role: 'AGENCY', eventId: eventId,
  });
  assert.equal(ownerScoped.status, 400);
  assert.equal(ownerScoped.json.field, 'eventId');

  const badRole = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '홍길동', email: uniqueEmail('role'), role: 'BILLING',
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

test('a stale staff invitation cannot demote the last active owner', async () => {
  const email = uniqueEmail('last-owner');
  const inviteeId = `acct-${crypto.randomUUID()}`;
  // The invitee exists as a global account but is not yet a member of this
  // org, so the invitation can be issued. Membership arrives afterwards.
  await harness.database.query(
    `INSERT INTO accounts (id, email, name, role, password_hash, org_permissions)
     VALUES ($1, $2, $3, 'MANAGER', 'scrypt:test:test', '[]'::jsonb)`,
    [inviteeId, email, '마지막 소유자']
  );
  const created = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '마지막 소유자', email, role: 'STAFF',
  });
  assert.equal(created.status, 201);

  // The invitee joins as the org's only active owner after the STAFF
  // invitation was issued; accepting it must not leave the org ownerless.
  await harness.database.query(
    `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
     VALUES ($1, $2, 'AGENCY', true, '[]'::jsonb)`,
    [LEGACY_ORG, inviteeId]
  );
  await harness.database.query(
    "UPDATE organization_memberships SET role='MANAGER' WHERE org_id=$1 AND account_id='agency-owner'",
    [LEGACY_ORG]
  );
  try {
    const cookie = await sessionCookie(harness, inviteeId);
    const rejected = await requestJson(harness.baseUrl, `/api/auth/invitations/${created.json.token}/accept`, {
      cookie,
      method: 'POST',
      body: {},
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.code, 'LAST_OWNER');
    const membership = await harness.database.query(
      'SELECT role, active FROM organization_memberships WHERE org_id=$1 AND account_id=$2',
      [LEGACY_ORG, inviteeId]
    );
    assert.deepEqual({ role: membership.rows[0].role, active: membership.rows[0].active }, { role: 'AGENCY', active: true });
    const invitation = await harness.database.query('SELECT status FROM invitations WHERE id=$1', [created.json.invitation.id]);
    assert.equal(invitation.rows[0].status, 'PENDING');
  } finally {
    await harness.database.query(
      "UPDATE organization_memberships SET role='AGENCY' WHERE org_id=$1 AND account_id='agency-owner'",
      [LEGACY_ORG]
    );
    await harness.database.query(
      'DELETE FROM organization_memberships WHERE org_id=$1 AND account_id=$2',
      [LEGACY_ORG, inviteeId]
    );
  }
});

test('concurrent stale invitations and role edits preserve an active owner', { timeout: 20000 }, async () => {
  for (const competingPath of ['invitation', 'role-edit']) {
    const invitees = [];
    for (let index = 0; index < 2; index += 1) {
      const id = `acct-${crypto.randomUUID()}`;
      const email = uniqueEmail('owner-race');
      await insertAccount(harness.database, { orgId: LEGACY_ORG, id, email, name: '소유자 경합', role: 'MANAGER' });
      await harness.database.query('DELETE FROM organization_memberships WHERE org_id=$1 AND account_id=$2', [LEGACY_ORG, id]);
      const invitation = await createInvitation(cookies.agency, {
        commandId: commandId(), email, name: '소유자 경합', role: 'STAFF',
      });
      assert.equal(invitation.status, 201);
      invitees.push({ id, token: invitation.json.token, invitationId: invitation.json.invitation.id });
    }
    try {
      for (const invitee of invitees) {
        await harness.database.query(
          `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
           VALUES ($1, $2, 'AGENCY', true, '[]'::jsonb)`, [LEGACY_ORG, invitee.id]
        );
      }
      await harness.database.query("UPDATE organization_memberships SET role='MANAGER' WHERE org_id=$1 AND account_id='agency-owner'", [LEGACY_ORG]);
      const accept = (invitee) => harness.auth.acceptInvitation(invitee.token, undefined, { id: invitee.id });
      const results = await Promise.allSettled([
        accept(invitees[0]),
        competingPath === 'invitation'
          ? accept(invitees[1])
          : harness.auth.setOrgMembership({ id: invitees[1].id }, LEGACY_ORG, invitees[1].id, { commandId: commandId(), role: 'STAFF' }),
      ]);
      assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1, competingPath);
      const denied = results.find((item) => item.status === 'rejected');
      assert.equal(denied?.reason.status, 409, `${competingPath}: denial, not a deadlock/500`);
      assert.match(denied.reason.message, /마지막 조직 소유자/);
      const owners = await harness.database.query("SELECT count(*)::int AS count FROM organization_memberships WHERE org_id=$1 AND role='AGENCY' AND active=true", [LEGACY_ORG]);
      assert.equal(owners.rows[0].count, 1);
      for (const [index, result] of results.entries()) {
        if (result.status !== 'rejected' || (index === 1 && competingPath !== 'invitation')) continue;
        const row = await harness.database.query('SELECT status FROM invitations WHERE id=$1', [invitees[index].invitationId]);
        assert.equal(row.rows[0].status, 'PENDING', 'failed acceptance does not consume the token');
      }
    } finally {
      await harness.database.query("UPDATE organization_memberships SET role='AGENCY' WHERE org_id=$1 AND account_id='agency-owner'", [LEGACY_ORG]);
      for (const invitee of invitees) {
        await harness.database.query('DELETE FROM organization_memberships WHERE org_id=$1 AND account_id=$2', [LEGACY_ORG, invitee.id]);
      }
    }
  }
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
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
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

test('staff invitations reject an event scope instead of silently dropping it', async () => {
  const email = uniqueEmail('staff-scoped');
  const rejected = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '행사 지정 스태프', email,
    role: 'STAFF', eventId,
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
  assert.match(rejected.json.error, /행사/);
  const rows = await harness.database.query('SELECT 1 FROM invitations WHERE email = $1', [email]);
  assert.equal(rows.rowCount, 0);
  const retry = await createInvitation(cookies.agency, {
    commandId: commandId(), name: '배정 대기 스태프', email: uniqueEmail('staff-unscoped'), role: 'STAFF',
  });
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  assert.equal(retry.json.invitation.eventId, null);
});
