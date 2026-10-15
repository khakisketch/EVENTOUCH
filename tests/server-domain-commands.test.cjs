'use strict';

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  insertAssignment,
  sessionCookie,
  requestJson,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const accounts = {
  agency: `domain-agency-${suffix}`,
  manager: `domain-manager-${suffix}`,
  outside: `domain-outside-${suffix}`,
  staff: `domain-staff-${suffix}`,
};
const eventIds = [];
let harness;
let cookies = {};
let fixtureNumber = 0;

function commandId() {
  return `domain-${crypto.randomUUID()}`;
}

function participant(eventId, name, overrides = {}) {
  return {
    id: `person-${crypto.randomUUID()}`,
    name,
    phone: `010${String(crypto.randomInt(10000000, 99999999))}`,
    email: '',
    company: '검증 소속',
    group: '일반',
    status: 'APPROVED',
    inside: false,
    everIn: false,
    revoked: false,
    ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
    ticketExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    registrationType: 'PRE',
    paymentStatus: 'FREE',
    answers: {},
    consent: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function workspaceDefaults(overrides = {}) {
  return {
    participants: [],
    fields: [
      { id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true },
      { id: 'company', label: '소속', type: 'text', required: false },
    ],
    publishedFields: [],
    formVersion: 1,
    publishedVersion: 0,
    registrationOpen: false,
    approvalRequired: false,
    consentText: '검증용 행사 안내',
    consentVersion: 1,
    notices: [],
    program: [],
    venue: { name: '', address: '', directions: '', contact: '', description: '' },
    groups: ['일반', 'VIP'],
    desks: [],
    booths: [],
    assignments: [],
    checks: [],
    visits: [],
    modules: [],
    responses: [],
    questions: [],
    photos: [],
    posts: [],
    messages: [],
    reports: [],
    payments: [],
    rewards: [],
    audit: [],
    display: { type: 'idle', moduleId: null },
    branding: { tagline: '행사 안내', logo: null, keyvisual: null },
    stampMode: 'STAFF',
    allowReentry: true,
    price: 0,
    ...overrides,
  };
}

async function createFixture({
  stage = 'READY',
  features = [],
  participants = [],
  workspace = {},
  membership = true,
} = {}) {
  fixtureNumber += 1;
  const id = `domain-${fixtureNumber}-${suffix}`;
  const slug = `domain-${fixtureNumber}-${suffix}`;
  const savedWorkspace = workspaceDefaults({ ...workspace, participants });
  await insertEvent(harness.database, {
    id,
    slug,
    payload: {
      id,
      slug,
      name: '도메인 명령 검증 행사',
      clientId: null,
      date: '2026-12-01',
      start: '09:00',
      end: '17:00',
      capacity: 100,
      stage,
      features,
    },
    workspace: savedWorkspace,
  });
  if (membership) await insertMembership(harness.database, accounts.manager, id, ['all']);
  eventIds.push(id);
  return { id, slug, workspace: savedWorkspace };
}

async function readWorkspace(eventId) {
  const result = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [eventId]
  );
  return result.rows[0].payload;
}

async function writeWorkspace(eventId, workspace) {
  await harness.database.query(
    'UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [eventId, JSON.stringify(workspace)]
  );
}

async function readEvent(eventId) {
  const result = await harness.database.query(
    'SELECT slug, payload, revision FROM events WHERE id = $1',
    [eventId]
  );
  return result.rows[0];
}

function operator(event, command, payload, { actor = 'manager', id = commandId() } = {}) {
  return requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST',
    cookie: cookies[actor],
    body: { commandId: id, command, payload },
  });
}

function attendee(event, ticket, command, payload, id = commandId()) {
  return requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST',
    bearer: ticket,
    body: { commandId: id, command, payload },
  });
}

async function addStoredFile(eventId, { type = 'image/jpeg', name = 'proof.jpg', size = 4 } = {}) {
  const id = `file-${crypto.randomUUID()}`;
  await harness.database.query(
    `INSERT INTO stored_files (id, event_id, storage_key, original_name, content_type, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, eventId, `eventouch/${eventId}/${id}`, name, type, size, accounts.manager]
  );
  return id;
}

async function seedAssignment(event, deskId) {
  const id = `assignment-${crypto.randomUUID()}`;
  await insertAssignment(harness.database, {
    id,
    accountId: accounts.staff,
    eventId: event.id,
    type: 'DESK',
    targetId: deskId,
  });
  const state = await readWorkspace(event.id);
  state.assignments.push({ id, accountId: accounts.staff, type: 'DESK', targetId: deskId });
  await writeWorkspace(event.id, state);
  return id;
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '운영사 관리자'],
    ['manager', 'MANAGER', '행사 매니저'],
    ['outside', 'MANAGER', '다른 행사 매니저'],
    ['staff', 'STAFF', '현장 스태프'],
  ]) {
    await insertAccount(harness.database, {
      id: accounts[key],
      role,
      name,
      email: `${accounts[key]}@example.test`,
    });
    cookies[key] = await sessionCookie(harness, accounts[key]);
  }
});

after(async () => {
  if (harness) await harness.close();
});

test('event-preparation-enforces-forward-stage-transitions-and-live/archive-gates', async () => {
  const event = await createFixture({ stage: 'DRAFT', features: ['poll'] });
  const ready = await operator(event, 'event.stage', { stage: 'READY' });
  assert.equal(ready.status, 200, JSON.stringify(ready.json));
  assert.equal((await operator(event, 'form.publish', {})).status, 200);
  const program = await operator(event, 'module.save', {
    type: 'poll', title: '상태 검증 투표', options: '찬성\n반대',
  });
  assert.equal(program.status, 201, JSON.stringify(program.json));
  assert.equal((await operator(event, 'module.status', { id: program.json.module.id, status: 'OPEN' })).status, 200);

  const missingDesk = await operator(event, 'event.stage', { stage: 'LIVE' });
  assert.equal(missingDesk.status, 409);

  const desk = await operator(event, 'desk.save', {
    name: '입장 데스크', action: 'IN', mode: 'desk', open: true,
  });
  assert.equal(desk.status, 201, JSON.stringify(desk.json));
  await seedAssignment(event, desk.json.desk.id);
  const live = await operator(event, 'event.stage', { stage: 'LIVE' });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  assert.equal((await readEvent(event.id)).payload.stage, 'LIVE');

  const downgrade = await operator(event, 'event.stage', { stage: 'READY' });
  assert.equal(downgrade.status, 409);
  const ended = await operator(event, 'event.stage', { stage: 'ENDED' });
  assert.equal(ended.status, 200, JSON.stringify(ended.json));

  const archiveWhileOpen = await operator(event, 'event.stage', { stage: 'ARCHIVED' });
  assert.equal(archiveWhileOpen.status, 409);
  assert.equal((await operator(event, 'form.close', {})).status, 200);
  const archiveWithOpenProgram = await operator(event, 'event.stage', { stage: 'ARCHIVED' });
  assert.equal(archiveWithOpenProgram.status, 409);
  assert.equal((await operator(event, 'module.status', { id: program.json.module.id, status: 'CLOSED' })).status, 200);
  const archived = await operator(event, 'event.stage', { stage: 'ARCHIVED' });
  assert.equal(archived.status, 200, JSON.stringify(archived.json));
  assert.equal((await operator(event, 'event.stage', { stage: 'ENDED' })).status, 409);
  assert.equal((await operator(event, 'notice.save', { title: '변경', body: '보관 이후 쓰기' })).status, 409);
});

test('event-settings-update-posts-event-and-workspace-atomically-and-validates-capacity-and-slug', async () => {
  const people = [participant('pending', '기존 참가자')];
  const event = await createFixture({ participants: people });
  const updated = await operator(event, 'event.update', {
    name: '새 행사명', slug: `${event.slug}-next`, date: '2026-12-02',
    start: '10:00', end: '18:00', capacity: 5, stage: 'READY',
    approvalRequired: true, allowReentry: false, price: 2500,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  const row = await readEvent(event.id);
  assert.equal(row.slug, `${event.slug}-next`);
  assert.equal(row.payload.name, '새 행사명');
  assert.equal(row.payload.date, '2026-12-02');
  assert.equal((await readWorkspace(event.id)).price, 2500);
  // Phone-verification opt-in rides the same boolean pattern: explicit set
  // persists, omission preserves the stored value (normalized to false on
  // the first save, like the other workspace flags).
  assert.equal((await readWorkspace(event.id)).verificationRequired, false);
  const verified = await operator(event, 'event.update', {
    name: '새 행사명', slug: `${event.slug}-next`, date: '2026-12-02',
    start: '10:00', end: '18:00', capacity: 5, stage: 'READY', price: 2500,
    verificationRequired: true,
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  assert.equal((await readWorkspace(event.id)).verificationRequired, true);
  const preserved = await operator(event, 'event.update', {
    name: '새 행사명', slug: `${event.slug}-next`, date: '2026-12-02',
    start: '10:00', end: '18:00', capacity: 5, stage: 'READY', price: 2500,
  });
  assert.equal(preserved.status, 200, JSON.stringify(preserved.json));
  assert.equal((await readWorkspace(event.id)).verificationRequired, true);

  const tooSmall = await operator(event, 'event.update', {
    name: '새 행사명', slug: `${event.slug}-next`, date: '2026-12-02',
    start: '10:00', end: '18:00', capacity: -1, stage: 'READY', price: 2500,
  });
  assert.equal(tooSmall.status, 400);
  const malformedFeatures = await operator(event, 'event.features', { features: 'poll' });
  assert.equal(malformedFeatures.status, 400);
  const invalidFeature = await operator(event, 'event.features', { features: ['unknown-feature'] });
  assert.equal(invalidFeature.status, 400);
  const features = await operator(event, 'event.features', { features: ['poll', 'qa', 'poll'] });
  assert.equal(features.status, 200, JSON.stringify(features.json));
  assert.deepEqual((await readEvent(event.id)).payload.features, ['poll', 'qa']);
});

test('concurrent-event-settings-reserve-a-shared-slug-and-return-conflicts-not-database-errors', async () => {
  const events = [];
  for (let index = 0; index < 8; index += 1) events.push(await createFixture());
  const slug = `shared-domain-${suffix}`;
  const results = await Promise.all(events.map((event, index) => operator(event, 'event.update', {
    name: `동시 행사 ${index}`,
    slug,
    date: '2026-12-01',
    start: '09:00',
    end: '17:00',
    capacity: 100,
    stage: 'READY',
    price: 0,
  })));
  assert.deepEqual(results.map((result) => result.status).sort((left, right) => left - right), [
    200, 409, 409, 409, 409, 409, 409, 409,
  ]);
  const saved = await harness.database.query('SELECT count(*)::int AS count FROM events WHERE slug = $1', [slug]);
  assert.equal(saved.rows[0].count, 1);
});

test('registration-form-and-group-commands-keep-draft-and-published-fields-separated', async () => {
  const person = participant('pending', '그룹 지정 대상');
  const event = await createFixture({ participants: [person] });
  const field = await operator(event, 'field.save', {
    id: 'meal', label: '식사 선택', type: 'select', required: true, options: '일반\n채식',
  });
  assert.equal(field.status, 200, JSON.stringify(field.json));
  let state = await readWorkspace(event.id);
  assert.deepEqual(state.fields.find((item) => item.id === 'meal').options, ['일반', '채식']);

  const publish = await operator(event, 'form.publish', { consentText: '검증된 동의 문구' });
  assert.equal(publish.status, 200, JSON.stringify(publish.json));
  state = await readWorkspace(event.id);
  assert.equal(state.registrationOpen, true);
  assert.equal(state.publishedVersion, state.formVersion);
  assert.equal(state.consentText, '검증된 동의 문구');
  assert.ok(state.publishedFields.some((item) => item.id === 'meal'));

  const draftUpdate = await operator(event, 'field.save', {
    id: 'meal', label: '점심 메뉴', type: 'select', required: false, options: '일반\n채식\n알레르기식',
  });
  assert.equal(draftUpdate.status, 200, JSON.stringify(draftUpdate.json));
  state = await readWorkspace(event.id);
  assert.equal(state.fields.find((item) => item.id === 'meal').label, '점심 메뉴');
  assert.equal(state.publishedFields.find((item) => item.id === 'meal').label, '식사 선택');

  assert.equal((await operator(event, 'field.delete', { id: 'name' })).status, 400);
  assert.equal((await operator(event, 'group.save', { name: '초청' })).status, 201);
  assert.equal((await operator(event, 'group.assign', { group: '초청', ids: [person.id] })).status, 200);
  assert.equal((await readWorkspace(event.id)).participants[0].group, '초청');
  assert.equal((await operator(event, 'form.close', {})).status, 200);
  assert.equal((await readWorkspace(event.id)).registrationOpen, false);
});

test('notice-program-branding-and-attendee-page-commands-validate-and-persist-file-references', async () => {
  const event = await createFixture({ features: ['venue'] });
  const logoId = await addStoredFile(event.id, { name: 'logo.png', type: 'image/png', size: 12 });
  const pdfId = await addStoredFile(event.id, { name: 'schedule.pdf', type: 'application/pdf', size: 50 });
  const other = await createFixture({ features: ['venue'] });
  const foreignFile = await addStoredFile(other.id);

  const notice = await operator(event, 'notice.save', {
    title: '입장 안내', body: '모바일 티켓을 준비해 주세요.', published: true, pinned: true,
  });
  assert.equal(notice.status, 201, JSON.stringify(notice.json));
  const venue = await operator(event, 'venue.save', {
    name: '메인 전시장', address: '서울시 검증구 1', directions: '동문으로 입장',
    contact: '02-0000-0000', description: '지하철 출구에서 도보 3분',
  });
  assert.equal(venue.status, 200, JSON.stringify(venue.json));
  const badProgram = await operator(event, 'program.save', {
    title: '잘못된 시간표', date: '2026-12-01', start: '12:00', end: '11:00',
  });
  assert.equal(badProgram.status, 400);
  const foreignAttachment = await operator(event, 'program.save', {
    title: '다른 행사 자료', date: '2026-12-01', start: '10:00', end: '11:00', attachment: { fileId: foreignFile },
  });
  assert.equal(foreignAttachment.status, 404);

  const program = await operator(event, 'program.save', {
    title: '환영 세션', date: '2026-12-01', start: '10:00', end: '11:00',
    place: '메인 홀', description: '행사 안내', published: true, attachment: { fileId: pdfId },
  });
  assert.equal(program.status, 201, JSON.stringify(program.json));
  const rawBlob = await operator(event, 'branding.save', {
    tagline: '다음 만남', logo: { data: 'data:image/png;base64,aGVsbG8=', width: 1, height: 1 },
  });
  assert.equal(rawBlob.status, 400);
  const branding = await operator(event, 'branding.save', {
    tagline: '다음 만남', logo: { fileId: logoId },
  });
  assert.equal(branding.status, 200, JSON.stringify(branding.json));
  const page = await operator(event, 'attendee.page.save', {
    intro: '모바일 안내', accent: '#123456', showAnnouncements: true,
    showSchedule: false, showVenue: true, showPrograms: true,
    keyvisual: { fileId: logoId },
  });
  assert.equal(page.status, 200, JSON.stringify(page.json));
  const pagePublish = await operator(event, 'attendee.page.publish', {});
  assert.equal(pagePublish.status, 200, JSON.stringify(pagePublish.json));

  let state = await readWorkspace(event.id);
  assert.equal(state.venue.name, '메인 전시장');
  assert.equal(state.branding.tagline, '모바일 안내');
  assert.deepEqual(state.branding.logo, { fileId: logoId, name: 'logo.png', type: 'image/png', size: 12 });
  assert.equal(state.pageExperience.published.accent, '#123456');
  assert.equal(state.pageExperience.published.showSchedule, false);
  assert.equal(state.program[0].attachment.fileId, pdfId);
  assert.equal(Object.hasOwn(state.program[0].attachment, 'data'), false);
  const publicPage = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(publicPage.json.workspace.branding.logo?.fileId, logoId);
  assert.equal(publicPage.json.workspace.program[0].attachment?.fileId, pdfId);
  assert.equal((await operator(event, 'notice.delete', { id: notice.json.notice.id })).status, 200);
  assert.equal((await readWorkspace(event.id)).notices.length, 0);
});

test('module-and-response-commands-enforce-feature-status-ticket-identity-and-one-response', async () => {
  const eligible = participant('pending', '설문 참가자');
  const secondEligible = participant('pending', '두 번째 투표 참가자');
  const pending = participant('pending', '미승인 참가자', { status: 'PENDING' });
  const event = await createFixture({
    stage: 'LIVE', features: ['poll', 'survey'], participants: [eligible, secondEligible, pending],
  });
  const disabled = await operator(event, 'module.save', {
    type: 'quiz', title: '기능 꺼진 퀴즈', answer: '정답',
  });
  assert.equal(disabled.status, 409);
  const module = await operator(event, 'module.save', {
    type: 'poll', title: '기대되는 세션', options: '환영\n네트워킹',
  });
  assert.equal(module.status, 201, JSON.stringify(module.json));
  const moduleId = module.json.module.id;
  const draftPublic = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(draftPublic.json.workspace.modules.length, 0);
  const opened = await operator(event, 'module.status', { id: moduleId, status: 'OPEN' });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal((await operator(event, 'event.features', { features: ['survey'] })).status, 200);
  assert.equal((await readWorkspace(event.id)).modules[0].status, 'OPEN');
  assert.equal((await operator(event, 'event.features', { features: ['poll', 'survey'] })).status, 200);
  const openPublic = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(openPublic.json.workspace.modules.length, 1);

  const invalidAnswer = await attendee(event, eligible.ticket, 'response.submit', {
    moduleId, answer: '없는 항목',
  });
  assert.equal(invalidAnswer.status, 400);
  const deniedPending = await attendee(event, pending.ticket, 'response.submit', {
    moduleId, answer: '환영',
  });
  assert.equal(deniedPending.status, 409);
  const requestId = commandId();
  const response = await attendee(event, eligible.ticket, 'response.submit', {
    moduleId, answer: '환영', comment: '기대합니다',
  }, requestId);
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const replay = await attendee(event, eligible.ticket, 'response.submit', {
    moduleId, answer: '환영', comment: '기대합니다',
  }, requestId);
  assert.equal(replay.status, 200);
  const duplicate = await attendee(event, eligible.ticket, 'response.submit', {
    moduleId, answer: '네트워킹',
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await operator(event, 'module.status', { id: moduleId, status: 'CLOSED' })).status, 200);
  const closedResponse = await attendee(event, secondEligible.ticket, 'response.submit', {
    moduleId, answer: '네트워킹',
  });
  assert.equal(closedResponse.status, 409);
  assert.equal((await readWorkspace(event.id)).responses.length, 1);
  assert.equal((await operator(event, 'module.status', { id: moduleId, status: 'DRAFT' })).status, 200);
  assert.equal((await readWorkspace(event.id)).responses.length, 1);
  assert.equal((await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`)).json.workspace.modules.length, 0);
  const receipt = await harness.database.query(
    'SELECT result FROM command_receipts WHERE command_id = $1', [requestId]
  );
  assert.equal(JSON.stringify(receipt.rows[0].result).includes(eligible.ticket), false);
});

test('survey-responses-require-every-rating-and-remain-one-per-eligible-ticket', async () => {
  const person = participant('pending', '설문 응답 참가자');
  const event = await createFixture({ stage: 'LIVE', features: ['survey'], participants: [person] });
  const module = await operator(event, 'module.save', {
    type: 'survey', title: '행사 만족도', questions: '전반 만족\n장소 만족',
  });
  assert.equal(module.status, 201, JSON.stringify(module.json));
  await operator(event, 'module.status', { id: module.json.module.id, status: 'OPEN' });
  const incomplete = await attendee(event, person.ticket, 'response.submit', {
    moduleId: module.json.module.id, ratings: { '전반 만족': 5 },
  });
  assert.equal(incomplete.status, 400);
  const valid = await attendee(event, person.ticket, 'response.submit', {
    moduleId: module.json.module.id, ratings: { '전반 만족': 5, '장소 만족': 4 },
  });
  assert.equal(valid.status, 201, JSON.stringify(valid.json));
  const duplicate = await attendee(event, person.ticket, 'response.submit', {
    moduleId: module.json.module.id, ratings: { '전반 만족': 4, '장소 만족': 4 },
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual((await readWorkspace(event.id)).responses[0].ratings, {
    '전반 만족': 5, '장소 만족': 4,
  });
});

test('quiz-answers-stay-hidden-until-an-operator-reveals-the-closed-quiz', async () => {
  const person = participant('pending', '퀴즈 응답 참가자');
  const event = await createFixture({ stage: 'LIVE', features: ['quiz'], participants: [person] });
  const module = await operator(event, 'module.save', {
    type: 'quiz', title: '행사 퀴즈', answer: 'EVENTOUCH',
  });
  assert.equal(module.status, 201, JSON.stringify(module.json));
  await operator(event, 'module.status', { id: module.json.module.id, status: 'OPEN' });
  const response = await attendee(event, person.ticket, 'response.submit', {
    moduleId: module.json.module.id, answer: '내 답변',
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const hidden = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(hidden.json.workspace.modules[0].answer, undefined);
  const revealed = await operator(event, 'module.reveal', { id: module.json.module.id });
  assert.equal(revealed.status, 200, JSON.stringify(revealed.json));
  const publicQuiz = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(publicQuiz.json.workspace.modules[0].status, 'CLOSED');
  assert.equal(publicQuiz.json.workspace.modules[0].answer, 'EVENTOUCH');
});

test('concurrent-guest-responses-with-different-command-ids-still-create-only-one-answer', async () => {
  const person = participant('pending', '경쟁 응답 참가자');
  const event = await createFixture({ stage: 'LIVE', features: ['poll'], participants: [person] });
  const module = await operator(event, 'module.save', {
    type: 'poll', title: '동시 투표', options: 'A\nB',
  });
  assert.equal(module.status, 201, JSON.stringify(module.json));
  await operator(event, 'module.status', { id: module.json.module.id, status: 'OPEN' });
  assert.equal((await operator(event, 'event.stage', { stage: 'ENDED' })).status, 200);
  assert.equal((await operator(event, 'module.status', {
    id: module.json.module.id, status: 'CLOSED',
  })).status, 200);
  assert.equal((await operator(event, 'module.status', {
    id: module.json.module.id, status: 'OPEN',
  })).status, 200);
  const results = await Promise.all(['A', 'B', 'A'].map((answer) =>
    attendee(event, person.ticket, 'response.submit', {
      moduleId: module.json.module.id, answer,
    })
  ));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409, 409]);
  assert.equal((await readWorkspace(event.id)).responses.length, 1);
});

test('qa-photo-and-board-submissions-start-pending-and-only-approved-content-is-public', async () => {
  const person = participant('pending', '콘텐츠 제출 참가자');
  const event = await createFixture({
    stage: 'LIVE', features: ['qa', 'photo', 'board'], participants: [person],
  });
  const qa = await operator(event, 'module.save', { type: 'qa', title: '질문하기' });
  assert.equal(qa.status, 201, JSON.stringify(qa.json));
  const qaModule = qa.json.module.id;
  await operator(event, 'module.status', { id: qaModule, status: 'OPEN' });
  const fileId = await addStoredFile(event.id, { type: 'image/jpeg', name: 'moment.jpg', size: 128 });

  const question = await attendee(event, person.ticket, 'question.submit', {
    moduleId: qaModule, text: '행사장 입장은 몇 시부터인가요?',
  });
  assert.equal(question.status, 201, JSON.stringify(question.json));
  const photo = await attendee(event, person.ticket, 'photo.submit', {
    image: { fileId }, caption: '행사 현장',
  });
  assert.equal(photo.status, 201, JSON.stringify(photo.json));
  const post = await attendee(event, person.ticket, 'post.submit', { body: '좋은 행사였습니다.' });
  assert.equal(post.status, 201, JSON.stringify(post.json));

  let state = await readWorkspace(event.id);
  assert.equal(state.questions[0].approved, false);
  assert.equal(state.photos[0].status, 'PENDING');
  assert.equal(state.posts[0].status, 'PENDING');
  const publicBefore = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(publicBefore.status, 200);
  assert.equal(publicBefore.json.workspace.questions.length, 0);
  assert.equal(publicBefore.json.workspace.photos.length, 0);
  assert.equal(publicBefore.json.workspace.posts.length, 0);

  assert.equal((await operator(event, 'question.manage', {
    id: state.questions[0].id, answer: '오전 9시부터입니다.', approved: true,
  })).status, 200);
  assert.equal((await operator(event, 'photo.moderate', {
    id: state.photos[0].id, status: 'APPROVED',
  })).status, 200);
  assert.equal((await operator(event, 'post.moderate', {
    id: state.posts[0].id, status: 'APPROVED',
  })).status, 200);
  const publicAfter = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(publicAfter.json.workspace.questions.length, 1);
  assert.equal(publicAfter.json.workspace.photos.length, 1);
  assert.equal(publicAfter.json.workspace.photos[0].image.fileId, fileId);
  assert.equal(publicAfter.json.workspace.posts.length, 1);

  const questionId = state.questions[0].id;
  const liked = await attendee(event, person.ticket, 'question.like', { id: questionId });
  assert.equal(liked.status, 200, JSON.stringify(liked.json));
  assert.equal((await readWorkspace(event.id)).questions[0].likes.length, 1);
  await attendee(event, person.ticket, 'question.like', { id: questionId });
  assert.equal((await readWorkspace(event.id)).questions[0].likes.length, 0);
  assert.equal((await operator(event, 'event.features', { features: ['photo', 'board'] })).status, 200);
  const disabledLike = await attendee(event, person.ticket, 'question.like', { id: questionId });
  assert.equal(disabledLike.status, 409);
  assert.equal((await readWorkspace(event.id)).questions[0].likes.length, 0);
});

test('draw-results-include-only-eligible-attendees-and-never-repeat-a-winner', async () => {
  const eligible = participant('pending', '입장한 참가자', { everIn: true });
  const notEntered = participant('pending', '미입장 참가자');
  const canceled = participant('pending', '취소 참가자', { status: 'CANCELLED', revoked: true, everIn: true });
  const event = await createFixture({
    stage: 'LIVE', features: ['draw'], participants: [eligible, notEntered, canceled],
  });
  const module = await operator(event, 'module.save', { type: 'draw', title: '현장 추첨' });
  assert.equal(module.status, 201, JSON.stringify(module.json));
  const id = module.json.module.id;
  await operator(event, 'module.status', { id, status: 'OPEN' });
  const result = await operator(event, 'draw.run', { id, count: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.deepEqual(result.json.winners, [{
    id: eligible.id, name: eligible.name, company: eligible.company,
  }]);
  assert.equal(result.json.poolCount, 1);
  assert.equal((await operator(event, 'draw.run', { id, count: 1 })).status, 409);
  assert.equal((await operator(event, 'draw.publish', { id })).status, 200);
  const saved = (await readWorkspace(event.id)).modules[0];
  assert.equal(saved.drawHistory[0].published, true);
});

test('message-and-template-commands-record-simulation-or-unconnected-state-only', async () => {
  const first = participant('pending', '메시지 대상 1');
  const second = participant('pending', '메시지 대상 2', { status: 'CANCELLED', revoked: true });
  const event = await createFixture({ participants: [first, second] });
  const template = await operator(event, 'template.save', {
    name: '검증 안내', channel: 'SMS', body: '{{이름}}님 {{행사명}} 안내입니다.',
  });
  assert.equal(template.status, 200, JSON.stringify(template.json));
  const invalidVariables = await operator(event, 'message.create', {
    ids: [first.id], title: '검증 발송', channel: 'SMS', body: '{{전화번호}}', simulate: true,
  });
  assert.equal(invalidVariables.status, 400);
  const invalidTarget = await operator(event, 'message.create', {
    ids: [first.id, second.id], title: '검증 발송', channel: 'SMS', body: '안내', simulate: true,
  });
  assert.equal(invalidTarget.status, 409);

  const simulated = await operator(event, 'message.create', {
    ids: [first.id], title: '시뮬레이션', channel: 'SMS', body: '{{이름}}님 {{행사명}} 안내입니다.',
    simulate: true,
  });
  assert.equal(simulated.status, 201, JSON.stringify(simulated.json));
  assert.equal(simulated.json.message.status, 'SIMULATED');
  assert.equal(simulated.json.message.deliveries[0].status, 'SIMULATED');

  // Alimtalk cannot be sent from free text, so a campaign without an
  // approved Solapi template is refused rather than accepted and never sent.
  const alimtalkWithoutTemplate = await operator(event, 'message.create', {
    ids: [first.id], title: '승인 템플릿 없음', channel: 'ALIMTALK', body: '예약 전 미연동', simulate: false,
  });
  assert.equal(alimtalkWithoutTemplate.status, 400);
  assert.equal(alimtalkWithoutTemplate.json.field, 'templateId');

  // Saving an alimtalk template without the approved id is refused too.
  const templateWithoutApproval = await operator(event, 'template.save', {
    name: '승인 없는 알림톡', channel: 'ALIMTALK', body: '{{이름}}님 안내',
  });
  assert.equal(templateWithoutApproval.status, 400);

  const alimtalkTemplate = await operator(event, 'template.save', {
    name: '승인된 알림톡', channel: 'ALIMTALK', body: '{{이름}}님 {{행사명}} 안내입니다.',
    solapiTemplateId: 'KAxxxxxxxxxxxxxxxx',
  });
  assert.equal(alimtalkTemplate.status, 200, JSON.stringify(alimtalkTemplate.json));
  assert.equal(alimtalkTemplate.json.template.solapiTemplateId, 'KAxxxxxxxxxxxxxxxx');

  const pendingConnection = await operator(event, 'message.create', {
    ids: [first.id], title: '미연동 요청', channel: 'ALIMTALK', body: '예약 전 미연동', simulate: false,
    templateId: alimtalkTemplate.json.template.id,
  });
  assert.equal(pendingConnection.status, 201, JSON.stringify(pendingConnection.json));
  assert.equal(pendingConnection.json.message.solapiTemplateId, 'KAxxxxxxxxxxxxxxxx');
  assert.equal(pendingConnection.json.message.status, 'NEEDS_CONNECTION');
  assert.equal(pendingConnection.json.message.deliveries[0].status, 'UNCONNECTED');
  assert.equal((await operator(event, 'message.retry', { id: pendingConnection.json.message.id })).status, 200);
  const state = await readWorkspace(event.id);
  const retried = state.messages.find((item) => item.id === pendingConnection.json.message.id);
  assert.equal(retried.status, 'NEEDS_CONNECTION');
  assert.equal(retried.attempts, 2);
  assert.equal(retried.deliveries[0].status, 'UNCONNECTED');
  assert.equal((await operator(event, 'message.cancel', { id: retried.id })).status, 200);
  assert.equal((await readWorkspace(event.id)).messages.find((item) => item.id === retried.id).status, 'CANCELLED');
});

test('reports-use-server-derived-snapshots-and-published-versions-cannot-be-mutated', async () => {
  const person = participant('pending', '보고서 집계 참가자', { everIn: true, inside: true });
  const event = await createFixture({
    stage: 'ENDED', features: ['survey'], participants: [person],
  });
  const initial = await readWorkspace(event.id);
  initial.modules.push({
    id: 'survey-module', type: 'survey', title: '만족도', status: 'CLOSED', published: true,
    questions: ['전반 만족'], options: [], answer: '', revealed: false,
  });
  initial.responses.push({
    id: 'survey-response', moduleId: 'survey-module', participantId: person.id,
    answer: 'SUBMITTED', ratings: { '전반 만족': 5 }, at: '2026-12-01T12:00:00.000Z',
  });
  await writeWorkspace(event.id, initial);

  const emptyReport = await operator(event, 'report.create', { title: '항목 없는 보고서', sections: [] });
  assert.equal(emptyReport.status, 400);
  const created = await operator(event, 'report.create', {
    title: '행사 결과', subtitle: '표지 부제목', coverNote: '표지 문구',
    sections: ['overview', 'attendance', 'survey'],
    summary: '운영 요약', color: '#123456',
    snapshot: { event: { name: '브라우저가 보낸 위조 값' } }, shareToken: 'attacker-controlled-token',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const reportId = created.json.report.id;
  let report = (await readWorkspace(event.id)).reports[0];
  assert.equal(report.subtitle, '표지 부제목');
  assert.equal(report.coverNote, '표지 문구');
  assert.equal(report.snapshot.event.name, '도메인 명령 검증 행사');
  assert.equal(report.snapshot.metrics.total, 1);
  assert.equal(report.snapshot.survey[0].average, '5.0');
  assert.equal(Object.hasOwn(report, 'shareToken'), false);

  await operator(event, 'report.update', {
    id: reportId, title: '확정본', subtitle: '확정 부제목', coverNote: '확정 문구',
    summary: '고정 요약', sections: ['overview'], color: '#654321',
  });
  const published = await operator(event, 'report.publish', { id: reportId });
  assert.equal(published.status, 200, JSON.stringify(published.json));
  report = (await readWorkspace(event.id)).reports.find((item) => item.id === reportId);
  const frozenSnapshot = structuredClone(report.snapshot);

  const state = await readWorkspace(event.id);
  state.participants[0].inside = false;
  state.participants[0].everIn = false;
  await writeWorkspace(event.id, state);
  assert.equal((await operator(event, 'report.update', {
    id: reportId, title: '수정 시도', summary: '', sections: ['overview'], color: '#654321',
  })).status, 409);
  const afterMutation = (await readWorkspace(event.id)).reports.find((item) => item.id === reportId);
  assert.deepEqual(afterMutation.snapshot, frozenSnapshot);

  const successor = await operator(event, 'report.successor', { id: reportId, source: 'current' });
  assert.equal(successor.status, 201, JSON.stringify(successor.json));
  const reports = (await readWorkspace(event.id)).reports;
  const next = reports.find((item) => item.id === successor.json.report.id);
  assert.equal(next.status, 'DRAFT');
  assert.equal(next.version, 3);
  assert.equal(next.parentId, reportId);
  assert.equal(next.subtitle, '확정 부제목');
  assert.equal(next.coverNote, '확정 문구');
  assert.equal(next.snapshot.metrics.inside, 0);
  assert.equal(reports.find((item) => item.id === reportId).snapshot.metrics.inside, 1);
});

test('payment-commands-remain-ticket-bound-simulations-without-provider-side-effects', async () => {
  const person = participant('pending', '결제 시뮬레이션 참가자', { paymentStatus: 'PENDING' });
  const event = await createFixture({ stage: 'LIVE', features: ['payment'], participants: [person] });
  const state = await readWorkspace(event.id);
  state.payments.push({
    id: 'payment-simulation', participantId: person.id, amount: 5000,
    status: 'PENDING', provider: 'UNCONNECTED', at: '2026-12-01T09:00:00.000Z',
  });
  await writeWorkspace(event.id, state);

  const unauthorized = await attendee(event, participant('other', '다른 행사 티켓').ticket,
    'payment.simulate', { id: 'payment-simulation', status: 'PAID' });
  assert.equal(unauthorized.status, 404);
  assert.equal((await operator(event, 'event.features', { features: [] })).status, 200);
  const disabledPayment = await attendee(event, person.ticket, 'payment.simulate', {
    id: 'payment-simulation', status: 'PAID',
  });
  assert.equal(disabledPayment.status, 409);
  assert.equal((await operator(event, 'event.features', { features: ['payment'] })).status, 200);
  const paid = await attendee(event, person.ticket, 'payment.simulate', {
    id: 'payment-simulation', status: 'PAID',
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  let saved = await readWorkspace(event.id);
  assert.equal(saved.payments[0].status, 'PAID');
  assert.equal(saved.payments[0].simulated, true);
  assert.equal(saved.payments[0].provider, 'UNCONNECTED');
  assert.equal(saved.participants[0].paymentStatus, 'PAID');

  const refundRequestId = commandId();
  const refundRequest = await attendee(event, person.ticket, 'payment.refund-request', {
    id: 'payment-simulation', reason: '일정 변경',
  }, refundRequestId);
  assert.equal(refundRequest.status, 200, JSON.stringify(refundRequest.json));
  const refundReplay = await attendee(event, person.ticket, 'payment.refund-request', {
    id: 'payment-simulation', reason: '일정 변경',
  }, refundRequestId);
  assert.equal(refundReplay.status, 200);
  const refund = await operator(event, 'payment.refund', { id: 'payment-simulation' });
  assert.equal(refund.status, 200, JSON.stringify(refund.json));
  saved = await readWorkspace(event.id);
  assert.equal(saved.payments[0].status, 'REFUNDED');
  assert.equal(saved.payments[0].simulated, true);
  assert.equal(saved.participants[0].status, 'CANCELLED');
  assert.equal(saved.participants[0].revoked, true);

  const canceledPerson = participant('pending', '결제 취소 참가자');
  const canceledEvent = await createFixture({ stage: 'LIVE', features: ['payment'], participants: [canceledPerson] });
  const canceledState = await readWorkspace(canceledEvent.id);
  canceledState.payments.push({
    id: 'payment-canceled', participantId: canceledPerson.id, amount: 3000,
    status: 'PENDING', provider: 'UNCONNECTED', at: '2026-12-01T09:00:00.000Z',
  });
  await writeWorkspace(canceledEvent.id, canceledState);
  const cancelId = commandId();
  const canceled = await attendee(canceledEvent, canceledPerson.ticket, 'payment.simulate', {
    id: 'payment-canceled', status: 'CANCELLED',
  }, cancelId);
  assert.equal(canceled.status, 200, JSON.stringify(canceled.json));
  const canceledReplay = await attendee(canceledEvent, canceledPerson.ticket, 'payment.simulate', {
    id: 'payment-canceled', status: 'CANCELLED',
  }, cancelId);
  assert.equal(canceledReplay.status, 200, JSON.stringify(canceledReplay.json));
});

test('domain-writes-require-event-membership-and-never-grant-staff-general-settings', async () => {
  const event = await createFixture({ membership: false });
  const outsideManager = await operator(event, 'notice.save', {
    title: '외부 변경', body: '권한이 없어야 합니다',
  }, { actor: 'outside' });
  assert.equal(outsideManager.status, 403);
  const staff = await operator(event, 'event.update', {
    name: '스태프 설정 변경', slug: event.slug, date: '2026-12-01',
    start: '09:00', end: '17:00', capacity: 100, stage: 'READY',
  }, { actor: 'staff' });
  assert.equal(staff.status, 403);
  assert.equal((await readWorkspace(event.id)).notices.length, 0);
});

test('mms-campaigns-pin-their-photo-before-they-can-go-out', async () => {
  const person = participant('pending', 'MMS 참가자');
  const event = await createFixture({ stage: 'READY', participants: [person] });

  const withoutImage = await operator(event, 'message.create', {
    title: '사진 안내', channel: 'MMS', body: '사진을 확인하세요',
    ids: [person.id],
  });
  assert.equal(withoutImage.status, 400);
  assert.equal(withoutImage.json.field, 'imageFileId');

  const missingFile = await operator(event, 'message.create', {
    title: '사진 안내', channel: 'MMS', body: '사진을 확인하세요',
    ids: [person.id], imageFileId: `file-missing-${suffix}`,
  });
  assert.equal(missingFile.status, 404);

  const fileId = `file-mms-${suffix}`;
  await harness.database.query(
    `INSERT INTO stored_files (id, event_id, storage_key, original_name, content_type, size_bytes, created_by)
     VALUES ($1, $2, $3, 'photo.jpg', 'image/jpeg', 1024, $4)`,
    [fileId, event.id, fileId, accounts.manager]
  );
  const created = await operator(event, 'message.create', {
    title: '사진 안내', channel: 'MMS', body: '사진을 확인하세요',
    ids: [person.id], imageFileId: fileId,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const stored = (await readWorkspace(event.id)).messages[0];
  assert.equal(stored.image.fileId, fileId);
  assert.equal(stored.image.contentType, 'image/jpeg');

  const pngId = `file-mms-png-${suffix}`;
  await harness.database.query(
    `INSERT INTO stored_files (id, event_id, storage_key, original_name, content_type, size_bytes, created_by)
     VALUES ($1, $2, $3, 'photo.png', 'image/png', 1024, $4)`,
    [pngId, event.id, pngId, accounts.manager]
  );
  const pngCampaign = await operator(event, 'message.create', {
    title: '사진 안내', channel: 'MMS', body: '사진을 확인하세요',
    ids: [person.id], imageFileId: pngId,
  });
  assert.equal(pngCampaign.status, 400);
});
