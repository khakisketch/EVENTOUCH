'use strict';

// OTP hourly admission cap is per-organization: one org's volume must never
// starve another into 429s. The cap window is counted through the
// event->org join (see server/attendees.js).

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { emptyWorkspace } = require('../server/state');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

let harness;
const api = (url, options) => requestJson(harness.baseUrl, url, options);

before(async () => {
  if (!databaseUrl) return;
  process.env.EVENTOUCH_VERIFY_HOURLY_CAP = '3';
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: `otp-agency-${suffix}`, role: 'AGENCY',
    name: 'OTP 관리자', email: `otp-agency-${suffix}@example.test`,
  });
  await harness.database.query(
    "INSERT INTO organizations (id, name) VALUES ($1, 'OTP 조직 B') ON CONFLICT (id) DO NOTHING",
    [`otp-org-b-${suffix}`]
  );
  await insertAccount(harness.database, {
    orgId: `otp-org-b-${suffix}`, id: `otp-owner-b-${suffix}`, role: 'AGENCY',
    name: 'OTP B 소유자', email: `otp-owner-b-${suffix}@example.test`,
  });
  await insertEvent(harness.database, {
    orgId: LEGACY_ORG, id: `otp-event-a-${suffix}`, slug: `otp-a-${suffix}`,
    payload: { id: `otp-event-a-${suffix}`, name: 'OTP A', stage: 'LIVE' }, workspace: emptyWorkspace(),
  });
  await insertEvent(harness.database, {
    orgId: `otp-org-b-${suffix}`, id: `otp-event-b-${suffix}`, slug: `otp-b-${suffix}`,
    payload: { id: `otp-event-b-${suffix}`, name: 'OTP B', stage: 'LIVE' }, workspace: emptyWorkspace(),
  });
});

after(async () => {
  delete process.env.EVENTOUCH_VERIFY_HOURLY_CAP;
  if (harness) {
    try {
      await harness.database.query('DELETE FROM events WHERE id IN ($1, $2)', [`otp-event-a-${suffix}`, `otp-event-b-${suffix}`]);
      await harness.database.query('DELETE FROM accounts WHERE id IN ($1, $2)', [`otp-agency-${suffix}`, `otp-owner-b-${suffix}`]);
      await harness.database.query('DELETE FROM organizations WHERE id = $1', [`otp-org-b-${suffix}`]);
    } finally {
      await harness.close();
    }
  }
});

async function challenge(slug, phone) {
  return api(`/api/public/events/${slug}/verification/request`, {
    method: 'POST', body: { phone, purpose: 'ENROLL' },
  });
}

test('hourly OTP admission is counted per organization', async (t) => {
  if (!databaseUrl) return t.skip();
  // Org A exhausts its own window: 3 reservations, then the 4th is capped.
  for (let i = 0; i < 3; i += 1) {
    const res = await challenge(`otp-a-${suffix}`, `010-0000-010${i}`);
    assert.equal(res.status, 503, `A reservation ${i} sends (no creds) but counts`);
  }
  const capped = await challenge(`otp-a-${suffix}`, '010-0000-0199');
  assert.equal(capped.status, 429);
  // Org B is unaffected by A's volume.
  for (let i = 0; i < 3; i += 1) {
    const res = await challenge(`otp-b-${suffix}`, `010-0000-020${i}`);
    assert.equal(res.status, 503, `B reservation ${i} is independent of A`);
  }
  const cappedB = await challenge(`otp-b-${suffix}`, '010-0000-0299');
  assert.equal(cappedB.status, 429);
});

test('concurrent bursts on a fresh org admit exactly up to the cap', async (t) => {
  if (!databaseUrl) return t.skip();
  const {
    startApiHarness: _unused, sessionCookie, LEGACY_ORG: _legacy,
  } = require('./helpers/postgres-api-server.cjs');
  void _unused;
  void _legacy;
  const agencyCookie = await sessionCookie(harness, `otp-agency-${suffix}`);
  const created = await api('/api/auth/organizations', {
    method: 'POST', cookie: agencyCookie,
    body: { name: 'OTP 조직 C', commandId: `otp-org-create-${suffix}` },
  });
  assert.equal(created.status, 201);
  const orgC = created.json.organization.id;
  const me = await api('/api/auth/me', { cookie: agencyCookie });
  const sel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie: agencyCookie,
    body: { organizationId: orgC, expectedContextVersion: me.json.user.contextVersion, commandId: `otp-sel-${suffix}` },
  });
  assert.equal(sel.status, 200);
  const eventC = await api('/api/events', {
    method: 'POST', cookie: agencyCookie,
    headers: { 'x-eventouch-organization-id': orgC, 'x-eventouch-context-version': String(sel.json.contextVersion) },
    body: {
      commandId: `otp-event-c-${suffix}`, name: 'OTP C', slug: `otp-c-${suffix}`,
      date: '2026-12-01', start: '10:00', end: '17:00', capacity: 50,
    },
  });
  assert.equal(eventC.status, 201);
  const results = await Promise.all([0, 1, 2, 3].map((i) =>
    challenge(`otp-c-${suffix}`, `010-0002-0${i}10`)
  ));
  const admitted = results.filter((r) => r.status === 503).length;
  const capped = results.filter((r) => r.status === 429).length;
  assert.equal(admitted, 3);
  assert.equal(capped, 1);
  await harness.database.query('DELETE FROM events WHERE id = $1', [eventC.json.event.id]);
  await harness.database.query('DELETE FROM organizations WHERE id = $1', [orgC]);
});

test('real-SMS transport never fires for a non-legacy org', async (t) => {
  if (!databaseUrl) return t.skip();
  const { createAttendeeAccess } = require('../server/attendees');
  const sent = [];
  const solapiLike = {
    state: () => ({ mode: 'solapi', connected: true, sender: '0200000000' }),
    sendCode: async ({ to }) => { sent.push(to); return { sent: true, mode: 'solapi' }; },
  };
  await harness.database.query('DELETE FROM attendee_challenges');
  const access = createAttendeeAccess(harness.database, { transport: solapiLike });
  // Legacy event: the deployment transport fires.
  const legacy = await access.requestChallenge({ eventRef: `otp-a-${suffix}`, phone: '010-9999-0001', purpose: 'ENROLL' });
  assert.ok(legacy.challengeId);
  assert.equal(sent.length, 1);
  // New-org event: honest NOT_CONFIGURED, nothing sent through legacy creds.
  await assert.rejects(
    access.requestChallenge({ eventRef: `otp-b-${suffix}`, phone: '010-9999-0002', purpose: 'ENROLL' }),
    (error) => error && error.status === 503 && error.code === 'NEEDS_CONNECTION'
  );
  assert.equal(sent.length, 1);
});
