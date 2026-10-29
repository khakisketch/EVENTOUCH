'use strict';

// Shared-SaaS organization isolation matrix (server authority).
//
// A/B orgs plus one account that is AGENCY in A (legacy) and STAFF in B.
// Every cross-boundary direction is exercised over real HTTP against an
// isolated Postgres + API harness: reads, writes, team, invites, password
// reset, public API, files, ZIP exports, receipts, and the outbox worker.
// Stale contexts, missing contexts and in-flight pins are all fail-closed
// with 409 + ORGANIZATION_CONTEXT_CHANGED — never rewritten into another
// org. Accepting an invite never auto-switches the session org.

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

const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const ids = {
  ownerA: `ten-owner-a-${suffix}`,
  dual: `ten-dual-${suffix}`,
  eventA: null,
  eventB: null,
};
const TEST_PASSWORD = 'not-a-real-test-password';
const H = (orgId, version) => {
  const headers = { 'x-eventouch-organization-id': orgId };
  if (version !== undefined) headers['x-eventouch-context-version'] = String(version);
  return headers;
};
// Current session revision, then headers pinned to it. Multi-membership
// writes always carry both org and version; nothing is ever omitted.
async function revOf(cookie) {
  const me = await api('/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  return me.json.user.contextVersion;
}
async function hdrs(cookie, orgId) {
  return H(orgId, await revOf(cookie));
}
async function pinLegacy(cookie) {
  const me = await api('/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  if (me.json.user.organizationId === LEGACY_ORG) return me.json.user.contextVersion;
  const sel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: me.json.user.contextVersion, commandId: commandId('pin-home') },
  });
  assert.equal(sel.status, 200);
  return sel.json.contextVersion;
}

let harness;
let orgB;
const cookies = {};

const api = (url, options) => requestJson(harness.baseUrl, url, options);
const commandId = (tag) => `ten-${tag}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: ids.ownerA, role: 'AGENCY',
    name: '조직 A 소유자', email: `${ids.ownerA}@example.test`,
  });
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: ids.dual, role: 'AGENCY',
    name: '이중 소속', email: `${ids.dual}@example.test`,
  });
  // Sessions pinned while single-membership stay on legacy after joining B
  // (accept never auto-switches the session).
  cookies.ownerA = await sessionCookie(harness, ids.ownerA);
  cookies.dual = await sessionCookie(harness, ids.dual);

  const created = await api('/api/auth/organizations', {
    method: 'POST', cookie: cookies.ownerA,
    body: { name: '신규 조직 B', commandId: commandId('org-create') },
  });
  assert.equal(created.status, 201);
  orgB = created.json.organization.id;
  assert.ok(orgB && orgB !== LEGACY_ORG, 'org B is distinct');

  // Owner selects B for B-scoped setup, then returns to legacy.
  const selB0 = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: 0, commandId: commandId('setup-sel-b') },
  });
  assert.equal(selB0.status, 200);
  const eventB = await api('/api/events', {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, selB0.json.contextVersion),
    body: {
      commandId: commandId('event-b'), name: 'B 행사', slug: `ten-b-${suffix}`,
      date: '2026-12-01', start: '10:00', end: '17:00', capacity: 50,
    },
  });
  assert.equal(eventB.status, 201);
  ids.eventB = eventB.json.event.id;

  const invite = await api('/api/auth/invitations', {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, selB0.json.contextVersion),
    body: { commandId: commandId('invite-dual'), name: '이중 소속', email: `${ids.dual}@example.test`, role: 'STAFF' },
  });

  const selA0 = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: selB0.json.contextVersion, commandId: commandId('setup-sel-a') },
  });
  assert.equal(selA0.status, 200);
  const eventA = await api('/api/events', {
    method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, selA0.json.contextVersion),
    body: {
      commandId: commandId('event-a'), name: 'A 행사', slug: `ten-a-${suffix}`,
      date: '2026-12-01', start: '10:00', end: '17:00', capacity: 50,
    },
  });
  assert.equal(eventA.status, 201);
  ids.eventA = eventA.json.event.id;
  assert.equal(invite.status, 201);
  const lookup = await api(`/api/auth/invitations/${invite.json.token}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.json.invitation.requiresSignIn, true);
  const accept = await api(`/api/auth/invitations/${invite.json.token}/accept`, {
    method: 'POST', cookie: cookies.dual, body: {},
  });
  assert.equal(accept.status, 201);
  assert.equal(accept.json.account.organizationId, orgB);
});


test('files, archives and PII stay inside the owning org', async (t) => {
  if (!databaseUrl) return t.skip();
  const revA = await pinLegacy(cookies.ownerA);
  // Minimal 1x1 PNG (a bare signature fails image inspection with 400).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const up = await fetch(`${harness.baseUrl}/api/events/${ids.eventA}/files?commandId=${commandId('file-a')}&name=a.png`, {
    method: 'POST', headers: { cookie: cookies.ownerA, ...H(LEGACY_ORG, revA), 'content-type': 'image/png' }, body: png,
  });
  assert.equal(up.status, 201);
  const fileId = (await up.json()).file.fileId;
  // Same cookie, other org context: the file is invisible.
  const cross = await fetch(`${harness.baseUrl}/api/events/${ids.eventA}/files/${fileId}`, {
    headers: { cookie: cookies.ownerA, ...H(orgB) },
  });
  assert.equal(cross.status, 409);
  assert.equal((await cross.json()).code, 'ORGANIZATION_CONTEXT_CHANGED');
  const zip = await fetch(`${harness.baseUrl}/api/events/${ids.eventA}/attendee-photos.zip`, {
    headers: { cookie: cookies.ownerA, ...H(orgB) },
  });
  assert.equal(zip.status, 409);
  // Public slug stays global: the B event renders anonymously once its
  // stage is public, with no operator session at all.
  const selPub = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: revA, commandId: commandId('sel-pub') },
  });
  assert.equal(selPub.status, 200);
  const ready = await api(`/api/events/${ids.eventB}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, selPub.json.contextVersion),
    body: { commandId: commandId('stage-b'), command: 'event.stage', payload: { stage: 'READY' } },
  });
  assert.ok([200, 201].includes(ready.status));
  const pub = await fetch(`${harness.baseUrl}/api/public/events/ten-b-${suffix}`);
  assert.equal(pub.status, 200);
  assert.equal((await pub.json()).event.id, ids.eventB);
});

test('deactivation is per-org and never touches other memberships', async (t) => {
  if (!databaseUrl) return t.skip();
  await pinLegacy(cookies.ownerA);
  const off = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB),
    body: { commandId: commandId('deact'), active: false },
  });
  assert.equal(off.status, 200);
  assert.equal(off.json.membership.active, false);
  const dualMe = await api('/api/auth/me', { cookie: cookies.dual });
  const reselect = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: dualMe.json.user.contextVersion, commandId: commandId('select-off') },
  });
  assert.equal(reselect.status, 409);
  assert.equal(reselect.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  // The home org is unaffected: legacy reads still work.
  const boot = await api('/api/bootstrap', { cookie: cookies.dual });
  assert.equal(boot.status, 200);
  const on = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB),
    body: { commandId: commandId('react'), active: true },
  });
  assert.equal(on.status, 200);
  assert.equal(on.json.membership.active, true);
});

test('the outbox worker never dispatches a new org through legacy credentials', async (t) => {
  if (!databaseUrl) return t.skip();
  const { drainMessageOutbox } = require('../server/message-outbox');
  const past = new Date(Date.now() - 60000).toISOString();
  for (const [eventId, mid] of [[ids.eventA, `ten-msg-a-${suffix}`], [ids.eventB, `ten-msg-b-${suffix}`]]) {
    const ws = await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]);
    const payload = typeof ws.rows[0].payload === 'string' ? JSON.parse(ws.rows[0].payload) : ws.rows[0].payload;
    payload.participants = [{ id: 'ten-p1', name: '수신자', phone: '010-1111-2222', status: 'APPROVED' }];
    payload.messages = [{
      id: mid, title: '안내', body: '본문', channel: 'SMS', status: 'SENDING', attempts: 1,
      recipientIds: ['ten-p1'],
      recipientSnapshot: [{ id: 'ten-p1', name: '수신자', phone: '010-1111-2222' }],
      deliveries: [{ participantId: 'ten-p1', name: '수신자', status: 'SENDING', at: past }],
    }];
    await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [eventId, JSON.stringify(payload)]);
    await harness.database.query(
      "INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at) VALUES ($1, $2, 'PENDING', 0, now() - interval '1 minute')",
      [mid, eventId]
    );
  }
  const sent = [];
  const mockProvider = {
    state: { connected: true },
    send: async ({ to, text }) => { sent.push({ to, text }); return { delivered: true, providerId: 'ten-mock-1' }; },
  };
  const result = await drainMessageOutbox(harness.database, mockProvider);
  assert.equal(result.dispatched, 1);
  assert.equal(result.deferred, 1);
  assert.equal(sent.length, 1);
  const remaining = await harness.database.query('SELECT message_id FROM message_outbox');
  assert.deepEqual(remaining.rows.map((r) => r.message_id), [`ten-msg-b-${suffix}`]);
});

test('concurrent requests on one session keep their own org pins', async (t) => {
  if (!databaseUrl) return t.skip();
  // Pin B; every write carries full headers pinned to the session.
  const meB = await api('/api/auth/me', { cookie: cookies.ownerA });
  const pinB = meB.json.user.organizationId === orgB
    ? meB.json.user.contextVersion
    : (await api('/api/auth/organizations/select', {
      method: 'POST', cookie: cookies.ownerA,
      body: { organizationId: orgB, expectedContextVersion: meB.json.user.contextVersion, commandId: commandId('conc-pin') },
    })).json.contextVersion;
  const [a, b, cross] = await Promise.all([
    api(`/api/events/${ids.eventA}/commands`, {
      method: 'POST', cookie: cookies.ownerA, headers: H(orgB, pinB),
      body: { commandId: commandId('conc-a'), command: 'notice.save', payload: { title: '동시 A', body: '본문' } },
    }),
    api(`/api/events/${ids.eventB}/commands`, {
      method: 'POST', cookie: cookies.ownerA, headers: H(orgB, pinB),
      body: { commandId: commandId('conc-b'), command: 'notice.save', payload: { title: '동시 B', body: '본문' } },
    }),
    api(`/api/events/${ids.eventB}/commands`, {
      method: 'POST', cookie: cookies.ownerA,
      body: { commandId: commandId('conc-x'), command: 'notice.save', payload: { title: '동시 X', body: '본문' } },
    }),
  ]);
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  assert.ok([200, 201].includes(b.status));
  assert.equal(cross.status, 409);
  assert.equal(cross.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  await pinLegacy(cookies.ownerA);
});

test('sessions survive an HTTP restart with their org pin', async (t) => {
  if (!databaseUrl) return t.skip();
  await harness.restartHttp();
  const me = await api('/api/auth/me', { cookie: cookies.ownerA });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.organizationId, LEGACY_ORG);
  const revR = await pinLegacy(cookies.ownerA);
  const res = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, revR),
    body: { commandId: commandId('after-restart'), command: 'notice.save', payload: { title: '재시작 후', body: '본문' } },
  });
  assert.ok([200, 201].includes(res.status));
});

test('legacy mapping preserves every existing id, payload and byte', async (t) => {
  if (!databaseUrl) return t.skip();
  const row = await harness.database.query('SELECT id, slug, org_id, payload FROM events WHERE id = $1', [ids.eventA]);
  assert.equal(row.rows[0].org_id, LEGACY_ORG);
  assert.equal(row.rows[0].payload.name, 'A 행사');
  const receipts = await harness.database.query(
    'SELECT count(*)::int AS n FROM command_receipts WHERE org_id = $1', [LEGACY_ORG]
  );
  assert.ok(receipts.rows[0].n > 0, 'receipts carry the legacy org');
});

after(async () => {
  if (harness) await harness.close();
});

test('organization list shows both orgs with per-org roles and keeps the session org', async (t) => {
  if (!databaseUrl) return t.skip();
  const res = await api('/api/auth/organizations', { cookie: cookies.dual });
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.json.organizations.map((o) => [o.id, o.role]));
  assert.equal(byId[LEGACY_ORG], 'AGENCY');
  assert.equal(byId[orgB], 'STAFF');
  // The pre-join session stays pinned to legacy: no auto-switch on accept.
  assert.equal(res.json.activeOrganizationId, LEGACY_ORG);
});

test('multi-membership writes without context fail closed', async (t) => {
  if (!databaseUrl) return t.skip();
  // Fresh session with no selection at all.
  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: `${ids.dual}@example.test`, password: TEST_PASSWORD },
  });
  assert.equal(login.status, 200);
  const raw = login.headers.get('set-cookie') || '';
  const fresh = `etko_session=${/etko_session=([^;]+)/.exec(raw)[1]}`;
  const me = await api('/api/auth/me', { cookie: fresh });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.organizationId, null);
  const res = await api('/api/events', {
    method: 'POST', cookie: fresh,
    body: { commandId: commandId('noctx'), name: 'x', slug: `ten-x-${suffix}`, date: '2026-12-01', start: '10:00', end: '11:00', capacity: 5 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
});

test('cross-org event writes are denied, never rewritten', async (t) => {
  if (!databaseUrl) return t.skip();
  const revC = await pinLegacy(cookies.ownerA);
  // Override attempt: headers naming B while pinned to legacy.
  const a = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, revC),
    body: { commandId: commandId('cross-a'), command: 'notice.save', payload: { title: 'x', body: 'y' } },
  });
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  // Missing context on a multi-membership session.
  const b = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('cross-b'), command: 'notice.save', payload: { title: 'x', body: 'y' } },
  });
  assert.equal(b.status, 409);
  assert.equal(b.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  // True mismatch: pinned to B, headers pinned to B, event in A.
  const selB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: revC, commandId: commandId('cross-sel') },
  });
  assert.equal(selB.status, 200);
  const c = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, selB.json.contextVersion),
    body: { commandId: commandId('cross-c'), command: 'notice.save', payload: { title: 'x', body: 'y' } },
  });
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  await pinLegacy(cookies.ownerA);
});

test('confirmed receipts never replay into another org', async (t) => {
  if (!databaseUrl) return t.skip();
  const revR = await pinLegacy(cookies.ownerA);
  const key = commandId('receipt-pin');
  const first = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, revR),
    body: { commandId: key, command: 'notice.save', payload: { title: '영수증', body: '원본' } },
  });
  assert.equal(first.status, 201);
  // Same key under a B pin: the stored legacy receipt is not returned.
  const selR = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: revR, commandId: commandId('receipt-sel') },
  });
  assert.equal(selR.status, 200);
  const replay = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, selR.json.contextVersion),
    body: { commandId: key, command: 'notice.save', payload: { title: '영수증', body: '원본' } },
  });
  assert.equal(replay.status, 409);
  await pinLegacy(cookies.ownerA);
});

test('stale bindings and foreign headers fail closed, reselect recovers', async (t) => {
  if (!databaseUrl) return t.skip();
  // Dual pins B; the tab holds (session rev, member binding).
  const dualMe = await api('/api/auth/me', { cookie: cookies.dual });
  const dualSel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: dualMe.json.user.contextVersion, commandId: commandId('sel-stale-b') },
  });
  assert.equal(dualSel.status, 200);
  const rev = dualSel.json.contextVersion;
  // Owner pins B and changes dual's own membership row: only dual's
  // binding drifts; everyone else keeps working.
  const ownerMe = await api('/api/auth/me', { cookie: cookies.ownerA });
  const ownerB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: ownerMe.json.user.contextVersion, commandId: commandId('sel-stale-owner-b') },
  });
  assert.equal(ownerB.status, 200);
  const perms = await api(`/api/accounts/${ids.dual}/org-permissions`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, ownerB.json.contextVersion),
    body: { commandId: commandId('perm-bump'), orgPermissions: ['team.manage'] },
  });
  assert.ok([200, 201].includes(perms.status));
  // The tab's old binding fails closed; other tabs are unaffected.
  const stale = await api('/api/bootstrap', {
    method: 'GET', cookie: cookies.dual, headers: H(orgB, rev),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  // A header naming the other org never overrides the pin.
  const foreign = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.dual, headers: H(LEGACY_ORG, rev),
    body: { commandId: commandId('foreign'), command: 'notice.save', payload: { title: 'x', body: 'y' } },
  });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  // Missing and partial contexts fail closed on multi-membership sessions.
  const missingCases = [undefined, { 'x-eventouch-organization-id': orgB }];
  for (let i = 0; i < missingCases.length; i += 1) {
    const headers = missingCases[i];
    const missing = await api('/api/events', {
      method: 'POST', cookie: cookies.dual, ...(headers ? { headers } : {}),
      body: { commandId: commandId(`miss-${i}`), name: 'x', slug: `ten-m-${suffix}-${i}`, date: '2026-12-01', start: '10:00', end: '11:00', capacity: 5 },
    });
    assert.equal(missing.status, 409);
    assert.equal(missing.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  }
  // Reselect with the fresh session revision rebinds and reads flow again.
  const me1 = await api('/api/auth/me', { cookie: cookies.dual });
  const resel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: me1.json.user.contextVersion, commandId: commandId('sel-again') },
  });
  assert.equal(resel.status, 200);
  const healed = await api('/api/bootstrap', {
    method: 'GET', cookie: cookies.dual, headers: H(orgB, resel.json.contextVersion),
  });
  assert.equal(healed.status, 200);
  // Restore dual to legacy for later tests and drop the extra grant.
  const me2 = await api('/api/auth/me', { cookie: cookies.dual });
  await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: me2.json.user.contextVersion, commandId: commandId('sel-home') },
  });
  await api(`/api/accounts/${ids.dual}/org-permissions`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, ownerB.json.contextVersion),
    body: { commandId: commandId('perm-restore'), orgPermissions: [] },
  });
  await pinLegacy(cookies.ownerA);
});

test('selection pins the session and returns the user in the new context', async (t) => {
  if (!databaseUrl) return t.skip();
  // expectedContextVersion is required: the tab CASes on its session view.
  const missing = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, commandId: commandId('select-noexp') },
  });
  assert.equal(missing.status, 400);
  const me0 = await api('/api/auth/me', { cookie: cookies.dual });
  const sel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: me0.json.user.contextVersion, commandId: commandId('select-b') },
  });
  assert.equal(sel.status, 200);
  assert.equal(sel.json.activeOrganizationId, orgB);
  assert.equal(sel.json.user.organizationId, orgB);
  assert.equal(sel.json.user.role, 'STAFF');
  assert.equal(sel.json.user.effectiveRole, 'STAFF');
  assert.equal(typeof sel.json.contextVersion, 'number');
  // Pinned session writes without headers fail closed even when selected.
  const missingCtx = await api('/api/events', {
    method: 'POST', cookie: cookies.dual,
    body: { commandId: commandId('pinned-miss'), name: 'x', slug: `ten-pm-${suffix}`, date: '2026-12-01', start: '10:00', end: '11:00', capacity: 5 },
  });
  assert.equal(missingCtx.status, 409);
  assert.equal(missingCtx.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  // With full headers the STAFF scope verdict applies.
  const denied = await api('/api/events', {
    method: 'POST', cookie: cookies.dual, headers: H(orgB, sel.json.contextVersion),
    body: { commandId: commandId('pinned'), name: 'x', slug: `ten-p-${suffix}`, date: '2026-12-01', start: '10:00', end: '11:00', capacity: 5 },
  });
  assert.equal(denied.status, 403);
  // Same nonce twice: exact same shape, no new write, no version drift.
  const replayNonce = commandId('select-replay');
  const replayA = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: sel.json.contextVersion, commandId: replayNonce },
  });
  assert.equal(replayA.status, 200);
  assert.equal(replayA.json.replayed, undefined);
  const replayB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: sel.json.contextVersion, commandId: replayNonce },
  });
  assert.equal(replayB.status, 200);
  assert.equal(replayB.json.replayed, true);
  assert.deepEqual(replayB.json.activeOrganizationId, replayA.json.activeOrganizationId);
  assert.deepEqual(replayB.json.contextVersion, replayA.json.contextVersion);
  assert.deepEqual(replayB.json.user, replayA.json.user);
  // Switch back; the same cookie now governs A again.
  const me1 = await api('/api/auth/me', { cookie: cookies.dual });
  const back = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: me1.json.user.contextVersion, commandId: commandId('select-a') },
  });
  assert.equal(back.status, 200);
  assert.equal(back.json.user.role, 'AGENCY');
  // The old B nonce retried after the switch keeps A: current-state 409, no revert.
  const oldB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: sel.json.contextVersion, commandId: replayNonce },
  });
  assert.equal(oldB.status, 409);
  assert.equal(oldB.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  assert.equal(oldB.json.activeOrganizationId, LEGACY_ORG);
  const stillA = await api('/api/auth/me', { cookie: cookies.dual });
  assert.equal(stillA.json.user.organizationId, LEGACY_ORG);
});

test('concurrent selects serialize: one wins, the loser gets current state', async (t) => {
  if (!databaseUrl) return t.skip();
  const me = await api('/api/auth/me', { cookie: cookies.dual });
  const v = me.json.user.contextVersion;
  const bodies = [commandId('cas-1'), commandId('cas-2')].map((cid) => ({
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: v, commandId: cid },
  }));
  const [first, second] = await Promise.all(bodies.map((b) => api('/api/auth/organizations/select', b)));
  const winners = [first, second].filter((r) => r.status === 200);
  const losers = [first, second].filter((r) => r.status !== 200);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].status, 409);
  assert.equal(losers[0].json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  assert.ok(losers[0].json.user, 'loser learns the current state');
  // Restore legacy pin.
  const cur = await api('/api/auth/me', { cookie: cookies.dual });
  await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: cur.json.user.contextVersion, commandId: commandId('sel-restore') },
  });
});

test('existing accounts join another org without password changes', async (t) => {
  if (!databaseUrl) return t.skip();
  const joinerId = `ten-joiner-${suffix}`;
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: joinerId, role: 'MANAGER',
    name: '합류자', email: `${joinerId}@example.test`,
  });
  const joinerCookie = await sessionCookie(harness, joinerId);
  const ownerMe = await api('/api/auth/me', { cookie: cookies.ownerA });
  const ownerB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: ownerMe.json.user.contextVersion, commandId: commandId('join-sel-b') },
  });
  assert.equal(ownerB.status, 200);
  // Unauthenticated accept of an existing email is refused with guidance.
  const invite = await api('/api/auth/invitations', {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, ownerB.json.contextVersion),
    body: { commandId: commandId('invite-b2'), name: '합류자', email: `${joinerId}@example.test`, role: 'STAFF' },
  });
  assert.equal(invite.status, 201);
  const anon = await api(`/api/auth/invitations/${invite.json.token}/accept`, {
    method: 'POST', body: { password: 'some-new-password' },
  });
  assert.equal(anon.status, 409);
  assert.equal(anon.json.code, 'INVITATION_LOGIN_REQUIRED');
  const join = await api(`/api/auth/invitations/${invite.json.token}/accept`, {
    method: 'POST', cookie: joinerCookie, body: {},
  });
  assert.equal(join.status, 201);
  assert.equal(join.json.account.organizationId, orgB);
  // Password untouched: the fixture password still logs in. The fresh
  // session selects nothing by itself (no auto-switch): the role appears
  // only after an explicit select of the home org, where it is still MANAGER.
  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: `${joinerId}@example.test`, password: TEST_PASSWORD },
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.organizationId, null);
  const rawLogin = login.headers.get('set-cookie') || '';
  const loginCookie = `etko_session=${/etko_session=([^;]+)/.exec(rawLogin)[1]}`;
  const home = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: loginCookie,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: login.json.user.contextVersion, commandId: commandId('select-home') },
  });
  assert.equal(home.status, 200);
  assert.equal(home.json.user.role, 'MANAGER');
  assert.equal(home.json.activeOrganizationId, LEGACY_ORG);
});

test('shared accounts cannot be password-reset globally by one org', async (t) => {
  if (!databaseUrl) return t.skip();
  const revHome = await pinLegacy(cookies.ownerA);
  const res = await api(`/api/auth/accounts/${ids.dual}/password`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, revHome),
    body: { commandId: commandId('pw-shared'), password: 'shared-new-password-1' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'SHARED_ACCOUNT_GLOBAL_EFFECT');
  // The password still works everywhere.
  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: `${ids.dual}@example.test`, password: TEST_PASSWORD },
  });
  assert.equal(login.status, 200);
});

test('explicitly selected org lost never silently switches', async (t) => {
  if (!databaseUrl) return t.skip();
  const joinerEmail = `ten-joiner-${suffix}@example.test`;
  const login = await api('/api/auth/login', { method: 'POST', body: { email: joinerEmail, password: TEST_PASSWORD } });
  assert.equal(login.status, 200);
  const rawLogin = login.headers.get('set-cookie') || '';
  const cookie = `etko_session=${/etko_session=([^;]+)/.exec(rawLogin)[1]}`;
  const sel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie,
    body: { organizationId: orgB, expectedContextVersion: login.json.user.contextVersion, commandId: commandId('sel-joiner-b') },
  });
  assert.equal(sel.status, 200);
  const rev = sel.json.contextVersion;
  assert.ok(rev >= 1, 'explicit selection advances the session revision');
  // Lose B explicitly (org-version CAS omitted here; covered below).
  const joinerRow = await harness.database.query('SELECT id FROM accounts WHERE lower(email) = $1', [joinerEmail]);
  const off = await api(`/api/auth/organizations/${orgB}/members/${joinerRow.rows[0].id}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('deact-joiner'), active: false },
  });
  assert.equal(off.status, 200);
  // A bogus org version is denied without touching anything.
  const bogus = await api(`/api/auth/organizations/${orgB}/members/${joinerRow.rows[0].id}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('deact-bogus'), active: true, expectedContextVersion: 9000 },
  });
  assert.equal(bogus.status, 409);
  const me = await api('/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.organizationId, null);
  assert.equal(me.json.user.orgSelectionRequired, true);
  assert.equal(me.json.user.deselectedOrganizationId, orgB);
  assert.equal(me.json.user.contextVersion, rev);
  assert.ok((me.json.user.availableOrganizations || []).some((o) => o.id === LEGACY_ORG));
  assert.ok(!(me.json.user.availableOrganizations || []).some((o) => o.id === orgB));
  // The single remaining org still evaluates compat writes (no silent
  // success, no other-org confusion): denied on the event grant, in A.
  const write = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie,
    body: { commandId: commandId('desel-write'), command: 'notice.save', payload: { title: 'x', body: 'y' } },
  });
  assert.equal(write.status, 403);
  assert.equal(write.json.code, undefined);
  const writePinned = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie, headers: H(LEGACY_ORG, rev),
    body: { commandId: commandId('desel-write-2'), command: 'notice.save', payload: { title: 'x', body: 'y' } },
  });
  assert.equal(writePinned.status, 403);
  // Explicit recovery works with the preserved revision.
  const resel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: rev, commandId: commandId('sel-joiner-a') },
  });
  assert.equal(resel.status, 200);
  assert.equal(resel.json.user.organizationId, LEGACY_ORG);
});

test('auto-pinned sessions keep single-remaining compat without a switch', async (t) => {
  if (!databaseUrl) return t.skip();
  const soloId = `ten-solo-${suffix}`;
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: soloId, role: 'MANAGER',
    name: '솔로', email: `${soloId}@example.test`,
  });
  const login = await api('/api/auth/login', { method: 'POST', body: { email: `${soloId}@example.test`, password: TEST_PASSWORD } });
  assert.equal(login.status, 200);
  // Single membership resolves inline (no explicit select ever happened).
  assert.equal(login.json.user.organizationId, LEGACY_ORG);
  const rawLogin = login.headers.get('set-cookie') || '';
  const cookie = `etko_session=${/etko_session=([^;]+)/.exec(rawLogin)[1]}`;
  // Join B, then lose the auto-pinned home: the only remaining org resolves.
  const soloOwner = await api('/api/auth/me', { cookie: cookies.ownerA });
  const soloSel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: soloOwner.json.user.contextVersion, commandId: commandId('solo-sel-b') },
  });
  assert.equal(soloSel.status, 200);
  const invite = await api('/api/auth/invitations', {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, soloSel.json.contextVersion),
    body: { commandId: commandId('invite-solo'), name: '솔로', email: `${soloId}@example.test`, role: 'STAFF' },
  });
  assert.equal(invite.status, 201);
  const accept = await api(`/api/auth/invitations/${invite.json.token}/accept`, {
    method: 'POST', cookie, body: {},
  });
  assert.equal(accept.status, 201);
  await harness.database.query(
    'UPDATE organization_memberships SET active = false WHERE org_id = $1 AND account_id = $2',
    [LEGACY_ORG, soloId]
  );
  const me = await api('/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.organizationId, orgB);
});

test('membership writes replay from the receipt despite an old version', async (t) => {
  if (!databaseUrl) return t.skip();
  const live = await harness.database.query('SELECT revision FROM organization_memberships WHERE org_id = $1 AND account_id = $2', [orgB, ids.dual]);
  const key = commandId('member-replay');
  const first = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: key, active: false, expectedContextVersion: Number(live.rows[0].revision) },
  });
  assert.equal(first.status, 200);
  // Restore first so the retry below is a pure receipt replay check.
  const restore = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('member-restore'), active: true },
  });
  assert.equal(restore.status, 200);
  const replay = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: key, active: false, expectedContextVersion: 0 },
  });
  // Same nonce, original (now old) version: the applied write re-confirms.
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.membership.active, false);
  // Leave dual active in B for the remaining tests.
  await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('member-restore-2'), active: true },
  });
});

test('a committed write retried after a permission change still replays', async (t) => {
  if (!databaseUrl) return t.skip();
  const { createDomainCommands } = require('../server/commands/domain');
  const mgrId = `ten-mgr-${suffix}`;
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: mgrId, role: 'MANAGER',
    name: '매니저', email: `${mgrId}@example.test`,
  });
  await harness.database.query(
    `INSERT INTO memberships (account_id, event_id, write_permissions)
     VALUES ($1, $2, '["all"]')`,
    [mgrId, ids.eventA]
  );
  const domain = createDomainCommands(harness.database, { messaging: { state: { connected: false } } });
  const account = { id: mgrId, organizationId: LEGACY_ORG, sessionRevision: 0, sessionOrgVersion: 0 };
  const key = commandId('perm-replay');
  const first = await domain.execute({
    eventId: ids.eventA, commandId: key, command: 'notice.save',
    payload: { title: '확정 공지', body: '본문' }, account,
  });
  assert.ok([200, 201].includes(first.status));
  // Permission narrowed afterwards: the same nonce still replays the record.
  await harness.database.query(
    `UPDATE memberships SET write_permissions = '[]'::jsonb WHERE account_id = $1 AND event_id = $2`,
    [mgrId, ids.eventA]
  );
  const retry = await domain.execute({
    eventId: ids.eventA, commandId: key, command: 'notice.save',
    payload: { title: '확정 공지', body: '본문' }, account,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.notice.title, '확정 공지');
  assert.equal(retry.replayed, true);
  // A fresh nonce is denied by the new grant.
  const fresh = await domain.execute({
    eventId: ids.eventA, commandId: commandId('perm-fresh'), command: 'notice.save',
    payload: { title: '새 공지', body: '본문' }, account,
  }).catch((error) => ({ status: error.status || 500 }));
  assert.equal(fresh.status, 403);
});

test('cross-org assignment is denied; shared accounts staff normally', async (t) => {
  if (!databaseUrl) return t.skip();
  const outsiderId = `ten-outsider-${suffix}`;
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: outsiderId, role: 'STAFF',
    name: '외부자', email: `${outsiderId}@example.test`,
  });
  // Pin (or rebind) B for the whole test: prior bumps may have moved the
  // org binding underneath the tab.
  const meB = await api('/api/auth/me', { cookie: cookies.ownerA });
  const pinB = (await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: meB.json.user.contextVersion, commandId: commandId('pin-assign-b') },
  })).json.contextVersion;
  // A desk in B.
  const desk = await api(`/api/events/${ids.eventB}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, pinB),
    body: { commandId: commandId('desk-b'), command: 'desk.save', payload: { name: 'B 안내', action: 'IN', mode: 'desk' } },
  });
  assert.ok([200, 201].includes(desk.status));
  const deskId = desk.json.desk.id;
  // Legacy-only STAFF into B: denied, and nothing is stored.
  const denied = await api(`/api/events/${ids.eventB}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, pinB),
    body: { commandId: commandId('assign-x'), command: 'staff.assign', payload: { accountId: outsiderId, type: 'DESK', targetId: deskId } },
  });
  assert.equal(denied.status, 400);
  const rows = await harness.database.query(
    'SELECT count(*)::int AS n FROM staff_assignments WHERE account_id = $1 AND event_id = $2',
    [outsiderId, ids.eventB]
  );
  assert.equal(rows.rows[0].n, 0);
  // Shared account (global AGENCY, B STAFF) assigns normally in B.
  const ok = await api(`/api/events/${ids.eventB}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, pinB),
    body: { commandId: commandId('assign-dual'), command: 'staff.assign', payload: { accountId: ids.dual, type: 'DESK', targetId: deskId } },
  });
  assert.ok([200, 201].includes(ok.status));
});

test('shared staff drive the full desk flow in their own org', async (t) => {
  if (!databaseUrl) return t.skip();
  const rebindB = await api('/api/auth/me', { cookie: cookies.ownerA });
  const selB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: rebindB.json.user.contextVersion, commandId: commandId('rebind-flow-b') },
  });
  assert.equal(selB.status, 200);
  const revOwnerB = selB.json.contextVersion;
  // B goes LIVE on the back of dual's B-STAFF assignment (global AGENCY).
  for (const stage of ['READY', 'LIVE']) {
    const moved = await api(`/api/events/${ids.eventB}/commands`, {
      method: 'POST', cookie: cookies.ownerA, headers: H(orgB, revOwnerB),
      body: { commandId: commandId(`stage-b-${stage}`), command: 'event.stage', payload: { stage } },
    });
    assert.ok([200, 201].includes(moved.status), stage);
  }
  const person = await api(`/api/events/${ids.eventB}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, revOwnerB),
    body: { commandId: commandId('person-b'), command: 'participant.create', payload: { name: 'B 참가자', phone: '010-0000-0001' } },
  });
  assert.ok([200, 201].includes(person.status));
  const ticket = person.json.participant.ticket;
  const assignment = await harness.database.query(
    'SELECT id, target_id FROM staff_assignments WHERE account_id = $1 AND event_id = $2 AND active = true LIMIT 1',
    [ids.dual, ids.eventB]
  );
  assert.equal(assignment.rowCount, 1);
  // Dual pins B for the scan; the session revision rides the write headers.
  const dualMe = await api('/api/auth/me', { cookie: cookies.dual });
  const dualSel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: dualMe.json.user.contextVersion, commandId: commandId('sel-dual-scan') },
  });
  assert.equal(dualSel.status, 200);
  const scan = await api(`/api/events/${ids.eventB}/commands`, {
    method: 'POST', cookie: cookies.dual, headers: H(orgB, dualSel.json.contextVersion),
    body: { commandId: commandId('scan-b'), command: 'check.scan', assignmentId: assignment.rows[0].id, payload: { ticket, deskId: assignment.rows[0].target_id } },
  });
  assert.ok([200, 201].includes(scan.status), `scan: ${scan.status} ${JSON.stringify(scan.json).slice(0, 200)}`);
  // Reverse direction: global STAFF staffs A and scans there.
  const stafferId = `ten-staffer-${suffix}`;
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: stafferId, role: 'STAFF',
    name: '현장요원', email: `${stafferId}@example.test`,
  });
  const revOwnerA = await pinLegacy(cookies.ownerA);
  const deskA = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, revOwnerA),
    body: { commandId: commandId('desk-a'), command: 'desk.save', payload: { name: 'A 안내', action: 'IN', mode: 'desk' } },
  });
  assert.ok([200, 201].includes(deskA.status));
  const assignA = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, revOwnerA),
    body: { commandId: commandId('assign-a'), command: 'staff.assign', payload: { accountId: stafferId, type: 'DESK', targetId: deskA.json.desk.id } },
  });
  assert.ok([200, 201].includes(assignA.status));
  for (const stage of ['READY', 'LIVE']) {
    const moved = await api(`/api/events/${ids.eventA}/commands`, {
      method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, revOwnerA),
      body: { commandId: commandId(`stage-a-${stage}`), command: 'event.stage', payload: { stage } },
    });
    assert.ok([200, 201].includes(moved.status), stage);
  }
  const personA = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, revOwnerA),
    body: { commandId: commandId('person-a'), command: 'participant.create', payload: { name: 'A 참가자', phone: '010-0000-0002' } },
  });
  assert.ok([200, 201].includes(personA.status));
  const stafferCookie = await sessionCookie(harness, stafferId);
  const assignRow = await harness.database.query(
    'SELECT id, target_id FROM staff_assignments WHERE account_id = $1 AND event_id = $2 AND active = true LIMIT 1',
    [stafferId, ids.eventA]
  );
  const scanA = await api(`/api/events/${ids.eventA}/commands`, {
    method: 'POST', cookie: stafferCookie,
    body: { commandId: commandId('scan-a'), command: 'check.scan', assignmentId: assignRow.rows[0].id, payload: { ticket: personA.json.participant.ticket, deskId: assignRow.rows[0].target_id } },
  });
  assert.ok([200, 201].includes(scanA.status), `reverse scan: ${scanA.status}`);
});

test('identity without membership is guided, not a bare failure', async (t) => {
  if (!databaseUrl) return t.skip();
  const ghostId = `ten-ghost-${suffix}`;
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: ghostId, role: 'MANAGER',
    name: '유령', email: `${ghostId}@example.test`,
  });
  const ghostCookie = await sessionCookie(harness, ghostId);
  await harness.database.query('DELETE FROM organization_memberships WHERE account_id = $1', [ghostId]);
  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: `${ghostId}@example.test`, password: TEST_PASSWORD },
  });
  assert.equal(login.status, 403);
  assert.equal(login.json.code, 'NO_ORGANIZATION_MEMBERSHIP');
  const me = await api('/api/auth/me', { cookie: ghostCookie });
  assert.equal(me.status, 403);
  assert.equal(me.json.code, 'NO_ORGANIZATION_MEMBERSHIP');
  assert.equal(me.json.user.id, ghostId);
});

test('security overview and release are org-scoped, never global', async (t) => {
  if (!databaseUrl) return t.skip();
  const bOnlyId = `ten-bonly-${suffix}`;
  await insertAccount(harness.database, {
    orgId: orgB, id: bOnlyId, role: 'STAFF',
    name: 'B전용', email: `${bOnlyId}@example.test`,
  });
  // Failures for a B-only account and for the shared dual account.
  await api('/api/auth/login', { method: 'POST', body: { email: `${bOnlyId}@example.test`, password: 'wrong-password' } });
  await api('/api/auth/login', { method: 'POST', body: { email: `${ids.dual}@example.test`, password: 'wrong-password' } });
  // Legacy-pinned owner: sees dual (legacy member) but never the B-only
  // account and never client-address rows.
  await pinLegacy(cookies.ownerA);
  const secA = await api('/api/auth/security', { cookie: cookies.ownerA });
  assert.equal(secA.status, 200);
  const keysA = secA.json.attempts.map((a) => a.key);
  assert.ok(!keysA.some((k) => String(k).toLowerCase() === `${bOnlyId}@example.test`), 'B-only email is invisible from A');
  assert.ok(secA.json.attempts.every((a) => a.scope === 'account'), 'no global address rows leak');
  assert.equal(secA.json.organizationId, LEGACY_ORG);
  // B-pinned owner: sees the B-only account.
  const meB = await api('/api/auth/me', { cookie: cookies.ownerA });
  const selB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: meB.json.user.contextVersion, commandId: commandId('sel-sec-b') },
  });
  if (selB.status !== 200) console.log('SELB-DEBUG', selB.status, JSON.stringify(selB.json));
  assert.equal(selB.status, 200);
  const secB = await api('/api/auth/security', { cookie: cookies.ownerA });
  assert.equal(secB.status, 200);
  assert.ok(secB.json.attempts.some((a) => String(a.key).toLowerCase() === `${bOnlyId}@example.test`), 'B owner sees own member');
  // Release of a B-only key from the legacy pin: not found here.
  await pinLegacy(cookies.ownerA);
  const crossClear = await api('/api/auth/login-lockouts', {
    method: 'DELETE', cookie: cookies.ownerA,
    body: { scope: 'account', key: `${bOnlyId}@example.test` },
  });
  assert.equal(crossClear.status, 404);
  // Release of a shared account from one org: safe-blocked, global effect.
  const sharedClear = await api('/api/auth/login-lockouts', {
    method: 'DELETE', cookie: cookies.ownerA,
    body: { scope: 'account', key: `${ids.dual}@example.test` },
  });
  assert.equal(sharedClear.status, 403);
  assert.equal(sharedClear.json.code, 'SHARED_ACCOUNT_GLOBAL_EFFECT');
  // Address scope is deployment-global: invisible and never clearable.
  const addrClear = await api('/api/auth/login-lockouts', {
    method: 'DELETE', cookie: cookies.ownerA,
    body: { scope: 'address', key: '127.0.0.1' },
  });
  assert.equal(addrClear.status, 403);
  await pinLegacy(cookies.ownerA);
});

test('private GETs stamp the verified session context, never a default', async (t) => {
  if (!databaseUrl) return t.skip();
  const rev0 = await pinLegacy(cookies.ownerA);
  const check = async (label, res, orgId, rev) => {
    assert.equal(res.status, 200, label);
    assert.equal(res.headers.get('x-eventouch-organization-id'), orgId, `${label} org header`);
    assert.equal(res.headers.get('x-eventouch-context-version'), String(rev), `${label} version header`);
  };
  const me = await api('/api/auth/me', { cookie: cookies.ownerA });
  await check('me', me, LEGACY_ORG, rev0);
  assert.equal(me.json.user.organizationId, me.headers.get('x-eventouch-organization-id'));
  assert.equal(String(me.json.user.contextVersion), me.headers.get('x-eventouch-context-version'));
  const list = await api('/api/auth/organizations', { cookie: cookies.ownerA });
  await check('org-list', list, LEGACY_ORG, rev0);
  const boot = await api('/api/bootstrap', { cookie: cookies.ownerA });
  await check('bootstrap', boot, LEGACY_ORG, rev0);
  assert.equal(boot.json.state.viewer.organizationId, boot.headers.get('x-eventouch-organization-id'));
  const dir = await api('/api/console/directory', { cookie: cookies.ownerA });
  await check('directory', dir, LEGACY_ORG, rev0);
  const evb = await api(`/api/events/${ids.eventB}/bootstrap`, { cookie: cookies.ownerA, headers: H(orgB, rev0) });
  assert.equal(evb.status, 409, 'B detail from a legacy pin stays denied');
  const sel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: rev0, commandId: commandId('sel-stamp-b') },
  });
  assert.equal(sel.status, 200);
  const evb2 = await api(`/api/events/${ids.eventB}/bootstrap`, { cookie: cookies.ownerA });
  await check('event-bootstrap', evb2, orgB, sel.json.contextVersion);
  assert.equal(evb2.json.state.viewer.organizationId, evb2.headers.get('x-eventouch-organization-id'));
  const sec = await api('/api/auth/security', { cookie: cookies.ownerA });
  await check('security', sec, orgB, sel.json.contextVersion);
  await pinLegacy(cookies.ownerA);
  // Fresh multi-membership session: no selection, no headers, but the
  // explicit selector body still works.
  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: `${ids.dual}@example.test`, password: TEST_PASSWORD },
  });
  assert.equal(login.status, 200);
  const rawLogin = login.headers.get('set-cookie') || '';
  const fresh = `etko_session=${/etko_session=([^;]+)/.exec(rawLogin)[1]}`;
  const meFresh = await api('/api/auth/me', { cookie: fresh });
  assert.equal(meFresh.status, 200);
  assert.equal(meFresh.json.user.organizationId, null);
  assert.equal(meFresh.headers.get('x-eventouch-organization-id'), null);
  assert.equal(meFresh.headers.get('x-eventouch-context-version'), null);
  const listFresh = await api('/api/auth/organizations', { cookie: fresh });
  assert.equal(listFresh.status, 200);
  assert.equal(listFresh.headers.get('x-eventouch-organization-id'), null);
});

test('org owners manage in-org roles; the last owner cannot go away', async (t) => {
  if (!databaseUrl) return t.skip();
  const memRev = async (accountId) => Number((await harness.database.query(
    'SELECT revision FROM organization_memberships WHERE org_id = $1 AND account_id = $2', [orgB, accountId]
  )).rows[0].revision);
  // Dual is STAFF in B: promote to MANAGER, then to AGENCY. Omitted active
  // stays untouched (role-only never reactivates or deactivates).
  const r0 = await memRev(ids.dual);
  const toMgr = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('role-mgr'), role: 'MANAGER', expectedContextVersion: r0 },
  });
  assert.equal(toMgr.status, 200);
  assert.equal(toMgr.json.membership.role, 'MANAGER');
  assert.equal(toMgr.json.membership.active, true);
  assert.deepEqual(toMgr.json.previous, { role: 'STAFF', active: true });
  const toOwner = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('role-owner'), role: 'AGENCY', expectedContextVersion: toMgr.json.membership.contextVersion },
  });
  assert.equal(toOwner.status, 200);
  // Dual (now owner) demotes ownerA: allowed while another owner remains.
  // The demotion is verified on the next write via the stale binding.
  const demoteOwner = await api(`/api/auth/organizations/${orgB}/members/${ids.ownerA}`, {
    method: 'POST', cookie: cookies.dual,
    body: { commandId: commandId('role-demote-owner'), role: 'MANAGER', expectedContextVersion: await memRev(ids.ownerA) },
  });
  assert.equal(demoteOwner.status, 200);
  // ownerA is MANAGER now: pin B, then an owner-only write is refused on
  // the role verdict (not on context).
  const ownerMe = await api('/api/auth/me', { cookie: cookies.ownerA });
  const ownerB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: ownerMe.json.user.contextVersion, commandId: commandId('sel-owner-b-check') },
  });
  assert.equal(ownerB.status, 200);
  const noInvite = await api('/api/auth/invitations', {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, ownerB.json.contextVersion),
    body: { commandId: commandId('invite-nonowner'), name: 'x', email: `x-${suffix}@example.test`, role: 'STAFF' },
  });
  assert.equal(noInvite.status, 403);
  // Dual is the sole active owner: self-demotion and self-deactivation both fail.
  const dualRev = await memRev(ids.dual);
  const lastDown = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.dual,
    body: { commandId: commandId('role-last'), role: 'STAFF', expectedContextVersion: dualRev },
  });
  assert.equal(lastDown.status, 409);
  const lastOff = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.dual,
    body: { commandId: commandId('role-last-off'), active: false, expectedContextVersion: dualRev },
  });
  assert.equal(lastOff.status, 409);
  // Re-promote ownerA so dual can step down, then dual steps down itself.
  const reupOwner = await api(`/api/auth/organizations/${orgB}/members/${ids.ownerA}`, {
    method: 'POST', cookie: cookies.dual,
    body: { commandId: commandId('role-reup-owner'), role: 'AGENCY', expectedContextVersion: await memRev(ids.ownerA) },
  });
  assert.equal(reupOwner.status, 200);
  const selfDown = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.dual,
    body: { commandId: commandId('role-self'), role: 'STAFF', expectedContextVersion: await memRev(ids.dual) },
  });
  assert.equal(selfDown.status, 200);
  assert.equal(selfDown.json.membership.role, 'STAFF');
  // Dual's old session binding is stale now; reselect to continue as STAFF.
  const dualMe = await api('/api/auth/me', { cookie: cookies.dual });
  const dualBack = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.dual,
    body: { organizationId: orgB, expectedContextVersion: dualMe.json.user.contextVersion, commandId: commandId('sel-dual-back') },
  });
  assert.equal(dualBack.status, 200);
  assert.equal(dualBack.json.user.role, 'STAFF');
  // Restore sessions for the remaining tests.
  await pinLegacy(cookies.ownerA);
  await pinLegacy(cookies.dual);
});

test('two owners racing demote/deactivate keep at least one active owner', async (t) => {
  if (!databaseUrl) return t.skip();
  // Re-promote dual so B has two active owners again.
  const reup = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('role-reup'), role: 'AGENCY' },
  });
  assert.ok([200, 409].includes(reup.status));
  const [a, b] = await Promise.all([
    api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
      method: 'POST', cookie: cookies.ownerA,
      body: { commandId: commandId('race-deact'), active: false },
    }),
    api(`/api/auth/organizations/${orgB}/members/${ids.ownerA}`, {
      method: 'POST', cookie: cookies.dual,
      body: { commandId: commandId('race-demote'), role: 'STAFF' },
    }),
  ]);
  const wins = [a, b].filter((r) => r.status === 200);
  const denied = [a, b].filter((r) => r.status !== 200);
  assert.equal(wins.length, 1);
  assert.equal(denied.length, 1);
  // The loser either lost its own authority first (403) or hit the
  // last-owner guard (409) — either way exactly one write lands.
  const owners = await harness.database.query(
    `SELECT count(*)::int AS n FROM organization_memberships WHERE org_id = $1 AND role = 'AGENCY' AND active = true`,
    [orgB]
  );
  assert.ok(owners.rows[0].n >= 1, 'at least one active owner survives the race');
  // Restore both owners for later tests (ownerA drives B setup).
  await harness.database.query(
    `UPDATE organization_memberships SET role = 'AGENCY', active = true, revision = revision + 1
     WHERE org_id = $1 AND account_id = ANY($2::text[])`,
    [orgB, [ids.ownerA, ids.dual]]
  );
});

test('inactive other-org memberships still count as shared for global ops', async (t) => {
  if (!databaseUrl) return t.skip();
  const before = await harness.database.query('SELECT password_hash FROM accounts WHERE id = $1', [ids.dual]);
  const sessionsBefore = await harness.database.query('SELECT count(*)::int AS n FROM sessions WHERE account_id = $1', [ids.dual]);
  // B membership paused: the account still belongs to two orgs on record.
  const off = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('pause-dual'), active: false },
  });
  assert.equal(off.status, 200);
  const revA = await pinLegacy(cookies.ownerA);
  const reset = await api(`/api/auth/accounts/${ids.dual}/password`, {
    method: 'POST', cookie: cookies.ownerA, headers: H(LEGACY_ORG, revA),
    body: { commandId: commandId('pw-paused'), password: 'paused-new-password-1' },
  });
  assert.equal(reset.status, 403);
  assert.equal(reset.json.code, 'SHARED_ACCOUNT_GLOBAL_EFFECT');
  const rel = await api('/api/auth/login-lockouts', {
    method: 'DELETE', cookie: cookies.ownerA,
    body: { scope: 'account', key: `${ids.dual}@example.test` },
  });
  assert.equal(rel.status, 403);
  assert.equal(rel.json.code, 'SHARED_ACCOUNT_GLOBAL_EFFECT');
  // Hash, sessions and failure counters are untouched.
  const after = await harness.database.query('SELECT password_hash FROM accounts WHERE id = $1', [ids.dual]);
  assert.equal(after.rows[0].password_hash, before.rows[0].password_hash);
  const sessionsAfter = await harness.database.query('SELECT count(*)::int AS n FROM sessions WHERE account_id = $1', [ids.dual]);
  assert.equal(sessionsAfter.rows[0].n, sessionsBefore.rows[0].n);
  // Re-enable B: the original password still works.
  const on = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: cookies.ownerA,
    body: { commandId: commandId('resume-dual'), active: true },
  });
  assert.equal(on.status, 200);
  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: `${ids.dual}@example.test`, password: TEST_PASSWORD },
  });
  assert.equal(login.status, 200);
});

test('shared accounts never surface as per-org counters', async (t) => {
  if (!databaseUrl) return t.skip();
  await api('/api/auth/login', { method: 'POST', body: { email: `${ids.dual}@example.test`, password: 'wrong-password' } });
  const revA = await pinLegacy(cookies.ownerA);
  void revA;
  const sec = await api('/api/auth/security', { cookie: cookies.ownerA });
  assert.equal(sec.status, 200);
  const keys = sec.json.attempts.map((a) => String(a.key).toLowerCase());
  assert.ok(!keys.includes(`${ids.dual}@example.test`), 'shared accounts are not attributed to one org');
  assert.ok(!keys.includes(`${ids.ownerA}@example.test`));
});

test('agency directory marks shared global identities without naming orgs', async (t) => {
  if (!databaseUrl) return t.skip();
  const soloId = `ten-shsolo-${suffix}`;
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: soloId, role: 'MANAGER',
    name: '단일', email: `${soloId}@example.test`,
  });
  await pinLegacy(cookies.ownerA);
  const dir = await api('/api/console/directory', { cookie: cookies.ownerA });
  assert.equal(dir.status, 200);
  const byId = Object.fromEntries(dir.json.directory.accounts.map((a) => [a.id, a]));
  assert.equal(byId[ids.dual].sharedAccount, true);
  assert.equal(byId[ids.ownerA].sharedAccount, true);
  assert.equal(byId[soloId].sharedAccount, false);
  for (const account of Object.values(byId)) {
    assert.ok(!('organizations' in account) && !('orgIds' in account), 'no org lists leak');
  }
});

test('shared accounts assemble through the real product path only', async (t) => {
  if (!databaseUrl) return t.skip();
  const uId = `ten-u-${suffix}`;
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: uId, role: 'MANAGER',
    name: '신규 운영자', email: `${uId}@example.test`,
  });
  const uLogin = await api('/api/auth/login', { method: 'POST', body: { email: `${uId}@example.test`, password: TEST_PASSWORD } });
  assert.equal(uLogin.status, 200);
  const rawU = uLogin.headers.get('set-cookie') || '';
  const uCookie = `etko_session=${/etko_session=([^;]+)/.exec(rawU)[1]}`;
  // A B-owner invites U as an owner (eventId forbidden for owners).
  const revO = await pinLegacy(cookies.ownerA);
  void revO;
  const ownerB = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: cookies.ownerA,
    body: { organizationId: orgB, expectedContextVersion: (await api('/api/auth/me', { cookie: cookies.ownerA })).json.user.contextVersion, commandId: commandId('sel-owner-b-u') },
  });
  assert.equal(ownerB.status, 200);
  const badScoped = await api('/api/auth/invitations', {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, ownerB.json.contextVersion),
    body: { commandId: commandId('invite-owner-ev'), name: '신규 운영자', email: `${uId}@example.test`, role: 'AGENCY', eventId: ids.eventB },
  });
  assert.equal(badScoped.status, 400);
  const inviteU = await api('/api/auth/invitations', {
    method: 'POST', cookie: cookies.ownerA, headers: H(orgB, ownerB.json.contextVersion),
    body: { commandId: commandId('invite-u-owner'), name: '신규 운영자', email: `${uId}@example.test`, role: 'AGENCY' },
  });
  assert.equal(inviteU.status, 201);
  const acceptU = await api(`/api/auth/invitations/${inviteU.json.token}/accept`, {
    method: 'POST', cookie: uCookie, body: {},
  });
  assert.equal(acceptU.status, 201);
  assert.equal(acceptU.json.account.organizationId, orgB);
  // U (new B owner) manages dual: deactivate, re-invite as STAFF, promote.
  const uMe = await api('/api/auth/me', { cookie: uCookie });
  const uSel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: uCookie,
    body: { organizationId: orgB, expectedContextVersion: uMe.json.user.contextVersion, commandId: commandId('sel-u-b') },
  });
  assert.equal(uSel.status, 200);
  const uRev = uSel.json.contextVersion;
  const leaveDual = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: uCookie, headers: H(orgB, uRev),
    body: { commandId: commandId('leave-dual'), active: false },
  });
  assert.equal(leaveDual.status, 200);
  const reinvite = await api('/api/auth/invitations', {
    method: 'POST', cookie: uCookie, headers: H(orgB, uRev),
    body: { commandId: commandId('reinvite-dual'), name: '이중 소속', email: `${ids.dual}@example.test`, role: 'STAFF' },
  });
  assert.equal(reinvite.status, 201, 'a deactivated address can be re-invited');
  // A stranger cannot accept someone else's invite: guidance, no join.
  const anon = await api(`/api/auth/invitations/${reinvite.json.token}/accept`, {
    method: 'POST', body: { password: 'some-new-password' },
  });
  assert.equal(anon.status, 409);
  assert.equal(anon.json.code, 'INVITATION_LOGIN_REQUIRED');
  const reaccept = await api(`/api/auth/invitations/${reinvite.json.token}/accept`, {
    method: 'POST', cookie: cookies.dual, body: {},
  });
  assert.equal(reaccept.status, 201);
  const promote = await api(`/api/auth/organizations/${orgB}/members/${ids.dual}`, {
    method: 'POST', cookie: uCookie, headers: H(orgB, uRev),
    body: { commandId: commandId('promote-dual'), role: 'MANAGER', expectedContextVersion: Number((await harness.database.query('SELECT revision FROM organization_memberships WHERE org_id = $1 AND account_id = $2', [orgB, ids.dual])).rows[0].revision) },
  });
  assert.equal(promote.status, 200);
  assert.equal(promote.json.membership.role, 'MANAGER');
  assert.deepEqual(promote.json.previous, { role: 'STAFF', active: true });
  const final = await harness.database.query(
    'SELECT role, active FROM organization_memberships WHERE org_id = $1 AND account_id = $2',
    [orgB, ids.dual]
  );
  assert.deepEqual(final.rows[0], { role: 'MANAGER', active: true });
});
