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
const ids = {
  agency: `bootstrap-agency-${suffix}`,
  manager: `bootstrap-manager-${suffix}`,
  staff: `bootstrap-staff-${suffix}`,
  eventA: `bootstrap-event-a-${suffix}`,
  eventB: `bootstrap-event-b-${suffix}`,
  assignment: `bootstrap-assignment-${suffix}`,
  desk: `bootstrap-desk-${suffix}`,
};
const slugs = { eventA: `bootstrap-a-${suffix}`, eventB: `bootstrap-b-${suffix}` };
let harness;
let cookies = {};

function eventPayload(id, slug, name) {
  return {
    id,
    slug,
    name,
    date: '2026-10-20',
    start: '09:00',
    end: '17:00',
    capacity: 20,
    stage: 'LIVE',
    features: ['stamp'],
    internalMarker: `private-${name}`,
  };
}

function eventWorkspace() {
  return {
    participants: [
      {
        id: 'person-desk',
        name: '데스크 대상',
        phone: '01012345678',
        email: 'desk-private@example.test',
        ticket: 'desk-ticket-must-not-leak',
        status: 'APPROVED',
        inside: false,
        everIn: false,
      },
      {
        id: 'person-other',
        name: '다른 대상',
        phone: '01087654321',
        email: 'other-private@example.test',
        ticket: 'other-ticket-must-not-leak',
        status: 'APPROVED',
        inside: false,
        everIn: false,
      },
    ],
    desks: [
      { id: ids.desk, name: '배정 등록 데스크', action: 'IN' },
      { id: 'unassigned-desk', name: '미배정 퇴장 데스크', action: 'OUT' },
    ],
    booths: [{ id: 'unassigned-booth', name: '미배정 부스', zone: '2층' }],
    assignments: [{ id: 'forged-assignment', accountId: 'forged-account', type: 'BOOTH', targetId: 'unassigned-booth' }],
    checks: [
      { id: 'check-assigned', deskId: ids.desk, participantId: 'person-desk', action: 'IN' },
      { id: 'check-other', deskId: 'unassigned-desk', participantId: 'person-other', action: 'OUT' },
    ],
    visits: [{ id: 'visit-other', boothId: 'unassigned-booth', participantId: 'person-other' }],
    notices: [{ id: 'notice', title: '게시 공지', published: true }],
    program: [],
    venue: { name: '테스트 홀' },
    branding: { tagline: '게시 안내' },
    reports: [{ id: 'private-report', summary: 'agency-only' }],
  };
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: ids.agency,
    role: 'AGENCY',
    name: '조직 관리자',
    email: `${ids.agency}@example.test`,
    orgPermissions: ['events.all'],
  });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: ids.manager,
    role: 'MANAGER',
    name: '행사 매니저',
    email: `${ids.manager}@example.test`,
  });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: ids.staff,
    role: 'STAFF',
    name: '현장 스태프',
    email: `${ids.staff}@example.test`,
  });
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: ids.eventA,
    slug: slugs.eventA,
    payload: eventPayload(ids.eventA, slugs.eventA, '행사 A'),
    workspace: eventWorkspace(),
  });
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: ids.eventB,
    slug: slugs.eventB,
    payload: eventPayload(ids.eventB, slugs.eventB, '행사 B'),
    workspace: eventWorkspace(),
  });
  await insertMembership(harness.database, ids.manager, ids.eventA, ['all']);
  await insertAssignment(harness.database, {
    id: ids.assignment,
    accountId: ids.staff,
    eventId: ids.eventA,
    type: 'DESK',
    targetId: ids.desk,
  });
  cookies = {
    agency: await sessionCookie(harness, ids.agency),
    manager: await sessionCookie(harness, ids.manager),
    staff: await sessionCookie(harness, ids.staff),
  };
});

after(async () => {
  if (!harness) return;
  try {
    await deleteFixtureRows(harness.database, {
      eventIds: [ids.eventA, ids.eventB],
      accountIds: [ids.agency, ids.manager, ids.staff],
    });
  } finally {
    await harness.close();
  }
});

test('api-bootstrap-projects-organization-and-membership-events-without-cross-event-leakage', async () => {
  const agency = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookies.agency });
  assert.equal(agency.status, 200);
  assert.equal(agency.json.state.version, 9);
  assert.deepEqual(
    agency.json.state.events.map((event) => event.id).sort(),
    [ids.eventA, ids.eventB].sort()
  );
  assert.ok(agency.json.state.accounts.some((account) => account.id === ids.manager));
  assert.ok(agency.json.state.accounts.every((account) => !Object.hasOwn(account, 'password_hash')));

  const manager = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookies.manager });
  assert.equal(manager.status, 200);
  assert.deepEqual(manager.json.state.events.map((event) => event.id), [ids.eventA]);
  assert.deepEqual(Object.keys(manager.json.state.workspaces), [ids.eventA]);
  assert.ok(!JSON.stringify(manager.json.state).includes('행사 B'));
});

test('manager-event-collection-lists-only-membership-events', async () => {
  const response = await requestJson(harness.baseUrl, '/api/events', { cookie: cookies.manager });

  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.deepEqual(response.json.events.map((event) => event.id), [ids.eventA]);
  assert.equal(response.json.activeEventId, ids.eventA);
});

test('api-bootstrap-staff-sees-only-assigned-targets-and-no-ticket-or-contact-secrets', async () => {
  const staff = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookies.staff });
  assert.equal(staff.status, 200);
  assert.deepEqual(staff.json.state.events.map((event) => event.id), [ids.eventA]);
  assert.ok(!Object.hasOwn(staff.json.state.events[0], 'internalMarker'));
  assert.ok(!Object.hasOwn(staff.json.state.events[0], 'clientId'));
  const workspace = staff.json.state.workspaces[ids.eventA];
  assert.deepEqual(workspace.assignments, [
    { id: ids.assignment, accountId: ids.staff, type: 'DESK', targetId: ids.desk },
  ]);
  assert.deepEqual(workspace.desks.map((desk) => desk.id), [ids.desk]);
  assert.deepEqual(workspace.booths, []);
  assert.deepEqual(workspace.participants.map((person) => person.id), ['person-desk', 'person-other']);
  assert.ok(workspace.participants.every((person) => !('ticket' in person) && !('phone' in person) && !('email' in person)));
  assert.deepEqual(workspace.checks.map((check) => check.id), ['check-assigned']);
  assert.deepEqual(workspace.visits, []);
  assert.deepEqual(workspace.reports, []);
  assert.ok(!JSON.stringify(workspace).includes('private-report'));
});

test('api-bootstrap-requires-session-and-ignores-browser-supplied-role-or-account-id', async () => {
  const anonymous = await requestJson(
    harness.baseUrl,
    `/api/bootstrap?role=AGENCY&accountId=${encodeURIComponent(ids.agency)}`
  );
  assert.equal(anonymous.status, 401);

  const forged = await requestJson(
    harness.baseUrl,
    `/api/bootstrap?role=AGENCY&accountId=${encodeURIComponent(ids.agency)}`,
    { cookie: cookies.staff }
  );
  assert.equal(forged.status, 200);
  assert.equal(forged.json.state.accounts.find((account) => account.id === ids.staff).role, 'STAFF');
  assert.deepEqual(forged.json.state.events.map((event) => event.id), [ids.eventA]);
  assert.ok(!forged.json.state.accounts.some((account) => account.id === ids.agency));
});
