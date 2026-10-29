'use strict';

// Self-service account recovery by verified email ("이메일+수동 예외").
//
// A signed-in holder proves mailbox ownership of their own stored address
// (VERIFY proof), and only that proven address later receives recovery links
// (RECOVER proof). Confirming a recovery link resets the global password and
// revokes every session. Locked accounts with no proven channel stay on the
// separately decided manual process (unbuilt): the anonymous endpoints keep
// their generic answers and the UI states the limitation honestly.
//
// Covers: verified-email lifecycle, invitation acceptance never counting as
// verification, A/B org isolation (shared accounts self-recover without any
// org owner; owner resets stay fail-closed), concurrency/replay/expiry, no
// enumeration (identical anonymous shapes), revocation of prior sessions,
// honest disabled/misconfigured states, and safe old-schema degradation.

const { test: nodeTest, before, after, afterEach } = require('node:test');
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
const { createEmailTransport, mockOutbox, clearMockOutbox } = require('../server/email-transport');
const { createAccountRecovery } = require('../server/account-recovery');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const MOCK_ENV = { EVENTOUCH_MAIL_MOCK: '1', EVENTOUCH_PUBLIC_URL: 'http://127.0.0.1:19999' };

// Recovery/verify links carry the bearer in the URL fragment (#t=), never
// the query: fragments never reach the server, proxy logs, or Referer.
function tokenOf(link) {
  const hash = new URL(link).hash;
  const match = /^#t=([A-Za-z0-9_-]{32,})$/.exec(hash);
  assert.ok(match, `link carries a fragment bearer: ${link}`);
  return match[1];
}

// Anonymous answers stay generic AND identically shaped: ok plus the global
// delivery flag only (never whether this address qualified).
function assertGenericRecovery(resOrBody, connected = true) {
  const body = resOrBody && resOrBody.json !== undefined ? resOrBody.json : resOrBody;
  if (resOrBody && resOrBody.json !== undefined) assert.equal(resOrBody.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.delivery && body.delivery.connected, connected);
  assert.ok(['mock', 'injected', 'none'].includes(body.delivery && body.delivery.mode));
}
const OFF_ENV = { EVENTOUCH_MAIL_MOCK: '0', EVENTOUCH_PUBLIC_URL: '' };
const HOURLY_CAP = 5;

let harness = null;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function freshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function login(email, password) {
  return requestJson(harness.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
}

async function status(cookie) {
  return requestJson(harness.baseUrl, '/api/auth/email/status', { cookie });
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness({ env: MOCK_ENV });
  clearMockOutbox();
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-a', role: 'AGENCY', name: '홀더', email: 'holder-a@example.test',
  });
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-b', role: 'MANAGER', name: '홀더B', email: 'holder-b@example.test',
  });
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-c', role: 'MANAGER', name: '홀더C', email: 'holder-c@example.test',
  });
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-e', role: 'STAFF', name: '홀더E', email: 'holder-e@example.test',
  });
  // Shared account across two orgs: self-recovery must work without any owner.
  await harness.database.query(`INSERT INTO organizations (id, name) VALUES ('org-b', '두번째 조직')`);
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'shared-s', role: 'MANAGER', name: '공유', email: 'shared-s@example.test',
  });
  await harness.database.query(
    `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
      VALUES ('org-b', 'shared-s', 'MANAGER', true, '[]'::jsonb)`
  );
  await insertAccount(harness.database, {
    orgId: 'org-b', id: 'owner-b', role: 'AGENCY', name: '오너B', email: 'owner-b@example.test',
  });
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-d', role: 'MANAGER', name: '홀더D', email: 'holder-d@example.test',
  });
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-g', role: 'STAFF', name: '홀더G', email: 'holder-g@example.test',
  });
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-t', role: 'MANAGER', name: '홀더T', email: 'holder-t@example.test',
  });
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-h', role: 'STAFF', name: '홀더H', email: 'holder-h@example.test',
  });
  // Active account with no memberships at all.
  await harness.database.query(
    `INSERT INTO accounts (id, email, name, role, password_hash, org_permissions)
      VALUES ('nomem-f', 'nomem-f@example.test', '무소속', 'MANAGER',
        (SELECT password_hash FROM accounts WHERE id = 'holder-a'), '[]'::jsonb)`
  );
});

after(async () => {
  if (harness) await harness.close();
});

// Recovery/verify throttle rows share the file's loopback client key: clear
// them between cases so each abuse test starts from a known-empty bucket.
// Proof rows and login (account/address) rows are never touched here.
async function clearRecoveryThrottle() {
  if (!harness) return;
  await harness.database.query(
    "DELETE FROM login_attempts WHERE scope NOT IN ('account', 'address')"
  ).catch(() => {});
}

afterEach(async () => {
  await clearRecoveryThrottle();
});

test('verification endpoints require a session', async () => {
  for (const [url, init] of [
    ['/api/auth/email/status', {}],
    ['/api/auth/email/verify/request', { method: 'POST', body: { currentPassword: 'x'.repeat(12) } }],
    ['/api/auth/email/verify/confirm', { method: 'POST', body: { token: freshToken() } }],
  ]) {
    const res = await requestJson(harness.baseUrl, url, init);
    assert.equal(res.status, 401);
  }
});

test('verify request reauthenticates the current password and mails only the stored address', async () => {
  const cookie = await sessionCookie(harness, 'holder-a');
  const wrong = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'wrong-password-1' },
  });
  assert.equal(wrong.status, 401);
  assert.match(wrong.json.error, /현재 비밀번호/);
  clearMockOutbox();
  // An attacker-chosen address in the body is ignored: mail goes to the
  // account's own stored address only.
  const ok = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password', email: 'attacker@example.test' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.ok(ok.json.expiresAt);
  assert.equal(mockOutbox.length, 1);
  assert.equal(mockOutbox[0].to, 'holder-a@example.test');
  assert.match(mockOutbox[0].link, /^http:\/\/127\.0\.0\.1:19999\/account\/email#t=[A-Za-z0-9_-]{32,}$/);
});

test('verify confirm distinguishes invalid links for the holder and verifies once', async () => {
  const cookie = await sessionCookie(harness, 'holder-a');
  const malformed = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token: 'short' },
  });
  assert.equal(malformed.status, 404);
  const unknown = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token: freshToken() },
  });
  assert.equal(unknown.status, 404);
  const token = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  const first = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.verified, true);
  const replay = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token },
  });
  assert.equal(replay.status, 409);
  const after = await status(cookie);
  assert.equal(after.status, 200);
  assert.equal(after.json.verified, true);
  assert.ok(after.json.verifiedAt);
  assert.ok(!String(after.json.emailMasked).includes('holder-a'), 'status masks the address');
  assert.match(after.json.emailMasked, /\*\*\*/);
});

test('already-verified holders skip sending, and resend cooldown is honest', async () => {
  const cookie = await sessionCookie(harness, 'holder-b');
  await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  const token = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token },
  });
  clearMockOutbox();
  const again = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  assert.equal(again.status, 200);
  assert.equal(mockOutbox.length, 0, 'no second mail for an already-verified address');
});

test('verify resend cooldown is honest to the holder', async () => {
  const cookie = await sessionCookie(harness, 'holder-e');
  clearMockOutbox();
  const first = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  assert.equal(first.status, 200);
  assert.equal(mockOutbox.length, 1);
  const second = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  assert.equal(second.status, 429);
  const token = tokenOf(mockOutbox[0].link);
  const confirmed = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token },
  });
  assert.equal(confirmed.status, 200);
});

test('invitation acceptance never counts as email verification', async () => {
  const agency = await sessionCookie(harness, 'holder-a');
  const created = await requestJson(harness.baseUrl, '/api/auth/invitations', {
    cookie: agency, method: 'POST',
    body: { commandId: `cmd-${crypto.randomUUID().replace(/-/g, '')}`, name: '신규', email: 'invited-new@example.test', role: 'MANAGER' },
  });
  assert.equal(created.status, 201);
  const accepted = await requestJson(harness.baseUrl, `/api/auth/invitations/${created.json.token}/accept`, {
    method: 'POST', body: { password: 'invited-password-1' },
  });
  assert.equal(accepted.status, 201);
  const loginRes = await login('invited-new@example.test', 'invited-password-1');
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.getSetCookie()[0].split(';')[0];
  const state = await status(cookie);
  assert.equal(state.status, 200);
  assert.equal(state.json.verified, false, 'bearer-delivered invitations prove nothing about the mailbox');
  clearMockOutbox();
  const rec = await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'invited-new@example.test' },
  });
  assertGenericRecovery(rec);
  assert.equal(mockOutbox.length, 0, 'unverified addresses receive no recovery mail');
});

test('anonymous recovery answers identically for unknown, unverified, and deactivated', async () => {
  clearMockOutbox();
  const shapes = [];
  for (const email of ['nobody-here@example.test', 'holder-c@example.test']) {
    const res = await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
      method: 'POST', body: { email },
    });
    assert.equal(res.status, 200);
    shapes.push(res.json);
  }
  await harness.database.query(`UPDATE accounts SET active = false WHERE id = 'holder-e'`);
  const deactivated = await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-e@example.test' },
  });
  assert.equal(deactivated.status, 200);
  shapes.push(deactivated.json);
  assertGenericRecovery(shapes[0]);
  assert.deepEqual(shapes[1], shapes[0], 'unverified matches unknown exactly');
  assert.deepEqual(shapes[2], shapes[0], 'deactivated matches unknown exactly');
  assert.equal(mockOutbox.length, 0, 'none of the three sends mail');
  await harness.database.query(`UPDATE accounts SET active = true WHERE id = 'holder-e'`);
});

test('recovery confirm keeps one identical denial for every non-success', async () => {
  clearMockOutbox();
  await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-a@example.test' },
  });
  const live = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  // Expired proof planted directly: same denial as invalid.
  const expiredToken = freshToken();
  await harness.database.query(
    `INSERT INTO account_email_proofs (id, account_id, email, purpose, token_hash, expires_at)
      VALUES ($1, 'holder-a', 'holder-a@example.test', 'RECOVER', $2, now() - interval '1 minute')`,
    [`rp-${crypto.randomUUID()}`, sha256(expiredToken)]
  );
  const denials = [];
  for (const [token, password] of [
    [freshToken(), 'new-password-1'],
    [expiredToken, 'new-password-1'],
    ['short', 'new-password-1'],
    [live, 'short'],
  ]) {
    const res = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
      method: 'POST', body: { token, password },
    });
    assert.equal(res.status, 401);
    denials.push(res.json);
  }
  for (const denial of denials) {
    assert.deepEqual(denial, denials[0], 'no variation leaks the failure kind');
  }
  assert.match(denials[0].error, /복구 링크를 확인하세요/);
});

test('recovery resets the password, revokes every session, and clears the way to login', async () => {
  const first = await sessionCookie(harness, 'holder-c');
  // holder-c is still unverified: verify it first through the holder flow.
  await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie: first, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  const vtoken = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie: first, method: 'POST', body: { token: vtoken },
  });
  // Fail the login throttle first: recovery must still let the holder back in.
  for (let i = 0; i < 3; i += 1) {
    await login('holder-c@example.test', 'wrong-password-9');
  }
  const second = await sessionCookie(harness, 'holder-c');
  clearMockOutbox();
  await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-c@example.test' },
  });
  assert.equal(mockOutbox.length, 1, 'verified address receives exactly one recovery mail');
  assert.match(mockOutbox[0].link, /^http:\/\/127\.0\.0\.1:19999\/recover#t=[A-Za-z0-9_-]{32,}$/);
  const token = tokenOf(mockOutbox[0].link);
  const confirmed = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token, password: 'holder-c-new-password' },
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.json, { ok: true });
  for (const stale of [first, second]) {
    const me = await requestJson(harness.baseUrl, '/api/auth/me', { cookie: stale });
    assert.equal(me.status, 401, 'every previous session is dead');
  }
  const replay = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token, password: 'holder-c-new-password' },
  });
  assert.equal(replay.status, 401, 'response-loss retry stays a generic denial');
  assert.deepEqual(replay.json, { error: '복구 링크를 확인하세요' });
  const back = await login('holder-c@example.test', 'holder-c-new-password');
  assert.equal(back.status, 200, 'the holder logs back in despite earlier failures');
});

test('concurrent confirms serialize: exactly one reset wins', async () => {
  clearMockOutbox();
  await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-b@example.test' },
  });
  const token = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  assert.ok(token);
  const [left, right] = await Promise.all([
    requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
      method: 'POST', body: { token, password: 'race-winner-password' },
    }),
    requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
      method: 'POST', body: { token, password: 'race-loser-password' },
    }),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.deepEqual(statuses, [200, 401], 'one reset applies, the other is a generic denial');
  const loginRes = await login('holder-b@example.test', 'race-winner-password');
  const loserLogin = await login('holder-b@example.test', 'race-loser-password');
  const winnerOk = loginRes.status === 200 || loserLogin.status === 200;
  assert.ok(winnerOk, 'the winning password logs in');
  assert.ok(loginRes.status !== 200 || loserLogin.status !== 200, 'both passwords never work at once');
});

test('shared accounts self-recover without any org owner; owner resets stay fail-closed', async () => {
  const cookie = await sessionCookie(harness, 'shared-s');
  await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  const vtoken = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token: vtoken },
  });
  clearMockOutbox();
  const asked = await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'shared-s@example.test' },
  });
  assertGenericRecovery(asked);
  assert.equal(mockOutbox.length, 1, 'multi-org membership does not block self-recovery');
  const token = tokenOf(mockOutbox[0].link);
  const confirmed = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token, password: 'shared-s-new-password' },
  });
  assert.equal(confirmed.status, 200);
  // The other org's owner still cannot touch the shared login.
  const ownerB = await sessionCookie(harness, 'owner-b');
  const ownerReset = await requestJson(harness.baseUrl, '/api/auth/accounts/shared-s/password', {
    cookie: ownerB, method: 'POST', body: { commandId: `cmd-${crypto.randomUUID().replace(/-/g, '')}`, password: 'owner-forced-password' },
  });
  assert.equal(ownerReset.status, 403);
  assert.equal(ownerReset.json.code, 'SHARED_ACCOUNT_GLOBAL_EFFECT');
  const back = await login('shared-s@example.test', 'shared-s-new-password');
  assert.equal(back.status, 200, 'self-recovery (not the owner reset) owns the new password');
});

test('accounts without memberships may recover the global login but gain no org', async () => {
  await harness.database.query(
    `UPDATE accounts SET email_verified_email = 'nomem-f@example.test', email_verified_at = now()
      WHERE id = 'nomem-f'`
  );
  clearMockOutbox();
  const asked = await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'nomem-f@example.test' },
  });
  assertGenericRecovery(asked);
  assert.equal(mockOutbox.length, 1);
  const token = tokenOf(mockOutbox[0].link);
  const confirmed = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token, password: 'nomem-f-new-password' },
  });
  assert.equal(confirmed.status, 200);
  const back = await login('nomem-f@example.test', 'nomem-f-new-password');
  assert.equal(back.status, 403, 'login succeeds as identity but org access stays denied');
  assert.equal(back.json.code, 'NO_ORGANIZATION_MEMBERSHIP');
});

test('per-account proof caps fail silent instead of oracling', async () => {
  // Five live RECOVER proofs exhaust the hourly cap for holder-a (earlier
  // VERIFY/RECOVER proofs already count toward it).
  for (let i = 0; i < HOURLY_CAP; i += 1) {
    await harness.database.query(
      `INSERT INTO account_email_proofs (id, account_id, email, purpose, token_hash, expires_at)
        VALUES ($1, 'holder-a', 'holder-a@example.test', 'RECOVER', $2, now() + interval '30 minutes')`,
      [`rp-cap-${i}-${crypto.randomUUID()}`, sha256(freshToken())]
    );
  }
  clearMockOutbox();
  const asked = await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-a@example.test' },
  });
  assertGenericRecovery(asked);
  assert.equal(mockOutbox.length, 0, 'capped accounts receive no mail');
});

test('an address that changed after issuance leaves old-mailbox links powerless', async () => {
  const cookie = await sessionCookie(harness, 'holder-d');
  await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  const vtoken = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  const verified = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token: vtoken },
  });
  assert.equal(verified.status, 200);
  clearMockOutbox();
  await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-d@example.test' },
  });
  assert.equal(mockOutbox.length, 1, 'verified address receives the link');
  const token = tokenOf(mockOutbox[0].link);
  // The address changes after the link is mailed (drift the stored address
  // while the proven address stays behind).
  await harness.database.query(
    "UPDATE accounts SET email = 'holder-d-moved@example.test' WHERE id = 'holder-d'"
  );
  const stale = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token, password: 'holder-d-taken-over' },
  });
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.json, { error: '복구 링크를 확인하세요' });
  const kept = await login('holder-d-moved@example.test', 'not-a-real-test-password');
  assert.equal(kept.status, 200, 'the old-mailbox bearer changed nothing');
  const hijack = await login('holder-d-moved@example.test', 'holder-d-taken-over');
  assert.equal(hijack.status, 401, 'the attacker password never landed');
  await harness.database.query(
    "UPDATE accounts SET email = 'holder-d@example.test', email_verified_email = NULL, email_verified_at = NULL WHERE id = 'holder-d'"
  );
});

test('a successful reset consumes every sibling proof of the account', async () => {
  // Previous cases leave live holder-d proofs behind (cooldown counts them).
  await harness.database.query("DELETE FROM account_email_proofs WHERE account_id = 'holder-d'");
  const cookie = await sessionCookie(harness, 'holder-d');
  await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  const vtoken = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token: vtoken },
  });
  clearMockOutbox();
  await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-d@example.test' },
  });
  const first = tokenOf(mockOutbox[0].link);
  // A sibling bearer planted while the mailed one is still live.
  const sibling = freshToken();
  await harness.database.query(
    `INSERT INTO account_email_proofs (id, account_id, email, purpose, token_hash, expires_at)
      VALUES ($1, 'holder-d', 'holder-d@example.test', 'RECOVER', $2, now() + interval '30 minutes')`,
    [`rp-sibling-${crypto.randomUUID()}`, sha256(sibling)]
  );
  const won = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token: first, password: 'holder-d-reset-password' },
  });
  assert.equal(won.status, 200);
  const late = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token: sibling, password: 'holder-d-sibling-password' },
  });
  assert.equal(late.status, 401);
  assert.deepEqual(late.json, { error: '복구 링크를 확인하세요' });
  const back = await login('holder-d@example.test', 'holder-d-reset-password');
  assert.equal(back.status, 200, 'only the winning reset landed');
  const rows = await harness.database.query(
    "SELECT count(*)::int AS n FROM account_email_proofs WHERE account_id = 'holder-d' AND consumed_at IS NULL"
  );
  assert.equal(rows.rows[0].n, 0, 'no live proof survives the reset');
});

test('an owner reset retires mailed recovery links', async () => {
  const cookie = await sessionCookie(harness, 'holder-g');
  await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  const vtoken = tokenOf(mockOutbox[mockOutbox.length - 1].link);
  await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie, method: 'POST', body: { token: vtoken },
  });
  clearMockOutbox();
  await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-g@example.test' },
  });
  assert.equal(mockOutbox.length, 1);
  const mailed = tokenOf(mockOutbox[0].link);
  // The organization owner resets the single-org member's password first.
  const owner = await sessionCookie(harness, 'holder-a');
  const reset = await requestJson(harness.baseUrl, '/api/auth/accounts/holder-g/password', {
    cookie: owner, method: 'POST',
    body: { commandId: `cmd-${crypto.randomUUID().replace(/-/g, '')}`, password: 'holder-g-owner-password' },
  });
  assert.equal(reset.status, 200);
  const late = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token: mailed, password: 'holder-g-stale-password' },
  });
  assert.equal(late.status, 401);
  assert.deepEqual(late.json, { error: '복구 링크를 확인하세요' });
  const back = await login('holder-g@example.test', 'holder-g-owner-password');
  assert.equal(back.status, 200, 'the owner reset (not the stale link) owns the password');
  // A VERIFY link mailed before a reset dies with it: the mailbox proof
  // cannot outlive the credential change it predates. holder-h is fresh and
  // unverified, so the request below actually mails (no already-shortcut).
  const hCookie = await sessionCookie(harness, 'holder-h');
  clearMockOutbox();
  await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie: hCookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  assert.equal(mockOutbox.length, 1);
  const vtoken2 = tokenOf(mockOutbox[0].link);
  const owner2 = await sessionCookie(harness, 'holder-a');
  const reset2 = await requestJson(harness.baseUrl, '/api/auth/accounts/holder-h/password', {
    cookie: owner2, method: 'POST',
    body: { commandId: `cmd-${crypto.randomUUID().replace(/-/g, '')}`, password: 'holder-h-owner-password' },
  });
  assert.equal(reset2.status, 200);
  // Fresh session on the new credential, stale mailed proof: the confirm
  // reaches the transaction and dies on the retired proof (409), proving
  // the reset retired it rather than the session check short-circuiting.
  const fresh = await login('holder-h@example.test', 'holder-h-owner-password');
  assert.equal(fresh.status, 200);
  const freshCookie = fresh.headers.getSetCookie()[0].split(';')[0];
  const dead = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', {
    cookie: freshCookie, method: 'POST', body: { token: vtoken2 },
  });
  assert.equal(dead.status, 409, 'a reset retires proofs mailed before it');
  // Fresh authority still works: re-request with the current password mails
  // again on the new credential.
  clearMockOutbox();
  const rerequest = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie: freshCookie, method: 'POST', body: { currentPassword: 'holder-h-owner-password' },
  });
  assert.equal(rerequest.status, 200);
  assert.equal(mockOutbox.length, 1, 'current authority mints fresh proofs');
});

test('wrong current passwords are throttled, not unlimited', async () => {
  const cookie = await sessionCookie(harness, 'holder-t');
  for (let i = 0; i < 10; i += 1) {
    const wrong = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
      cookie, method: 'POST', body: { currentPassword: `wrong-password-${i}` },
    });
    assert.equal(wrong.status, 401, `attempt ${i} stays a password denial`);
  }
  const throttled = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'wrong-password-10' },
  });
  assert.equal(throttled.status, 429, 'the 11th guess in the hour is bounded');
  const rightButLate = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
  });
  assert.equal(rightButLate.status, 429, 'the throttle binds the bucket, not the guess');
});

test('anonymous confirm abuse is throttled by caller before hashing', async () => {
  for (let i = 0; i < 30; i += 1) {
    const denied = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
      method: 'POST', body: { token: freshToken(), password: 'some-long-password-1' },
    });
    assert.equal(denied.status, 401, `guess ${i} stays generic`);
    assert.deepEqual(denied.json, { error: '복구 링크를 확인하세요' });
  }
  const throttled = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token: freshToken(), password: 'some-long-password-1' },
  });
  assert.equal(throttled.status, 429, 'the 31st guess from the caller is bounded');
});

test('eligible and ineligible recovery answers share one timing floor', async () => {
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-u', role: 'MANAGER', name: '홀더U', email: 'holder-u@example.test',
  });
  await harness.database.query(
    "UPDATE accounts SET email_verified_email = 'holder-u@example.test', email_verified_at = now() WHERE id = 'holder-u'"
  );
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-v', role: 'MANAGER', name: '홀더V', email: 'holder-v@example.test',
  });
  const take = async (email) => {
    const start = Date.now();
    const res = await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
      method: 'POST', body: { email },
    });
    assertGenericRecovery(res);
    return Date.now() - start;
  };
  const eligible = [];
  const ineligible = [];
  for (let i = 0; i < 5; i += 1) {
    eligible.push(await take('holder-u@example.test'));
    ineligible.push(await take('holder-v@example.test'));
  }
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const lo = median(eligible);
  const hi = median(ineligible);
  assert.ok(Math.max(lo, hi) <= Math.max(1, Math.min(lo, hi)) * 5,
    `eligible median ${lo}ms vs ineligible median ${hi}ms must share one floor`);
});

test('login and recovery prunes never erase each other\'s live rows', async () => {
  // A recovery row live under its 60m window survives login activity whose
  // own prune window is 15m.
  await harness.database.query(
    `INSERT INTO login_attempts (scope, key, failures, first_failure_at, last_failure_at)
      VALUES ('recovery-email', 'prune-probe@example.test', 1, now() - interval '16 minutes', now() - interval '16 minutes')`
  );
  await login('holder-a@example.test', 'wrong-password-1');
  const kept = await harness.database.query(
    "SELECT 1 FROM login_attempts WHERE scope = 'recovery-email' AND key = 'prune-probe@example.test'"
  );
  assert.equal(kept.rowCount, 1, 'login prune keeps live recovery rows');
  // A login row live under a 1440m window survives recovery activity whose
  // own prune window is 60m.
  const savedWindow = process.env.EVENTOUCH_LOGIN_WINDOW_MINUTES;
  const savedBlock = process.env.EVENTOUCH_LOGIN_BLOCK_MINUTES;
  process.env.EVENTOUCH_LOGIN_WINDOW_MINUTES = '1440';
  process.env.EVENTOUCH_LOGIN_BLOCK_MINUTES = '1440';
  const wide = await startApiHarness({ env: MOCK_ENV });
  try {
    await insertAccount(wide.database, {
      orgId: LEGACY_ORG, id: 'wide-a', role: 'AGENCY', name: '와이드', email: 'wide-a@example.test',
    });
    await requestJson(wide.baseUrl, '/api/auth/login', {
      method: 'POST', body: { email: 'wide-a@example.test', password: 'wrong-password-1' },
    });
    await wide.database.query(
      `UPDATE login_attempts SET last_failure_at = now() - interval '61 minutes'
        WHERE scope = 'account' AND key = 'wide-a@example.test'`
    );
    await requestJson(wide.baseUrl, '/api/auth/recovery/request', {
      method: 'POST', body: { email: 'nobody-here@example.test' },
    });
    const survived = await wide.database.query(
      "SELECT 1 FROM login_attempts WHERE scope = 'account' AND key = 'wide-a@example.test'"
    );
    assert.equal(survived.rowCount, 1, 'recovery prune keeps live login rows');
  } finally {
    if (savedWindow === undefined) delete process.env.EVENTOUCH_LOGIN_WINDOW_MINUTES;
    else process.env.EVENTOUCH_LOGIN_WINDOW_MINUTES = savedWindow;
    if (savedBlock === undefined) delete process.env.EVENTOUCH_LOGIN_BLOCK_MINUTES;
    else process.env.EVENTOUCH_LOGIN_BLOCK_MINUTES = savedBlock;
    await wide.close();
  }
});

test('delivery without a public base is honestly down even with mock mail', async () => {
  const bare = await startApiHarness({ env: { EVENTOUCH_MAIL_MOCK: '1', EVENTOUCH_PUBLIC_URL: '' } });
  try {
    await insertAccount(bare.database, {
      orgId: LEGACY_ORG, id: 'bare-a', role: 'AGENCY', name: '베어', email: 'bare-a@example.test',
    });
    const cookie = await sessionCookie(bare, 'bare-a');
    const requested = await requestJson(bare.baseUrl, '/api/auth/email/verify/request', {
      cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
    });
    assert.equal(requested.status, 503);
    assert.equal(requested.json.code, 'EMAIL_NOT_CONFIGURED');
    const state = await requestJson(bare.baseUrl, '/api/auth/email/status', { cookie });
    assert.equal(state.status, 200);
    assert.equal(state.json.delivery.connected, false, 'no base means no send');
    clearMockOutbox();
    const stranger = await requestJson(bare.baseUrl, '/api/auth/recovery/request', {
      method: 'POST', body: { email: 'bare-a@example.test' },
    });
    assertGenericRecovery(stranger, false);
    assert.equal(mockOutbox.length, 0, 'nothing sends without a link base');
  } finally {
    await bare.close();
  }
});

test('expired caller limits start a fresh window on the next request', async () => {
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-decay', role: 'MANAGER', name: '대기 시간', email: 'holder-decay@example.test',
  });
  const cookie = await sessionCookie(harness, 'holder-decay');
  const verify = (password) => requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie, method: 'POST', body: { currentPassword: password },
  });
  await verify('wrong-password-1');
  await harness.database.query(
    `UPDATE login_attempts SET failures = 30,
       first_failure_at = now() - interval '16 minutes',
       last_failure_at = now() - interval '16 minutes'
     WHERE scope = 'verify-address'`
  );
  const afterVerifyWindow = await verify('not-a-real-test-password');
  assert.equal(afterVerifyWindow.status, 200, 'a passed 15-minute caller window must not renew its old block');
  const verifyCounter = await harness.database.query(
    "SELECT failures FROM login_attempts WHERE scope = 'verify-address'"
  );
  assert.equal(verifyCounter.rows[0].failures, 1);

  const recovery = () => requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'unknown-decay@example.test' },
  });
  await recovery();
  await harness.database.query(
    `UPDATE login_attempts SET failures = 30,
       first_failure_at = now() - interval '16 minutes',
       last_failure_at = now() - interval '16 minutes'
     WHERE scope = 'recovery-address'`
  );
  const afterRecoveryWindow = await recovery();
  assertGenericRecovery(afterRecoveryWindow);
  const recoveryCounter = await harness.database.query(
    "SELECT failures FROM login_attempts WHERE scope = 'recovery-address'"
  );
  assert.equal(recoveryCounter.rows[0].failures, 1);
});

test('missing throttle scopes fail closed without sending mail or resetting passwords', async () => {
  const stale = await startApiHarness({ env: MOCK_ENV });
  try {
    await insertAccount(stale.database, {
      orgId: LEGACY_ORG, id: 'stale-scope', role: 'MANAGER', name: '검증', email: 'stale-scope@example.test',
    });
    const cookie = await sessionCookie(stale, 'stale-scope');
    await stale.database.query('ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_scope_check');
    await stale.database.query(`ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_scope_check
      CHECK (scope IN ('account', 'address', 'recovery-email', 'recovery-address'))`);
    clearMockOutbox();
    const unprotectedVerify = await requestJson(stale.baseUrl, '/api/auth/email/verify/request', {
      cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
    });
    assert.equal(unprotectedVerify.status, 503, '016 without 017 cannot issue unthrottled verification links');
    assert.equal(mockOutbox.length, 0);

    await stale.database.query(`UPDATE accounts SET email_verified_email = lower(email), email_verified_at = now()
      WHERE id = 'stale-scope'`);
    await stale.database.query('ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_scope_check');
    await stale.database.query(`ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_scope_check
      CHECK (scope IN ('account', 'address'))`);
    const asked = await requestJson(stale.baseUrl, '/api/auth/recovery/request', {
      method: 'POST', body: { email: 'stale-scope@example.test' },
    });
    assert.equal(asked.status, 200, 'anonymous failure remains generic');
    assert.equal(asked.json.ok, true);
    assert.equal(mockOutbox.length, 0, 'missing anonymous throttle must not send recovery mail');

    const token = freshToken();
    await stale.database.query(
      `INSERT INTO account_email_proofs (id, account_id, email, purpose, token_hash, expires_at)
        VALUES ($1, 'stale-scope', 'stale-scope@example.test', 'RECOVER', $2, now() + interval '30 minutes')`,
      [`stale-scope-${crypto.randomUUID()}`, sha256(token)]
    );
    const unprotectedConfirm = await requestJson(stale.baseUrl, '/api/auth/recovery/confirm', {
      method: 'POST', body: { token, password: 'must-not-be-accepted' },
    });
    assert.equal(unprotectedConfirm.status, 401, 'a live link cannot bypass unavailable abuse controls');
    const stillOriginal = await requestJson(stale.baseUrl, '/api/auth/login', {
      method: 'POST', body: { email: 'stale-scope@example.test', password: 'not-a-real-test-password' },
    });
    assert.equal(stillOriginal.status, 200);
  } finally {
    await stale.close();
  }
});

test('a thrown mail transport removes the unused proof and keeps the public answer generic', async () => {
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: 'holder-send-error', role: 'MANAGER', name: '발송 오류', email: 'send-error@example.test',
  });
  await harness.database.query(`UPDATE accounts SET email_verified_email = lower(email), email_verified_at = now()
    WHERE id = 'holder-send-error'`);
  const transport = createEmailTransport({ send: async () => { throw new Error('synthetic provider failure'); } });
  const recovery = createAccountRecovery(harness.database, { transport, env: MOCK_ENV });
  const answer = await recovery.requestRecovery({ email: 'send-error@example.test', clientIp: 'fixture-provider-failure' });
  assertGenericRecovery(answer);
  const proofs = await harness.database.query(
    "SELECT COUNT(*)::int AS n FROM account_email_proofs WHERE account_id = 'holder-send-error'"
  );
  assert.equal(proofs.rows[0].n, 0, 'a failed send must not retain a usable bearer');
});

test('concurrent wrong passwords are bounded, not unlimited', async () => {
  const cookie = await sessionCookie(harness, 'holder-t');
  const attempts = await Promise.all(
    Array.from({ length: 25 }, (_, i) => requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
      cookie, method: 'POST', body: { currentPassword: `wrong-password-${i}` },
    }))
  );
  const denied = attempts.filter((r) => r.status === 401);
  const throttled = attempts.filter((r) => r.status === 429);
  const other = attempts.filter((r) => r.status !== 401 && r.status !== 429);
  assert.equal(other.length, 0, `only 401/429, got ${JSON.stringify(other.map((r) => r.status))}`);
  assert.ok(denied.length > 0, 'early guesses stay password denials');
  assert.ok(throttled.length > 0, `the email bucket bounds 25 concurrent guesses (429s: ${throttled.length})`);
  for (const res of denied) {
    assert.equal(res.json.error, '현재 비밀번호를 확인하세요');
  }
});

test('concurrent anonymous confirms are bounded before hashing', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 35 }, () => requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
      method: 'POST', body: { token: freshToken(), password: 'some-long-password-1' },
    }))
  );
  const denied = attempts.filter((r) => r.status === 401);
  const throttled = attempts.filter((r) => r.status === 429);
  const other = attempts.filter((r) => r.status !== 401 && r.status !== 429);
  assert.equal(other.length, 0, `only 401/429, got ${JSON.stringify(other.map((r) => r.status))}`);
  assert.ok(denied.length > 0, 'early guesses stay generic denials');
  assert.ok(throttled.length > 0, `the caller bucket bounds 35 concurrent guesses (429s: ${throttled.length})`);
  for (const res of denied) {
    assert.deepEqual(res.json, { error: '복구 링크를 확인하세요' });
  }
});

test('misconfigured delivery is honest to holders and generic to strangers', async () => {
  const off = await startApiHarness({ env: OFF_ENV });
  try {
    await insertAccount(off.database, {
      orgId: LEGACY_ORG, id: 'off-a', role: 'AGENCY', name: '오프', email: 'off-a@example.test',
    });
    const cookie = await sessionCookie(off, 'off-a');
    const requested = await requestJson(off.baseUrl, '/api/auth/email/verify/request', {
      cookie, method: 'POST', body: { currentPassword: 'not-a-real-test-password' },
    });
    assert.equal(requested.status, 503);
    assert.equal(requested.json.code, 'EMAIL_NOT_CONFIGURED');
    const state = await requestJson(off.baseUrl, '/api/auth/email/status', { cookie });
    assert.equal(state.status, 200, 'status itself stays readable and reports the honest delivery state');
    assert.equal(state.json.verified, false);
    assert.equal(state.json.delivery.mode, 'none');
    assert.equal(state.json.delivery.connected, false);
    const stranger = await requestJson(off.baseUrl, '/api/auth/recovery/request', {
      method: 'POST', body: { email: 'off-a@example.test' },
    });
    assertGenericRecovery(stranger, false);
    const confirm = await requestJson(off.baseUrl, '/api/auth/recovery/confirm', {
      method: 'POST', body: { token: freshToken(), password: 'off-a-new-password' },
    });
    assert.equal(confirm.status, 401);
    assert.deepEqual(confirm.json, { error: '복구 링크를 확인하세요' });
  } finally {
    await off.close();
  }
});

test('old schema without recovery tables degrades instead of 500ing', async () => {
  // Full 001-015 shape: no proofs table and no verified columns.
  await harness.database.query('DROP TABLE account_email_proofs');
  await harness.database.query(
    'ALTER TABLE accounts DROP COLUMN IF EXISTS email_verified_email, DROP COLUMN IF EXISTS email_verified_at'
  );
  // invited-new stays unverified with a known password, so the holder path
  // reaches the proof table and must degrade to the honest 503.
  const relogin = await login('invited-new@example.test', 'invited-password-1');
  assert.equal(relogin.status, 200);
  const invitedCookie = relogin.headers.getSetCookie()[0].split(';')[0];
  const requested = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', {
    cookie: invitedCookie, method: 'POST', body: { currentPassword: 'invited-password-1' },
  });
  assert.equal(requested.status, 503);
  assert.equal(requested.json.code, 'EMAIL_NOT_CONFIGURED');
  const stranger = await requestJson(harness.baseUrl, '/api/auth/recovery/request', {
    method: 'POST', body: { email: 'holder-a@example.test' },
  });
  assertGenericRecovery(stranger, false);
  // The status read needs the verified columns, so it degrades honestly too.
  const holderCookie = await sessionCookie(harness, 'holder-a');
  const state = await requestJson(harness.baseUrl, '/api/auth/email/status', { cookie: holderCookie });
  assert.equal(state.status, 503);
  assert.equal(state.json.code, 'EMAIL_NOT_CONFIGURED');
  const confirm = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', {
    method: 'POST', body: { token: freshToken(), password: 'some-new-password' },
  });
  assert.equal(confirm.status, 401);
  assert.deepEqual(confirm.json, { error: '복구 링크를 확인하세요' });
  // The owner reset runs end-to-end on the old schema: the proofs
  // invalidation is skipped via to_regclass instead of aborting the
  // transaction (25P02), so the password changes and sessions die.
  const stale = await sessionCookie(harness, 'holder-c');
  const ownerReset = await requestJson(harness.baseUrl, '/api/auth/accounts/holder-c/password', {
    cookie: holderCookie, method: 'POST',
    body: { commandId: `cmd-${crypto.randomUUID().replace(/-/g, '')}`, password: 'holder-c-oldschema-password' },
  });
  assert.equal(ownerReset.status, 200);
  const gone = await requestJson(harness.baseUrl, '/api/auth/me', { cookie: stale });
  assert.equal(gone.status, 401, 'old-schema resets still revoke sessions');
  const back = await login('holder-c@example.test', 'holder-c-oldschema-password');
  assert.equal(back.status, 200, 'old-schema resets still change the password');
});
