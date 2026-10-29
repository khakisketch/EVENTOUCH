'use strict';

// Attendee verification and browser sessions (slice 7a).
//
// The mock SMS transport is in-process, so tests read the sent code from the
// module outbox exactly as a handset would receive it. Plaintext codes never
// touch the database or an HTTP response in any mode.

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
  deleteFixtureRows,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const {
  mockOutbox,
  clearMockOutbox,
  createVerificationTransport,
} = require('../server/verification-transport');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const ids = {
  gated: `attendee-gated-${suffix}`,
  open: `attendee-open-${suffix}`,
};
const slugs = { gated: ids.gated, open: ids.open };
const agencyId = `attendee-agency-${suffix}`;
let harness;
let mockEnvWas;

function eventPayload(id, slug) {
  return {
    id,
    slug,
    name: '참가자 접근 검증 행사',
    date: '2026-12-01',
    start: '09:00',
    end: '17:00',
    capacity: 20,
    stage: 'READY',
    features: [],
  };
}

function workspace({ verificationRequired = false } = {}) {
  const fields = [
    { id: 'name', label: '이름', type: 'text', required: true, options: [] },
    { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
    { id: 'email', label: '이메일', type: 'email', required: false, options: [] },
    { id: 'company', label: '소속', type: 'text', required: false, options: [] },
    { id: 'meal', label: '식사 선택', type: 'select', required: true, options: ['일반식', '채식'] },
  ];
  return {
    participants: [],
    payments: [],
    registrationOpen: true,
    approvalRequired: false,
    formVersion: 8,
    publishedVersion: 3,
    fields,
    publishedFields: fields,
    consentText: '행사 신청을 위해 정보를 사용합니다.',
    consentVersion: 4,
    price: 0,
    verificationRequired,
  };
}

function commandId() {
  return `cmd-${crypto.randomUUID()}`;
}

function signupBody(name, phone, extra = {}) {
  return {
    commandId: commandId(),
    formVersion: 3,
    consent: true,
    name,
    phone,
    email: '',
    company: '',
    meal: '일반식',
    ...extra,
  };
}

function verifyRequest(slug, body) {
  return requestJson(harness.baseUrl, `/api/public/events/${slug}/verification/request`, {
    method: 'POST',
    body,
  });
}

function verifyConfirm(slug, body) {
  return requestJson(harness.baseUrl, `/api/public/events/${slug}/verification/confirm`, {
    method: 'POST',
    body,
  });
}

function lastMockCode(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const entries = mockOutbox.filter((item) => item.to === digits);
  return entries.length ? entries[entries.length - 1].code : null;
}

function attendeeCookieFrom(response) {
  const header = response.headers.get('set-cookie') || '';
  const match = /etko_attendee=([^;]+)/.exec(header);
  return match ? `etko_attendee=${match[1]}` : null;
}

before(async () => {
  if (!databaseUrl) return;
  // Mock transport for this file's harness only; restored afterwards so no
  // other suite observes it.
  mockEnvWas = process.env.EVENTOUCH_SMS_MOCK;
  process.env.EVENTOUCH_SMS_MOCK = '1';
  harness = await startApiHarness();
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: agencyId,
    role: 'AGENCY',
    name: '검증 담당',
    email: `attendee-agency-${suffix}@example.test`,
  });
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: ids.gated,
    slug: slugs.gated,
    payload: eventPayload(ids.gated, slugs.gated),
    workspace: workspace({ verificationRequired: true }),
  });
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: ids.open,
    slug: slugs.open,
    payload: eventPayload(ids.open, slugs.open),
    workspace: workspace({ verificationRequired: false }),
  });
});

after(async () => {
  if (mockEnvWas === undefined) delete process.env.EVENTOUCH_SMS_MOCK;
  else process.env.EVENTOUCH_SMS_MOCK = mockEnvWas;
  if (!harness) return;
  await deleteFixtureRows(harness.database, {
    eventIds: [ids.gated, ids.open],
    accountIds: [agencyId],
  });
  await harness.close();
  harness = null;
});

test('attendee-request-never-enumerates-events-or-numbers', async () => {
  clearMockOutbox();
  const unknown = await verifyRequest('no-such-event-ever', { phone: '01012345678', purpose: 'RECOVER' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.ok, true);
  // No challenge, no SMS, same shape as the real thing.
  assert.equal(unknown.json.challengeId, null);
  assert.equal(mockOutbox.length, 0);
  assert.ok(!('code' in (unknown.json || {})));
});

test('attendee-request-issues-a-challenge-without-leaking-the-code', async () => {
  clearMockOutbox();
  const res = await verifyRequest(slugs.gated, { phone: '010-1111-2222', purpose: 'ENROLL' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.challengeId, /^ac-/);
  assert.ok(!('code' in res.json));
  assert.ok(!('grant' in res.json));
  assert.equal(lastMockCode('01011112222').length, 6);
});

test('attendee-request-is-rate-limited-per-number', async () => {
  clearMockOutbox();
  const first = await verifyRequest(slugs.gated, { phone: '010-2222-3333', purpose: 'ENROLL' });
  assert.equal(first.status, 200);
  const second = await verifyRequest(slugs.gated, { phone: '010-2222-3333', purpose: 'ENROLL' });
  assert.equal(second.status, 429);
});

test('attendee-confirm-rejects-wrong-codes-and-exhausts-attempts', async () => {
  clearMockOutbox();
  const phone = '01033334444';
  await verifyRequest(slugs.gated, { phone, purpose: 'ENROLL' });
  const correct = lastMockCode(phone);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await verifyConfirm(slugs.gated, { phone, code: '000000' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.field, 'code');
  }
  // Even the right code no longer works once attempts are spent.
  const spent = await verifyConfirm(slugs.gated, { phone, code: correct });
  assert.equal(spent.status, 401);
});

test('attendee-enroll-grant-signs-up-once-and-opens-a-session', async () => {
  clearMockOutbox();
  const phone = '01044445555';
  await verifyRequest(slugs.gated, { phone, purpose: 'ENROLL' });
  const code = lastMockCode(phone);
  const confirmed = await verifyConfirm(slugs.gated, { phone, code });
  assert.equal(confirmed.status, 200);
  assert.ok(confirmed.json.grant);

  // The gate holds without a grant on verified-only events.
  const ungated = await requestJson(harness.baseUrl, `/api/events/${slugs.gated}/signup`, {
    method: 'POST',
    body: signupBody('김참가', phone),
  });
  assert.equal(ungated.status, 409);
  assert.equal(ungated.json.field, 'phone');

  const signed = await requestJson(harness.baseUrl, `/api/events/${slugs.gated}/signup`, {
    method: 'POST',
    body: signupBody('김참가', phone, { verificationGrant: confirmed.json.grant }),
  });
  assert.equal(signed.status, 201);
  assert.ok(signed.json.participant.ticket);
  const cookie = attendeeCookieFrom(signed);
  assert.ok(cookie);
  assert.match(attendeeCookieFrom(signed) || '', /^etko_attendee=/);

  // A spent grant cannot sign up twice.
  const replay = await requestJson(harness.baseUrl, `/api/events/${slugs.gated}/signup`, {
    method: 'POST',
    body: signupBody('김참가', '01044445555', { verificationGrant: confirmed.json.grant }),
  });
  assert.equal(replay.status, 409);

  // The session restores the ticket without the bearer.
  const viaSession = await requestJson(harness.baseUrl, `/api/public/events/${slugs.gated}/ticket`, {
    cookie,
  });
  assert.equal(viaSession.status, 200);
  assert.equal(viaSession.json.participant.ticket, signed.json.participant.ticket);
});

test('attendee-recover-restores-an-existing-registration-by-session', async () => {
  clearMockOutbox();
  // Unknown numbers get the same failure shape as a wrong code.
  await verifyRequest(slugs.gated, { phone: '01055556666', purpose: 'RECOVER' });
  const strangerCode = lastMockCode('01055556666');
  const stranger = await verifyConfirm(slugs.gated, { phone: '01055556666', code: strangerCode });
  assert.equal(stranger.status, 401);
  assert.equal(stranger.headers.get('set-cookie'), null);

  // A photographed QR is not a recovery credential.
  const qrProbe = await verifyConfirm(slugs.gated, { phone: '01044445555', code: 'ET:whatever' });
  assert.equal(qrProbe.status, 401);

  await verifyRequest(slugs.gated, { phone: '01044445555', purpose: 'RECOVER' });
  const code = lastMockCode('01044445555');
  const recovered = await verifyConfirm(slugs.gated, { phone: '01044445555', code });
  assert.equal(recovered.status, 200);
  const cookie = attendeeCookieFrom(recovered);
  assert.ok(cookie);
  const viaSession = await requestJson(harness.baseUrl, `/api/public/events/${slugs.gated}/ticket`, {
    cookie,
  });
  assert.equal(viaSession.status, 200);
  assert.equal(viaSession.json.participant.name, '김참가');
});

test('attendee-cancellation-revokes-the-browser-session', async () => {
  clearMockOutbox();
  await verifyRequest(slugs.gated, { phone: '01044445555', purpose: 'RECOVER' });
  const cookie = attendeeCookieFrom(
    await verifyConfirm(slugs.gated, { phone: '01044445555', code: lastMockCode('01044445555') })
  );
  assert.ok(cookie);
  const operator = await sessionCookie(harness, agencyId);
  const listed = await requestJson(harness.baseUrl, `/api/public/events/${slugs.gated}/ticket`, { cookie });
  const participantId = listed.json.participant.id;
  const cancelled = await requestJson(harness.baseUrl, `/api/events/${ids.gated}/commands`, {
    method: 'POST',
    cookie: operator,
    body: { commandId: commandId(), command: 'participant.status', payload: { id: participantId, status: 'CANCELLED' } },
  });
  assert.equal(cancelled.status, 200);
  // The revoked grant resolves to nothing: no ticket, no status leak.
  const after = await requestJson(harness.baseUrl, `/api/public/events/${slugs.gated}/ticket`, { cookie });
  assert.equal(after.status, 404);
});

test('attendee-open-events-keep-working-and-still-open-a-session', async () => {
  const signed = await requestJson(harness.baseUrl, `/api/events/${slugs.open}/signup`, {
    method: 'POST',
    body: signupBody('이자유', '01066667777'),
  });
  assert.equal(signed.status, 201);
  const cookie = attendeeCookieFrom(signed);
  assert.ok(cookie);
  const viaSession = await requestJson(harness.baseUrl, `/api/public/events/${slugs.open}/ticket`, { cookie });
  assert.equal(viaSession.status, 200);
});

test('verification-transport-reports-unconfigured-honestly-and-sends-through-solapi', async () => {
  const silent = createVerificationTransport({ env: {} });
  assert.equal(silent.state().connected, false);
  assert.equal((await silent.sendCode({ to: '01012345678', code: '123456' })).reason, 'NOT_CONFIGURED');

  const calls = [];
  const solapiTransport = createVerificationTransport({
    env: { SOLAPI_API_KEY: 'key', SOLAPI_API_SECRET: 'secret', SOLAPI_SENDER: '0212345678' },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({ groupInfo: { groupId: 'G1' }, failedMessageList: [] }),
      };
    },
  });
  const sent = await solapiTransport.sendCode({ to: '010-1234-5678', code: '654321', eventName: '데모' });
  assert.equal(sent.sent, true);
  assert.equal(sent.mode, 'solapi');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('send-many/detail'));
  const message = calls[0].body.messages[0];
  assert.equal(message.to, '01012345678');
  assert.ok(message.text.includes('654321'));
});
