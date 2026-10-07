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
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const accountIds = {
  agency: `operations-agency-${suffix}`,
  manager: `operations-manager-${suffix}`,
  staff: `operations-staff-${suffix}`,
  otherStaff: `operations-other-staff-${suffix}`,
};
const eventIds = [];
let harness;
let cookies = {};
let fixtureNumber = 0;

function commandId() {
  return `cmd-${crypto.randomUUID()}`;
}

function makeParticipant(eventId, name, overrides = {}) {
  return {
    id: `person-${crypto.randomUUID()}`,
    name,
    phone: `010${String(crypto.randomInt(10000000, 99999999))}`,
    email: '',
    company: '',
    group: '일반',
    status: 'APPROVED',
    inside: false,
    everIn: false,
    revoked: false,
    ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
    ticketExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
    registrationType: 'PRE',
    paymentStatus: 'FREE',
    answers: {},
    consent: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function createFixture({
  stage = 'LIVE',
  features = ['stamp'],
  allowReentry = true,
  participants = [],
  stampMode = 'STAFF',
} = {}) {
  fixtureNumber += 1;
  const id = `operations-${fixtureNumber}-${suffix}`;
  const slug = `operations-${fixtureNumber}-${suffix}`;
  const deskIn = `desk-in-${fixtureNumber}-${suffix}`;
  const deskOut = `desk-out-${fixtureNumber}-${suffix}`;
  const boothId = `booth-${fixtureNumber}-${suffix}`;
  const workspace = {
    participants,
    desks: [
      { id: deskIn, name: '입장 데스크', action: 'IN', mode: 'desk', open: true },
      { id: deskOut, name: '퇴장 데스크', action: 'OUT', mode: 'tablet', open: true },
    ],
    booths: [
      {
        id: boothId,
        name: '체험 부스',
        zone: '로비',
        status: 'OPEN',
        capacity: 10,
        limit: 1,
        used: 0,
        startsAt: '',
        endsAt: '',
      },
    ],
    assignments: [],
    checks: [],
    visits: [],
    audit: [],
    stampMode,
    allowReentry,
  };
  await insertEvent(harness.database, {
    id,
    slug,
    payload: {
      id,
      slug,
      name: '현장 운영 검증 행사',
      date: '2026-12-01',
      start: '09:00',
      end: '17:00',
      capacity: 100,
      stage,
      features,
    },
    workspace,
  });
  await insertMembership(harness.database, accountIds.manager, id, ['all']);
  eventIds.push(id);
  return { id, slug, deskIn, deskOut, boothId, workspace };
}

async function seedAssignment(event, { accountId = accountIds.staff, type = 'DESK', targetId } = {}) {
  const assignment = {
    id: `assignment-${crypto.randomUUID()}`,
    accountId,
    eventId: event.id,
    type,
    targetId: targetId || (type === 'DESK' ? event.deskIn : event.boothId),
  };
  await insertAssignment(harness.database, assignment);
  const saved = await readWorkspace(event.id);
  saved.assignments.push({
    id: assignment.id,
    accountId: assignment.accountId,
    type: assignment.type,
    targetId: assignment.targetId,
  });
  await writeWorkspace(event.id, saved);
  return assignment;
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

function operatorCommand(eventId, command, payload, {
  actor = 'manager',
  assignmentId,
  id = commandId(),
} = {}) {
  return requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie: cookies[actor],
    body: { commandId: id, command, assignmentId, payload },
  });
}

function attendeeBoothCommand(event, ticket, code, id = commandId()) {
  return requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST',
    bearer: ticket,
    body: { commandId: id, command: 'booth.visit', payload: { code } },
  });
}

async function assignStaff(event, { accountId = accountIds.staff, type = 'DESK', targetId } = {}) {
  return operatorCommand(event.id, 'staff.assign', {
    accountId,
    type,
    targetId: targetId || (type === 'DESK' ? event.deskIn : event.boothId),
  });
}

async function scan(event, participant, {
  actor = 'manager',
  assignmentId,
  deskId = event.deskIn,
  id = commandId(),
} = {}) {
  return operatorCommand(event.id, 'check.scan', { deskId, ticket: participant.ticket }, {
    actor,
    assignmentId,
    id,
  });
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '운영사 관리자'],
    ['manager', 'MANAGER', '행사 매니저'],
    ['staff', 'STAFF', '현장 스태프'],
    ['otherStaff', 'STAFF', '다른 스태프'],
  ]) {
    await insertAccount(harness.database, {
      id: accountIds[key],
      role,
      name,
      email: `${accountIds[key]}@example.test`,
    });
    cookies[key] = await sessionCookie(harness, accountIds[key]);
  }
});

after(async () => {
  if (!harness) return;
  try {
    await deleteFixtureRows(harness.database, {
      eventIds,
      accountIds: Object.values(accountIds),
    });
  } finally {
    await harness.close();
  }
});

test('desk-setup-requires-confirmation-to-change-direction-and-can-reopen', async () => {
  const event = await createFixture({ stage: 'READY' });
  const created = await operatorCommand(event.id, 'desk.save', {
    name: '임시 등록 데스크', action: 'IN', mode: 'desk', open: true,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const deskId = created.json.desk.id;
  assert.ok(deskId);
  assert.equal(created.json.desk.open, true);

  const unconfirmed = await operatorCommand(event.id, 'desk.save', {
    id: deskId, name: '임시 등록 데스크', action: 'OUT', mode: 'tablet', open: true,
  });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.json.error, /방향|확인/);

  const changed = await operatorCommand(event.id, 'desk.save', {
    id: deskId, name: '임시 등록 데스크', action: 'OUT', mode: 'tablet',
    confirmDirectionChange: true, open: true,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.desk.action, 'OUT');
  assert.equal(changed.json.desk.open, false);

  const reopened = await operatorCommand(event.id, 'desk.set-open', { id: deskId, open: true });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
  assert.equal(reopened.json.desk.open, true);
});

test('staff-assignment-is-relational-revocation-invalidates-link-and-reassignment-rotates-it', async () => {
  const event = await createFixture();
  const assigned = await assignStaff(event);
  assert.equal(assigned.status, 201, JSON.stringify(assigned.json));
  const oldId = assigned.json.assignment.id;
  assert.ok(oldId);

  const [relational, workspace] = await Promise.all([
    harness.database.query(
      'SELECT active, account_id, type, target_id FROM staff_assignments WHERE id = $1',
      [oldId]
    ),
    readWorkspace(event.id),
  ]);
  assert.deepEqual(relational.rows[0], {
    active: true,
    account_id: accountIds.staff,
    type: 'DESK',
    target_id: event.deskIn,
  });
  assert.deepEqual(workspace.assignments, [{
    id: oldId, accountId: accountIds.staff, type: 'DESK', targetId: event.deskIn,
  }]);

  const duplicate = await assignStaff(event);
  assert.equal(duplicate.status, 409);
  const wrongRole = await assignStaff(event, { accountId: accountIds.manager });
  assert.equal(wrongRole.status, 400);

  const revoked = await operatorCommand(event.id, 'staff.unassign', { id: oldId });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  const saved = await harness.database.query(
    'SELECT active FROM staff_assignments WHERE id = $1',
    [oldId]
  );
  assert.equal(saved.rows[0].active, false);
  assert.deepEqual((await readWorkspace(event.id)).assignments, []);

  const revokedLink = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, ticket: 'not-a-ticket',
  }, { actor: 'staff', assignmentId: oldId });
  assert.equal(revokedLink.status, 403);

  const reassigned = await assignStaff(event);
  assert.equal(reassigned.status, 201, JSON.stringify(reassigned.json));
  assert.notEqual(reassigned.json.assignment.id, oldId);
  const staleLink = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, ticket: 'not-a-ticket',
  }, { actor: 'staff', assignmentId: oldId });
  assert.equal(staleLink.status, 403);
});

test('staff-checkin-requires-live-event-open-exact-active-desk-assignment', async () => {
  const participant = makeParticipant('placeholder', '스캔 대상');
  const event = await createFixture({ stage: 'READY', participants: [participant] });
  participant.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  const assignment = await seedAssignment(event);

  const notLive = await scan(event, participant, { actor: 'staff', assignmentId: assignment.id });
  assert.equal(notLive.status, 409);

  const wrongDesk = await scan(event, participant, {
    actor: 'staff', assignmentId: assignment.id, deskId: event.deskOut,
  });
  assert.equal(wrongDesk.status, 403);

  const payload = await readWorkspace(event.id);
  payload.participants[0].ticket = participant.ticket;
  payload.desks[0].open = false;
  await writeWorkspace(event.id, payload);
  await harness.database.query(
    "UPDATE events SET payload = jsonb_set(payload, '{stage}', to_jsonb('LIVE'::text), true) WHERE id = $1",
    [event.id]
  );
  const closedDesk = await scan(event, participant, { actor: 'staff', assignmentId: assignment.id });
  assert.equal(closedDesk.status, 409);

  const inactive = await harness.database.query(
    'UPDATE staff_assignments SET active = false WHERE id = $1',
    [assignment.id]
  );
  assert.equal(inactive.rowCount, 1);
  const revoked = await scan(event, participant, { actor: 'staff', assignmentId: assignment.id });
  assert.equal(revoked.status, 403);
});

test('checkin-validates-ticket-payment-and-status-and-records-v9-history', async () => {
  const event = await createFixture();
  const free = makeParticipant(event.id, '무료 참가자');
  const pending = makeParticipant(event.id, '승인 대기 참가자', { status: 'PENDING' });
  const expired = makeParticipant(event.id, '만료 참가자', {
    ticketExpiresAt: '2020-01-01T00:00:00.000Z',
  });
  const unpaid = makeParticipant(event.id, '결제 대기 참가자', { paymentStatus: 'PENDING' });
  const paid = makeParticipant(event.id, '결제 완료 참가자', { paymentStatus: 'PAID' });
  const saved = await readWorkspace(event.id);
  saved.participants.push(free, pending, expired, unpaid, paid);
  await writeWorkspace(event.id, saved);

  const checkId = commandId();
  const entered = await scan(event, free, { id: checkId });
  assert.equal(entered.status, 200, JSON.stringify(entered.json));
  assert.deepEqual(entered.json, { name: free.name, id: free.id, action: 'IN', reentry: false });

  const duplicate = await scan(event, free);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.json.error, /이미|중복/);
  assert.equal((await scan(event, pending)).status, 409);
  assert.equal((await scan(event, expired)).status, 409);
  assert.equal((await scan(event, unpaid)).status, 409);
  assert.equal((await scan(event, { ...paid, ticket: 'wrong-event-ticket' })).status, 404);

  const paidIn = await scan(event, paid);
  assert.equal(paidIn.status, 200, JSON.stringify(paidIn.json));

  const state = await readWorkspace(event.id);
  assert.equal(state.participants.find((person) => person.id === free.id).inside, true);
  assert.equal(state.participants.find((person) => person.id === free.id).everIn, true);
  const freeCheck = state.checks.find((check) => check.id === checkId);
  assert.match(freeCheck.at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual({ ...freeCheck, at: null }, {
    id: checkId,
    participantId: free.id,
    name: free.name,
    action: 'IN',
    deskId: event.deskIn,
    actor: accountIds.manager,
    at: null,
    before: { inside: false, everIn: false },
    corrected: false,
  });
  assert.equal(state.audit[0].type, 'check.scan');
  assert.equal(state.audit[0].actor, accountIds.manager);
});

test('concurrent-offline-replay-with-same-command-id-creates-one-checkin', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '오프라인 재전송 참가자');
  const workspace = await readWorkspace(event.id);
  workspace.participants.push(person);
  await writeWorkspace(event.id, workspace);
  const assignment = await seedAssignment(event);
  const id = commandId();
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    scan(event, person, { actor: 'staff', assignmentId: assignment.id, id })
  ));

  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 200, 200, 200]);
  assert.ok(results.every((result) => result.json.id === person.id));
  const state = await readWorkspace(event.id);
  assert.equal(state.checks.filter((row) => row.participantId === person.id).length, 1);
  assert.equal(state.audit.filter((row) => row.id === id).length, 1);
});

test('checkin-respects-reentry-and-supports-exit-before-a-later-entry', async () => {
  const person = makeParticipant('placeholder', '재입장 참가자', { everIn: true });
  const event = await createFixture({ allowReentry: false, participants: [person] });
  person.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  let state = await readWorkspace(event.id);
  state.participants[0].ticket = person.ticket;
  await writeWorkspace(event.id, state);

  const deniedReentry = await scan(event, person);
  assert.equal(deniedReentry.status, 409);
  assert.match(deniedReentry.json.error, /재입장/);

  state = await readWorkspace(event.id);
  state.allowReentry = true;
  await writeWorkspace(event.id, state);
  const entered = await scan(event, person);
  assert.equal(entered.status, 200, JSON.stringify(entered.json));
  assert.equal(entered.json.reentry, true);

  const exited = await scan(event, person, { deskId: event.deskOut });
  assert.equal(exited.status, 200, JSON.stringify(exited.json));
  assert.equal(exited.json.action, 'OUT');
  const duplicateExit = await scan(event, person, { deskId: event.deskOut });
  assert.equal(duplicateExit.status, 409);
  const finalState = await readWorkspace(event.id);
  const savedPerson = finalState.participants.find((item) => item.id === person.id);
  assert.equal(savedPerson.inside, false);
  assert.equal(savedPerson.everIn, true);
});

test('check-correction-preserves-original-record-and-recomputes-participant-state', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '정정 대상 참가자');
  const workspace = await readWorkspace(event.id);
  workspace.participants.push(person);
  await writeWorkspace(event.id, workspace);
  const entered = await scan(event, person);
  assert.equal(entered.status, 200, JSON.stringify(entered.json));
  const before = await readWorkspace(event.id);
  const check = before.checks[0];

  const missingReason = await operatorCommand(event.id, 'check.correct', { id: check.id, reason: '' });
  assert.equal(missingReason.status, 400);
  const corrected = await operatorCommand(event.id, 'check.correct', {
    id: check.id, reason: '티켓 확인을 잘못 처리했습니다.',
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.json));

  const state = await readWorkspace(event.id);
  assert.equal(state.checks.length, 1);
  assert.equal(state.checks[0].id, check.id);
  assert.equal(state.checks[0].action, 'IN');
  assert.equal(state.checks[0].corrected, true);
  assert.equal(state.checks[0].correction.reason, '티켓 확인을 잘못 처리했습니다.');
  assert.equal(state.checks[0].correction.actor, accountIds.manager);
  const savedPerson = state.participants.find((item) => item.id === person.id);
  assert.equal(savedPerson.inside, false);
  assert.equal(savedPerson.everIn, false);

  const duplicateCorrection = await operatorCommand(event.id, 'check.correct', {
    id: check.id, reason: '다시 정정 시도',
  });
  assert.equal(duplicateCorrection.status, 409);
});

test('staff-correction-is-limited-to-own-record-on-the-assigned-desk', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '담당자 정정 대상');
  const workspace = await readWorkspace(event.id);
  workspace.participants.push(person);
  await writeWorkspace(event.id, workspace);
  const first = await seedAssignment(event, { accountId: accountIds.staff });
  const second = await seedAssignment(event, { accountId: accountIds.otherStaff });
  const entered = await scan(event, person, { actor: 'staff', assignmentId: first.id });
  assert.equal(entered.status, 200, JSON.stringify(entered.json));
  const check = (await readWorkspace(event.id)).checks[0];

  const otherStaffCorrection = await operatorCommand(event.id, 'check.correct', {
    id: check.id, reason: '다른 스태프 정정 시도',
  }, { actor: 'otherStaff', assignmentId: second.id });
  assert.equal(otherStaffCorrection.status, 403);

  const ownCorrection = await operatorCommand(event.id, 'check.correct', {
    id: check.id, reason: '본인 기록 정정 사유',
  }, { actor: 'staff', assignmentId: first.id });
  assert.equal(ownCorrection.status, 200, JSON.stringify(ownCorrection.json));
});

test('booth-visit-uses-assigned-booth-enforces-payment-capacity-and-records-actor', async () => {
  const person = makeParticipant('placeholder', '부스 참가자', { inside: true });
  const event = await createFixture({ participants: [person] });
  person.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  const initial = await readWorkspace(event.id);
  initial.participants[0].ticket = person.ticket;
  await writeWorkspace(event.id, initial);

  const configured = await operatorCommand(event.id, 'booth.save', {
    id: event.boothId,
    name: '체험 부스',
    zone: '1층 로비',
    status: 'OPEN',
    capacity: 1,
    limit: 1,
    startsAt: '',
    endsAt: '',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.json));

  const assignment = await assignStaff(event, { type: 'BOOTH' });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.json));
  const visitId = commandId();
  const visit = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId,
    ticket: person.ticket,
  }, { actor: 'staff', assignmentId: assignment.json.assignment.id, id: visitId });
  assert.equal(visit.status, 201, JSON.stringify(visit.json));
  assert.deepEqual(visit.json, { name: person.name, booth: '체험 부스' });

  const replay = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId,
    ticket: person.ticket,
  }, { actor: 'staff', assignmentId: assignment.json.assignment.id, id: visitId });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, visit.json);

  const wrongBooth = await operatorCommand(event.id, 'booth.visit', {
    boothId: 'other-booth', ticket: person.ticket,
  }, { actor: 'staff', assignmentId: assignment.json.assignment.id });
  assert.equal(wrongBooth.status, 403);

  const overCapacity = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId, ticket: person.ticket,
  }, { actor: 'manager' });
  assert.equal(overCapacity.status, 409);
  const state = await readWorkspace(event.id);
  assert.equal(state.booths[0].used, 1);
  assert.deepEqual(state.visits[0], {
    id: visitId,
    boothId: event.boothId,
    participantId: person.id,
    name: person.name,
    actor: accountIds.staff,
    at: state.visits[0].at,
    mode: 'STAFF',
  });

  const lockedMode = await operatorCommand(event.id, 'booth.mode', { mode: 'SELF', acknowledge: true });
  assert.equal(lockedMode.status, 409);
});

test('booth-visit-rejects-unpaid-not-inside-closed-or-disabled-booth-state', async () => {
  const unpaid = makeParticipant('placeholder', '결제 대기 부스 참가자', {
    inside: true, paymentStatus: 'PENDING',
  });
  const outside = makeParticipant('placeholder', '미입장 부스 참가자');
  const eligible = makeParticipant('placeholder', '부스 종료 검증 참가자', { inside: true });
  const event = await createFixture({ participants: [unpaid, outside, eligible] });
  unpaid.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  outside.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  eligible.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  const state = await readWorkspace(event.id);
  state.participants[0].ticket = unpaid.ticket;
  state.participants[1].ticket = outside.ticket;
  state.participants[2].ticket = eligible.ticket;
  await writeWorkspace(event.id, state);

  const unpaidVisit = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId, ticket: unpaid.ticket,
  });
  assert.equal(unpaidVisit.status, 409);
  const closedVisit = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId, ticket: outside.ticket,
  });
  assert.equal(closedVisit.status, 409);

  const closedWorkspace = await readWorkspace(event.id);
  closedWorkspace.booths[0].status = 'CLOSED';
  await writeWorkspace(event.id, closedWorkspace);
  const rejectedClosedBooth = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId, ticket: eligible.ticket,
  });
  assert.equal(rejectedClosedBooth.status, 409);

  const readyEvent = await createFixture({ stage: 'READY' });
  const notLive = await operatorCommand(readyEvent.id, 'booth.visit', {
    boothId: readyEvent.boothId, ticket: outside.ticket,
  });
  assert.equal(notLive.status, 409);
});

test('booth-mode-requires-explicit-acknowledgement-and-feature-is-required-for-visits', async () => {
  const event = await createFixture({ stampMode: 'SELF' });
  const missingAck = await operatorCommand(event.id, 'booth.mode', {
    mode: 'STAFF', acknowledge: false,
  });
  assert.equal(missingAck.status, 400);
  const changed = await operatorCommand(event.id, 'booth.mode', {
    mode: 'STAFF', acknowledge: true,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));

  const noStamp = await createFixture({ features: [] });
  const disabled = await operatorCommand(noStamp.id, 'booth.save', {
    name: '기능이 꺼진 부스', status: 'OPEN', capacity: 0, limit: 1,
  });
  assert.equal(disabled.status, 409);
});

test('app-free-attendee-can-redeem-self-booth-qr-with-ticket-and-replay-safely', async () => {
  const person = makeParticipant('placeholder', '셀프 인증 참가자', { inside: true });
  const otherPerson = makeParticipant('placeholder', '다른 티켓 재생 참가자', { inside: true });
  const event = await createFixture({ stampMode: 'SELF', participants: [person, otherPerson] });
  person.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  otherPerson.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  const workspace = await readWorkspace(event.id);
  workspace.participants[0].ticket = person.ticket;
  workspace.participants[1].ticket = otherPerson.ticket;
  await writeWorkspace(event.id, workspace);
  const id = commandId();
  const code = `ET:BOOTH:${event.id}:${event.boothId}`;

  const visit = await attendeeBoothCommand(event, person.ticket, code, id);
  assert.equal(visit.status, 201, JSON.stringify(visit.json));
  assert.deepEqual(visit.json, { name: person.name, booth: '체험 부스' });
  const replay = await attendeeBoothCommand(event, person.ticket, code, id);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, visit.json);
  const otherTicketReplay = await attendeeBoothCommand(event, otherPerson.ticket, code, id);
  assert.equal(otherTicketReplay.status, 409);

  const saved = await readWorkspace(event.id);
  assert.equal(saved.visits.length, 1);
  assert.equal(saved.visits[0].participantId, person.id);
  assert.equal(saved.visits[0].actor, person.id);
  assert.equal(saved.visits[0].mode, 'SELF');
  assert.equal(saved.booths[0].used, 1);
  const receipt = await harness.database.query(
    'SELECT result FROM command_receipts WHERE command_id = $1',
    [id]
  );
  assert.ok(!JSON.stringify(receipt.rows[0].result).includes(person.ticket));

  const wrongCode = await attendeeBoothCommand(event, person.ticket, 'ET:BOOTH:another-event:other-booth');
  assert.equal(wrongCode.status, 400);

  const anotherEvent = await createFixture({ stampMode: 'SELF' });
  const crossEventTicket = await attendeeBoothCommand(
    anotherEvent,
    person.ticket,
    `ET:BOOTH:${anotherEvent.id}:${anotherEvent.boothId}`
  );
  assert.equal(crossEventTicket.status, 404);
});

test('booth-person-limit-is-independent-of-total-capacity', async () => {
  const first = makeParticipant('placeholder', '1인 제한 참가자', { inside: true });
  const second = makeParticipant('placeholder', '다음 참가자', { inside: true });
  const event = await createFixture({ participants: [first, second] });
  first.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  second.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  const workspace = await readWorkspace(event.id);
  workspace.participants[0].ticket = first.ticket;
  workspace.participants[1].ticket = second.ticket;
  workspace.booths[0].capacity = 0;
  workspace.booths[0].limit = 1;
  await writeWorkspace(event.id, workspace);

  const firstVisit = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId, ticket: first.ticket,
  });
  assert.equal(firstVisit.status, 201, JSON.stringify(firstVisit.json));
  const repeatedVisit = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId, ticket: first.ticket,
  });
  assert.equal(repeatedVisit.status, 409);
  const secondVisit = await operatorCommand(event.id, 'booth.visit', {
    boothId: event.boothId, ticket: second.ticket,
  });
  assert.equal(secondVisit.status, 201, JSON.stringify(secondVisit.json));
  assert.equal((await readWorkspace(event.id)).booths[0].used, 2);
});

test('operation-command-id-cannot-be-reused-for-a-different-operation-or-event', async () => {
  const event = await createFixture();
  const id = commandId();
  const created = await operatorCommand(event.id, 'desk.save', {
    name: '중복 명령 테스트', action: 'IN', mode: 'desk', open: true,
  }, { id });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const reused = await operatorCommand(event.id, 'desk.set-open', {
    id: created.json.desk.id, open: false,
  }, { id });
  assert.equal(reused.status, 409);
  const eventOutside = await createFixture();
  const crossEvent = await operatorCommand(eventOutside.id, 'desk.save', {
    name: '다른 행사 명령', action: 'IN', mode: 'desk', open: true,
  }, { id });
  assert.equal(crossEvent.status, 409);
});

test('manager-membership-is-required-for-operation-setup-and-archived-event-writes', async () => {
  const event = await createFixture({ stage: 'ARCHIVED' });
  const archived = await operatorCommand(event.id, 'desk.save', {
    name: '보관 행사 데스크', action: 'IN', mode: 'desk',
  });
  assert.equal(archived.status, 409);

  const outside = await createFixture();
  await harness.database.query('DELETE FROM memberships WHERE account_id = $1 AND event_id = $2', [
    accountIds.manager, outside.id,
  ]);
  const denied = await operatorCommand(outside.id, 'desk.save', {
    name: '권한 없는 데스크', action: 'IN', mode: 'desk',
  });
  assert.equal(denied.status, 403);
});
