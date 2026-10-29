'use strict';

// Scoped console reads: GET /api/console/directory (lightweight shell +
// event home) and GET /api/events/:id/bootstrap (single-event detail in the
// historical `{ state }` bootstrap shape).
//
// Both are additive: /api/bootstrap and GET /api/events keep their
// historical behaviour untouched (pinned by server-bootstrap.test.cjs).
// These pin the new contract instead:
//
// - routing / shape / freshness (no-store on every owned answer) / errors
//   at the Fastify boundary without a database;
// - role scoping, STAFF minimal projection parity with loadBootstrap,
//   verbatim membership grants (omitted -> ['all'], explicit [] readonly),
//   and payload weight against the task PostgreSQL database.
//
// Database tests run only with EVENTOUCH_TEST_DATABASE_URL pointing at the
// task-isolated PostgreSQL instance. They never touch any other database:
// the harness creates one uuid schema per run and drops it afterwards.

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

const { buildScopedReadsApp, scopedReadsPath } = require('../server/fastify/scoped-reads.ts');
const { createState } = require('../server/state');

// ---------------------------------------------------------------------------
// Pure boundary contracts (no database).
// ---------------------------------------------------------------------------

function stubDeps(overrides = {}) {
  return {
    sessionFromCookie: async () => ({ id: 'viewer-agency' }),
    loadDirectory: async () => ({ version: 1, events: [], activeEventId: null }),
    loadEventBootstrap: async () => ({ version: 9, events: [], workspaces: {} }),
    failureMessage: (error, fallback) => (error && error.message ? error.message : fallback),
    ...overrides,
  };
}

async function inject(app, method, url, headers = {}) {
  const response = await app.inject({ method, url, headers });
  return { status: response.statusCode, json: response.json(), headers: response.headers };
}

nodeTest('scoped-reads-path-owns-only-the-two-additive-get-routes', () => {
  assert.equal(scopedReadsPath('/api/console/directory', 'GET'), true);
  assert.equal(scopedReadsPath('/api/events/event-1/bootstrap', 'GET'), true);
  assert.equal(scopedReadsPath('/api/console/directory', 'POST'), false);
  assert.equal(scopedReadsPath('/api/events/event-1/bootstrap', 'POST'), false);
  assert.equal(scopedReadsPath('/api/bootstrap', 'GET'), false);
  assert.equal(scopedReadsPath('/api/events', 'GET'), false);
  assert.equal(scopedReadsPath('/api/events/event-1/members', 'POST'), false);
  assert.equal(scopedReadsPath('/api/events/event-1/duplicate', 'POST'), false);
  assert.equal(scopedReadsPath('/api/events/event-1/commands', 'POST'), false);
  assert.equal(scopedReadsPath('/api/console/other', 'GET'), false);
});

nodeTest('scoped-reads-directory-answers-the-stub-shape-with-no-store', async () => {
  const app = buildScopedReadsApp(stubDeps({
    loadDirectory: async () => ({ version: 1, revision: 3, activeEventId: 'event-1', events: [] }),
  }));
  const response = await inject(app, 'GET', '/api/console/directory', { cookie: 'etko_session=x' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    directory: { version: 1, revision: 3, activeEventId: 'event-1', events: [] },
  });
  assert.equal(response.headers['cache-control'], 'no-store');
});

nodeTest('scoped-reads-event-bootstrap-answers-the-stub-state-with-no-store', async () => {
  const app = buildScopedReadsApp(stubDeps({
    loadEventBootstrap: async (account, eventId) => ({ version: 9, activeEventId: eventId }),
  }));
  const response = await inject(app, 'GET', '/api/events/event-9/bootstrap', { cookie: 'etko_session=x' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { state: { version: 9, activeEventId: 'event-9' } });
  assert.equal(response.headers['cache-control'], 'no-store');
});

nodeTest('scoped-reads-anonymous-callers-get-401-without-echoing-internals', async () => {
  const app = buildScopedReadsApp(stubDeps({ sessionFromCookie: async () => null }));
  for (const url of ['/api/console/directory', '/api/events/event-1/bootstrap']) {
    const response = await inject(app, 'GET', url);
    assert.equal(response.status, 401, url);
    assert.deepEqual(response.json, { error: '로그인이 필요합니다' }, url);
    assert.equal(response.headers['cache-control'], 'no-store', url);
  }
});

nodeTest('scoped-reads-undecodable-event-id-answers-404-like-the-legacy-branch', async () => {
  const app = buildScopedReadsApp(stubDeps());
  const response = await inject(app, 'GET', '/api/events/%zz/bootstrap', { cookie: 'etko_session=x' });
  assert.equal(response.status, 404);
  assert.equal(response.headers['cache-control'], 'no-store');
});

nodeTest('scoped-reads-without-loaders-answers-503-like-bootstrap-without-a-database', async () => {
  const app = buildScopedReadsApp(stubDeps({ loadDirectory: null, loadEventBootstrap: null }));
  for (const url of ['/api/console/directory', '/api/events/event-1/bootstrap']) {
    const response = await inject(app, 'GET', url, { cookie: 'etko_session=x' });
    assert.equal(response.status, 503, url);
    assert.deepEqual(response.json, { error: '데이터베이스를 사용할 수 없습니다' }, url);
  }
});

nodeTest('scoped-reads-write-methods-are-not-owned', async () => {
  const app = buildScopedReadsApp(stubDeps());
  const response = await inject(app, 'POST', '/api/console/directory', { cookie: 'etko_session=x' });
  assert.equal(response.status, 404);
});

// ---------------------------------------------------------------------------
// Database contracts (task-isolated PostgreSQL only).
// ---------------------------------------------------------------------------

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to the task-isolated PostgreSQL database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const ids = {
  agency: `reads-agency-${suffix}`,
  manager: `reads-manager-${suffix}`,
  managerRo: `reads-manager-ro-${suffix}`,
  managerB: `reads-manager-b-${suffix}`,
  loner: `reads-loner-${suffix}`,
  staff: `reads-staff-${suffix}`,
  staffIdle: `reads-staff-idle-${suffix}`,
  eventA: `reads-event-a-${suffix}`,
  eventB: `reads-event-b-${suffix}`,
  assignment: `reads-assignment-${suffix}`,
  deskA1: `reads-desk-a1-${suffix}`,
  clientA: `reads-client-a-${suffix}`,
  clientB: `reads-client-b-${suffix}`,
  inviteGlobal: `reads-invite-global-${suffix}`,
  inviteA: `reads-invite-a-${suffix}`,
  inviteB: `reads-invite-b-${suffix}`,
};
const slugs = { eventA: `reads-a-${suffix}`, eventB: `reads-b-${suffix}` };

function eventPayload(id, slug, name, stage, clientId) {
  return {
    id,
    slug,
    name,
    date: '2026-11-20',
    start: '09:00',
    end: '17:00',
    capacity: 900,
    stage,
    features: ['stamp', 'reward'],
    internalMarker: `private-${name}`,
  };
}

function workspaceA() {
  return {
    participants: [
      {
        id: 'person-pending-1', name: '대기 하나', phone: '01011112222',
        email: 'pending1-private@example.test', ticket: 'secret-ticket-1',
        status: 'PENDING', inside: false, everIn: false,
      },
      {
        id: 'person-pending-2', name: '대기 둘', phone: '01033334444',
        email: 'pending2-private@example.test', ticket: 'secret-ticket-2',
        status: 'PENDING', inside: false, everIn: false,
      },
      {
        id: 'person-approved', name: '확정 하나', phone: '01055556666',
        email: 'approved-private@example.test', ticket: 'secret-ticket-3',
        status: 'APPROVED', inside: true, everIn: true,
      },
    ],
    desks: [
      { id: ids.deskA1, name: '배정 등록 데스크', action: 'IN' },
      { id: 'unassigned-desk', name: '미배정 퇴장 데스크', action: 'OUT' },
    ],
    booths: [{ id: 'unassigned-booth', name: '미배정 부스', zone: '2층', status: 'OPEN' }],
    assignments: [{ id: 'forged-assignment', accountId: 'forged-account', type: 'BOOTH', targetId: 'unassigned-booth' }],
    checks: [
      { id: 'check-assigned', deskId: ids.deskA1, participantId: 'person-approved', action: 'IN' },
      { id: 'check-other', deskId: 'unassigned-desk', participantId: 'person-pending-1', action: 'OUT' },
    ],
    visits: [{ id: 'visit-other', boothId: 'unassigned-booth', participantId: 'person-approved' }],
    messages: [
      { id: 'message-failed', status: 'FAILED', body: 'private-body-failed' },
      { id: 'message-partial', status: 'PARTIAL', body: 'private-body-partial' },
      { id: 'message-sent', status: 'SENT', body: 'private-body-sent' },
    ],
    notices: [{ id: 'notice', title: '게시 공지', published: true }],
    program: [],
    venue: { name: 'A홀' },
    branding: { tagline: '게시 안내' },
    reports: [{ id: 'private-report', summary: 'agency-only' }],
    rewards: [{ id: 'global-prize', name: '전역 경품', quantity: 5 }],
    pageExperience: {
      publishedAt: '2026-10-24T00:00:00.000Z',
      published: { homeStyle: { backgroundColor: '#123abc' } },
      draft: { homeStyle: { backgroundColor: '#ff0000' } },
      draftVersion: 3,
      publishedVersion: 2,
    },
  };
}

function workspaceB() {
  return {
    participants: [{ id: 'person-b', name: 'B 대기', status: 'PENDING', inside: false, everIn: false }],
    desks: [],
    booths: [],
    checks: [],
    visits: [],
    messages: [],
    venue: { name: 'B홀' },
  };
}

let harness;
let state;
let cookies = {};

async function insertInvitation(database, { id, email, role, eventId, status }) {
  await database.query(
    `INSERT INTO invitations (id, token_hash, email, name, role, event_id, org_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'org-legacy', $7, now() + interval '7 days')`,
    [id, `hash-${id}`, email, `초대 ${id}`, role, eventId, status]
  );
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  state = createState(harness.database);
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: ids.agency, role: 'AGENCY', name: '조직 관리자',
    email: `${ids.agency}@example.test`, orgPermissions: ['events.all'],
  });
  for (const [id, role] of [
    [ids.manager, 'MANAGER'], [ids.managerRo, 'MANAGER'], [ids.managerB, 'MANAGER'],
    [ids.loner, 'MANAGER'], [ids.staff, 'STAFF'], [ids.staffIdle, 'STAFF'],
  ]) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,  id, role, name: id, email: `${id}@example.test` });
  }
  await harness.database.query(
    "INSERT INTO clients (id, org_id, payload) VALUES ($1, 'org-legacy', $2::jsonb), ($3, 'org-legacy', $4::jsonb)",
    [
      ids.clientA, JSON.stringify({ name: '고객사 A', contact: '담당 A', email: 'a@example.test' }),
      ids.clientB, JSON.stringify({ name: '고객사 B', contact: '담당 B', email: 'b@example.test' }),
    ]
  );
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: ids.eventA, slug: slugs.eventA,
    payload: { ...eventPayload(ids.eventA, slugs.eventA, '행사 A', 'LIVE', ids.clientA), clientId: ids.clientA },
    workspace: workspaceA(),
  });
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: ids.eventB, slug: slugs.eventB,
    payload: { ...eventPayload(ids.eventB, slugs.eventB, '행사 B', 'DRAFT', ids.clientB), clientId: ids.clientB },
    workspace: workspaceB(),
  });
  await harness.database.query('UPDATE events SET client_id = $2 WHERE id = $1', [ids.eventA, ids.clientA]);
  await harness.database.query('UPDATE events SET client_id = $2 WHERE id = $1', [ids.eventB, ids.clientB]);
  await insertMembership(harness.database, ids.manager, ids.eventA, ['all']);
  await insertMembership(harness.database, ids.managerRo, ids.eventA, []);
  await insertMembership(harness.database, ids.managerB, ids.eventB, ['all']);
  await insertAssignment(harness.database, {
    id: ids.assignment, accountId: ids.staff, eventId: ids.eventA, type: 'DESK', targetId: ids.deskA1,
  });
  await insertInvitation(harness.database, {
    id: ids.inviteGlobal, email: `global-${suffix}@example.test`, role: 'MANAGER', eventId: null, status: 'PENDING',
  });
  await insertInvitation(harness.database, {
    id: ids.inviteA, email: `a-${suffix}@example.test`, role: 'STAFF', eventId: ids.eventA, status: 'PENDING',
  });
  await insertInvitation(harness.database, {
    id: ids.inviteB, email: `b-${suffix}@example.test`, role: 'STAFF', eventId: ids.eventB, status: 'PENDING',
  });
  cookies = {
    agency: await sessionCookie(harness, ids.agency),
    manager: await sessionCookie(harness, ids.manager),
    staff: await sessionCookie(harness, ids.staff),
    loner: await sessionCookie(harness, ids.loner),
  };
});

after(async () => {
  if (!harness) return;
  try {
    await deleteFixtureRows(harness.database, {
      eventIds: [ids.eventA, ids.eventB],
      accountIds: [ids.agency, ids.manager, ids.managerRo, ids.managerB, ids.loner, ids.staff, ids.staffIdle],
      clientIds: [ids.clientA, ids.clientB],
    });
  } finally {
    await harness.close();
  }
});

test('directory-gives-agency-both-events-as-summaries-without-workspace-weight', async () => {
  const directory = await state.loadDirectory({ id: ids.agency });
  assert.equal(directory.version, 1);
  assert.deepEqual(directory.events.map((event) => event.id), [ids.eventA, ids.eventB]);
  assert.equal(directory.activeEventId, ids.eventA);
  assert.deepEqual(directory.viewer, {
    id: ids.agency, name: '조직 관리자', role: 'AGENCY', orgOwner: true,
    organizationId: 'org-legacy', organizationName: '기존 조직', contextVersion: null,
    orgPermissions: ['events.all'],
  });

  const eventA = directory.events[0];
  assert.deepEqual(Object.keys(eventA).sort(), [
    'capacity', 'clientId', 'date', 'end', 'features', 'id',
    'manualDue', 'messageAttention', 'name', 'pending', 'revision', 'slug',
    'stage', 'start', 'themeColor', 'venue',
  ]);
  assert.equal(eventA.venue, 'A홀');
  assert.equal(eventA.pending, 2);
  assert.equal(eventA.messageAttention, 2);
  // Published background only, normalized to uppercase; the red draft never leaks.
  assert.equal(eventA.themeColor, '#123ABC');
  assert.equal(directory.events[1].themeColor, null);
  assert.equal(directory.events[1].pending, 1);

  const flat = JSON.stringify(directory);
  for (const secret of [
    'participants', 'private-body-failed', 'secret-ticket-1', '01011112222',
    'pending1-private@example.test', 'private-report', 'global-prize', 'workspaces',
    'forged-assignment', '#ff0000',
  ]) {
    assert.ok(!flat.includes(secret), `directory must not carry ${secret}`);
  }

  assert.ok(directory.clients.some((client) => client.id === ids.clientA && client.contact === '담당 A'));
  assert.ok(directory.accounts.some((account) => account.id === ids.manager));
  assert.ok(directory.memberships.some((grant) => grant.accountId === ids.manager && grant.eventId === ids.eventA));
  assert.deepEqual(
    directory.invitations.map((invitation) => invitation.id).sort(),
    [ids.inviteA, ids.inviteB, ids.inviteGlobal].sort()
  );
  assert.ok(directory.integrations && typeof directory.integrations === 'object');
});

test('directory-scopes-manager-to-membership-events-with-minimal-neighbours', async () => {
  const directory = await state.loadDirectory({ id: ids.manager });
  assert.deepEqual(directory.events.map((event) => event.id), [ids.eventA]);
  assert.equal(directory.activeEventId, ids.eventA);
  assert.ok(!JSON.stringify(directory).includes('행사 B'));

  const accountIds = directory.accounts.map((account) => account.id);
  assert.ok(accountIds.includes(ids.manager));
  assert.ok(accountIds.includes(ids.managerRo));
  assert.ok(accountIds.includes(ids.staff));
  // Unassigned STAFF stay visible so the assignment dialog can attach them.
  assert.ok(accountIds.includes(ids.staffIdle));
  const managerRevision = Number((await harness.database.query(
    "SELECT revision FROM organization_memberships WHERE org_id = $1 AND account_id = $2", [LEGACY_ORG, ids.manager]
  )).rows[0].revision);
  assert.equal(directory.accounts.find((account) => account.id === ids.manager).membershipVersion, managerRevision);
  // No cross-event leakage: the other event's manager, the loner and the
  // organisation owner are outside this directory.
  assert.ok(!accountIds.includes(ids.managerB));
  assert.ok(!accountIds.includes(ids.loner));
  assert.ok(!accountIds.includes(ids.agency));

  assert.deepEqual(directory.clients, [{ id: ids.clientA, name: '고객사 A' }]);
  assert.deepEqual(directory.invitations, []);
  // The explicit [] grant stays read-only; it is never widened to ['all'].
  assert.deepEqual(
    directory.memberships.find((grant) => grant.accountId === ids.managerRo),
    { accountId: ids.managerRo, eventId: ids.eventA, write: [] }
  );
});

test('directory-scopes-staff-to-assigned-events-without-contact-or-ticket-secrets', async () => {
  const directory = await state.loadDirectory({ id: ids.staff });
  assert.deepEqual(directory.events.map((event) => event.id), [ids.eventA]);
  assert.deepEqual(directory.accounts.map((account) => account.id), [ids.staff]);
  assert.deepEqual(directory.memberships.filter((grant) => grant.accountId !== ids.staff), []);
  // The staff's own account row (including their own login email) is the
  // same projection bootstrap carries; everyone else's secrets stay out.
  const flat = JSON.stringify(directory);
  for (const secret of ['010', 'secret-ticket', 'pending1-private@example.test', 'global-prize', 'private-report']) {
    assert.ok(!flat.includes(secret), `staff directory must not carry ${secret}`);
  }
});

test('directory-requires-a-session-and-hides-events-from-outsiders', async () => {
  await assert.rejects(state.loadDirectory(null), { status: 401 });
  await assert.rejects(state.loadDirectory({ id: 'nobody' }), { status: 401 });
  const loner = await state.loadDirectory({ id: ids.loner });
  assert.deepEqual(loner.events, []);
  assert.equal(loner.activeEventId, null);
});

test('event-bootstrap-keeps-the-historical-state-shape-for-one-event', async () => {
  const full = await state.loadBootstrap({ id: ids.manager });
  const single = await state.loadEventBootstrap({ id: ids.manager }, ids.eventA);
  assert.equal(single.version, 9);
  assert.deepEqual(Object.keys(single).sort(), Object.keys(full).sort());
  assert.deepEqual(single.events, [full.events.find((event) => event.id === ids.eventA)]);
  assert.deepEqual(Object.keys(single.workspaces), [ids.eventA]);
  assert.deepEqual(single.workspaces[ids.eventA], full.workspaces[ids.eventA]);
  assert.equal(single.activeEventId, ids.eventA);
  assert.deepEqual(single.accounts, full.accounts);
  assert.deepEqual(single.memberships, full.memberships);
  const revisions = new Map((await harness.database.query(
    'SELECT account_id, revision FROM organization_memberships WHERE org_id = $1', [LEGACY_ORG]
  )).rows.map((row) => [String(row.account_id), Number(row.revision)]));
  for (const account of full.accounts) {
    assert.equal(account.membershipVersion, revisions.get(account.id), `projected revision for ${account.id}`);
  }
  assert.deepEqual(single.clients, [{ id: ids.clientA, name: '고객사 A' }]);
  assert.deepEqual(single.invitations, []);
  assert.deepEqual(single.globalAudit, []);
  assert.deepEqual(single.commands, []);
  const flat = JSON.stringify(single);
  assert.ok(!flat.includes('행사 B'));
  assert.ok(!flat.includes(ids.eventB));
});

test('event-bootstrap-projects-staff-exactly-like-bootstrap', async () => {
  const full = await state.loadBootstrap({ id: ids.staff });
  const single = await state.loadEventBootstrap({ id: ids.staff }, ids.eventA);
  assert.deepEqual(single.events, full.events);
  assert.deepEqual(single.workspaces[ids.eventA], full.workspaces[ids.eventA]);
  assert.deepEqual(single.accounts, full.accounts);
  assert.deepEqual(single.memberships, full.memberships);
  const flat = JSON.stringify(single);
  for (const secret of ['secret-ticket', '010', 'pending1-private@example.test', 'private-report', 'global-prize']) {
    assert.ok(!flat.includes(secret), `staff event bootstrap must not carry ${secret}`);
  }
});

test('event-bootstrap-gives-agency-the-full-event-with-filtered-invitations', async () => {
  const single = await state.loadEventBootstrap({ id: ids.agency }, ids.eventA);
  assert.equal(single.events.length, 1);
  assert.equal(single.workspaces[ids.eventA].participants.length, 3);
  assert.ok(single.workspaces[ids.eventA].participants.some((person) => person.ticket === 'secret-ticket-1'));
  assert.deepEqual(
    single.invitations.map((invitation) => invitation.id).sort(),
    [ids.inviteA, ids.inviteGlobal].sort()
  );
  assert.ok(single.clients.some((client) => client.id === ids.clientA && client.contact === '담당 A'));
});

test('event-bootstrap-hides-unseen-events-as-404-and-requires-a-session', async () => {
  await assert.rejects(state.loadEventBootstrap({ id: ids.manager }, ids.eventB), { status: 404 });
  await assert.rejects(state.loadEventBootstrap({ id: ids.loner }, ids.eventA), { status: 404 });
  await assert.rejects(state.loadEventBootstrap({ id: ids.staff }, ids.eventB), { status: 404 });
  await assert.rejects(
    state.loadEventBootstrap({ id: ids.manager }, `missing-${suffix}`),
    { message: '행사를 찾을 수 없습니다' }
  );
  await assert.rejects(state.loadEventBootstrap(null, ids.eventA), { status: 401 });
});

test('scoped-reads-cost-less-than-the-full-bootstrap-on-a-900-person-event', async () => {
  const eventId = `reads-perf-${suffix}`;
  const participants = Array.from({ length: 900 }, (_, index) => ({
    id: `perf-person-${index}`,
    name: `참가자 ${index}`,
    phone: `010${String(10000000 + index)}`,
    email: `perf-${index}@example.test`,
    ticket: `perf-ticket-${index}`,
    status: index % 3 === 0 ? 'PENDING' : 'APPROVED',
    inside: false,
    everIn: false,
  }));
  const checks = Array.from({ length: 900 }, (_, index) => ({
    id: `perf-check-${index}`,
    deskId: ids.deskA1,
    participantId: `perf-person-${index}`,
    action: index % 2 === 0 ? 'IN' : 'OUT',
    at: '2026-11-20T09:00:00.000Z',
  }));
  const messages = Array.from({ length: 200 }, (_, index) => ({
    id: `perf-message-${index}`,
    status: index % 2 === 0 ? 'FAILED' : 'SENT',
    body: `perf-body-${index}`,
  }));
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: eventId,
    slug: `reads-perf-${suffix}`,
    payload: eventPayload(eventId, `reads-perf-${suffix}`, '성능 행사', 'LIVE', null),
    workspace: { participants, desks: [], booths: [], checks, visits: [], messages, venue: { name: '성능 홀' } },
  });
  await insertMembership(harness.database, ids.manager, eventId, ['all']);
  try {
    const startedFull = Date.now();
    const full = await state.loadBootstrap({ id: ids.agency });
    const fullMs = Date.now() - startedFull;

    const startedDirectory = Date.now();
    const directory = await state.loadDirectory({ id: ids.agency });
    const directoryMs = Date.now() - startedDirectory;

    const startedSingle = Date.now();
    const single = await state.loadEventBootstrap({ id: ids.agency }, eventId);
    const singleMs = Date.now() - startedSingle;

    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const directoryBytes = Buffer.byteLength(JSON.stringify(directory));
    const singleBytes = Buffer.byteLength(JSON.stringify(single));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      scopedReadsPerf: {
        events: full.events.length,
        fullBytes, fullMs, directoryBytes, directoryMs, singleBytes, singleMs,
      },
    }));

    assert.ok(directory.events.some((event) => event.id === eventId && event.pending === 300));
    assert.ok(directoryBytes < fullBytes, `directory ${directoryBytes} must stay below bootstrap ${fullBytes}`);
    assert.ok(
      directoryBytes + singleBytes < fullBytes,
      `directory + one event ${directoryBytes + singleBytes} must stay below bootstrap ${fullBytes}`
    );
  } finally {
    await deleteFixtureRows(harness.database, { eventIds: [eventId], accountIds: [] });
    await harness.database.query('DELETE FROM memberships WHERE event_id = $1', [eventId]);
  }
});

// ---------------------------------------------------------------------------
// HTTP contracts through createHttpServer (route registered by the server
// owner). These prove the wired path: session gating, shapes, freshness
// headers and that the historical routes are untouched.
// ---------------------------------------------------------------------------

test('http-directory-answers-shaped-directory-over-the-wired-server', async () => {
  const agency = await requestJson(harness.baseUrl, '/api/console/directory', { cookie: cookies.agency });
  assert.equal(agency.status, 200);
  assert.equal(agency.headers.get('cache-control'), 'no-store');
  assert.equal(agency.json.directory.version, 1);
  assert.deepEqual(agency.json.directory.events.map((event) => event.id), [ids.eventA, ids.eventB]);
  assert.equal(agency.json.directory.events[0].venue, 'A홀');
  assert.equal(agency.json.directory.events[0].pending, 2);
  assert.equal(agency.json.directory.events[0].themeColor, '#123ABC');

  const manager = await requestJson(harness.baseUrl, '/api/console/directory', { cookie: cookies.manager });
  assert.equal(manager.status, 200);
  assert.equal(manager.headers.get('cache-control'), 'no-store');
  assert.deepEqual(manager.json.directory.events.map((event) => event.id), [ids.eventA]);
  assert.ok(!JSON.stringify(manager.json).includes(ids.eventB));

  const staff = await requestJson(harness.baseUrl, '/api/console/directory', { cookie: cookies.staff });
  assert.equal(staff.status, 200);
  assert.deepEqual(staff.json.directory.events.map((event) => event.id), [ids.eventA]);
});

test('http-event-bootstrap-answers-single-event-state-over-the-wired-server', async () => {
  const manager = await requestJson(harness.baseUrl, `/api/events/${ids.eventA}/bootstrap`, { cookie: cookies.manager });
  assert.equal(manager.status, 200);
  assert.equal(manager.headers.get('cache-control'), 'no-store');
  assert.equal(manager.json.state.version, 9);
  assert.deepEqual(manager.json.state.events.map((event) => event.id), [ids.eventA]);
  assert.deepEqual(Object.keys(manager.json.state.workspaces), [ids.eventA]);

  const staff = await requestJson(harness.baseUrl, `/api/events/${ids.eventA}/bootstrap`, { cookie: cookies.staff });
  assert.equal(staff.status, 200);
  assert.deepEqual(staff.json.state.events.map((event) => event.id), [ids.eventA]);
  assert.ok(!JSON.stringify(staff.json).includes('secret-ticket-1'));
});

test('http-scoped-reads-reject-anonymous-and-unseen-events', async () => {
  for (const url of ['/api/console/directory', `/api/events/${ids.eventA}/bootstrap`]) {
    const anonymous = await requestJson(harness.baseUrl, url);
    assert.equal(anonymous.status, 401, url);
    assert.equal(anonymous.json.error, '로그인이 필요합니다', url);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store', url);
  }

  const managerElsewhere = await requestJson(harness.baseUrl, `/api/events/${ids.eventB}/bootstrap`, { cookie: cookies.manager });
  assert.equal(managerElsewhere.status, 404);
  assert.deepEqual(managerElsewhere.json, { error: '행사를 찾을 수 없습니다' });

  const staffElsewhere = await requestJson(harness.baseUrl, `/api/events/${ids.eventB}/bootstrap`, { cookie: cookies.staff });
  assert.equal(staffElsewhere.status, 404);

  const missing = await requestJson(harness.baseUrl, `/api/events/missing-${suffix}/bootstrap`, { cookie: cookies.agency });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: '행사를 찾을 수 없습니다' });
});

test('http-historical-events-and-bootstrap-routes-stay-compatible', async () => {
  const listed = await requestJson(harness.baseUrl, '/api/events', { cookie: cookies.manager });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(listed.json.events.map((event) => event.id), [ids.eventA]);
  assert.equal(listed.json.activeEventId, ids.eventA);

  const full = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookies.manager });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('cache-control'), 'no-store');
  assert.equal(full.json.state.version, 9);
  assert.deepEqual(full.json.state.events.map((event) => event.id), [ids.eventA]);
  assert.deepEqual(Object.keys(full.json.state.workspaces), [ids.eventA]);
});

test('http-write-methods-are-not-owned-by-the-scoped-reads', async () => {
  const created = await requestJson(harness.baseUrl, '/api/console/directory', {
    method: 'POST',
    cookie: cookies.agency,
    body: {},
  });
  assert.equal(created.status, 404);
});
