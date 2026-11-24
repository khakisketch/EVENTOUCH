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
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
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
    await insertAccount(harness.database, {orgId: LEGACY_ORG,
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

test('desk-save-defaults-missing-mode-to-desk-and-rejects-unknown-mode', async () => {
  const event = await createFixture({ stage: 'READY' });
  const defaulted = await operatorCommand(event.id, 'desk.save', {
    name: '모드 없는 데스크', action: 'IN', open: true,
  });
  assert.equal(defaulted.status, 201, JSON.stringify(defaulted.json));
  assert.equal(defaulted.json.desk.mode, 'desk');
  const stored = (await readWorkspace(event.id)).desks.find((desk) => desk.id === defaulted.json.desk.id);
  assert.equal(stored.mode, 'desk');

  const invalid = await operatorCommand(event.id, 'desk.save', {
    name: '모드 없는 데스크', action: 'IN', mode: 'kiosk', open: true,
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
});

test('desk edits and open changes reject stale snapshots without interrupting receipt replay', async () => {
  const person = makeParticipant('placeholder', '합성 데스크 검증');
  const event = await createFixture({ participants: [person] });
  const assignment = await seedAssignment(event);
  const original = { name: '입장 데스크', action: 'IN', mode: 'desk', open: true };
  const save = (expectedDesk, changes = {}, options = {}) => operatorCommand(event.id, 'desk.save', {
    id: event.deskIn, ...original, ...changes, expectedDesk,
  }, options);
  const stopId = commandId();
  const stop = await operatorCommand(event.id, 'desk.set-open', {
    id: event.deskIn, open: false, expectedOpen: true,
  }, { actor: 'agency', id: stopId });
  assert.equal(stop.status, 200, JSON.stringify(stop.json));
  const rejectedId = commandId();
  const staleSave = await save(original, { name: '합성 이름 수정' }, { id: rejectedId });
  assert.equal(staleSave.status, 409);
  assert.equal(staleSave.json.code, 'DESK_CHANGED');
  const staleToggleId = commandId();
  const staleToggle = await operatorCommand(event.id, 'desk.set-open', {
    id: event.deskIn, open: true, expectedOpen: true,
  }, { id: staleToggleId });
  assert.equal(staleToggle.status, 409);
  assert.equal(staleToggle.json.code, 'DESK_OPEN_CHANGED');
  const deniedScan = await scan(event, person, { actor: 'staff', assignmentId: assignment.id });
  assert.equal(deniedScan.status, 409);
  assert.equal(deniedScan.json.code, 'DESK_CLOSED');
  const stored = await readWorkspace(event.id);
  assert.equal(stored.desks.find((desk) => desk.id === event.deskIn).open, false);
  assert.equal(stored.checks.length, 0);
  const rejectedReceipts = await harness.database.query(
    'SELECT command_id FROM command_receipts WHERE command_id = ANY($1::text[])', [[rejectedId, staleToggleId]]
  );
  assert.equal(rejectedReceipts.rows.length, 0);

  const closed = { ...original, open: false };
  for (const [key, value] of Object.entries({ name: '오래된 이름', action: 'OUT', mode: 'tablet', open: true })) {
    const rejected = await save({ ...closed, [key]: value }, { open: false });
    assert.equal(rejected.status, 409, key);
    assert.equal(rejected.json.code, 'DESK_CHANGED', key);
  }
  for (const expectedDesk of [null, {}, { ...closed, open: 'false' }]) {
    const malformed = await save(expectedDesk, { open: false });
    assert.equal(malformed.status, 400);
  }
  assert.equal((await operatorCommand(event.id, 'desk.set-open', {
    id: event.deskIn, open: true, expectedOpen: 'false',
  })).status, 400);

  const reopen = await operatorCommand(event.id, 'desk.set-open', {
    id: event.deskIn, open: true, expectedOpen: false,
  });
  assert.equal(reopen.status, 200);
  // The committed stop is replayed even though the current desk is now open.
  const replayStop = await operatorCommand(event.id, 'desk.set-open', {
    id: event.deskIn, open: false, expectedOpen: true,
  }, { actor: 'agency', id: stopId });
  assert.equal(replayStop.status, 200);
  assert.equal(replayStop.json.desk.open, false);
  assert.equal((await readWorkspace(event.id)).desks.find((desk) => desk.id === event.deskIn).open, true);

  const changeId = commandId();
  const direction = await save(original, { action: 'OUT', confirmDirectionChange: true }, { id: changeId });
  assert.equal(direction.status, 200);
  assert.equal(direction.json.desk.open, false);
  assert.equal(direction.json.desk.action, 'OUT');
  // A saw the same stopped state before B changed IN to OUT. The open flag
  // still matches, but starting the desk would enable the wrong direction.
  const staleStartId = commandId();
  const staleStart = await operatorCommand(event.id, 'desk.set-open', {
    id: event.deskIn, open: true, expectedOpen: false, expectedDesk: closed,
  }, { id: staleStartId });
  assert.equal(staleStart.status, 409);
  assert.equal(staleStart.json.code, 'DESK_CHANGED');
  assert.equal((await readWorkspace(event.id)).desks.find((desk) => desk.id === event.deskIn).open, false);
  assert.equal((await harness.database.query('SELECT command_id FROM command_receipts WHERE command_id = $1', [staleStartId])).rows.length, 0);
  const staleDirection = await save(original, { name: '이전 화면의 이름 변경' });
  assert.equal(staleDirection.status, 409);
  assert.equal(staleDirection.json.code, 'DESK_CHANGED');
  const directionReplay = await save(original, { action: 'OUT', confirmDirectionChange: true }, { id: changeId });
  assert.equal(directionReplay.status, 200);
  assert.equal(directionReplay.json.desk.action, 'OUT');

  const changedSnapshot = { ...original, action: 'OUT', open: false };
  const otherEdit = await save(changedSnapshot, {
    name: '다른 운영자의 이름', action: 'OUT', mode: 'tablet', open: false,
  }, { actor: 'agency' });
  assert.equal(otherEdit.status, 200);
  const staleEdit = await save(changedSnapshot, { action: 'OUT', open: false });
  assert.equal(staleEdit.status, 409);
  assert.equal(staleEdit.json.code, 'DESK_CHANGED');
  const afterOtherEdit = (await readWorkspace(event.id)).desks.find((desk) => desk.id === event.deskIn);
  assert.equal(afterOtherEdit.name, '다른 운영자의 이름');
  assert.equal(afterOtherEdit.mode, 'tablet');
  for (const key of ['name', 'mode']) {
    const staleExpected = { name: afterOtherEdit.name, action: afterOtherEdit.action, mode: afterOtherEdit.mode, open: false,
      [key]: changedSnapshot[key] };
    const staleOpen = await operatorCommand(event.id, 'desk.set-open', {
      id: event.deskIn, open: true, expectedOpen: false, expectedDesk: staleExpected,
    });
    assert.equal(staleOpen.status, 409, key);
    assert.equal(staleOpen.json.code, 'DESK_CHANGED', key);
  }

  // Existing clients without either optional comparison continue to work.
  assert.equal((await operatorCommand(event.id, 'desk.set-open', { id: event.deskIn, open: true })).status, 200);
  const legacy = await operatorCommand(event.id, 'desk.save', {
    id: event.deskIn, name: '구 클라이언트 저장', action: 'OUT', mode: 'tablet', open: true,
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.desk.mode, 'tablet');
});

test('operator bootstrap explicitly projects legacy desk omissions without changing stored data or staff scope', async () => {
  const person = makeParticipant('placeholder', '레거시 데스크 참가자');
  const event = await createFixture({ participants: [person] });
  const workspace = await readWorkspace(event.id);
  const legacy = workspace.desks.find((desk) => desk.id === event.deskIn);
  delete legacy.action;
  delete legacy.mode;
  delete legacy.open;
  workspace.desks.push({ id: 'missing-name', action: 'OUT', mode: 'tablet', open: false });
  workspace.desks.push({ id: 'invalid-values', name: '비정상 데스크', action: 'INVALID', mode: 'kiosk', open: false });
  workspace.desks.push({ id: 'legacy-mode', name: '레거시 화면', action: 'IN', open: false });
  await writeWorkspace(event.id, workspace);
  const assignment = await seedAssignment(event);
  const original = await readWorkspace(event.id);
  const read = (path, actor) => requestJson(harness.baseUrl, path, { cookie: cookies[actor] });
  for (const actor of ['manager', 'agency']) {
    for (const path of ['/api/bootstrap', `/api/events/${event.id}/bootstrap`]) {
      const response = await read(path, actor);
      assert.equal(response.status, 200);
      const desks = response.json.state.workspaces[event.id].desks;
      const projected = desks.find((desk) => desk.id === event.deskIn);
      assert.equal(projected.name, legacy.name);
      assert.equal(projected.action, null, 'missing direction stays unknown');
      assert.equal(projected.mode, 'desk');
      assert.equal(projected.open, true);
      assert.equal(desks.find((desk) => desk.id === 'missing-name').name, null);
      const invalid = desks.find((desk) => desk.id === 'invalid-values');
      assert.equal(invalid.action, 'INVALID');
      assert.equal(invalid.mode, 'kiosk');
      assert.equal(invalid.open, false);
      const normal = desks.find((desk) => desk.id === event.deskOut);
      assert.deepEqual({ name: normal.name, action: normal.action, mode: normal.mode, open: normal.open },
        { name: '퇴장 데스크', action: 'OUT', mode: 'tablet', open: true });
    }
  }
  for (const path of ['/api/bootstrap', `/api/events/${event.id}/bootstrap`]) {
    const response = await read(path, 'staff');
    assert.equal(response.status, 200);
    const desks = response.json.state.workspaces[event.id].desks;
    assert.deepEqual(desks.map((desk) => desk.id), [event.deskIn]);
    assert.equal(desks[0].action, '', 'staff projection remains unchanged');
    assert.equal(Object.hasOwn(desks[0], 'mode'), false, 'staff projection does not gain operator-only mode');
  }
  const scanAttempt = await scan(event, person, { actor: 'staff', assignmentId: assignment.id });
  assert.equal(scanAttempt.status, 409);
  assert.match(scanAttempt.json.error, /데스크 작업/);
  assert.deepEqual(await readWorkspace(event.id), original, 'reads and rejected scan do not rewrite stored workspace');

  const expectedDesk = { name: legacy.name, action: null, mode: 'desk', open: true };
  const stopLegacyId = commandId();
  const legacyStopRequest = { id: event.deskIn, open: false, expectedOpen: true, expectedDesk };
  const stoppedLegacy = await operatorCommand(event.id, 'desk.set-open', legacyStopRequest, { id: stopLegacyId });
  assert.equal(stoppedLegacy.status, 200);
  assert.deepEqual({ name: stoppedLegacy.json.desk.name, action: stoppedLegacy.json.desk.action,
    mode: stoppedLegacy.json.desk.mode, open: stoppedLegacy.json.desk.open },
  { name: legacy.name, action: null, mode: 'desk', open: false });
  const rawStopped = (await readWorkspace(event.id)).desks.find((desk) => desk.id === event.deskIn);
  assert.equal(Object.hasOwn(rawStopped, 'action'), false);
  assert.equal(Object.hasOwn(rawStopped, 'mode'), false);
  const incompleteLegacy = await operatorCommand(event.id, 'desk.set-open', { id: event.deskIn, open: true });
  assert.equal(incompleteLegacy.status, 409);
  assert.equal(incompleteLegacy.json.code, 'DESK_INCOMPLETE');
  const legacyUnguarded = await operatorCommand(event.id, 'desk.set-open', { id: 'legacy-mode', open: true });
  assert.equal(legacyUnguarded.status, 200, 'missing mode keeps the desk default');
  assert.equal(Object.hasOwn(legacyUnguarded.json.desk, 'mode'), false);

  const repair = { id: event.deskIn, name: legacy.name, action: 'IN', mode: 'desk', open: false,
    expectedDesk: { ...expectedDesk, open: false } };
  const unconfirmed = await operatorCommand(event.id, 'desk.save', repair);
  assert.equal(unconfirmed.status, 400, 'explicit direction change confirmation stays required');
  const repairId = commandId();
  const repaired = await operatorCommand(event.id, 'desk.save', { ...repair, confirmDirectionChange: true }, { id: repairId });
  assert.equal(repaired.status, 200, JSON.stringify(repaired.json));
  assert.equal(repaired.json.desk.action, 'IN');
  assert.equal(repaired.json.desk.open, false, 'repair does not automatically start the desk');
  const reopen = await operatorCommand(event.id, 'desk.set-open', {
    id: event.deskIn, open: true, expectedOpen: false,
    expectedDesk: { name: legacy.name, action: 'IN', mode: 'desk', open: false },
  });
  assert.equal(reopen.status, 200);
  const stopReplay = await operatorCommand(event.id, 'desk.set-open', legacyStopRequest, { id: stopLegacyId });
  assert.deepEqual(stopReplay.json, stoppedLegacy.json, 'guarded receipt replays its complete original response');
  assert.equal((await readWorkspace(event.id)).desks.find((desk) => desk.id === event.deskIn).open, true,
    'replaying the earlier stop does not rewrite the desk');
  const repairReplay = await operatorCommand(event.id, 'desk.save', { ...repair, confirmDirectionChange: true }, { id: repairId });
  assert.equal(repairReplay.status, 200);
  assert.equal(repairReplay.json.desk.open, false, 'replay returns the committed response');
  assert.equal((await readWorkspace(event.id)).desks.find((desk) => desk.id === event.deskIn).open, true, 'replay does not stop the newly reopened desk');

  const nameRepair = await operatorCommand(event.id, 'desk.save', {
    id: 'missing-name', name: '이름 복구', action: 'OUT', mode: 'tablet', open: false,
    expectedDesk: { name: null, action: 'OUT', mode: 'tablet', open: false },
  });
  assert.equal(nameRepair.status, 200, JSON.stringify(nameRepair.json));
  assert.equal(nameRepair.json.desk.name, '이름 복구');
});

test('starting incomplete desks is rejected for all clients while stopping and legacy defaults remain available', async () => {
  const event = await createFixture();
  const workspace = await readWorkspace(event.id);
  workspace.desks.push(
    { id: 'missing-name', action: 'IN', mode: 'desk', open: false },
    { id: 'blank-name', name: '  ', action: 'IN', mode: 'desk', open: false },
    { id: 'missing-action', name: '방향 확인', mode: 'desk', open: false },
    { id: 'bad-action', name: '방향 확인', action: 'in', mode: 'desk', open: false },
    { id: 'bad-mode', name: '화면 확인', action: 'IN', mode: 'kiosk', open: false },
    { id: 'legacy-mode', name: '기존 데스크', action: 'IN', open: false },
    { id: 'already-open', name: '현재 가동', mode: 'desk', open: true },
  );
  await writeWorkspace(event.id, workspace);
  const rejectedIds = [];
  for (const [id, field] of [
    ['missing-name', 'name'], ['blank-name', 'name'], ['missing-action', 'action'],
    ['bad-action', 'action'], ['bad-mode', 'mode'],
  ]) {
    const desk = workspace.desks.find((item) => item.id === id);
    const expectedDesk = { name: typeof desk.name === 'string' ? desk.name : null,
      action: typeof desk.action === 'string' ? desk.action : null,
      mode: desk.mode || 'desk', open: false };
    for (const guarded of [false, true]) {
      const requestId = commandId();
      rejectedIds.push(requestId);
      const result = await operatorCommand(event.id, 'desk.set-open', {
        id, open: true, ...(guarded ? { expectedOpen: false, expectedDesk } : {}),
      }, { id: requestId });
      assert.equal(result.status, 409, `${id} guarded=${guarded}`);
      assert.equal(result.json.code, 'DESK_INCOMPLETE');
      assert.equal(result.json.field, field);
      assert.ok(result.json.error.includes(field === 'name' ? '이름' : field === 'action' ? '방향' : '화면'));
      assert.equal((await readWorkspace(event.id)).desks.find((item) => item.id === id).open, false);
    }
    const stop = await operatorCommand(event.id, 'desk.set-open', { id, open: false });
    assert.equal(stop.status, 200, `${id} can always be stopped`);
  }
  assert.equal((await harness.database.query('SELECT command_id FROM command_receipts WHERE command_id = ANY($1::text[])', [rejectedIds])).rows.length, 0);

  // New rejected starts do not silently change an already open legacy desk.
  const alreadyOpen = await operatorCommand(event.id, 'desk.set-open', { id: 'already-open', open: true });
  assert.equal(alreadyOpen.status, 409);
  assert.equal((await readWorkspace(event.id)).desks.find((desk) => desk.id === 'already-open').open, true);
  assert.equal((await operatorCommand(event.id, 'desk.set-open', { id: 'already-open', open: false })).status, 200);

  const successfulId = commandId();
  const legacyRequest = { id: 'legacy-mode', open: true };
  assert.equal((await operatorCommand(event.id, 'desk.set-open', legacyRequest, { id: successfulId })).status, 200);
  const changed = await readWorkspace(event.id);
  delete changed.desks.find((desk) => desk.id === 'legacy-mode').action;
  await writeWorkspace(event.id, changed);
  const replay = await operatorCommand(event.id, 'desk.set-open', legacyRequest, { id: successfulId });
  assert.equal(replay.status, 200, 'committed receipt precedes new validation');
  assert.equal(replay.json.desk.action, 'IN');
  const newRequest = await operatorCommand(event.id, 'desk.set-open', legacyRequest);
  assert.equal(newRequest.status, 409);
  assert.equal(newRequest.json.code, 'DESK_INCOMPLETE');
  assert.equal((await readWorkspace(event.id)).desks.find((desk) => desk.id === 'legacy-mode').open, true);
});

test('desk scan rejects a stale direction before saving and replays an existing receipt', async () => {
  const person = makeParticipant('placeholder', '데스크 방향 검증');
  const event = await createFixture({ participants: [person] });
  const assignment = await seedAssignment(event);
  const staff = { actor: 'staff', assignmentId: assignment.id };
  const id = commandId();
  const entry = { deskId: event.deskIn, ticket: person.ticket, expectedAction: 'IN' };
  assert.equal((await operatorCommand(event.id, 'check.scan', entry, { ...staff, id })).status, 200);

  const changed = await operatorCommand(event.id, 'desk.save', {
    id: event.deskIn, name: '전환 데스크', action: 'OUT', confirmDirectionChange: true,
  });
  assert.equal(changed.status, 200);
  const closed = await operatorCommand(event.id, 'check.scan', entry, staff);
  assert.equal(closed.status, 409);
  assert.equal(closed.json.code, 'DESK_CLOSED');
  assert.equal((await operatorCommand(event.id, 'desk.set-open', { id: event.deskIn, open: true })).status, 200);

  const replay = await operatorCommand(event.id, 'check.scan', entry, { ...staff, id });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.action, 'IN');
  const staleTicket = await operatorCommand(event.id, 'check.scan', entry, staff);
  assert.equal(staleTicket.status, 409);
  assert.equal(staleTicket.json.code, 'DESK_ACTION_CHANGED');
  const stalePerson = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, participantId: person.id, expectedAction: 'IN',
  }, staff);
  assert.equal(stalePerson.status, 409);
  assert.equal(stalePerson.json.code, 'DESK_ACTION_CHANGED');
  assert.equal((await operatorCommand(event.id, 'check.scan', { ...entry, expectedAction: 'STAMP' }, staff)).status, 400);

  const beforeExit = await readWorkspace(event.id);
  assert.equal(beforeExit.checks.length, 1);
  assert.equal(beforeExit.participants[0].inside, true);
  const exit = await operatorCommand(event.id, 'check.scan', { ...entry, expectedAction: 'OUT' }, staff);
  assert.equal(exit.status, 200);
  assert.equal(exit.json.action, 'OUT');
  assert.deepEqual((await readWorkspace(event.id)).checks.map(check => check.action), ['OUT', 'IN']);
});

test('a final report includes exactly the check-ins committed before concurrent event end', async () => {
  const people = ['마감 전', '동시 A', '동시 B', '마감 후'].map(name => makeParticipant('placeholder', name));
  const event = await createFixture({ participants: people });
  const assignment = await seedAssignment(event);
  const staff = { actor: 'staff', assignmentId: assignment.id };
  const secondDesk = await operatorCommand(event.id, 'desk.save', { name: '두 번째 입장 데스크', action: 'IN' });
  assert.equal(secondDesk.status, 201);
  const secondAssignment = await seedAssignment(event, { accountId: accountIds.otherStaff, targetId: secondDesk.json.desk.id });
  const earlyReport = await operatorCommand(event.id, 'report.create', { title: '진행 중 집계' });
  assert.equal(earlyReport.status, 201);
  assert.equal(earlyReport.json.report.snapshot.metrics.checked, 0);
  assert.equal((await scan(event, people[0], staff)).status, 200);

  const [atDeskA, end, atDeskB] = await Promise.all([
    scan(event, people[1], staff),
    operatorCommand(event.id, 'event.stage', { stage: 'ENDED' }),
    scan(event, people[2], { actor: 'otherStaff', assignmentId: secondAssignment.id, deskId: secondDesk.json.desk.id }),
  ]);
  assert.equal(end.status, 200);
  assert.ok([200, 409].includes(atDeskA.status) && [200, 409].includes(atDeskB.status));
  assert.equal((await scan(event, people[3], staff)).status, 409);

  const committed = [people[0].id, ...[atDeskA, atDeskB].flatMap((response, index) => response.status === 200 ? [people[index + 1].id] : [])];
  const final = await operatorCommand(event.id, 'report.create', { title: '종료 집계' });
  assert.equal(final.status, 201);
  assert.equal(final.json.report.snapshot.metrics.checked, committed.length);
  const saved = await readWorkspace(event.id);
  assert.deepEqual(saved.checks.map(check => check.participantId).sort(), committed.sort());
  assert.equal(saved.reports.find(report => report.id === earlyReport.json.report.id).snapshot.metrics.checked, 0);
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
  assert.deepEqual(entered.json, { name: free.name, id: free.id, action: 'IN', reentry: false, rewards: [], checkId });

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

test('desk change verdicts follow same-request receipt replay, never replacing a committed scan', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '데스크 변경 전 입장');
  const workspace = await readWorkspace(event.id);
  workspace.participants.push(person);
  await writeWorkspace(event.id, workspace);
  const assignment = await seedAssignment(event);
  const payload = { deskId: event.deskIn, expectedAction: 'IN', ticket: person.ticket };
  const id = commandId();
  const send = (requestId) => operatorCommand(event.id, 'check.scan', payload, { actor: 'staff', assignmentId: assignment.id, id: requestId });
  assert.equal((await send(id)).status, 200);

  assert.equal((await operatorCommand(event.id, 'desk.set-open', { id: event.deskIn, open: false })).status, 200);
  const closedReplay = await send(id);
  assert.equal(closedReplay.status, 200);
  assert.equal(closedReplay.json.checkId, id);
  const closedId = commandId();
  const closed = await send(closedId);
  assert.equal(closed.status, 409);
  assert.equal(closed.json.code, 'DESK_CLOSED');

  assert.equal((await operatorCommand(event.id, 'desk.save', { id: event.deskIn, name: '방향 변경 데스크', action: 'OUT', mode: 'desk', confirmDirectionChange: true })).status, 200);
  assert.equal((await operatorCommand(event.id, 'desk.set-open', { id: event.deskIn, open: true })).status, 200);
  const directionReplay = await send(id);
  assert.equal(directionReplay.status, 200);
  assert.equal(directionReplay.json.checkId, id);
  assert.equal(directionReplay.json.action, 'IN');
  const directionId = commandId();
  const direction = await send(directionId);
  assert.equal(direction.status, 409);
  assert.equal(direction.json.code, 'DESK_ACTION_CHANGED');
  const receipts = await harness.database.query('SELECT command_id FROM command_receipts WHERE command_id = ANY($1::text[])', [[id, closedId, directionId]]);
  assert.deepEqual(receipts.rows.map(row => row.command_id), [id]);
  const after = await readWorkspace(event.id);
  assert.equal(after.checks.filter(row => row.participantId === person.id).length, 1);
  assert.equal(after.participants.find(row => row.id === person.id).inside, true);
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

test('concurrent-scans-with-distinct-command-ids-allow-only-one-entry', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '동시 스캔 참가자');
  const workspace = await readWorkspace(event.id);
  workspace.participants.push(person);
  await writeWorkspace(event.id, workspace);
  const assignment = await seedAssignment(event);

  const results = await Promise.all([
    scan(event, person, { actor: 'staff', assignmentId: assignment.id, id: commandId() }),
    scan(event, person, { actor: 'staff', assignmentId: assignment.id, id: commandId() }),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const state = await readWorkspace(event.id);
  assert.equal(state.checks.filter((row) => row.participantId === person.id && row.corrected !== true).length, 1);
  assert.equal(state.participants.find((row) => row.id === person.id).inside, true);
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

test('staff correction cannot undo an earlier entry after a different desk checked the attendee out', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '동시 출입 정정 대상');
  const workspace = await readWorkspace(event.id);
  workspace.participants.push(person);
  await writeWorkspace(event.id, workspace);
  const entry = await seedAssignment(event);
  const exit = await seedAssignment(event, { accountId: accountIds.otherStaff, targetId: event.deskOut });
  const entryId = commandId();
  const exitId = commandId();
  assert.equal((await scan(event, person, { actor: 'staff', assignmentId: entry.id, id: entryId })).status, 200);
  assert.equal((await scan(event, person, { actor: 'otherStaff', assignmentId: exit.id, deskId: event.deskOut, id: exitId })).status, 200);

  const stale = await operatorCommand(event.id, 'check.correct', { id: entryId, reason: '오래된 입장 취소' }, { actor: 'staff', assignmentId: entry.id });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'CHECK_CORRECTION_STALE');
  const unchanged = await readWorkspace(event.id);
  assert.deepEqual(unchanged.checks.map(row => [row.id, row.corrected]), [[exitId, false], [entryId, false]]);
  assert.equal(unchanged.participants[0].inside, false);
  assert.equal(unchanged.participants[0].everIn, true);

  const correctionId = commandId();
  const options = { actor: 'otherStaff', assignmentId: exit.id, id: correctionId };
  const correction = { id: exitId, reason: '최신 퇴장 취소' };
  assert.equal((await operatorCommand(event.id, 'check.correct', correction, options)).status, 200);
  const replay = await operatorCommand(event.id, 'check.correct', correction, options);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.check.correction.id, correctionId);
  assert.equal((await readWorkspace(event.id)).participants[0].inside, true);

  const newExitId = commandId();
  assert.equal((await scan(event, person, { actor: 'otherStaff', assignmentId: exit.id, deskId: event.deskOut, id: newExitId })).status, 200);
  assert.equal((await operatorCommand(event.id, 'participant.status', { ids: [person.id], status: 'CANCELLED' })).status, 200);
  const cancelled = await operatorCommand(event.id, 'check.correct', { id: newExitId, reason: '취소된 참가자 정정' }, { actor: 'otherStaff', assignmentId: exit.id });
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.json.code, 'CHECK_CORRECTION_STALE');
  const afterCancel = await readWorkspace(event.id);
  assert.equal(afterCancel.participants[0].inside, false);
  assert.equal(afterCancel.checks[0].corrected, false);
});

test('booth edit checks the reviewed settings, preserves omitted schedules, and replays receipts', async () => {
  const person = makeParticipant('placeholder', '합성 부스 참가자', { inside: true, everIn: true });
  const event = await createFixture({ participants: [person] });
  person.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  const initial = await readWorkspace(event.id);
  initial.participants[0].ticket = person.ticket;
  const startsAt = new Date(Date.now() - 86400000).toISOString();
  const endsAt = new Date(Date.now() + 86400000).toISOString();
  Object.assign(initial.booths[0], { startsAt, endsAt });
  await writeWorkspace(event.id, initial);
  const booth = initial.booths[0];
  const snapshot = (row) => ({ name: row.name, zone: row.zone, status: row.status,
    capacity: row.capacity, limit: row.limit, startsAt: row.startsAt, endsAt: row.endsAt });
  const reviewed = snapshot(booth);
  const input = { id: booth.id, name: '수정된 부스', zone: booth.zone, status: booth.status,
    capacity: booth.capacity, limit: booth.limit, expectedBooth: reviewed };

  // The operator's editor omits the schedule entirely. A normal save retains
  // both timestamps rather than silently removing the operating window.
  const savedId = commandId();
  const saved = await operatorCommand(event.id, 'booth.save', input, { id: savedId });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.booth.startsAt, startsAt);
  assert.equal(saved.json.booth.endsAt, endsAt);
  const current = snapshot(saved.json.booth);
  const closed = await operatorCommand(event.id, 'booth.save', { ...saved.json.booth, status: 'CLOSED' });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  const rejectedId = commandId();
  const stale = await operatorCommand(event.id, 'booth.save', { ...input, expectedBooth: current }, { id: rejectedId });
  assert.equal(stale.status, 409, JSON.stringify(stale.json));
  assert.equal(stale.json.code, 'BOOTH_CHANGED');
  assert.equal((await readWorkspace(event.id)).booths[0].status, 'CLOSED');
  assert.equal((await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id = $1', [rejectedId])).rowCount, 0);
  const assignment = await assignStaff(event, { type: 'BOOTH' });
  assert.equal(assignment.status, 201);
  const blocked = await operatorCommand(event.id, 'booth.visit', { boothId: event.boothId, ticket: person.ticket },
    { actor: 'staff', assignmentId: assignment.json.assignment.id });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, 'BOOTH_UNAVAILABLE');
  const replay = await operatorCommand(event.id, 'booth.save', input, { id: savedId });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, saved.json, 'a committed receipt is returned before checking the newer booth');
  assert.equal((await readWorkspace(event.id)).booths[0].status, 'CLOSED');

  const differences = {
    name: '다른 부스', zone: '서관', status: 'OPEN', capacity: 20, limit: 3,
    startsAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 86400000).toISOString(),
  };
  for (const [key, next] of Object.entries(differences)) {
    const before = (await readWorkspace(event.id)).booths[0];
    const expectedBooth = snapshot(before);
    const changed = await operatorCommand(event.id, 'booth.save', { ...before, [key]: next });
    assert.equal(changed.status, 200, `${key}: ${JSON.stringify(changed.json)}`);
    const attempt = await operatorCommand(event.id, 'booth.save', { ...before, expectedBooth });
    assert.equal(attempt.status, 409, key);
    assert.equal(attempt.json.code, 'BOOTH_CHANGED', key);
  }
  const latest = (await readWorkspace(event.id)).booths[0];
  for (const expectedBooth of [null, {}, { ...snapshot(latest), capacity: String(latest.capacity) }]) {
    const bad = await operatorCommand(event.id, 'booth.save', { ...latest, expectedBooth });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'expectedBooth');
  }

  // Reopen and review; visits only change `used` and must not cause a false
  // conflict. Capacity is still independently checked against actual usage.
  const reopened = await operatorCommand(event.id, 'booth.save', { ...latest, status: 'OPEN', capacity: 20 });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
  const beforeVisit = snapshot(reopened.json.booth);
  const visit = await operatorCommand(event.id, 'booth.visit', { boothId: event.boothId, ticket: person.ticket },
    { actor: 'staff', assignmentId: assignment.json.assignment.id });
  assert.equal(visit.status, 201, JSON.stringify(visit.json));
  const afterVisit = await operatorCommand(event.id, 'booth.save', { ...reopened.json.booth, name: '방문 후 수정', expectedBooth: beforeVisit });
  assert.equal(afterVisit.status, 200, JSON.stringify(afterVisit.json));
  assert.equal(afterVisit.json.booth.used, 1);
  const clear = await operatorCommand(event.id, 'booth.save', { ...afterVisit.json.booth, startsAt: '', endsAt: '' });
  assert.equal(clear.status, 200);
  assert.equal(clear.json.booth.startsAt, '');
  assert.equal(clear.json.booth.endsAt, '');

  const legacy = await readWorkspace(event.id);
  delete legacy.booths[0].zone;
  delete legacy.booths[0].status;
  delete legacy.booths[0].capacity;
  delete legacy.booths[0].limit;
  delete legacy.booths[0].startsAt;
  delete legacy.booths[0].endsAt;
  await writeWorkspace(event.id, legacy);
  const legacyBaseline = { name: legacy.booths[0].name, zone: '', status: 'WAITING',
    capacity: 0, limit: 1, startsAt: '', endsAt: '' };
  const legacySaved = await operatorCommand(event.id, 'booth.save', { id: event.boothId, ...legacyBaseline,
    expectedBooth: legacyBaseline });
  assert.equal(legacySaved.status, 200, JSON.stringify(legacySaved.json));
  assert.equal(legacySaved.json.booth.used, 1);

  const timeFixture = await readWorkspace(event.id);
  Object.assign(timeFixture.booths[0], { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' });
  await writeWorkspace(event.id, timeFixture);
  const timeBaseline = { ...snapshot(timeFixture.booths[0]), startsAt: '2026-01-01T09:00:00+09:00', endsAt: '2027-01-01T09:00:00+09:00' };
  const equivalent = await operatorCommand(event.id, 'booth.save', { ...timeFixture.booths[0], name: '시간대 확인', expectedBooth: timeBaseline });
  assert.equal(equivalent.status, 200, JSON.stringify(equivalent.json));

  const impossible = await readWorkspace(event.id);
  impossible.booths[0].startsAt = '2026-02-31T09:00:00+09:00';
  await writeWorkspace(event.id, impossible);
  const normalizedByDateParse = { ...snapshot(impossible.booths[0]), startsAt: '2026-03-03T00:00:00Z' };
  const falseEquivalent = await operatorCommand(event.id, 'booth.save', { ...impossible.booths[0],
    expectedBooth: normalizedByDateParse });
  assert.equal(falseEquivalent.status, 409, 'an impossible date is not equivalent to the date JS silently normalizes it into');
  assert.equal(falseEquivalent.json.code, 'BOOTH_CHANGED');

  // Pre-existing malformed schedule strings are not silently deleted or
  // treated as a new scheduling change when the editor does not send them.
  const malformed = await readWorkspace(event.id);
  Object.assign(malformed.booths[0], { startsAt: '잘못된 시작', endsAt: '잘못된 종료' });
  await writeWorkspace(event.id, malformed);
  const malformedBaseline = snapshot(malformed.booths[0]);
  const { startsAt: _start, endsAt: _end, ...withoutSchedule } = malformed.booths[0];
  const preserved = await operatorCommand(event.id, 'booth.save', { ...withoutSchedule,
    name: '레거시 이름 변경', expectedBooth: malformedBaseline });
  assert.equal(preserved.status, 200, JSON.stringify(preserved.json));
  assert.equal(preserved.json.booth.startsAt, '잘못된 시작');
  assert.equal(preserved.json.booth.endsAt, '잘못된 종료');
  const partialCorrection = await operatorCommand(event.id, 'booth.save', { ...withoutSchedule, startsAt: '' });
  assert.equal(partialCorrection.status, 400, 'changing one time validates the preserved other time');
  const anotherPartial = await operatorCommand(event.id, 'booth.save', { ...withoutSchedule, endsAt: '' });
  assert.equal(anotherPartial.status, 400, 'changing the end also validates the preserved start');
  const clearedLegacy = await operatorCommand(event.id, 'booth.save', { ...withoutSchedule, startsAt: '', endsAt: '' });
  assert.equal(clearedLegacy.status, 200, JSON.stringify(clearedLegacy.json));
  assert.equal(clearedLegacy.json.booth.startsAt, '');
  assert.equal(clearedLegacy.json.booth.endsAt, '');
});

test('booth schedule rejects ambiguous or invalid times for staff and attendees without changing records', async () => {
  const person = makeParticipant('placeholder', '합성 참가자', { inside: true, everIn: true });
  const event = await createFixture({ participants: [person] });
  person.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  let workspace = await readWorkspace(event.id);
  workspace.participants[0].ticket = person.ticket;
  await writeWorkspace(event.id, workspace);
  const assignment = await seedAssignment(event, { type: 'BOOTH' });
  const badSchedules = [
    ['2026-11-06T09:00', ''], // no offset, server locale dependent
    ['not-a-date', ''],
    ['2026-02-31T09:00:00+09:00', ''], // Date.parse normalizes impossible dates
    ['2026-11-06T25:00:00+09:00', ''],
    ['2026-11-06T09:00:00+15:00', ''],
    ['2026-11-06T09:00:00+14:30', ''],
    ['2027-01-02T00:00:00Z', '2027-01-01T00:00:00Z'],
    ['2027-01-01T00:00:00Z', '2027-01-01T09:00:00+09:00'],
  ];
  for (const [startsAt, endsAt] of badSchedules) {
    workspace = await readWorkspace(event.id);
    Object.assign(workspace.booths[0], { status: 'OPEN', startsAt, endsAt });
    workspace.stampMode = 'STAFF';
    await writeWorkspace(event.id, workspace);
    const id = commandId();
    const staff = await operatorCommand(event.id, 'booth.visit', { boothId: event.boothId, ticket: person.ticket },
      { actor: 'staff', assignmentId: assignment.id, id });
    assert.equal(staff.status, 409, startsAt);
    assert.equal(staff.json.code, 'BOOTH_UNAVAILABLE');
    assert.match(staff.json.error, /운영 시간을 확인/);
    assert.equal((await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [id])).rowCount, 0);
    workspace = await readWorkspace(event.id);
    workspace.stampMode = 'SELF';
    await writeWorkspace(event.id, workspace);
    const guest = await attendeeBoothCommand(event, person.ticket, `ET:BOOTH:${event.id}:${event.boothId}`);
    assert.equal(guest.status, 409, startsAt);
    assert.equal(guest.json.code, 'BOOTH_UNAVAILABLE');
    const after = await readWorkspace(event.id);
    assert.equal(after.visits.length, 0);
    assert.equal(after.booths[0].used, 0);
    assert.equal(after.booths[0].startsAt, startsAt, 'the stored legacy value is not rewritten');
  }
  // Explicit closure and waiting take precedence over legacy schedule data.
  for (const [status, message] of [['CLOSED', /종료된 부스/], ['WAITING', /아직 운영/]]) {
    workspace = await readWorkspace(event.id);
    Object.assign(workspace.booths[0], { status, startsAt: 'invalid' });
    workspace.stampMode = 'STAFF';
    await writeWorkspace(event.id, workspace);
    const response = await operatorCommand(event.id, 'booth.visit', { boothId: event.boothId, ticket: person.ticket },
      { actor: 'staff', assignmentId: assignment.id });
    assert.equal(response.status, 409);
    assert.match(response.json.error, message);
  }
  // Old callers may omit the snapshot, but an explicitly changed time must
  // now contain a valid offset; this avoids accepting a booth that cannot run.
  workspace = await readWorkspace(event.id);
  Object.assign(workspace.booths[0], { status: 'OPEN', startsAt: 'legacy local time', endsAt: '' });
  await writeWorkspace(event.id, workspace);
  const old = workspace.booths[0];
  const { startsAt: _legacyStart, endsAt: _legacyEnd, ...withoutTimes } = old;
  const unchanged = await operatorCommand(event.id, 'booth.save', { ...withoutTimes, name: '기존 시간 보존' });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.json.booth.startsAt, 'legacy local time');
  for (const startsAt of ['2026-11-06T09:00', '2026-02-31T09:00:00+09:00', '2026-11-06T09:00:00+15:00']) {
    const rejected = await operatorCommand(event.id, 'booth.save', { ...withoutTimes, startsAt, endsAt: '' });
    assert.equal(rejected.status, 400, startsAt);
    assert.match(rejected.json.error, /시간대/);
  }
  const explicit = await operatorCommand(event.id, 'booth.save', { ...withoutTimes,
    startsAt: '2026-11-06T09:00:00+09:00', endsAt: '2026-11-06T12:00:00+09:00' });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.json));
  assert.equal(explicit.json.booth.startsAt, '2026-11-06T09:00:00+09:00');
  const deleted = await operatorCommand(event.id, 'booth.save', { ...withoutTimes, startsAt: '', endsAt: '' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.booth.startsAt, '');

  // Invalid JSON data remains distinguishable without exposing its contents.
  workspace = await readWorkspace(event.id);
  Object.assign(workspace.booths[0], { status: 'OPEN', startsAt: { bad: '합성 값' }, endsAt: '' });
  await writeWorkspace(event.id, workspace);
  const bootstrap = await requestJson(harness.baseUrl, `/api/events/${event.id}/bootstrap`, { cookie: cookies.manager });
  assert.equal(bootstrap.status, 200);
  const projected = bootstrap.json.state.workspaces[event.id].booths[0];
  assert.match(projected.startsAt, /^__invalid_booth_time__:[0-9a-f]{64}$/);
  assert.ok(!projected.startsAt.includes('합성 값'));
  const baseline = { name: projected.name, zone: projected.zone, status: projected.status,
    capacity: projected.capacity, limit: projected.limit, startsAt: projected.startsAt, endsAt: projected.endsAt };
  const update = { id: event.boothId, name: '원본 유지', zone: baseline.zone, status: baseline.status,
    capacity: baseline.capacity, limit: baseline.limit, expectedBooth: baseline };
  const savedId = commandId();
  const saved = await operatorCommand(event.id, 'booth.save', update, { id: savedId });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.booth.startsAt, baseline.startsAt);
  assert.deepEqual((await readWorkspace(event.id)).booths[0].startsAt, { bad: '합성 값' });
  const replay = await operatorCommand(event.id, 'booth.save', update, { id: savedId });
  assert.deepEqual(replay.json, saved.json);
  workspace = await readWorkspace(event.id);
  workspace.booths[0].startsAt = { bad: '다른 합성 값' };
  await writeWorkspace(event.id, workspace);
  const changed = await operatorCommand(event.id, 'booth.save', update);
  assert.equal(changed.status, 409);
  assert.equal(changed.json.code, 'BOOTH_CHANGED');
  workspace = await readWorkspace(event.id);
  workspace.booths[0].startsAt = baseline.startsAt;
  await writeWorkspace(event.id, workspace);
  assert.equal((await operatorCommand(event.id, 'booth.save', update)).json.code, 'BOOTH_CHANGED');
  const legacyBootstrap = await requestJson(harness.baseUrl, `/api/events/${event.id}/bootstrap`, { cookie: cookies.manager });
  const legacy = legacyBootstrap.json.state.workspaces[event.id].booths[0];
  assert.match(legacy.startsAt, /^__invalid_booth_text__:[0-9a-f]{64}$/);
  const repairedBaseline = { ...baseline, name: legacy.name, startsAt: legacy.startsAt };
  const cleared = await operatorCommand(event.id, 'booth.save', { ...update, expectedBooth: repairedBaseline, startsAt: '' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal((await readWorkspace(event.id)).booths[0].startsAt, '');

  // Explicit valid windows still open and close at their actual instant.
  const reference = Date.now();
  for (const [startsAt, endsAt] of [
    [new Date(reference + 3600000).toISOString(), ''],
    ['', new Date(reference - 3600000).toISOString()],
  ]) {
    workspace = await readWorkspace(event.id);
    Object.assign(workspace.booths[0], { status: 'OPEN', startsAt, endsAt });
    workspace.stampMode = 'STAFF';
    await writeWorkspace(event.id, workspace);
    const outside = await operatorCommand(event.id, 'booth.visit', { boothId: event.boothId, ticket: person.ticket },
      { actor: 'staff', assignmentId: assignment.id });
    assert.equal(outside.status, 409);
    assert.equal(outside.json.code, 'BOOTH_UNAVAILABLE');
    assert.match(outside.json.error, /운영 시간이 아닙니다/);
  }

  // An absent boundary remains unlimited. Explicit offsets and equivalent Z
  // timestamps describe the same instants in every host timezone.
  const now = Date.now();
  const kst = (millis) => new Date(millis + 9 * 3600000).toISOString().slice(0, 23) + '+09:00';
  for (const [startsAt, endsAt] of [['', ''], [null, null], [kst(now - 3600000), kst(now + 3600000)],
    [new Date(now - 3600000).toISOString(), new Date(now + 3600000).toISOString()]]) {
    workspace = await readWorkspace(event.id);
    Object.assign(workspace.booths[0], { status: 'OPEN', startsAt, endsAt, used: 0 });
    workspace.visits = []; workspace.stampMode = 'STAFF';
    await writeWorkspace(event.id, workspace);
    const id = commandId();
    const accepted = await operatorCommand(event.id, 'booth.visit', { boothId: event.boothId, ticket: person.ticket },
      { actor: 'staff', assignmentId: assignment.id, id });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    workspace = await readWorkspace(event.id);
    workspace.booths[0].startsAt = 'unverified legacy time';
    await writeWorkspace(event.id, workspace);
    const replay = await operatorCommand(event.id, 'booth.visit', { boothId: event.boothId, ticket: person.ticket },
      { actor: 'staff', assignmentId: assignment.id, id });
    assert.equal(replay.status, 200, 'a committed receipt is replayed before the new schedule guard');
    assert.deepEqual(replay.json, accepted.json);
    assert.equal((await readWorkspace(event.id)).visits.length, 1);
  }
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
  assert.deepEqual(visit.json, { name: person.name, booth: '체험 부스',
    visitId, boothId: event.boothId, participantId: person.id });

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

test('booth limit guidance counts only alternatives the same attendee can use now', async () => {
  const person = makeParticipant('placeholder', '부스 참가자', { inside: true });
  const event = await createFixture({ stampMode: 'SELF', participants: [person] });
  person.ticket = makeParticipant(event.id, person.name).ticket;
  const workspace = await readWorkspace(event.id);
  workspace.participants[0].ticket = person.ticket;
  const alternate = { status: 'OPEN', capacity: 0, limit: 1, used: 0 };
  workspace.booths.push(
    { ...alternate, id: 'later', name: '운영 전 부스', startsAt: new Date(Date.now() + 3600000).toISOString() },
    { ...alternate, id: 'past', name: '시간 종료 부스', endsAt: new Date(Date.now() - 3600000).toISOString() },
    { ...alternate, id: 'sold', name: '수량 소진 부스', capacity: 1, used: 1 },
    { ...alternate, id: 'closed', name: '종료 부스', status: 'CLOSED' },
    { ...alternate, id: 'done', name: '한도 도달 부스' },
    { ...alternate, id: 'available', name: '이용 가능한 부스' },
  );
  await writeWorkspace(event.id, workspace);
  const visit = (boothId) => attendeeBoothCommand(event, person.ticket, `ET:BOOTH:${event.id}:${boothId}`);
  assert.equal((await visit(event.boothId)).status, 201);
  assert.equal((await visit('done')).status, 201);

  const limited = await visit(event.boothId);
  assert.equal(limited.status, 409);
  assert.match(limited.json.error, /1곳/);
  assert.equal(limited.json.code, 'BOOTH_LIMIT_REACHED');
  assert.equal((await readWorkspace(event.id)).visits.length, 2);

  assert.equal((await visit('available')).status, 201);
  const none = await visit(event.boothId);
  assert.equal(none.status, 409);
  assert.match(none.json.error, /인증할 수 있는 다른 부스가 없습니다/);
  assert.equal((await readWorkspace(event.id)).visits.length, 3);
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
  assert.deepEqual(visit.json, { name: person.name, booth: '체험 부스',
    visitId: id, boothId: event.boothId, participantId: person.id });
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

test('check-scan-by-participant-id-processes-checkin-without-ticket', async () => {
  const person = makeParticipant('placeholder', 'QR 손상 참가자');
  const event = await createFixture({ participants: [person] });
  const stripped = await readWorkspace(event.id);
  stripped.participants.find((item) => item.id === person.id).ticket = '';
  await writeWorkspace(event.id, stripped);
  const assignment = await seedAssignment(event);

  const checkId = commandId();
  const scanned = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, participantId: person.id,
  }, { actor: 'staff', assignmentId: assignment.id, id: checkId });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.json));
  assert.deepEqual(scanned.json, { name: person.name, id: person.id, action: 'IN', reentry: false, rewards: [], checkId });

  const state = await readWorkspace(event.id);
  assert.equal(state.participants.find((item) => item.id === person.id).inside, true);
  assert.equal(state.participants.find((item) => item.id === person.id).everIn, true);
  assert.equal(state.checks[0].participantId, person.id);
});

test('reviewed manual identity rejects stale or ambiguous names atomically and preserves receipt replay', async () => {
  const person = makeParticipant('placeholder', '수동 확인 참가자', { company: '검증 소속' });
  const event = await createFixture({ participants: [person] });
  const assignment = await seedAssignment(event);
  const id = commandId();
  const reviewed = { deskId: event.deskIn, expectedAction: 'IN', participantId: person.id,
    expectedIdentity: { name: person.name, company: person.company } };
  const duplicate = await operatorCommand(event.id, 'participant.create', {
    name: person.name, company: person.company, phone: '01094761234',
  });
  assert.equal(duplicate.status, 201);
  const options = { actor: 'staff', assignmentId: assignment.id, id };
  const conflict = await operatorCommand(event.id, 'check.scan', reviewed, options);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'MANUAL_IDENTITY_CHANGED');
  let workspace = await readWorkspace(event.id);
  assert.equal(workspace.participants.find(item => item.id === person.id).inside, false);
  assert.equal(workspace.checks.length, 0);
  assert.equal((await harness.database.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [id])).rowCount, 0);
  const olderClient = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, expectedAction: 'IN', participantId: person.id,
  }, { ...options, id: commandId() });
  assert.equal(olderClient.status, 409, 'an older staff screen must also reject an ambiguous identity');
  assert.equal(olderClient.json.code, 'MANUAL_IDENTITY_CHANGED');
  workspace.participants = workspace.participants.filter(item => item.id !== duplicate.json.participant.id);
  await writeWorkspace(event.id, workspace);
  const success = await operatorCommand(event.id, 'check.scan', reviewed, options);
  assert.equal(success.status, 200);
  workspace = await readWorkspace(event.id);
  workspace.participants.find(item => item.id === person.id).company = '변경된 소속';
  await writeWorkspace(event.id, workspace);
  const replay = await operatorCommand(event.id, 'check.scan', reviewed, options);
  assert.equal(replay.status, 200, 'a committed receipt is checked before the current identity');
  assert.equal(replay.json.id, person.id);
  const reused = await operatorCommand(event.id, 'check.scan', {
    ...reviewed, expectedIdentity: { name: person.name, company: '변경된 소속' },
  }, options);
  assert.equal(reused.status, 409, 'a different reviewed identity cannot reuse the prior receipt');
  const fresh = await operatorCommand(event.id, 'check.scan', reviewed, { ...options, id: commandId() });
  assert.equal(fresh.status, 409);
  assert.equal(fresh.json.code, 'MANUAL_IDENTITY_CHANGED');
  workspace = await readWorkspace(event.id);
  assert.equal(workspace.checks.length, 1);
});

test('check-scan-by-participant-id-rejects-ineligible-and-unknown-person', async () => {
  const pending = makeParticipant('placeholder', '승인 대기 참가자', { status: 'PENDING' });
  const revoked = makeParticipant('placeholder', '회수 참가자', { revoked: true });
  const event = await createFixture({ participants: [pending, revoked] });
  const stripped = await readWorkspace(event.id);
  for (const item of stripped.participants) item.ticket = '';
  await writeWorkspace(event.id, stripped);

  const pendingScan = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, participantId: pending.id,
  });
  assert.equal(pendingScan.status, 409);

  const revokedScan = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, participantId: revoked.id,
  });
  assert.equal(revokedScan.status, 409);

  const unknown = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, participantId: `person-${crypto.randomUUID()}`,
  });
  assert.equal(unknown.status, 404);

  const other = await createFixture();
  const crossEvent = await operatorCommand(other.id, 'check.scan', {
    deskId: other.deskIn, participantId: pending.id,
  });
  assert.equal(crossEvent.status, 404);
});

test('check-scan-requires-ticket-or-participant-id-and-keeps-ticket-path', async () => {
  const person = makeParticipant('placeholder', '티켓 경로 참가자');
  const event = await createFixture({ participants: [person] });
  const saved = await readWorkspace(event.id);
  saved.participants[0].ticket = person.ticket = `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
  await writeWorkspace(event.id, saved);

  const missing = await operatorCommand(event.id, 'check.scan', { deskId: event.deskIn });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /티켓 코드/);

  const checkId = commandId();
  const ticketScan = await scan(event, person, { id: checkId });
  assert.equal(ticketScan.status, 200, JSON.stringify(ticketScan.json));
  assert.deepEqual(ticketScan.json, { name: person.name, id: person.id, action: 'IN', reentry: false, rewards: [], checkId });
});

test('check-scan-by-participant-id-retry-with-same-command-id-is-idempotent', async () => {
  const person = makeParticipant('placeholder', '재전송 참가자');
  const other = makeParticipant('placeholder', '다른 참가자');
  const event = await createFixture({ participants: [person, other] });
  const stripped = await readWorkspace(event.id);
  for (const item of stripped.participants) item.ticket = '';
  await writeWorkspace(event.id, stripped);

  const id = commandId();
  const first = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, participantId: person.id,
  }, { id });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const replayed = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, participantId: person.id,
  }, { id });
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.json, first.json);

  const state = await readWorkspace(event.id);
  assert.equal(state.checks.filter((row) => row.participantId === person.id).length, 1);
  assert.equal(state.audit.filter((row) => row.id === id).length, 1);

  const reused = await operatorCommand(event.id, 'check.scan', {
    deskId: event.deskIn, participantId: other.id,
  }, { id });
  assert.equal(reused.status, 409);
});

test('an operator admits a walk-in registered at the door by participant id, no assignment (2026-11-24)', async () => {
  const event = await createFixture({ participants: [] });
  // The console flow: register on site, then check the same person in by id at an open IN desk.
  const created = await operatorCommand(event.id, 'participant.create', {
    name: '현장 등록 참가자', phone: '01055550001', registrationType: 'ONSITE',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.participant.status, 'APPROVED');
  const personId = created.json.participant.id;
  assert.ok(personId, 'the create response carries the new participant id');

  const payload = { deskId: event.deskIn, participantId: personId, expectedAction: 'IN' };
  const checkId = commandId();
  const entered = await operatorCommand(event.id, 'check.scan', payload, { id: checkId });
  assert.equal(entered.status, 200, JSON.stringify(entered.json));
  assert.deepEqual(entered.json, { name: '현장 등록 참가자', id: personId, action: 'IN', reentry: false, rewards: [], checkId });
  let state = await readWorkspace(event.id);
  assert.equal(state.participants.find((item) => item.id === personId).inside, true);
  assert.equal(state.checks.length, 1);
  assert.equal(state.checks[0].deskId, event.deskIn);
  assert.equal(state.checks[0].actor, accountIds.manager, 'the record names the operator account');

  // A lost answer is retried with the same command id: replayed, never recorded twice.
  const replay = await operatorCommand(event.id, 'check.scan', payload, { id: checkId });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.checkId, checkId);
  assert.equal((await readWorkspace(event.id)).checks.length, 1);

  // A second attempt with a new id is a user-readable rejection, not a second entry.
  const again = await operatorCommand(event.id, 'check.scan', payload);
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'ALREADY_CHECKED_IN');
  assert.match(again.json.error, /이미 입장/);
  assert.equal((await readWorkspace(event.id)).checks.length, 1);

  // A closed desk is refused with its own code; the roster must offer only open IN desks.
  const second = await operatorCommand(event.id, 'participant.create', {
    name: '현장 등록 두 번째', phone: '01055550002', registrationType: 'ONSITE',
  });
  assert.equal(second.status, 201);
  assert.equal((await operatorCommand(event.id, 'desk.set-open', { id: event.deskIn, open: false })).status, 200);
  const closed = await operatorCommand(event.id, 'check.scan', { ...payload, participantId: second.json.participant.id });
  assert.equal(closed.status, 409);
  assert.equal(closed.json.code, 'DESK_CLOSED');
  // An exit desk is not an entry desk: expectedAction guards a desk that changed direction.
  const wrongDirection = await operatorCommand(event.id, 'check.scan', { deskId: event.deskOut, participantId: second.json.participant.id, expectedAction: 'IN' });
  assert.equal(wrongDirection.status, 409);
  assert.equal(wrongDirection.json.code, 'DESK_ACTION_CHANGED');
  state = await readWorkspace(event.id);
  assert.equal(state.participants.find((item) => item.id === second.json.participant.id).inside, false);

  // A manager without the 현장 데스크 (onsite) grant cannot admit anyone.
  await harness.database.query(
    'UPDATE memberships SET write_permissions = $3::jsonb WHERE account_id = $1 AND event_id = $2',
    [accountIds.manager, event.id, JSON.stringify(['participants'])]
  );
  assert.equal((await operatorCommand(event.id, 'desk.set-open', { id: event.deskIn, open: true })).status, 403);
  const denied = await operatorCommand(event.id, 'check.scan', { ...payload, participantId: second.json.participant.id });
  assert.equal(denied.status, 403);
  assert.equal((await readWorkspace(event.id)).checks.length, 1);
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
