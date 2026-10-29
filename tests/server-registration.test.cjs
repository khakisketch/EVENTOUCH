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
  deleteFixtureRows,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const ids = Object.fromEntries([
  'signup', 'stale', 'duplicate', 'capacity', 'parallel', 'replay', 'operators', 'expired', 'payment',
  'importOverflow', 'duplicateImport',
].map((name) => [name, `registration-${name}-${suffix}`]));
const slugs = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, id]));
const accountIds = {
  agency: `registration-agency-${suffix}`,
  manager: `registration-manager-${suffix}`,
  staff: `registration-staff-${suffix}`,
};
const assignmentId = `registration-assignment-${suffix}`;
const invalidDeskAssignmentId = `registration-invalid-desk-${suffix}`;
const boothAssignmentId = `registration-booth-assignment-${suffix}`;
const deskId = `registration-desk-${suffix}`;
const expiredTicket = `ET:${ids.expired}:T-${crypto.randomBytes(32).toString('base64url')}`;
let harness;
let cookies = {};

function eventPayload(id, slug, capacity = 20, features = []) {
  return {
    id,
    slug,
    name: '등록 검증 행사',
    date: '2026-12-01',
    start: '09:00',
    end: '17:00',
    capacity,
    stage: 'READY',
    features,
  };
}

function workspace({ approvalRequired = false, participants = [], price = 0 } = {}) {
  const fields = [
    { id: 'name', label: '이름', type: 'text', required: true, options: [] },
    { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
    { id: 'email', label: '이메일', type: 'email', required: false, options: [] },
    { id: 'company', label: '소속', type: 'text', required: false, options: [] },
    { id: 'meal', label: '식사 선택', type: 'select', required: true, options: ['일반식', '채식'] },
  ];
  return {
    participants,
    payments: [],
    registrationOpen: true,
    approvalRequired,
    formVersion: 8,
    publishedVersion: 3,
    fields,
    publishedFields: fields,
    consentText: '행사 신청을 위해 정보를 사용합니다.',
    consentVersion: 4,
    price,
    desks: [{ id: deskId, name: '등록 데스크', action: 'IN' }],
  };
}

function commandId() {
  return `cmd-${crypto.randomUUID()}`;
}

function publicSignup(slug, body) {
  return requestJson(harness.baseUrl, `/api/events/${slug}/signup`, {
    method: 'POST',
    body,
  });
}

function attendeeCommand(eventId, name, payload, ticket, id = commandId()) {
  return requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    bearer: ticket,
    body: { commandId: id, command: name, payload },
  });
}

function operatorCommand(eventId, name, payload, cookie, id = commandId()) {
  return requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: id, command: name, payload },
  });
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

function expiredParticipant(ticket) {
  return {
    id: 'person-expired',
    name: '만료 티켓 참가자',
    phone: '01055556666',
    email: '',
    company: '',
    group: '일반',
    status: 'APPROVED',
    inside: false,
    everIn: false,
    revoked: false,
    ticket,
    ticketExpiresAt: '2020-01-01T00:00:00.000Z',
    registrationType: 'PRE',
    paymentStatus: 'FREE',
    answers: { meal: '일반식' },
    consent: { version: 4, at: '2020-01-01T00:00:00.000Z' },
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: accountIds.agency,
    role: 'AGENCY',
    name: '운영사 관리자',
    email: `${accountIds.agency}@example.test`,
  });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: accountIds.manager,
    role: 'MANAGER',
    name: '행사 매니저',
    email: `${accountIds.manager}@example.test`,
  });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: accountIds.staff,
    role: 'STAFF',
    name: '현장 스태프',
    email: `${accountIds.staff}@example.test`,
  });

  for (const name of Object.keys(ids)) {
    const eventWorkspace = workspace({
      approvalRequired: ['signup', 'importOverflow'].includes(name),
      price: name === 'payment' ? 1500 : 0,
      participants: name === 'expired'
        ? [expiredParticipant(expiredTicket)]
        : [],
    });
    await insertEvent(harness.database, {orgId: LEGACY_ORG,
      id: ids[name],
      slug: slugs[name],
      payload: eventPayload(ids[name], slugs[name], ['capacity', 'parallel', 'signup', 'importOverflow'].includes(name)
        ? 1
        : name === 'duplicateImport' ? 0 : 20,
        ['operators', 'payment'].includes(name) ? ['payment'] : []),
      workspace: eventWorkspace,
    });
  }
  await insertMembership(harness.database, accountIds.manager, ids.operators, ['all']);
  await insertMembership(harness.database, accountIds.manager, ids.payment, ['all']);
  await insertMembership(harness.database, accountIds.manager, ids.importOverflow, ['all']);
  await insertMembership(harness.database, accountIds.manager, ids.duplicateImport, ['all']);
  await insertAssignment(harness.database, {
    id: assignmentId,
    accountId: accountIds.staff,
    eventId: ids.operators,
    type: 'DESK',
    targetId: deskId,
  });
  await insertAssignment(harness.database, {
    id: invalidDeskAssignmentId,
    accountId: accountIds.staff,
    eventId: ids.operators,
    type: 'DESK',
    targetId: `registration-missing-desk-${suffix}`,
  });
  await insertAssignment(harness.database, {
    id: boothAssignmentId,
    accountId: accountIds.staff,
    eventId: ids.operators,
    type: 'BOOTH',
    targetId: `registration-booth-${suffix}`,
  });
  cookies = {
    agency: await sessionCookie(harness, accountIds.agency),
    manager: await sessionCookie(harness, accountIds.manager),
    staff: await sessionCookie(harness, accountIds.staff),
  };
});

after(async () => {
  if (!harness) return;
  try {
    await deleteFixtureRows(harness.database, {
      eventIds: Object.values(ids),
      accountIds: Object.values(accountIds),
    });
  } finally {
    await harness.close();
  }
});

test('public-signup-uses-published-form-and-returns-only-the-new-ticket-projection', async () => {
  const response = await publicSignup(slugs.signup, signupBody('한결 참가자', '01012345678', {
    privateNote: '브라우저가 보내면 안 되는 필드',
    ticket: 'attacker-chosen-ticket',
  }));

  assert.equal(response.status, 201);
  assert.equal(response.json.participant.name, '한결 참가자');
  assert.equal(response.json.participant.status, 'PENDING');
  assert.equal(response.json.participant.registrationType, 'PRE');
  assert.deepEqual(response.json.participant.consent.version, 4);
  assert.equal(response.json.participant.answers.meal, '일반식');
  assert.match(response.json.participant.ticket, new RegExp(`^ET:${ids.signup}:T-[A-Za-z0-9_-]{43}$`));
  assert.ok(!JSON.stringify(response.json).includes('브라우저가 보내면 안 되는 필드'));
  assert.notEqual(response.json.participant.ticket, 'attacker-chosen-ticket');

  const ticket = await requestJson(
    harness.baseUrl,
    `/api/public/events/${slugs.signup}/ticket`,
    { bearer: response.json.participant.ticket }
  );
  assert.equal(ticket.status, 200);
  assert.equal(ticket.json.participant.id, response.json.participant.id);
  assert.equal(ticket.json.participant.consent.version, 4);

  const waitlisted = await publicSignup(slugs.signup, signupBody('대기 명단 참가자', '01012345670'));
  assert.equal(waitlisted.status, 201);
  assert.equal(waitlisted.json.participant.status, 'WAITLIST');
});

test('public-signup-rejects-stale-published-forms-and-missing-required-consent', async () => {
  const stale = await publicSignup(slugs.stale, signupBody('민서 참가자', '01012345679', { formVersion: 2 }));
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /양식|변경/);

  const noConsent = await publicSignup(slugs.stale, signupBody('민서 참가자', '01012345679', { consent: false }));
  assert.equal(noConsent.status, 400);
  assert.match(noConsent.json.error, /동의/);

  const missingField = await publicSignup(slugs.stale, signupBody('민서 참가자', '01012345679', { meal: '' }));
  assert.equal(missingField.status, 400);
  assert.equal(missingField.json.field, 'meal');

  const invalidOption = await publicSignup(slugs.stale, signupBody('민서 참가자', '01012345679', { meal: '무제한 선택' }));
  assert.equal(invalidOption.status, 400);
  assert.equal(invalidOption.json.field, 'meal');
});

test('public-signup-reports-an-ended-visible-event-as-closed', async () => {
  const original = await harness.database.query('SELECT payload FROM events WHERE id = $1', [ids.operators]);
  try {
    await harness.database.query(
      "UPDATE events SET payload = jsonb_set(payload, '{stage}', to_jsonb('ENDED'::text), true) WHERE id = $1",
      [ids.operators]
    );
    const response = await publicSignup(slugs.operators, signupBody('종료 행사 신청자', '01000000025'));
    assert.equal(response.status, 409);
    assert.match(response.json.error, /종료|받지 않습니다/);
  } finally {
    await harness.database.query('UPDATE events SET payload = $2::jsonb WHERE id = $1', [
      ids.operators,
      JSON.stringify(original.rows[0].payload),
    ]);
  }
});

test('public-signup-rejects-duplicate-normalized-phone-numbers', async () => {
  const first = await publicSignup(slugs.duplicate, signupBody('수아 참가자', '010-1234-5678'));
  const duplicate = await publicSignup(slugs.duplicate, signupBody('다른 이름', '01012345678'));
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.json.error, /이미 등록/);
});

test('capacity-boundary-allows-one-seat-and-rejects-the-next-signup', async () => {
  const first = await publicSignup(slugs.capacity, signupBody('첫 참가자', '01000000001'));
  const second = await publicSignup(slugs.capacity, signupBody('둘째 참가자', '01000000002'));
  assert.equal(first.status, 201);
  assert.equal(first.json.participant.status, 'APPROVED');
  assert.equal(second.status, 409);
});

test('parallel-signups-for-the-final-seat-commit-exactly-one-participant', async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    publicSignup(slugs.parallel, signupBody(`병렬 참가자 ${index + 1}`, `010000000${30 + index}`))
  ));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  const stored = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.parallel]
  );
  assert.equal(stored.rows[0].payload.participants.length, 1);
});

test('replayed-public-command-id-returns-the-original-signup-without-a-second-record', async () => {
  const id = commandId();
  const first = await publicSignup(slugs.replay, signupBody('재시도 참가자', '01000000005', { commandId: id }));
  const retry = await publicSignup(slugs.replay, signupBody('다른 payload', '01000000006', { commandId: id }));
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json, first.json);

  const receipt = await harness.database.query(
    'SELECT result FROM command_receipts WHERE command_id = $1',
    [id]
  );
  assert.ok(!JSON.stringify(receipt.rows[0].result).includes(first.json.participant.ticket));

  const stored = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.replay]
  );
  assert.equal(stored.rows[0].payload.participants.length, 1);
});

test('command-id-reuse-in-a-different-event-is-rejected-without-a-second-signup', async () => {
  const id = commandId();
  const first = await publicSignup(slugs.replay, signupBody('첫 행사 참가자', '01000000015', { commandId: id }));
  const crossEvent = await publicSignup(slugs.stale, signupBody('다른 행사 참가자', '01000000016', { commandId: id }));

  assert.equal(first.status, 201);
  assert.equal(crossEvent.status, 409);
  const target = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.stale]
  );
  assert.equal(target.rows[0].payload.participants.length, 0);
});

test('concurrent-signup-retries-with-one-command-id-create-a-single-participant', async () => {
  const id = commandId();
  const before = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.replay]
  );
  const originalCount = before.rows[0].payload.participants.length;
  const responses = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    publicSignup(slugs.replay, signupBody(`동시 재시도 ${index + 1}`, `010000000${40 + index}`, { commandId: id }))
  ));

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 200, 201]);
  assert.ok(responses.every((response) => response.json.participant.id === responses[0].json.participant.id));
  const after = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.replay]
  );
  assert.equal(after.rows[0].payload.participants.length, originalCount + 1);
});

test('concurrent-operator-retries-with-one-command-id-create-a-single-participant', async () => {
  const id = commandId();
  const before = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.operators]
  );
  const originalCount = before.rows[0].payload.participants.length;
  const responses = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    operatorCommand(ids.operators, 'participant.create', {
      name: `운영자 동시 재시도 ${index + 1}`, phone: `010123400${30 + index}`, meal: '일반식',
    }, cookies.manager, id)
  ));

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 200, 201]);
  assert.ok(responses.every((response) => response.json.participant.id === responses[0].json.participant.id));
  const after = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.operators]
  );
  assert.equal(after.rows[0].payload.participants.length, originalCount + 1);
  const receipt = await harness.database.query(
    'SELECT result FROM command_receipts WHERE command_id = $1',
    [id]
  );
  assert.ok(!JSON.stringify(receipt.rows[0].result).includes(responses[0].json.participant.ticket));
});

test('numeric-demo-signup-does-not-fall-back-when-no-postgresql-event-matches', async () => {
  const response = await publicSignup('evt-1', {
    name: '기존 데모 신청자', phone: '01012349999',
  });

  assert.equal(response.status, 404, JSON.stringify(response.json));
  assert.equal(response.json.participant, undefined);
  const databaseMatch = await harness.database.query('SELECT 1 FROM events WHERE slug = $1', ['evt-1']);
  assert.equal(databaseMatch.rowCount, 0);
});

test('authenticated-commands-preserve-role-boundaries-and-csv-import-does-not-create-consent', async () => {
  const anonymous = await operatorCommand(ids.operators, 'participant.create', {
    name: '무인 요청', phone: '01012340000',
  });
  assert.equal(anonymous.status, 401);

  const created = await operatorCommand(ids.operators, 'participant.create', {
    name: '매니저 등록', phone: '01012340001', email: 'manager@example.test', meal: '채식',
  }, cookies.manager);
  assert.equal(created.status, 201);
  const participantId = created.json.participant.id;

  const beforeUpdate = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.operators]
  );
  const beforeUpdatePayload = beforeUpdate.rows[0].payload;
  beforeUpdatePayload.participants.find((person) => person.id === participantId).answers.legacyField = '기존 답변 보존';
  await harness.database.query(
    'UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [ids.operators, JSON.stringify(beforeUpdatePayload)]
  );

  const updated = await operatorCommand(ids.operators, 'participant.update', {
    id: participantId, name: '매니저 수정', phone: '01012340001', email: 'manager@example.test',
  }, cookies.manager);
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.participant.name, '매니저 수정');
  const afterUpdate = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.operators]
  );
  assert.equal(
    afterUpdate.rows[0].payload.participants.find((person) => person.id === participantId).answers.legacyField,
    '기존 답변 보존'
  );

  const status = await operatorCommand(ids.operators, 'participant.status', {
    id: participantId, status: 'PENDING',
  }, cookies.manager);
  assert.equal(status.status, 200);
  assert.equal(status.json.participants[0].status, 'PENDING');

  const imported = await operatorCommand(ids.operators, 'participant.import', {
    rows: [{ name: 'CSV 참가자', phone: '01012340002', email: 'csv@example.test', company: '예시 회사' }],
  }, cookies.manager);
  assert.equal(imported.status, 200);
  assert.equal(imported.json.participants[0].consent, null);
  const stored = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.operators]
  );
  const savedImport = stored.rows[0].payload.participants.find((person) => person.id === imported.json.participants[0].id);
  assert.equal(savedImport.consent, null);
  assert.deepEqual(savedImport.answers, {});

  const completedImport = await attendeeCommand(ids.operators, 'participant.self-update', {
    name: savedImport.name,
    phone: savedImport.phone,
    email: savedImport.email,
    company: savedImport.company,
    meal: '채식',
  }, imported.json.participants[0].ticket);
  assert.equal(completedImport.status, 200, JSON.stringify(completedImport.json));
  assert.equal(completedImport.json.participant.answers.meal, '채식');

  const staffImport = await operatorCommand(ids.operators, 'participant.import', {
    rows: [{ name: '권한 밖 CSV', phone: '01012340003' }],
  }, cookies.staff);
  assert.equal(staffImport.status, 403);

  const staffUpdate = await operatorCommand(ids.operators, 'participant.update', {
    id: participantId, name: '권한 밖 수정', phone: '01012340001',
  }, cookies.staff);
  assert.equal(staffUpdate.status, 403);

  const deskCreate = await requestJson(harness.baseUrl, `/api/events/${ids.operators}/commands`, {
    method: 'POST',
    cookie: cookies.staff,
    body: {
      commandId: commandId(),
      command: 'participant.create',
      assignmentId,
      payload: { name: '데스크 현장 등록', phone: '01012340004', meal: '일반식' },
    },
  });
  assert.equal(deskCreate.status, 201);
  assert.equal(deskCreate.json.participant.registrationType, 'ONSITE');

  const wrongEvent = await operatorCommand(ids.capacity, 'participant.create', {
    name: '다른 행사 요청', phone: '01012340005',
  }, cookies.manager);
  assert.equal(wrongEvent.status, 403);
});

test('staff-participant-create-rejects-assignments-with-the-wrong-type-or-target', async () => {
  const wrongTarget = await requestJson(harness.baseUrl, `/api/events/${ids.operators}/commands`, {
    method: 'POST',
    cookie: cookies.staff,
    body: {
      commandId: commandId(),
      command: 'participant.create',
      assignmentId: invalidDeskAssignmentId,
      payload: { name: '잘못된 데스크 배정', phone: '01012340017', meal: '일반식' },
    },
  });
  const wrongType = await requestJson(harness.baseUrl, `/api/events/${ids.operators}/commands`, {
    method: 'POST',
    cookie: cookies.staff,
    body: {
      commandId: commandId(),
      command: 'participant.create',
      assignmentId: boothAssignmentId,
      payload: { name: '부스 배정 데스크 등록', phone: '01012340018', meal: '일반식' },
    },
  });

  assert.equal(wrongTarget.status, 403);
  assert.equal(wrongType.status, 403);
  const stored = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.operators]
  );
  assert.ok(stored.rows[0].payload.participants.every((person) =>
    !['01012340017', '01012340018'].includes(person.phone))
  );
});

test('participant-import-overflow-and-duplicate-batches-are-rejected-atomically', async () => {
  const overflow = await operatorCommand(ids.importOverflow, 'participant.import', {
    rows: [
      { name: '정원 안 참가자', phone: '01012340019' },
      { name: '정원 초과 참가자', phone: '01012340020' },
    ],
  }, cookies.manager);
  const duplicate = await operatorCommand(ids.duplicateImport, 'participant.import', {
    rows: [
      { name: '중복 대상 하나', phone: '010-1234-0021' },
      { name: '중복 대상 둘', phone: '01012340021' },
    ],
  }, cookies.manager);

  assert.equal(overflow.status, 409);
  assert.equal(duplicate.status, 409);
  const [overflowState, duplicateState] = await Promise.all([
    harness.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [ids.importOverflow]),
    harness.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [ids.duplicateImport]),
  ]);
  assert.equal(overflowState.rows[0].payload.participants.length, 0);
  assert.equal(duplicateState.rows[0].payload.participants.length, 0);
});

test('attendee-ticket-allows-only-self-update-and-cancellation-then-revokes-the-ticket', async () => {
  const created = await operatorCommand(ids.operators, 'participant.create', {
    name: '티켓 참가자', phone: '01012340006', email: 'ticket@example.test', meal: '일반식',
  }, cookies.manager);
  assert.equal(created.status, 201);
  const person = created.json.participant;

  const crossEvent = await attendeeCommand(ids.capacity, 'participant.cancel', {}, person.ticket);
  assert.equal(crossEvent.status, 404);

  const selfUpdateCommand = commandId();
  const selfUpdatePayload = {
    name: '티켓 정보 수정', phone: '01012340006', email: 'ticket@example.test', company: '수정 회사',
  };
  const updated = await attendeeCommand(ids.operators, 'participant.self-update', {
    ...selfUpdatePayload,
  }, person.ticket, selfUpdateCommand);
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.participant.name, '티켓 정보 수정');
  assert.equal(updated.json.participant.company, '수정 회사');

  const cancelCommand = commandId();
  const canceled = await attendeeCommand(ids.operators, 'participant.cancel', {}, person.ticket, cancelCommand);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.json.participant.status, 'CANCELLED');
  assert.equal(canceled.json.participant.revoked, true);
  const cancelRetry = await attendeeCommand(ids.operators, 'participant.cancel', {}, person.ticket, cancelCommand);
  assert.equal(cancelRetry.status, 200);
  assert.deepEqual(cancelRetry.json, canceled.json);

  const oldTicket = await requestJson(
    harness.baseUrl,
    `/api/public/events/${slugs.operators}/ticket`,
    { bearer: person.ticket }
  );
  assert.equal(oldTicket.status, 404);

  const rejectedReissue = await operatorCommand(ids.operators, 'ticket.reissue', { id: person.id }, cookies.manager);
  assert.equal(rejectedReissue.status, 409);

  const restored = await operatorCommand(ids.operators, 'participant.status', {
    id: person.id, status: 'APPROVED',
  }, cookies.manager);
  assert.equal(restored.status, 200);
  assert.notEqual(restored.json.participants[0].ticket, person.ticket);
  const restoredTicket = await requestJson(
    harness.baseUrl,
    `/api/public/events/${slugs.operators}/ticket`,
    { bearer: restored.json.participants[0].ticket }
  );
  assert.equal(restoredTicket.status, 200);

  const revokedReplay = await attendeeCommand(
    ids.operators,
    'participant.self-update',
    selfUpdatePayload,
    person.ticket,
    selfUpdateCommand
  );
  assert.equal(revokedReplay.status, 404);
});

test('attendee-self-update-cannot-change-operator-managed-or-unpublished-fields', async () => {
  const created = await operatorCommand(ids.operators, 'participant.create', {
    name: '수정 전 참가자', phone: '01012340008', company: '원래 소속', group: 'VIP', meal: '일반식',
  }, cookies.manager);
  assert.equal(created.status, 201);

  const updated = await attendeeCommand(ids.operators, 'participant.self-update', {
    name: '수정 후 참가자', phone: '01012340008', company: '변경 소속', group: '운영자 그룹',
    status: 'CANCELLED', registrationType: 'PRE', paymentStatus: 'PAID',
    ticket: 'attacker-selected-ticket', answers: { meal: '채식', hiddenField: '비공개 값' },
  }, created.json.participant.ticket);

  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.participant.name, '수정 후 참가자');
  assert.equal(updated.json.participant.company, '변경 소속');
  assert.equal(updated.json.participant.group, 'VIP');
  assert.equal(updated.json.participant.status, 'APPROVED');
  assert.equal(updated.json.participant.registrationType, 'ONSITE');
  assert.equal(updated.json.participant.paymentStatus, 'FREE');
  assert.equal(updated.json.participant.ticket, created.json.participant.ticket);
  assert.deepEqual(updated.json.participant.answers, { email: '', meal: '채식' });
});

test('ended-and-archived-events-reject-operator-participant-mutations', async () => {
  const created = await operatorCommand(ids.operators, 'participant.create', {
    name: '종료 행사 참가자', phone: '01012340009', meal: '일반식',
  }, cookies.manager);
  assert.equal(created.status, 201);

  const original = await harness.database.query('SELECT payload FROM events WHERE id = $1', [ids.operators]);
  const statuses = [];
  try {
    for (const stage of ['ENDED', 'ARCHIVED']) {
      await harness.database.query(
        "UPDATE events SET payload = jsonb_set(payload, '{stage}', to_jsonb($2::text), true) WHERE id = $1",
        [ids.operators, stage]
      );
      statuses.push(
        (await operatorCommand(ids.operators, 'participant.update', {
          id: created.json.participant.id, name: '변경 시도', phone: '01012340009',
        }, cookies.manager)).status,
        (await operatorCommand(ids.operators, 'participant.status', {
          id: created.json.participant.id, status: 'PENDING',
        }, cookies.manager)).status,
        (await operatorCommand(ids.operators, 'ticket.reissue', {
          id: created.json.participant.id,
        }, cookies.manager)).status,
        (await operatorCommand(ids.operators, 'participant.create', {
          name: '추가 시도', phone: stage === 'ENDED' ? '01012340010' : '01012340011',
        }, cookies.manager)).status,
        (await operatorCommand(ids.operators, 'participant.import', {
          rows: [{ name: '가져오기 시도', phone: stage === 'ENDED' ? '01012340012' : '01012340013' }],
        }, cookies.manager)).status,
      );
    }
  } finally {
    await harness.database.query('UPDATE events SET payload = $2::jsonb WHERE id = $1', [
      ids.operators,
      JSON.stringify(original.rows[0].payload),
    ]);
  }

  assert.deepEqual(statuses, [409, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
});

test('participant-cancellation-keeps-the-payment-and-ticket-projection-in-sync', async () => {
  const created = await operatorCommand(ids.payment, 'participant.create', {
    name: '결제 참가자', phone: '01012340014', meal: '일반식',
  }, cookies.manager);
  assert.equal(created.status, 201);
  assert.equal(created.json.participant.paymentStatus, 'PENDING');

  const paid = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.payment]
  );
  const paidWorkspace = paid.rows[0].payload;
  const person = paidWorkspace.participants.find((item) => item.id === created.json.participant.id);
  person.paymentStatus = 'PAID';
  paidWorkspace.payments.find((item) => item.participantId === person.id).status = 'PAID';
  await harness.database.query(
    'UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [ids.payment, JSON.stringify(paidWorkspace)]
  );

  const canceled = await operatorCommand(ids.payment, 'participant.status', {
    id: person.id, status: 'CANCELLED',
  }, cookies.manager);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.json.participants[0].status, 'CANCELLED');
  assert.equal(canceled.json.participants[0].revoked, true);
  assert.equal(canceled.json.participants[0].paymentStatus, 'REFUND_REQUESTED');

  const saved = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.payment]
  );
  const savedPerson = saved.rows[0].payload.participants.find((item) => item.id === person.id);
  const savedPayment = saved.rows[0].payload.payments.find((item) => item.participantId === person.id);
  assert.equal(savedPerson.paymentStatus, 'REFUND_REQUESTED');
  assert.equal(savedPayment.status, 'REFUND_REQUESTED');
  assert.equal(savedPayment.provider, 'UNCONNECTED');

  const restored = await operatorCommand(ids.payment, 'participant.status', {
    id: person.id, status: 'APPROVED',
  }, cookies.manager);
  assert.equal(restored.status, 200);
  assert.equal(restored.json.participants[0].paymentStatus, 'REFUND_REQUESTED');
  assert.notEqual(restored.json.participants[0].ticket, created.json.participant.ticket);
});

test('participant-cancellation-preserves-v9-pending-payment-projection', async () => {
  const created = await operatorCommand(ids.payment, 'participant.create', {
    name: '결제 대기 취소 참가자', phone: '01012340024', meal: '일반식',
  }, cookies.manager);
  assert.equal(created.status, 201);
  assert.equal(created.json.participant.paymentStatus, 'PENDING');

  const canceled = await operatorCommand(ids.payment, 'participant.status', {
    id: created.json.participant.id, status: 'CANCELLED',
  }, cookies.manager);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.json.participants[0].status, 'CANCELLED');
  assert.equal(canceled.json.participants[0].paymentStatus, 'PENDING');

  const stored = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [ids.payment]
  );
  const participant = stored.rows[0].payload.participants.find((item) => item.id === created.json.participant.id);
  const payment = stored.rows[0].payload.payments.find((item) => item.participantId === participant.id);
  assert.equal(participant.revoked, true);
  assert.equal(payment.status, 'PENDING');
});

test('replaying-an-old-ticket-reissue-does-not-return-a-later-ticket', async () => {
  const created = await operatorCommand(ids.operators, 'participant.create', {
    name: '재발급 재시도 참가자', phone: '01012340023', meal: '일반식',
  }, cookies.manager);
  assert.equal(created.status, 201);
  const firstReissueId = commandId();
  const firstReissue = await operatorCommand(ids.operators, 'ticket.reissue', {
    id: created.json.participant.id,
  }, cookies.manager, firstReissueId);
  const laterReissue = await operatorCommand(ids.operators, 'ticket.reissue', {
    id: created.json.participant.id,
  }, cookies.manager);
  const replay = await operatorCommand(ids.operators, 'ticket.reissue', {
    id: created.json.participant.id,
  }, cookies.manager, firstReissueId);

  assert.equal(firstReissue.status, 200);
  assert.equal(laterReissue.status, 200);
  assert.equal(replay.status, 409);
});

test('operator-ticket-reissue-invalidates-the-old-token-and-expired-tickets-are-rejected', async () => {
  const created = await operatorCommand(ids.operators, 'participant.create', {
    name: '재발급 참가자', phone: '01012340007', meal: '일반식',
  }, cookies.manager);
  assert.equal(created.status, 201);

  const expired = await requestJson(
    harness.baseUrl,
    `/api/public/events/${slugs.expired}/ticket`,
    { bearer: expiredTicket }
  );
  assert.equal(expired.status, 404);
  const expiredCommand = await attendeeCommand(ids.expired, 'participant.cancel', {}, expiredTicket);
  assert.equal(expiredCommand.status, 404);

  const reissued = await operatorCommand(ids.operators, 'ticket.reissue', {
    id: created.json.participant.id,
  }, cookies.manager);
  assert.equal(reissued.status, 200);
  assert.notEqual(reissued.json.participant.ticket, created.json.participant.ticket);

  const oldTicket = await requestJson(
    harness.baseUrl,
    `/api/public/events/${slugs.operators}/ticket`,
    { bearer: created.json.participant.ticket }
  );
  const newTicket = await requestJson(
    harness.baseUrl,
    `/api/public/events/${slugs.operators}/ticket`,
    { bearer: reissued.json.participant.ticket }
  );
  assert.equal(oldTicket.status, 404);
  assert.equal(newTicket.status, 200);
});
