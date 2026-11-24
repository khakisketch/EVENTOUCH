'use strict';

// Policy backlog 2026-11-24, server part: participant contact line,
// default consent template, and participant.erase (anonymization).
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson,
  deleteFixtureRows, LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { emptyWorkspace, normalizeWorkspace } = require('../server/state');
const { consentTemplate, LEGACY_DEFAULT_CONSENT_TEXT } = require('../server/consent-template');
const { COMMAND_WRITE_SCOPE, managerWriteAllowed } = require('../server/event-permissions');
const { redactReceiptResult, eraseWorkspaceCopies, anonymizeParticipant } = require('../server/participant-erasure');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const ids = Object.fromEntries(['live', 'ended', 'archived', 'inside'].map((name) => [name, `policy-${name}-${suffix}`]));
const accountIds = { agency: `policy-agency-${suffix}`, manager: `policy-manager-${suffix}`, limited: `policy-limited-${suffix}`, staff: `policy-staff-${suffix}` };
let harness;
let cookies;

const NAME = '김지우';
const PHONE = '01077778888';

function command() { return `cmd-${crypto.randomUUID()}`; }
function run(eventId, name, payload, cookie, id = command()) {
  return requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId: id, command: name, payload } });
}
async function workspaceOf(eventId) {
  const row = await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]);
  return row.rows[0].payload;
}
function participant(overrides = {}) {
  return {
    id: `person-${crypto.randomUUID()}`, name: NAME, phone: PHONE, email: 'jiwoo@example.test', company: '가나다 주식회사',
    group: 'VIP', status: 'APPROVED', inside: false, everIn: false, revoked: false,
    ticket: `ET:x:T-${crypto.randomBytes(24).toString('base64url')}`, ticketExpiresAt: '2099-01-01T00:00:00.000Z',
    registrationType: 'PRE', paymentStatus: 'FREE', answers: { meal: '채식', memo: '알레르기 있음' },
    memo: '임의 열', consent: { version: 1, at: '2026-11-01T00:00:00.000Z' }, createdAt: '2026-11-01T00:00:00.000Z', ...overrides,
  };
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role] of [['agency', 'AGENCY'], ['manager', 'MANAGER'], ['limited', 'MANAGER'], ['staff', 'STAFF']]) {
    await insertAccount(harness.database, { orgId: LEGACY_ORG, id: accountIds[key], role, name: `정책 ${key}`, email: `${accountIds[key]}@example.test` });
  }
  for (const [name, stage] of [['live', 'LIVE'], ['ended', 'ENDED'], ['archived', 'ARCHIVED'], ['inside', 'LIVE']]) {
    await insertEvent(harness.database, { orgId: LEGACY_ORG, id: ids[name], slug: ids[name],
      payload: { id: ids[name], slug: ids[name], name: `정책 ${name}`, date: '2026-12-01', start: '09:00', end: '17:00', capacity: 50, stage, features: ['reward'] },
      workspace: { ...emptyWorkspace(), registrationOpen: true, publishedVersion: 1, formVersion: 1, participants: [] } });
    await insertMembership(harness.database, accountIds.manager, ids[name], ['all']);
    await insertMembership(harness.database, accountIds.limited, ids[name], ['page']);
  }
  cookies = {
    agency: await sessionCookie(harness, accountIds.agency),
    manager: await sessionCookie(harness, accountIds.manager),
    limited: await sessionCookie(harness, accountIds.limited),
    staff: await sessionCookie(harness, accountIds.staff),
  };
});

after(async () => {
  if (!harness) return;
  try {
    await deleteFixtureRows(harness.database, { eventIds: Object.values(ids), accountIds: Object.values(accountIds) });
  } finally {
    await harness.close();
  }
});

// ---- no database needed ----

test('new events start with the template; stored events keep their text and version', () => {
  const fresh = emptyWorkspace();
  assert.equal(fresh.consentText, consentTemplate('', ''));
  assert.equal(fresh.consentVersion, 1);
  assert.equal(fresh.participantContact, '');
  assert.match(fresh.consentText, /주최 측 요청에 따라 파기합니다/);
  assert.doesNotMatch(fresh.consentText, /자동/);
  // A stored row that never had the key reads as the historical one-liner.
  assert.equal(normalizeWorkspace({ participants: [] }).consentText, LEGACY_DEFAULT_CONSENT_TEXT);
  assert.equal(normalizeWorkspace({ consentText: '기존 문구', consentVersion: 7 }).consentText, '기존 문구');
  assert.equal(normalizeWorkspace({ consentText: '', consentVersion: 7 }).consentText, '');
  assert.equal(normalizeWorkspace({ consentText: '기존 문구', consentVersion: 7 }).consentVersion, 7);
});

test('contact.save belongs to settings; participant.erase to participants', () => {
  assert.equal(COMMAND_WRITE_SCOPE['contact.save'], 'settings');
  assert.equal(COMMAND_WRITE_SCOPE['participant.erase'], 'participants');
  assert.equal(managerWriteAllowed(['settings'], 'contact.save'), true);
  assert.equal(managerWriteAllowed(['participants'], 'contact.save'), false);
  assert.equal(managerWriteAllowed(['participants'], 'participant.erase'), true);
  assert.equal(managerWriteAllowed(['page'], 'participant.erase'), false);
});

test('erasure helpers drop unknown keys and every copy, and keep what counts rely on', () => {
  const person = participant();
  anonymizeParticipant(person, '2026-12-02T00:00:00.000Z');
  assert.deepEqual(Object.keys(person).sort(), [
    'answers', 'company', 'consent', 'createdAt', 'email', 'erased', 'erasedAt', 'everIn', 'group', 'id', 'inside', 'name', 'paymentStatus',
    'phone', 'registrationType', 'revoked', 'status', 'ticket', 'ticketExpiresAt',
  ]);
  assert.equal(person.name, '삭제된 참가자');
  assert.equal(JSON.stringify(person).includes('김지우'), false);
  assert.equal(JSON.stringify(person).includes('가나다'), false);

  const receipt = { response: { participant: { id: 'p1', name: '김지우', phone: '010', answers: { a: 'x' } }, reward: { participantId: 'p1', name: '상품권', claim: null } } };
  assert.equal(redactReceiptResult(receipt, 'p1'), 1);
  assert.equal(receipt.response.participant.name, '');
  assert.deepEqual(receipt.response.participant.answers, {});
  assert.equal(receipt.response.reward.name, '상품권');
  assert.equal(redactReceiptResult(receipt, 'p1'), 0);

  const workspace = { audit: [{ id: 'a', type: 'x', detail: '김지우 · 사유', cancellationResolution: { participantId: 'p1', participantName: '김지우' } }, { id: 'b', type: 'y', detail: '김지우 · 다른 사람 기록' }], rewards: [{ participantId: 'p1', name: '경품' }] };
  const counts = eraseWorkspaceCopies(workspace, 'p1', '김지우');
  assert.equal(counts.audit, 1);
  assert.equal(workspace.audit[0].cancellationResolution.participantName, '');
  assert.equal(workspace.audit[0].detail, '삭제된 참가자 · 사유');
  assert.equal(workspace.audit[1].detail, '김지우 · 다른 사람 기록', 'entries of other records are left alone');
  assert.equal(workspace.rewards[0].name, '경품');
});

// ---- database ----

test('contact.save stores, trims, clears, and projects the contact publicly regardless of the venue feature', async () => {
  assert.equal((await run(ids.live, 'contact.save', { participantContact: '  운영 사무국 02-123-4567 · help@example.com ' }, cookies.manager)).status, 200);
  assert.equal((await workspaceOf(ids.live)).participantContact, '운영 사무국 02-123-4567 · help@example.com');
  const pub = await requestJson(harness.baseUrl, `/api/public/events/${ids.live}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.json.workspace.participantContact, '운영 사무국 02-123-4567 · help@example.com');
  assert.equal(pub.json.workspace.venue.contact, '', 'venue feature is off; the contact line does not depend on it');

  const replayId = command();
  const first = await run(ids.live, 'contact.save', { participantContact: '문의 A' }, cookies.agency, replayId);
  const replay = await run(ids.live, 'contact.save', { participantContact: '문의 A' }, cookies.agency, replayId);
  assert.equal(first.status, 200);
  assert.equal(replay.json.replayed ?? true, true);
  assert.equal((await workspaceOf(ids.live)).participantContact, '문의 A');

  assert.equal((await run(ids.live, 'contact.save', { participantContact: '' }, cookies.agency)).status, 200);
  const cleared = await requestJson(harness.baseUrl, `/api/public/events/${ids.live}`);
  assert.equal(cleared.json.workspace.participantContact, '');
});

test('contact.save validates, needs the settings scope, and leaves consent untouched', async () => {
  const before = await workspaceOf(ids.live);
  const tooLong = await run(ids.live, 'contact.save', { participantContact: '가'.repeat(201) }, cookies.manager);
  assert.equal(tooLong.status, 400);
  assert.equal((await run(ids.live, 'contact.save', { participantContact: { a: 1 } }, cookies.manager)).status, 400);
  assert.equal((await run(ids.live, 'contact.save', { participantContact: '가'.repeat(200) }, cookies.manager)).status, 200);
  assert.equal((await run(ids.live, 'contact.save', { participantContact: '문의' }, cookies.limited)).status, 403);
  assert.equal((await run(ids.live, 'contact.save', { participantContact: '문의' }, cookies.staff)).status, 403);
  const after = await workspaceOf(ids.live);
  assert.equal(after.consentText, before.consentText);
  assert.equal(after.consentVersion, before.consentVersion);
  assert.equal((await run(ids.archived, 'contact.save', { participantContact: '문의' }, cookies.manager)).status, 409);
});

async function seedPerson(eventId, { inside = false, status = 'APPROVED' } = {}) {
  const person = participant({ inside, everIn: inside, status });
  const other = participant({ name: '박다른', phone: '01099990000', email: '', company: '', answers: {}, memo: undefined });
  const row = await workspaceOf(eventId);
  row.participants = [person, other];
  row.checks = [{ id: `chk-${suffix}-${eventId}`, participantId: person.id, name: NAME, action: 'IN', deskId: 'd', actor: 'a', at: '2026-12-01T01:00:00.000Z', before: { inside: false, everIn: false }, corrected: false }];
  row.visits = [{ id: 'v1', boothId: 'b', participantId: person.id, name: NAME, at: '2026-12-01T01:00:00.000Z' }];
  row.responses = [{ id: 'r1', moduleId: 'm', participantId: person.id, answer: '보기 1', comment: '개인 연락처 010-7777-8888 로 연락주세요', at: 'x' }];
  row.questions = [{ id: 'q1', moduleId: 'm', participantId: person.id, name: NAME, text: '질문입니다', answer: '', approved: true, likes: [], at: 'x' }];
  row.photos = [{ id: 'ph1', participantId: person.id, name: NAME, image: { fileId: 'f1' }, caption: '우리 가족', status: 'APPROVED', at: 'x' }];
  row.posts = [{ id: 'po1', participantId: person.id, name: NAME, body: '안녕하세요', status: 'APPROVED', at: 'x' }];
  row.messages = [{ id: 'msg1', status: 'DONE', recipientIds: [person.id, other.id],
    recipientSnapshot: [{ id: person.id, name: NAME, phone: PHONE }, { id: other.id, name: '박다른', phone: '01099990000' }],
    deliveries: [{ participantId: person.id, name: NAME, status: 'DELIVERED' }, { participantId: other.id, name: '박다른', status: 'DELIVERED' }] }];
  row.rewards = [{ id: 'rw1', participantId: person.id, name: '상품권', method: 'ONSITE', status: 'READY', at: 'x', claim: null }];
  row.drawPrograms = [{ id: 'dp1', winners: [{ id: person.id, name: NAME, company: '가나다 주식회사', kind: 'PERSON' }] }];
  row.audit = [{ id: 'au1', type: 'participant.resolve-cancellation-conflict', actor: 'x', at: 'x', detail: `${NAME} · 사유`, eventId, cancellationResolution: { participantId: person.id, participantName: NAME } }];
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [eventId, JSON.stringify(row)]);
  await harness.database.query(`INSERT INTO checkin_records (id, event_id, participant_id, name, action) VALUES ($1, $2, $3, $4, 'IN')`, [`chk-${suffix}-${eventId}`, eventId, person.id, NAME]);
  await harness.database.query(`INSERT INTO attendee_challenges (id, event_id, phone, purpose, code_hash, expires_at) VALUES ($1, $2, $3, 'RECOVER', 'h', now() + interval '1 hour')`, [`ch-${suffix}-${eventId}`, eventId, PHONE]);
  await harness.database.query(`INSERT INTO attendee_challenges (id, event_id, phone, purpose, code_hash, expires_at) VALUES ($1, $2, $3, 'RECOVER', 'h', now() + interval '1 hour')`, [`ch2-${suffix}-${eventId}`, eventId, '01099990000']);
  return { person, other };
}

test('participant.erase anonymizes the record and every copy, audits without values, and keeps counts', async () => {
  const { person, other } = await seedPerson(ids.live);
  // A receipt that holds a copy of the participant (a roster registration response).
  const created = await run(ids.live, 'participant.create', { name: '복사본 참가자', phone: '01012341234', email: 'copy@example.test' }, cookies.manager);
  assert.equal(created.status, 201);
  const copyId = created.json.participant.id;

  const denied = await run(ids.live, 'participant.erase', { id: person.id }, cookies.limited);
  assert.equal(denied.status, 403);
  assert.equal((await run(ids.live, 'participant.erase', { id: person.id }, cookies.staff)).status, 403);
  assert.equal((await run(ids.live, 'participant.erase', { id: person.id, expectedName: '다른 이름' }, cookies.manager)).status, 409);
  assert.equal((await run(ids.live, 'participant.erase', { id: 'person-missing' }, cookies.manager)).status, 404);
  assert.equal((await workspaceOf(ids.live)).participants.find((item) => item.id === person.id).name, NAME, 'rejected attempts change nothing');

  const eraseId = command();
  const erased = await run(ids.live, 'participant.erase', { id: person.id, expectedName: NAME }, cookies.manager, eraseId);
  assert.equal(erased.status, 200, JSON.stringify(erased.json));
  assert.deepEqual(erased.json.participant.erased, true);
  assert.equal(erased.json.participant.name, '삭제된 참가자');
  assert.equal(JSON.stringify(erased.json).includes(NAME), false);
  assert.equal(JSON.stringify(erased.json).includes(PHONE), false);

  const ws = await workspaceOf(ids.live);
  const text = JSON.stringify(ws);
  for (const secret of [NAME, PHONE, 'jiwoo@example.test', '가나다', '알레르기', '임의 열', '010-7777-8888', '우리 가족']) {
    assert.equal(text.includes(secret), false, `workspace no longer contains ${secret}`);
  }
  const stored = ws.participants.find((item) => item.id === person.id);
  assert.equal(stored.status, 'CANCELLED');
  assert.equal(stored.revoked, true);
  assert.equal(stored.erased, true);
  assert.ok(stored.erasedAt);
  assert.equal(stored.phone, '');
  assert.deepEqual(stored.answers, {});
  assert.deepEqual(stored.consent, person.consent, 'consent evidence stays');
  assert.equal(ws.checks.length, 1, 'check-in history stays');
  assert.equal(ws.checks[0].action, 'IN');
  assert.equal(ws.checks[0].name, '');
  assert.equal(ws.responses[0].answer, '보기 1', 'aggregate answer stays');
  assert.equal(ws.responses[0].comment, '');
  assert.equal(ws.questions[0].approved, false);
  assert.equal(ws.photos[0].status, 'HIDDEN');
  assert.equal(ws.photos[0].image.fileId, 'f1', 'bytes and reference are never deleted');
  assert.equal(ws.posts[0].status, 'HIDDEN');
  assert.equal(ws.rewards[0].name, '상품권');
  assert.equal(ws.rewards[0].participantId, person.id);
  assert.equal(ws.drawPrograms[0].winners[0].id, person.id);
  assert.equal(ws.messages[0].recipientSnapshot[1].phone, '01099990000', 'other recipients untouched');
  assert.equal(ws.participants.find((item) => item.id === other.id).name, '박다른');
  const audit = ws.audit.find((entry) => entry.id === eraseId);
  assert.deepEqual({ type: audit.type, participantId: audit.participantId, eventId: audit.eventId, detail: audit.detail }, { type: 'participant.erase', participantId: person.id, eventId: ids.live, detail: '' });
  assert.equal(audit.actor, accountIds.manager);

  assert.equal((await harness.database.query(`SELECT name FROM checkin_records WHERE event_id=$1 AND participant_id=$2`, [ids.live, person.id])).rows[0].name, '');
  const challenges = await harness.database.query(`SELECT phone FROM attendee_challenges WHERE event_id=$1 ORDER BY phone`, [ids.live]);
  assert.deepEqual(challenges.rows.map((row) => row.phone), ['01099990000']);
  const ticket = await harness.database.query(`SELECT revoked FROM tickets WHERE participant_id=$1`, [person.id]);
  assert.equal(ticket.rows[0].revoked, true);

  // The copy participant's receipt is unaffected; erasing it scrubs the saved response.
  const receiptBefore = await harness.database.query(`SELECT result FROM command_receipts WHERE event_id=$1 AND result::text LIKE $2`, [ids.live, `%${copyId}%`]);
  assert.ok(receiptBefore.rows.length >= 1);
  const copyErase = await run(ids.live, 'participant.erase', { id: copyId }, cookies.agency);
  assert.equal(copyErase.status, 200);
  const receiptAfter = await harness.database.query(`SELECT result FROM command_receipts WHERE event_id=$1 AND result::text LIKE $2`, [ids.live, `%${copyId}%`]);
  const receiptText = JSON.stringify(receiptAfter.rows.map((row) => row.result));
  assert.equal(receiptText.includes('복사본 참가자'), false);
  assert.equal(receiptText.includes('01012341234'), false);
  assert.equal(receiptText.includes('copy@example.test'), false);
  assert.equal(copyErase.json.cleaned.receipts >= 1, true);

  // Same command id replays; a different participant under it conflicts; an erased record is closed to edits.
  const replay = await run(ids.live, 'participant.erase', { id: person.id, expectedName: NAME }, cookies.manager, eraseId);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.participant.id, person.id);
  assert.equal((await run(ids.live, 'participant.erase', { id: other.id }, cookies.manager, eraseId)).status, 409);
  assert.equal((await run(ids.live, 'participant.erase', { id: person.id }, cookies.manager)).status, 409);
  assert.equal((await run(ids.live, 'participant.update', { id: person.id, name: '되살리기', phone: PHONE }, cookies.manager)).status, 409);
  assert.equal((await run(ids.live, 'participant.status', { id: person.id, status: 'APPROVED' }, cookies.manager)).status, 409);
  assert.equal((await run(ids.live, 'ticket.reissue', { id: person.id }, cookies.manager)).status, 409);
});

test('participant.erase works after the event ended and after it was archived', async () => {
  for (const key of ['ended', 'archived']) {
    const { person } = await seedPerson(ids[key], { inside: true });
    const result = await run(ids[key], 'participant.erase', { id: person.id }, cookies.manager);
    assert.equal(result.status, 200, `${key}: ${JSON.stringify(result.json)}`);
    const stored = (await workspaceOf(ids[key])).participants.find((item) => item.id === person.id);
    assert.equal(stored.erased, true);
    assert.equal(stored.inside, true, 'history flag stays for counts after the event');
    assert.equal(JSON.stringify(await workspaceOf(ids[key])).includes(NAME), false);
  }
});

test('participant.erase asks a person who is still inside a live event to check out first', async () => {
  const { person } = await seedPerson(ids.inside, { inside: true });
  const blocked = await run(ids.inside, 'participant.erase', { id: person.id }, cookies.manager);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, 'PARTICIPANT_INSIDE');
  assert.equal((await workspaceOf(ids.inside)).participants.find((item) => item.id === person.id).name, NAME);
});

test('participant.erase requests a refund for a paid, still active participant', async () => {
  const row = await workspaceOf(ids.live);
  const paid = participant({ name: '결제 참가자', phone: '01055550000', paymentStatus: 'PAID' });
  row.participants.push(paid);
  row.payments = [{ id: 'pay1', participantId: paid.id, amount: 1000, status: 'PAID', at: 'x' }];
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [ids.live, JSON.stringify(row)]);
  assert.equal((await run(ids.live, 'participant.erase', { id: paid.id }, cookies.manager)).status, 200);
  const ws = await workspaceOf(ids.live);
  assert.equal(ws.payments.find((item) => item.id === 'pay1').status, 'REFUND_REQUESTED');
  assert.equal(ws.participants.find((item) => item.id === paid.id).paymentStatus, 'REFUND_REQUESTED');
});

test('a newly created event starts with the consent template and an empty contact; its public projection carries the contact field', async () => {
  const created = await requestJson(harness.baseUrl, '/api/events', { method: 'POST', cookie: cookies.agency, body: {
    commandId: command(), name: '새 행사', slug: `policy-new-${suffix}`.slice(0, 50), date: '2026-12-20', start: '09:00', end: '17:00', capacity: 10,
  } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const eventId = created.json.event.id;
  try {
    const ws = await workspaceOf(eventId);
    assert.equal(ws.consentText, consentTemplate('', ''));
    assert.equal(ws.consentVersion, 1);
    assert.equal(ws.participantContact, '');
  } finally {
    await deleteFixtureRows(harness.database, { eventIds: [eventId] });
  }
});
