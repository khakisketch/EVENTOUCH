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
  LEGACY_ORG,
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
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
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

test('event basics guard rejects stale settings atomically and preserves receipt replay', async () => {
  const event = await createFixture();
  const baseline = {
    name: '도메인 명령 검증 행사', slug: event.slug, clientId: '', date: '2026-12-01',
    start: '09:00', end: '17:00', capacity: 100, price: 0, format: '',
    approvalRequired: false, allowReentry: true, verificationRequired: false,
  };
  const write = (values, expectedBasics = baseline) => ({ ...baseline, ...values, expectedBasics });

  // An unrelated workspace change must not prevent saving basic settings.
  const field = await operator(event, 'field.save', { id: 'concurrency-field', label: '검증 항목', type: 'text', required: false });
  assert.equal(field.status, 200, JSON.stringify(field.json));
  const firstId = commandId();
  const firstPayload = write({ name: '첫 번째 수정' });
  const first = await operator(event, 'event.update', firstPayload, { id: firstId });
  assert.equal(first.status, 200, JSON.stringify(first.json));

  const current = { ...baseline, name: '첫 번째 수정' };
  const second = await operator(event, 'event.update', { ...current, end: '18:00', capacity: 120,
    verificationRequired: true, expectedBasics: current }, { actor: 'agency' });
  assert.equal(second.status, 200, JSON.stringify(second.json));

  // A response-lost retry uses the same receipt even after a later edit.
  const retry = await operator(event, 'event.update', firstPayload, { id: firstId });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.deepEqual(retry.json, first.json);
  const stale = await operator(event, 'event.update', write({ name: '오래된 화면의 수정' }), { actor: 'manager' });
  assert.equal(stale.status, 409, JSON.stringify(stale.json));
  assert.equal(stale.json.code, 'EVENT_BASICS_CHANGED');
  const saved = await readEvent(event.id);
  const workspace = await readWorkspace(event.id);
  assert.equal(saved.payload.name, '첫 번째 수정');
  assert.equal(saved.payload.end, '18:00');
  assert.equal(saved.payload.capacity, 120);
  assert.equal(workspace.verificationRequired, true);

  // Every setting submitted by the editor participates in the comparison.
  const latest = { ...current, end: '18:00', capacity: 120, verificationRequired: true };
  for (const key of Object.keys(latest)) {
    const value = latest[key];
    const different = typeof value === 'boolean' ? !value : typeof value === 'number' ? value + 1 : `${value}x`;
    const response = await operator(event, 'event.update', { ...latest, expectedBasics: { ...latest, [key]: different } });
    assert.equal(response.status, 409, `${key}: ${JSON.stringify(response.json)}`);
    assert.equal(response.json.code, 'EVENT_BASICS_CHANGED', key);
  }
  const incomplete = { ...latest };
  delete incomplete.allowReentry;
  for (const expectedBasics of [null, incomplete, { ...latest, capacity: '120' }]) {
    const response = await operator(event, 'event.update', { ...latest, expectedBasics });
    assert.equal(response.status, 400, JSON.stringify(response.json));
  }
  assert.deepEqual((await readEvent(event.id)).payload, saved.payload);
  assert.deepEqual(await readWorkspace(event.id), workspace);

  // Existing integrations that do not send the optional baseline still work.
  const legacy = await operator(event, 'event.update', { ...latest, name: '기존 API 호출' });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.json));
});

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '운영사 관리자'],
    ['manager', 'MANAGER', '행사 매니저'],
    ['outside', 'MANAGER', '다른 행사 매니저'],
    ['staff', 'STAFF', '현장 스태프'],
  ]) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,
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

  // Owner decision 2026-11-25: a running entry desk is enough; no staff account has to be assigned.
  const exitOnly = await operator(event, 'desk.save', { name: '퇴장 데스크', action: 'OUT', mode: 'desk', open: true });
  assert.equal(exitOnly.status, 201, JSON.stringify(exitOnly.json));
  assert.equal((await operator(event, 'event.stage', { stage: 'LIVE' })).status, 409, 'an exit desk cannot admit anyone');
  const closed = await operator(event, 'desk.save', { name: '닫힌 데스크', action: 'IN', mode: 'desk', open: false });
  assert.equal(closed.status, 201, JSON.stringify(closed.json));
  assert.equal((await operator(event, 'event.stage', { stage: 'LIVE' })).status, 409, 'a closed entry desk does not count');
  const desk = await operator(event, 'desk.save', {
    name: '입장 데스크', action: 'IN', mode: 'desk', open: true,
  });
  assert.equal(desk.status, 201, JSON.stringify(desk.json));
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

test('group assignment rejects stale selections atomically and replays committed receipts', async () => {
  const first = participant('group-guard', '첫 번째');
  const second = participant('group-guard', '두 번째');
  const event = await createFixture({ participants: [first, second], workspace: { groups: ['일반', 'VIP', '발표자'] } });
  const expectedGroups = [first, second].map(({ id }) => ({ id, group: '일반' }));
  assert.equal((await operator(event, 'group.assign', { group: 'VIP', ids: [first.id] }, { actor: 'agency' })).status, 200);
  const staleId = commandId();
  const stale = await operator(event, 'group.assign', { group: '발표자', ids: [first.id, second.id], expectedGroups }, { id: staleId });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PARTICIPANT_GROUP_CHANGED');
  let state = await readWorkspace(event.id);
  assert.deepEqual(state.participants.map((person) => person.group), ['VIP', '일반']);
  for (const invalid of [null, [], [{ id: first.id, group: 'VIP' }, { id: first.id, group: '일반' }], [{ id: first.id, group: 'VIP' }, { id: second.id, group: null }]]) {
    const response = await operator(event, 'group.assign', { group: '발표자', ids: [first.id, second.id], expectedGroups: invalid });
    assert.equal(response.status, 400);
  }
  const current = [{ id: first.id, group: 'VIP' }, { id: second.id, group: '일반' }];
  const savedId = commandId();
  const saved = await operator(event, 'group.assign', { group: '발표자', ids: [first.id, second.id], expectedGroups: current }, { id: savedId });
  assert.equal(saved.status, 200);
  assert.equal((await operator(event, 'group.assign', { group: 'VIP', ids: [first.id] }, { actor: 'agency' })).status, 200);
  const replay = await operator(event, 'group.assign', { group: '발표자', ids: [first.id, second.id], expectedGroups: current }, { id: savedId });
  assert.equal(replay.status, 200); assert.deepEqual(replay.json, saved.json);
  state = await readWorkspace(event.id);
  assert.deepEqual(state.participants.map((person) => person.group), ['VIP', '발표자']);
});

test('operator bootstrap projects missing groups and booth defaults without writing legacy rows', async () => {
  const person = participant('legacy-group', '이전 참가자');
  delete person.group;
  const booth = { id: 'legacy-booth', name: '이전 부스', status: 'OPEN' };
  const event = await createFixture({ features: ['stamp'], participants: [person], workspace: { booths: [booth] } });
  await insertAssignment(harness.database, { id: `legacy-booth-${suffix}`, accountId: accounts.staff, eventId: event.id, type: 'BOOTH', targetId: booth.id });
  const original = await readWorkspace(event.id);
  for (const path of ['/api/bootstrap', `/api/events/${event.id}/bootstrap`]) {
    for (const actor of ['agency', 'manager']) {
      const result = await requestJson(harness.baseUrl, path, { cookie: cookies[actor] });
      assert.equal(result.status, 200);
      const workspace = result.json.state.workspaces[event.id];
      assert.equal(workspace.participants[0].group, '일반');
      assert.deepEqual(workspace.booths[0], { ...booth, zone: '', capacity: 0, limit: 1, used: 0, startsAt: '', endsAt: '' });
    }
    const staff = await requestJson(harness.baseUrl, path, { cookie: cookies.staff });
    assert.equal(staff.status, 200);
    const projected = staff.json.state.workspaces[event.id];
    assert.equal(Object.hasOwn(projected.booths[0], 'startsAt'), false, 'staff projection stays on its existing public shape');
  }
  assert.deepEqual(await readWorkspace(event.id), original);
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

test('form and participant edit guards preserve answers across conflicts and receipt replay', async () => {
  const person = participant('safe-form', '수정 전', { answers: { meal: '채식', consentExtra: false, retired: '보존할 이전 답변' } });
  const fields = [
    ...workspaceDefaults().fields,
    { id: 'meal', label: '식사', type: 'select', required: true, options: ['일반', '채식'] },
    { id: 'consentExtra', label: '추가 동의', type: 'checkbox', required: false, options: [] },
  ];
  const event = await createFixture({ participants: [person], workspace: { fields, formVersion: 2 } });

  const stale = await operator(event, 'field.save', { id: 'new', label: '새 항목', type: 'text', expectedFormVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await readWorkspace(event.id)).fields.some((field) => field.id === 'new'), false);
  assert.equal((await operator(event, 'form.publish', { expectedFormVersion: 1 })).status, 409);
  assert.equal((await operator(event, 'field.save', { id: 'meal', label: '식사', type: 'select', options: ['일반', '기타'], protectExistingAnswers: true, expectedFormVersion: 2 })).status, 409);
  assert.equal((await operator(event, 'field.save', { id: 'consentExtra', label: '추가 동의', type: 'text', protectExistingAnswers: true, expectedFormVersion: 2 })).status, 409);

  const requestId = commandId();
  const addition = { id: 'new', label: '새 항목', type: 'text', required: false, expectedFormVersion: 2, protectExistingAnswers: true };
  assert.equal((await operator(event, 'field.save', addition, { id: requestId })).status, 200);
  assert.equal((await operator(event, 'field.save', addition, { id: requestId })).status, 200);
  assert.equal((await readWorkspace(event.id)).formVersion, 3);

  const wrongForm = await operator(event, 'participant.update', { id: person.id, name: '다른 이름', expectedFormVersion: 2, expectedValues: { name: person.name } });
  assert.equal(wrongForm.status, 409);
  const changedByOther = await operator(event, 'participant.update', { id: person.id, company: '다른 운영자 변경' });
  assert.equal(changedByOther.status, 200);
  const independent = await operator(event, 'participant.update', {
    id: person.id, name: '수정 후', answers: { meal: '일반' }, expectedFormVersion: 3,
    expectedValues: { name: person.name, answers: { meal: '채식' } },
  });
  assert.equal(independent.status, 200, JSON.stringify(independent.json));
  assert.equal((await operator(event, 'participant.update', { id: person.id, name: '충돌', expectedFormVersion: 3, expectedValues: { name: person.name } })).status, 409);
  assert.equal((await operator(event, 'participant.update', { id: person.id, answers: { meal: '채식' }, expectedFormVersion: 3, expectedValues: { answers: { meal: '채식' } } })).status, 409);
  const saved = (await readWorkspace(event.id)).participants.find((entry) => entry.id === person.id);
  assert.equal(saved.name, '수정 후');
  assert.equal(saved.company, '다른 운영자 변경');
  assert.deepEqual(saved.answers, { meal: '일반', consentExtra: false, retired: '보존할 이전 답변', new: '' });
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

test('question edits are owner-only, preserve the public answer until approval, and replay safely', async () => {
  const owner = participant('pending', '질문 작성자');
  const other = participant('pending', '다른 참가자');
  const event = await createFixture({ stage: 'LIVE', features: ['qa'], participants: [owner, other] });
  const module = (await operator(event, 'module.save', { type: 'qa', title: '질문' })).json.module;
  assert.equal((await operator(event, 'module.status', { id: module.id, status: 'OPEN' })).status, 200);
  const submitted = await attendee(event, owner.ticket, 'question.submit', { moduleId: module.id, text: '원래 질문' });
  assert.equal(submitted.status, 201);
  const id = submitted.json.question.id;
  const first = { id, text: '승인 전 수정', expectedText: '원래 질문', expectedPendingId: '', expectedApproved: false };
  assert.equal((await attendee(event, other.ticket, 'question.edit', first)).status, 404);
  assert.equal((await attendee(event, owner.ticket, 'question.edit', first)).status, 200);
  assert.equal((await operator(event, 'question.manage', { id, answer: '기존 답변', approved: true, expectedText: '원래 질문' })).status, 409);
  assert.equal((await operator(event, 'question.manage', { id, answer: '기존 답변', approved: true, expectedText: '승인 전 수정' })).status, 200);
  const editId = commandId();
  const edit = { id, text: '공개 후 수정안', expectedText: '승인 전 수정', expectedPendingId: '', expectedApproved: true };
  const editResult = await attendee(event, owner.ticket, 'question.edit', edit, editId);
  assert.equal(editResult.status, 200);
  assert.equal((await attendee(event, owner.ticket, 'question.edit', edit, editId)).json.editId, editId);
  const publicBefore = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(publicBefore.json.workspace.questions[0].text, '승인 전 수정');
  assert.equal(publicBefore.json.workspace.questions[0].answer, '기존 답변');
  assert.equal('pendingEdit' in publicBefore.json.workspace.questions[0], false);
  const ownerView = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, { bearer: owner.ticket });
  assert.equal(ownerView.json.workspace.questions[0].pendingEdit.text, '공개 후 수정안');
  const otherView = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, { bearer: other.ticket });
  assert.equal('pendingEdit' in otherView.json.workspace.questions[0], false);
  const approval = { id, expectedEditId: editId, expectedText: '승인 전 수정', expectedAnswer: '기존 답변' };
  assert.equal((await operator(event, 'question.edit.approve', { ...approval, expectedAnswer: '이전 답변' })).status, 409);
  assert.ok([403, 404].includes((await operator(event, 'question.edit.approve', approval, { actor: 'outside' })).status));
  const approvalId = commandId();
  assert.equal((await operator(event, 'question.edit.approve', approval, { id: approvalId })).status, 200);
  assert.equal((await operator(event, 'question.edit.approve', approval, { id: approvalId })).status, 200);
  const stored = (await readWorkspace(event.id)).questions.find((row) => row.id === id);
  assert.equal(stored.text, '공개 후 수정안');
  assert.equal(stored.answer, '기존 답변');
  assert.equal(stored.pendingEdit, undefined);
  assert.equal((await operator(event, 'question.manage', { id, answer: '새 답변', approved: true, expectedText: '공개 후 수정안' })).status, 200);
});

test('rejecting a question edit preserves public content, is private to its author, and can be safely revised', async () => {
  const owner = participant('pending', '질문 작성자');
  const other = participant('pending', '다른 참가자');
  const event = await createFixture({ stage: 'LIVE', features: ['qa'], participants: [owner, other] });
  await insertMembership(harness.database, accounts.outside, event.id, ['participants']);
  const module = (await operator(event, 'module.save', { type: 'qa', title: '질문' })).json.module;
  assert.equal((await operator(event, 'module.status', { id: module.id, status: 'OPEN' })).status, 200);
  const question = (await attendee(event, owner.ticket, 'question.submit', { moduleId: module.id, text: '공개 질문' })).json.question;
  assert.equal((await operator(event, 'question.manage', { id: question.id, answer: '기존 답변', approved: true })).status, 200);
  const editId = commandId();
  const edit = { id: question.id, text: '수정 요청 내용', expectedText: '공개 질문', expectedPendingId: '', expectedApproved: true };
  assert.equal((await attendee(event, owner.ticket, 'question.edit', edit, editId)).status, 200);
  const rejection = { id: question.id, expectedEditId: editId, expectedText: '공개 질문', expectedAnswer: '기존 답변', expectedNewText: '수정 요청 내용', reason: '행사 일정을 확인해 주세요' };
  assert.equal((await attendee(event, owner.ticket, 'question.edit.reject', rejection)).status, 401);
  assert.equal((await operator(event, 'question.edit.reject', rejection, { actor: 'outside' })).status, 403);
  for (const stale of [
    { expectedEditId: commandId() }, { expectedText: '다른 질문' },
    { expectedAnswer: '다른 답변' }, { expectedNewText: '다른 수정안' },
  ]) assert.equal((await operator(event, 'question.edit.reject', { ...rejection, ...stale })).status, 409);
  for (const reason of ['', '   ', '가'.repeat(301), { text: 'not a string' }]) {
    const invalid = await operator(event, 'question.edit.reject', { ...rejection, reason });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.field, 'reason');
  }
  const rejectionId = commandId();
  const result = await operator(event, 'question.edit.reject', rejection, { id: rejectionId });
  assert.equal(result.status, 200);
  assert.equal((await operator(event, 'question.edit.reject', rejection, { id: rejectionId })).status, 200);
  const replayWithDifferentInput = await operator(event, 'question.edit.reject', { ...rejection, reason: '다른 사유' }, { id: rejectionId });
  assert.equal(replayWithDifferentInput.status, 200);
  assert.equal(replayWithDifferentInput.json.question.editRejection.reason, rejection.reason);
  const stored = (await readWorkspace(event.id)).questions.find((item) => item.id === question.id);
  assert.equal(stored.text, '공개 질문');
  assert.equal(stored.answer, '기존 답변');
  assert.equal(stored.approved, true);
  assert.equal(stored.pendingEdit, undefined);
  const audit = (await readWorkspace(event.id)).audit.find((item) => item.id === rejectionId);
  assert.equal(audit.type, 'question.edit.reject');
  assert.equal(audit.detail, '');
  assert.deepEqual({ id: stored.editRejection.id, text: stored.editRejection.text, reason: stored.editRejection.reason },
    { id: editId, text: '수정 요청 내용', reason: rejection.reason });
  assert.equal((await operator(event, 'question.edit.approve', rejection)).status, 409);
  for (const bearer of [undefined, other.ticket]) {
    const view = await requestJson(harness.baseUrl, bearer ? `/api/public/events/${event.slug}/ticket` : `/api/public/events/${event.slug}`, bearer ? { bearer } : {});
    const projected = view.json.workspace.questions.find((item) => item.id === question.id);
    assert.equal(projected.text, '공개 질문');
    assert.equal(projected.answer, '기존 답변');
    assert.equal('editRejection' in projected, false);
    assert.equal(JSON.stringify(projected).includes(rejection.reason), false);
  }
  const ownerView = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, { bearer: owner.ticket });
  assert.deepEqual(ownerView.json.workspace.questions.find((item) => item.id === question.id).editRejection,
    { id: editId, text: '수정 요청 내용', reason: rejection.reason });
  const originalWorkspace = await readWorkspace(event.id);
  const legacyWorkspace = structuredClone(originalWorkspace);
  const legacyQuestion = legacyWorkspace.questions.find((item) => item.id === question.id);
  legacyQuestion.pendingEdit = { id: commandId(), text: '이전 서버의 새 수정안' };
  await writeWorkspace(event.id, legacyWorkspace);
  const legacyPending = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, { bearer: owner.ticket });
  assert.equal(legacyPending.json.workspace.questions.find((item) => item.id === question.id).editRejection, null);
  delete legacyQuestion.pendingEdit;
  legacyQuestion.text = '이전 서버에서 승인된 질문';
  await writeWorkspace(event.id, legacyWorkspace);
  const legacyApproved = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, { bearer: owner.ticket });
  assert.equal(legacyApproved.json.workspace.questions.find((item) => item.id === question.id).editRejection, null);
  await writeWorkspace(event.id, originalWorkspace);
  const revisedId = commandId();
  assert.equal((await attendee(event, owner.ticket, 'question.edit', { ...edit, text: '다시 고친 질문' }, revisedId)).status, 200);
  const revised = (await readWorkspace(event.id)).questions.find((item) => item.id === question.id);
  assert.equal(revised.editRejection, undefined);
  assert.equal(revised.pendingEdit.text, '다시 고친 질문');
  assert.equal((await operator(event, 'question.edit.reject', rejection)).status, 409);
  assert.equal((await operator(event, 'question.edit.approve', { ...rejection, expectedEditId: revisedId })).status, 200);
  const final = (await readWorkspace(event.id)).questions.find((item) => item.id === question.id);
  assert.equal(final.text, '다시 고친 질문');
  assert.equal(final.answer, '기존 답변');
  assert.equal(final.editRejection, undefined);
});

test('simultaneous approval and rejection decide a question proposal only once', async () => {
  const owner = participant('pending', '질문 작성자');
  const event = await createFixture({ stage: 'LIVE', features: ['qa'], participants: [owner] });
  const module = (await operator(event, 'module.save', { type: 'qa', title: '질문' })).json.module;
  assert.equal((await operator(event, 'module.status', { id: module.id, status: 'OPEN' })).status, 200);
  const question = (await attendee(event, owner.ticket, 'question.submit', { moduleId: module.id, text: '기존 질문' })).json.question;
  assert.equal((await operator(event, 'question.manage', { id: question.id, answer: '기존 답변', approved: true })).status, 200);
  const editId = commandId();
  assert.equal((await attendee(event, owner.ticket, 'question.edit', { id: question.id, text: '수정안', expectedText: '기존 질문', expectedPendingId: '', expectedApproved: true }, editId)).status, 200);
  const expected = { id: question.id, expectedEditId: editId, expectedText: '기존 질문', expectedAnswer: '기존 답변', expectedNewText: '수정안' };
  const outcomes = await Promise.all([
    operator(event, 'question.edit.approve', expected),
    operator(event, 'question.edit.reject', { ...expected, reason: '재확인해 주세요' }),
  ]);
  assert.deepEqual(outcomes.map((result) => result.status).sort(), [200, 409]);
  const stored = (await readWorkspace(event.id)).questions.find((item) => item.id === question.id);
  assert.equal(stored.answer, '기존 답변');
  assert.equal(stored.pendingEdit, undefined);
  if (stored.text === '수정안') assert.equal(stored.editRejection, undefined);
  else {
    assert.equal(stored.text, '기존 질문');
    assert.equal(stored.editRejection.reason, '재확인해 주세요');
  }
});

test('new reservations default to manual and only an explicit real reservation can select auto', async () => {
  const person = participant('pending', '예약 수신자');
  const event = await createFixture({ stage: 'LIVE', participants: [person] });
  const base = { ids: [person.id], title: '예약', channel: 'SMS', body: '안내', scheduled: new Date(Date.now() + 3600000).toISOString() };
  const manual = await operator(event, 'message.create', base);
  assert.equal(manual.status, 201);
  assert.equal(manual.json.message.scheduleMode, 'MANUAL');
  const autoId = commandId();
  const auto = await operator(event, 'message.create', { ...base, scheduleMode: 'AUTO' }, { id: autoId });
  assert.equal(auto.status, 201);
  assert.equal(auto.json.message.scheduleMode, 'AUTO');
  assert.equal(auto.json.message.autoScheduleIntent, 'confirmed-v1');
  assert.equal((await operator(event, 'message.create', { ...base, scheduleMode: 'AUTO' }, { id: autoId })).json.message.id, autoId);
  assert.equal((await operator(event, 'message.create', { ...base, scheduleMode: 'AUTO', simulate: true })).status, 400);
  assert.equal((await operator(event, 'message.create', { ...base, scheduleMode: 'AUTO', scheduled: '' })).status, 400);
  assert.equal((await operator(event, 'message.create', { ...base, scheduleMode: 'INVALID' })).status, 400);
  const messages = (await readWorkspace(event.id)).messages;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(m => m.scheduleMode).sort(), ['AUTO', 'MANUAL']);
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

test('a stale draw publication leaves both results private until the newest result is reviewed', async () => {
  const people = ['첫 참가자', '두 번째 참가자'].map(name => participant('pending', name, { everIn: true }));
  const event = await createFixture({ stage: 'LIVE', features: ['draw'], participants: people });
  const saved = await operator(event, 'module.save', { type: 'draw', title: '동시 추첨' });
  assert.equal(saved.status, 201);
  const id = saved.json.module.id;
  assert.equal((await operator(event, 'module.status', { id, status: 'OPEN' })).status, 200);
  const first = await operator(event, 'draw.run', { id, count: 1 });
  const second = await operator(event, 'draw.run', { id, count: 1 }, { actor: 'agency' });
  const stale = await operator(event, 'draw.publish', { id, expectedDrawId: first.json.draw.id });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.field, 'expectedDrawId');
  assert.equal((await operator(event, 'draw.publish', { id, expectedDrawId: [] })).status, 400);
  const publicDraws = async () => {
    const view = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
    assert.equal(view.status, 200);
    return view.json.workspace.modules.find(module => module.id === id).drawHistory;
  };
  assert.deepEqual(await publicDraws(), []);
  const key = commandId();
  const intent = { id, expectedDrawId: second.json.draw.id };
  const published = await operator(event, 'draw.publish', intent, { id: key });
  assert.equal(published.status, 200);
  assert.equal(published.json.draw.id, intent.expectedDrawId);
  assert.deepEqual((await operator(event, 'draw.publish', intent, { id: key })).json, published.json);
  assert.deepEqual((await publicDraws()).map(draw => draw.id), [intent.expectedDrawId]);
});

test('a reviewed message cannot use a changed recipient and keeps receipt replay idempotent', async () => {
  const first = participant('pending', '검토 수신자');
  const other = participant('pending', '다른 수신자');
  const event = await createFixture({ participants: [first, other], workspace: { groups: ['일반', '스피커'] } });
  const getVersions = async () => {
    const read = await requestJson(harness.baseUrl, `/api/events/${event.id}/bootstrap?messageRecipientReview=1`, { cookie: cookies.manager });
    assert.equal(read.status, 200);
    return read.json.state.recipientReviewVersions;
  };
  const reviewed = (await getVersions())[first.id];
  assert.match(reviewed, /^[a-f0-9]{64}$/);
  assert.equal((await operator(event, 'group.assign', { ids: [first.id], group: '스피커' })).status, 200);
  const payload = {
    ids: [first.id], expectedRecipientVersions: [reviewed], title: '수신자 검토', channel: 'SMS', body: '행사 안내입니다.', simulate: true,
  };
  const stale = await operator(event, 'message.create', payload);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.field, 'expectedRecipientVersions');
  assert.equal((await readWorkspace(event.id)).messages.length, 0);
  const grouped = (await getVersions())[first.id];
  assert.notEqual(grouped, reviewed);
  assert.equal((await operator(event, 'participant.update', { id: first.id, phone: '01090001234' })).status, 200);
  const latest = (await getVersions())[first.id];
  assert.notEqual(latest, grouped);
  assert.equal((await operator(event, 'message.create', { ...payload, expectedRecipientVersions: [grouped] })).status, 409);
  assert.equal((await operator(event, 'group.assign', { ids: [other.id], group: '스피커' })).status, 200);
  const id = commandId();
  const reviewedLatest = { ...payload, expectedRecipientVersions: [latest] };
  assert.equal((await operator(event, 'message.create', reviewedLatest, { id })).status, 201);
  assert.equal((await operator(event, 'participant.status', { ids: [first.id], status: 'CANCELLED' })).status, 200);
  assert.equal((await operator(event, 'message.create', reviewedLatest, { id })).json.message.id, id);
  assert.equal((await readWorkspace(event.id)).messages.length, 1);
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
  assert.equal(alimtalkTemplate.json.template.description, '', 'the note is optional and empty by default');

  // The optional one-line note is trimmed, kept when a save omits it, and cleared only by an explicit empty value.
  const described = await operator(event, 'template.save', {
    name: '설명 있는 문자', channel: 'SMS', body: '{{이름}}님 안녕하세요', description: '  입장 전날 저녁에 보내는 안내  ',
  });
  assert.equal(described.status, 200, JSON.stringify(described.json));
  assert.equal(described.json.template.description, '입장 전날 저녁에 보내는 안내');
  const keptNote = await operator(event, 'template.save', {
    id: described.json.template.id, expectedVersion: described.json.template.version,
    name: '설명 있는 문자', channel: 'SMS', body: '{{이름}}님 안녕하세요',
  });
  assert.equal(keptNote.status, 200, JSON.stringify(keptNote.json));
  assert.equal(keptNote.json.template.description, '입장 전날 저녁에 보내는 안내', 'omitting the field keeps the note');
  const clearedNote = await operator(event, 'template.save', {
    id: described.json.template.id, expectedVersion: keptNote.json.template.version,
    name: '설명 있는 문자', channel: 'SMS', body: '{{이름}}님 안녕하세요', description: '',
  });
  assert.equal(clearedNote.status, 200, JSON.stringify(clearedNote.json));
  assert.equal(clearedNote.json.template.description, '', 'an explicit empty value clears it');
  const longNote = await operator(event, 'template.save', {
    name: '긴 설명', channel: 'SMS', body: '{{이름}}님', description: '가'.repeat(200),
  });
  assert.equal(longNote.status, 200, JSON.stringify(longNote.json));
  assert.ok(longNote.json.template.description.length <= 80, 'the note is capped at 80 characters');

  const changedApprovedBody = await operator(event, 'message.create', {
    ids: [first.id], title: '승인 문구 변경', channel: 'ALIMTALK', body: '예약 전 미연동', simulate: false,
    templateId: alimtalkTemplate.json.template.id,
  });
  assert.equal(changedApprovedBody.status, 409);
  assert.equal(changedApprovedBody.json.field, 'templateId');

  const pendingConnection = await operator(event, 'message.create', {
    ids: [first.id], title: '미연동 요청', channel: 'ALIMTALK', body: alimtalkTemplate.json.template.body, simulate: false,
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

test('a report rejects stale reviewed attendance and still replays a saved report', async () => {
  const person = participant('pending', '보고서 검토 참가자', { status: 'PENDING' });
  const event = await createFixture({ stage: 'LIVE', participants: [person] });
  const reviewed = { total: 1, approved: 0, checked: 0, inside: 0 };
  const input = { title: '검토한 집계', expectedAttendance: reviewed };
  assert.equal((await operator(event, 'participant.status', { ids: [person.id], status: 'APPROVED' })).status, 200);
  const rejected = await operator(event, 'report.create', input);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.field, 'expectedAttendance');
  assert.equal((await readWorkspace(event.id)).reports.length, 0);
  const current = { ...input, expectedAttendance: { ...reviewed, approved: 1 } };
  const commandId = crypto.randomUUID();
  const saved = await operator(event, 'report.create', current, { id: commandId });
  assert.equal(saved.status, 201);
  assert.equal(saved.json.report.snapshot.metrics.approved, 1);
  assert.equal((await operator(event, 'report.publish', { id: saved.json.report.id })).status, 200);
  assert.equal((await operator(event, 'participant.status', { ids: [person.id], status: 'CANCELLED' })).status, 200);
  const replay = await operator(event, 'report.create', current, { id: commandId });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json.report, saved.json.report);
  const source = { id: saved.json.report.id, expectedAttendance: current.expectedAttendance };
  assert.equal((await operator(event, 'report.successor', { ...source, source: 'current' })).status, 409);
  const copy = await operator(event, 'report.successor', { id: source.id, source: 'snapshot' });
  assert.equal(copy.status, 201);
  assert.equal(copy.json.report.snapshot.metrics.approved, 1);
  const latest = await operator(event, 'report.successor', {
    id: source.id, source: 'current', expectedAttendance: { ...reviewed, total: 0 },
  });
  assert.equal(latest.status, 201);
  assert.equal(latest.json.report.snapshot.metrics.total, 0);
});

test('report freezes attendance uncertainty and guards its reviewed count while allowing old callers', async () => {
  const ambiguous = participant('pending', '출입 확인 참가자', { inside: null, everIn: false });
  const cancelled = participant('pending', '취소된 참가자', { status: 'CANCELLED', inside: null });
  const event = await createFixture({ stage: 'LIVE', participants: [ambiguous, cancelled] });
  const expected = { total: 1, approved: 1, checked: 0, inside: 0, attendanceReview: 0 };
  const stale = await operator(event, 'report.create', { title: '오래된 검토', expectedAttendance: expected });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.field, 'expectedAttendance');
  assert.equal((await readWorkspace(event.id)).reports.length, 0);
  const input = { title: '확인 필요 보고서', expectedAttendance: { ...expected, attendanceReview: 1 } };
  const id = commandId();
  const saved = await operator(event, 'report.create', input, { id });
  assert.equal(saved.status, 201);
  assert.equal(saved.json.report.snapshot.metrics.attendanceReview, 1);
  const replay = await operator(event, 'report.create', input, { id });
  assert.deepEqual(replay.json.report, saved.json.report);
  const legacy = await operator(event, 'report.create', { title: '이전 호출자' });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.json.report.snapshot.metrics.attendanceReview, 1);
  const workspace = await readWorkspace(event.id);
  workspace.participants[0].inside = false;
  await writeWorkspace(event.id, workspace);
  assert.equal((await readWorkspace(event.id)).reports.find(item => item.id === saved.json.report.id).snapshot.metrics.attendanceReview, 1);
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

test('report saves and locks are conditional on the reviewed version while receipts still replay', async () => {
  const event = await createFixture({ stage: 'ENDED' });
  const created = await operator(event, 'report.create', { title: '초안' });
  assert.equal(created.status, 201);
  const reportId = created.json.report.id;
  const update = { id: reportId, expectedVersion: 1, title: '다른 운영자가 저장한 초안' };
  const updateId = commandId();
  const accepted = await operator(event, 'report.update', update, { actor: 'agency', id: updateId });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.report.version, 2);
  for (const command of ['report.update', 'report.publish']) {
    const stale = await operator(event, command, { ...update, title: '오래된 화면의 변경' });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.field, 'expectedVersion');
  }
  assert.equal((await operator(event, 'report.publish', { id: reportId, expectedVersion: '2' })).status, 400);
  const draft = (await readWorkspace(event.id)).reports[0];
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.title, update.title);
  const lockId = commandId();
  const lock = { id: reportId, expectedVersion: 2 };
  const published = await operator(event, 'report.publish', lock, { id: lockId });
  assert.equal(published.status, 200);
  assert.equal(published.json.report.version, 2);
  assert.deepEqual((await operator(event, 'report.publish', lock, { id: lockId })).json, published.json);
  assert.deepEqual((await operator(event, 'report.update', update, { actor: 'agency', id: updateId })).json, accepted.json);
  const later = await operator(event, 'report.update', { ...update, expectedVersion: 2 });
  assert.equal(later.status, 409);
  assert.equal(later.json.field, 'expectedVersion');
  assert.equal((await readWorkspace(event.id)).reports[0].status, 'PUBLISHED');
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
test('event features guards stale editors as sets while replaying committed requests', async () => {
  const event = await createFixture({ features: ['qa', 'payment'] });
  const recipient = participant(event.id, '합성 경품 수령자');
  const setup = await readWorkspace(event.id);
  setup.participants.push(recipient);
  setup.rewards.push({ id: 'feature-guard-reward', participantId: recipient.id, name: '합성 경품', method: 'ONSITE', status: 'READY' });
  await writeWorkspace(event.id, setup);
  const desk = await operator(event, 'desk.save', { name: '합성 퇴장 데스크', action: 'OUT', mode: 'desk', open: true });
  assert.equal(desk.status, 201, JSON.stringify(desk.json));
  const assignmentId = await seedAssignment(event, desk.json.desk.id);
  const staff = (command, payload) => requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST', cookie: cookies.staff, body: { commandId: commandId(), command, payload, assignmentId },
  });
  // Two authorized operators saw the same flags, including the feature not
  // shown in the current editor. B enables on-site reward handling.
  const before = ['qa', 'payment'];
  const b = await operator(event, 'event.features', {
    features: ['qa', 'payment', 'reward'], expectedFeatures: before,
  }, { actor: 'agency' });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  const staleId = commandId();
  const stale = await operator(event, 'event.features', {
    features: ['qa', 'payment', 'quiz'], expectedFeatures: ['payment', 'qa'],
  }, { id: staleId });
  assert.equal(stale.status, 409, JSON.stringify(stale.json));
  assert.equal(stale.json.code, 'EVENT_FEATURES_CHANGED');
  assert.deepEqual((await readEvent(event.id)).payload.features, ['qa', 'payment', 'reward']);
  const staleReceipt = await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id = $1', [staleId]);
  assert.equal(staleReceipt.rowCount, 0);
  const lookup = await staff('reward.lookup', { ticket: recipient.ticket });
  assert.equal(lookup.status, 200, JSON.stringify(lookup.json));
  const collect = await staff('reward.collect', { id: 'feature-guard-reward', verificationId: lookup.json.rewardVerificationId });
  assert.equal(collect.status, 200, JSON.stringify(collect.json));

  // Order and duplicates in the expected baseline are immaterial; hidden
  // features remain present when the editor submits its complete selection.
  const acceptedId = commandId();
  const acceptedPayload = { features: ['qa', 'payment', 'reward', 'quiz'],
    expectedFeatures: ['reward', 'payment', 'qa', 'qa'] };
  const accepted = await operator(event, 'event.features', acceptedPayload, { id: acceptedId });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.deepEqual((await readEvent(event.id)).payload.features, acceptedPayload.features);
  const later = await operator(event, 'event.features', { features: ['qa', 'payment'],
    expectedFeatures: acceptedPayload.features }, { actor: 'agency' });
  assert.equal(later.status, 200, JSON.stringify(later.json));
  const replay = await operator(event, 'event.features', acceptedPayload, { id: acceptedId });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.deepEqual(replay.json, accepted.json);
  assert.deepEqual((await readEvent(event.id)).payload.features, ['qa', 'payment']);

  for (const expectedFeatures of [null, 'qa', ['qa', 2], {}]) {
    const invalid = await operator(event, 'event.features', { features: ['qa'], expectedFeatures });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
  }
  const unknownBaseline = await operator(event, 'event.features', { features: ['qa'], expectedFeatures: ['future-feature'] });
  assert.equal(unknownBaseline.status, 409, JSON.stringify(unknownBaseline.json));
  assert.equal(unknownBaseline.json.code, 'EVENT_FEATURES_CHANGED');
  assert.deepEqual((await readEvent(event.id)).payload.features, ['qa', 'payment']);
  const legacy = await operator(event, 'event.features', { features: ['qa', 'payment', 'draw'] });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.json));
});

test('participation responses require the viewed content version and replay committed receipts first', async () => {
  const first = participant('pending', '기준 참가자');
  const legacy = participant('pending', '이전 화면 참가자');
  const event = await createFixture({ stage: 'LIVE', features: ['poll', 'quiz', 'survey', 'qa'], participants: [first, legacy] });
  const cases = [
    { type: 'poll', title: '원래 투표', options: ['예', '아니요'], answer: '예', changed: { title: '변경된 투표' } },
    { type: 'quiz', title: '원래 퀴즈', answer: '비공개 정답', submitted: '예', changed: { answer: '변경된 비공개 정답' } },
    { type: 'survey', title: '원래 설문', questions: ['만족도'], ratings: { '만족도': 4 }, changed: { title: '변경된 설문' } },
  ];
  for (const item of cases) {
    const definition = { type: item.type, title: item.title,
      ...(item.options ? { options: item.options } : {}),
      ...(item.type === 'quiz' ? { answer: item.answer } : {}),
      ...(item.questions ? { questions: item.questions } : {}) };
    const created = await operator(event, 'module.save', definition);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.module.id;
    assert.equal(created.json.module.contentVersion, 1);
    assert.equal((await operator(event, 'module.status', { id, status: 'OPEN' })).status, 200);
    const unchanged = await operator(event, 'module.save', { id, ...definition });
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.json));
    assert.equal(unchanged.json.module.contentVersion, 1, 'unchanged definition is not a conflict');
    const oldProjection = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
    const visible = oldProjection.json.workspace.modules.find((row) => row.id === id);
    assert.equal(visible.contentVersion, 1);
    if (item.type === 'quiz') assert.equal(Object.hasOwn(visible, 'answer'), false, 'unrevealed answer stays private');
    const changed = await operator(event, 'module.save', { id, ...definition, ...item.changed });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal(changed.json.module.contentVersion, 2);
    const payload = { moduleId: id, ...(item.ratings ? { ratings: item.ratings } : { answer: item.submitted || item.answer }), expectedContentVersion: 1 };
    const rejectedId = commandId();
    const rejected = await attendee(event, first.ticket, 'response.submit', payload, rejectedId);
    assert.equal(rejected.status, 409, JSON.stringify(rejected.json));
    assert.equal(rejected.json.code, 'MODULE_CONTENT_CHANGED');
    assert.equal((await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [rejectedId])).rowCount, 0);
    assert.equal((await readWorkspace(event.id)).responses.filter((row) => row.moduleId === id).length, 0);
    for (const expectedContentVersion of [-1, null, '2']) {
      const invalid = await attendee(event, first.ticket, 'response.submit', { ...payload, expectedContentVersion });
      assert.equal(invalid.status, 400);
    }
    const acceptedId = commandId();
    const accepted = await attendee(event, first.ticket, 'response.submit', { ...payload, expectedContentVersion: 2 }, acceptedId);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    assert.equal(accepted.json.response.contentVersion, 2);
    const legacyPayload = { ...payload }; delete legacyPayload.expectedContentVersion;
    assert.equal((await attendee(event, legacy.ticket, 'response.submit', legacyPayload)).status, 201, 'old clients remain compatible');
    assert.equal((await operator(event, 'module.status', { id, status: 'CLOSED' })).status, 200);
    const replay = await attendee(event, first.ticket, 'response.submit', { ...payload, expectedContentVersion: 2 }, acceptedId);
    assert.equal(replay.status, 200, 'committed receipt precedes closed-state and version checks');
    assert.deepEqual(replay.json, accepted.json);
    assert.equal((await operator(event, 'module.save', { id, ...definition })).status, 409, 'responses still lock edits');
  }
  // A published row written by an older server projects version zero.
  const workspace = await readWorkspace(event.id);
  workspace.modules.push({ id: 'legacy-poll-version', type: 'poll', title: '이전 투표', options: ['예', '아니요'], status: 'OPEN', published: true });
  await writeWorkspace(event.id, workspace);
  const publicState = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(publicState.json.workspace.modules.find((row) => row.id === 'legacy-poll-version').contentVersion, 0);
  const legacyId = commandId();
  const legacyAnswer = { moduleId: 'legacy-poll-version', answer: '예', expectedContentVersion: 0 };
  const legacyAccepted = await attendee(event, first.ticket, 'response.submit', legacyAnswer, legacyId);
  assert.equal(legacyAccepted.status, 201, JSON.stringify(legacyAccepted.json));
  assert.equal(legacyAccepted.json.response.contentVersion, 0);
  const legacyReplay = await attendee(event, first.ticket, 'response.submit', legacyAnswer, legacyId);
  assert.equal(legacyReplay.status, 200);
  assert.deepEqual(legacyReplay.json, legacyAccepted.json);
  // A type change is also a definitive content conflict. The original
  // request must not get an ambiguous generic 400 on a lost-response retry.
  const typed = await operator(event, 'module.save', { type: 'poll', title: '유형 변경 전', options: ['예', '아니요'] });
  assert.equal(typed.status, 201);
  assert.equal((await operator(event, 'module.status', { id: typed.json.module.id, status: 'OPEN' })).status, 200);
  const converted = await operator(event, 'module.save', { id: typed.json.module.id, type: 'qa', title: '유형 변경 후' });
  assert.equal(converted.status, 200);
  const oldType = await attendee(event, first.ticket, 'response.submit', { moduleId: typed.json.module.id, answer: '예', expectedContentVersion: 1 });
  assert.equal(oldType.status, 409);
  assert.equal(oldType.json.code, 'MODULE_CONTENT_CHANGED');
  assert.equal((await readWorkspace(event.id)).responses.some((row) => row.moduleId === typed.json.module.id), false);
});

test('Q&A questions require the viewed content version while preserving receipts and existing moderation', async () => {
  const first = participant('pending', '질문 작성자');
  const legacy = participant('pending', '이전 화면 참가자');
  const event = await createFixture({ stage: 'LIVE', features: ['qa', 'poll'], participants: [first, legacy] });
  const created = await operator(event, 'module.save', { type: 'qa', title: '오전 세션 질의' });
  assert.equal(created.status, 201);
  const id = created.json.module.id;
  assert.equal(created.json.module.contentVersion, 1);
  assert.equal((await operator(event, 'module.status', { id, status: 'OPEN' })).status, 200);
  const publicBefore = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(publicBefore.json.workspace.modules.find((item) => item.id === id).contentVersion, 1);
  const renamed = await operator(event, 'module.save', { id, type: 'qa', title: '오후 세션 질의' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.module.contentVersion, 2);
  const stale = { moduleId: id, text: '오전 발표 자료는 어디서 받나요?', expectedContentVersion: 1 };
  const rejectedId = commandId();
  const rejected = await attendee(event, first.ticket, 'question.submit', stale, rejectedId);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.json));
  assert.equal(rejected.json.code, 'MODULE_CONTENT_CHANGED');
  assert.equal((await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [rejectedId])).rowCount, 0);
  assert.equal((await readWorkspace(event.id)).questions.filter((item) => item.moduleId === id).length, 0);
  for (const expectedContentVersion of [-1, null, '2']) {
    assert.equal((await attendee(event, first.ticket, 'question.submit', { ...stale, expectedContentVersion })).status, 400);
  }
  const acceptedId = commandId();
  const accepted = await attendee(event, first.ticket, 'question.submit', { ...stale, expectedContentVersion: 2 }, acceptedId);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
  assert.equal(accepted.json.question.contentVersion, 2);
  assert.equal(accepted.json.question.approved, false);
  const other = await attendee(event, legacy.ticket, 'question.submit', { moduleId: id, text: '기존 클라이언트 질문' });
  assert.equal(other.status, 201, 'old clients remain compatible');
  const publicAfter = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(publicAfter.json.workspace.questions.some((item) => item.id === accepted.json.question.id), false, 'new question remains private until moderation');
  assert.equal((await operator(event, 'module.save', { id, type: 'qa', title: '다시 변경' })).status, 409, 'questions still lock editing');
  assert.equal((await operator(event, 'module.status', { id, status: 'CLOSED' })).status, 200);
  const replay = await attendee(event, first.ticket, 'question.submit', { ...stale, expectedContentVersion: 2 }, acceptedId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, accepted.json, 'receipt precedes the closed-state gate');
  const typed = await operator(event, 'module.save', { type: 'qa', title: '유형 변경 전 Q&A' });
  assert.equal((await operator(event, 'module.status', { id: typed.json.module.id, status: 'OPEN' })).status, 200);
  assert.equal((await operator(event, 'module.save', { id: typed.json.module.id, type: 'poll', title: '유형 변경 후', options: ['예', '아니요'] })).status, 200);
  const changedType = await attendee(event, first.ticket, 'question.submit', { moduleId: typed.json.module.id, text: '이전 질문', expectedContentVersion: 1 });
  assert.equal(changedType.status, 409);
  assert.equal(changedType.json.code, 'MODULE_CONTENT_CHANGED');
  assert.equal((await readWorkspace(event.id)).questions.some((item) => item.moduleId === typed.json.module.id), false);
  const workspace = await readWorkspace(event.id);
  workspace.modules.push({ id: 'legacy-qa-version', type: 'qa', title: '이전 Q&A', status: 'OPEN', published: true });
  await writeWorkspace(event.id, workspace);
  const legacyView = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}`);
  assert.equal(legacyView.json.workspace.modules.find((item) => item.id === 'legacy-qa-version').contentVersion, 0);
  assert.equal((await attendee(event, first.ticket, 'question.submit', { moduleId: 'legacy-qa-version', text: '이전 행사 질문', expectedContentVersion: 0 })).status, 201);
});
