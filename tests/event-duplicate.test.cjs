'use strict';

// Event duplication contract: configuration and program definitions are
// copied, runtime records and event-scoped file references are not. The new
// event starts in DRAFT with registration closed, and a lost-response retry
// replays the same copy through the organization-scope receipt.

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

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const sourceId = `duplicate-source-${suffix}`;
const sourceSlug = `duplicate-${suffix.slice(0, 20)}`;
const accountIds = {
  agency: `duplicate-agency-${suffix}`,
  manager: `duplicate-manager-${suffix}`,
};
const eventIds = [];
let harness;
let cookies = {};

function commandId() {
  return `duplicate-${crypto.randomUUID()}`;
}

async function workspaceOf(eventId) {
  const row = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [eventId]
  );
  return row.rows[0].payload;
}

async function eventOf(eventId) {
  const row = await harness.database.query(
    'SELECT id, slug, client_id, payload, revision FROM events WHERE id = $1',
    [eventId]
  );
  return row.rows[0];
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '복제 운영사 관리자'],
    ['manager', 'MANAGER', '복제 행사 매니저'],
  ]) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,
      id: accountIds[key],
      role,
      name,
      email: `${accountIds[key]}@example.test`,
    });
    cookies[key] = await sessionCookie(harness, accountIds[key]);
  }

  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: sourceId,
    slug: sourceSlug,
    payload: {
      id: sourceId,
      slug: sourceSlug,
      name: '복제 원본 행사',
      clientId: null,
      date: '2027-01-16',
      start: '09:00',
      end: '17:00',
      capacity: 200,
      stage: 'LIVE',
      features: ['poll', 'survey', 'stamp', 'reward'],
    },
    workspace: {
      participants: [{
        id: 'source-person',
        name: '원본 참가자',
        phone: '01000000001',
        status: 'APPROVED',
        ticket: 'ET:source:secret-ticket',
        registrationType: 'PRE',
      }],
      checks: [{ id: 'source-check', participantId: 'source-person' }],
      visits: [{ id: 'source-visit' }],
      assignments: [{ id: 'source-assignment' }],
      responses: [{ id: 'source-response' }],
      questions: [{ id: 'source-question' }],
      photos: [{ id: 'source-photo' }],
      posts: [{ id: 'source-post' }],
      messages: [{ id: 'source-message', status: 'SENT' }],
      reports: [{ id: 'source-report' }],
      payments: [{ id: 'source-payment' }],
      rewards: [{ id: 'source-reward' }],
      audit: [{ id: 'source-audit' }],
      luckyNumbers: [{ participantId: 'source-person', number: 17 }],
      rouletteResults: [{ id: 'source-roulette' }],
      teams: [{ id: 'source-team' }],
      votes: [{ id: 'source-vote' }],
      drawPrograms: [{ id: 'source-draw', winners: [{ name: '원본 당첨자' }] }],
      pollConfig: { pickCount: 1 },
      fields: [
        { id: 'name', label: '이름', type: 'text', required: true },
        { id: 'phone', label: '연락처', type: 'text', required: true },
        { id: 'team', label: '소속', type: 'text', required: false },
      ],
      publishedFields: [
        { id: 'name', label: '이름', type: 'text', required: true },
        { id: 'phone', label: '연락처', type: 'text', required: true },
      ],
      formVersion: 3,
      publishedVersion: 2,
      consentText: '원본 동의 문구',
      consentVersion: 2,
      registrationOpen: true,
      groups: ['일반', 'VIP'],
      venue: { name: '원본 행사장', address: '서울', directions: '3번 출구', contact: '02-000-0000', description: '안내' },
      stampMode: 'SELF',
      allowReentry: false,
      verificationRequired: true,
      price: 5000,
      branding: {
        tagline: '원본 소개 문구',
        logo: { fileId: 'file-logo' },
        keyvisual: { fileId: 'file-keyvisual' },
      },
      notices: [{
        id: 'source-notice',
        title: '원본 공지',
        body: '원본 공지 본문',
        published: true,
        pinned: true,
        at: '2027-01-01T00:00:00.000Z',
        attachment: { fileId: 'file-notice' },
      }],
      program: [{
        id: 'source-program',
        title: '원본 세션',
        date: '2027-01-16',
        start: '10:00',
        end: '11:00',
        place: '본관',
        description: '세션 설명',
        published: true,
        attachment: { fileId: 'file-program' },
      }],
      modules: [{
        id: 'source-module',
        type: 'poll',
        title: '원본 투표',
        status: 'OPEN',
        options: ['A', 'B'],
        answer: '',
        questions: [],
        published: true,
        revealed: true,
      }],
      desks: [{ id: 'source-desk', name: '입장 데스크', action: 'IN', mode: 'desk', open: true }],
      booths: [{
        id: 'source-booth',
        name: '원본 부스',
        zone: 'A',
        status: 'OPEN',
        capacity: 10,
        limit: 1,
        used: 3,
        startsAt: '',
        endsAt: '',
      }],
      boothMap: {
        draft: { image: { fileId: 'file-map' }, locations: [{ id: 'source-booth', x: 0.5, y: 0.5 }] },
        published: { image: { fileId: 'file-map' }, locations: [{ id: 'source-booth', x: 0.5, y: 0.5 }] },
      },
    },
  });
  eventIds.push(sourceId);
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

test('event duplication copies configuration but never runtime records or file references', async () => {
  const id = commandId();
  const response = await requestJson(harness.baseUrl, `/api/events/${sourceId}/duplicate`, {
    method: 'POST',
    cookie: cookies.agency,
    body: {
      commandId: id,
      name: '복제된 행사',
      slug: `${sourceSlug}-copy-a`,
      date: '2027-02-20',
      start: '10:00',
      end: '18:00',
      capacity: 120,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const created = response.json.event;
  eventIds.push(created.id);

  assert.ok(created.id && created.id !== sourceId);
  assert.equal(created.name, '복제된 행사');
  assert.equal(created.slug, `${sourceSlug}-copy-a`);
  assert.equal(created.date, '2027-02-20');
  assert.equal(created.start, '10:00');
  assert.equal(created.end, '18:00');
  assert.equal(created.capacity, 120);
  assert.equal(created.stage, 'DRAFT');
  assert.deepEqual(created.features, ['poll', 'survey', 'stamp', 'reward']);

  const workspace = await workspaceOf(created.id);
  assert.deepEqual(workspace.participants, []);
  assert.deepEqual(workspace.checks, []);
  assert.deepEqual(workspace.visits, []);
  assert.deepEqual(workspace.assignments, []);
  assert.deepEqual(workspace.responses, []);
  assert.deepEqual(workspace.questions, []);
  assert.deepEqual(workspace.photos, []);
  assert.deepEqual(workspace.posts, []);
  assert.deepEqual(workspace.messages, []);
  assert.deepEqual(workspace.reports, []);
  assert.deepEqual(workspace.payments, []);
  assert.deepEqual(workspace.rewards, []);
  assert.deepEqual(workspace.audit, []);
  assert.deepEqual(workspace.luckyNumbers, []);
  assert.deepEqual(workspace.rouletteResults, []);
  assert.deepEqual(workspace.teams, []);
  assert.deepEqual(workspace.votes, []);
  assert.deepEqual(workspace.drawPrograms, []);
  assert.deepEqual(workspace.boothMap, { draft: null, published: null });

  assert.deepEqual(workspace.fields, [
    { id: 'name', label: '이름', type: 'text', required: true },
    { id: 'phone', label: '연락처', type: 'text', required: true },
    { id: 'team', label: '소속', type: 'text', required: false },
  ]);
  assert.equal(workspace.formVersion, 3);
  assert.equal(workspace.publishedVersion, 2);
  assert.equal(workspace.consentText, '원본 동의 문구');
  assert.equal(workspace.consentVersion, 2);
  assert.deepEqual(workspace.groups, ['일반', 'VIP']);
  assert.deepEqual(workspace.venue, {
    name: '원본 행사장',
    address: '서울',
    directions: '3번 출구',
    contact: '02-000-0000',
    description: '안내',
  });
  assert.equal(workspace.stampMode, 'SELF');
  assert.equal(workspace.allowReentry, false);
  assert.equal(workspace.verificationRequired, true);
  assert.equal(workspace.price, 5000);
  assert.equal(workspace.registrationOpen, false);
  assert.equal(workspace.branding.tagline, '원본 소개 문구');
  assert.equal(workspace.branding.logo, null);
  assert.equal(workspace.branding.keyvisual, null);

  assert.equal(workspace.notices.length, 1);
  assert.equal(workspace.notices[0].title, '원본 공지');
  assert.equal(workspace.notices[0].published, false);
  assert.equal(workspace.notices[0].attachment, undefined);

  assert.equal(workspace.program.length, 1);
  assert.equal(workspace.program[0].title, '원본 세션');
  assert.equal(workspace.program[0].published, false);
  assert.equal(workspace.program[0].attachment, null);

  assert.equal(workspace.modules.length, 1);
  assert.equal(workspace.modules[0].title, '원본 투표');
  assert.equal(workspace.modules[0].status, 'DRAFT');
  assert.equal(workspace.modules[0].published, false);
  assert.equal(workspace.modules[0].revealed, false);

  assert.equal(workspace.desks.length, 1);
  assert.equal(workspace.desks[0].open, false);
  assert.equal(workspace.booths.length, 1);
  assert.equal(workspace.booths[0].used, 0);
  assert.equal(workspace.booths[0].status, 'CLOSED');

  const serialized = JSON.stringify(workspace);
  assert.doesNotMatch(serialized, /secret-ticket|file-logo|file-keyvisual|file-notice|file-program|file-map|원본 참가자|원본 당첨자/);
});

test('a lost-response retry replays the same duplicate and slug collisions are refused', async () => {
  const id = commandId();
  const body = {
    commandId: id,
    name: '재시도 행사',
    slug: `${sourceSlug}-retry`,
    date: '2027-03-01',
    start: '09:00',
    end: '17:00',
    capacity: 80,
  };
  const first = await requestJson(harness.baseUrl, `/api/events/${sourceId}/duplicate`, {
    method: 'POST', cookie: cookies.agency, body,
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  eventIds.push(first.json.event.id);

  const retry = await requestJson(harness.baseUrl, `/api/events/${sourceId}/duplicate`, {
    method: 'POST', cookie: cookies.agency, body,
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.equal(retry.json.event.id, first.json.event.id);

  const count = await harness.database.query('SELECT count(*)::int AS value FROM events WHERE slug = $1', [body.slug]);
  assert.equal(count.rows[0].value, 1);

  const collision = await requestJson(harness.baseUrl, `/api/events/${sourceId}/duplicate`, {
    method: 'POST',
    cookie: cookies.agency,
    body: { ...body, commandId: commandId(), name: '충돌 행사' },
  });
  assert.equal(collision.status, 409, JSON.stringify(collision.json));
  assert.equal(collision.json.field, 'slug');
});

test('duplication defaults follow the source event and permissions stay agency-only', async () => {
  const response = await requestJson(harness.baseUrl, `/api/events/${sourceId}/duplicate`, {
    method: 'POST',
    cookie: cookies.agency,
    body: { commandId: commandId() },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const created = response.json.event;
  eventIds.push(created.id);
  assert.equal(created.name, '복제 원본 행사 (복사)');
  assert.equal(created.slug, `${sourceSlug}-copy`);
  assert.equal(created.date, '2027-01-16');
  assert.equal(created.start, '09:00');
  assert.equal(created.end, '17:00');
  assert.equal(created.capacity, 200);
  assert.equal(created.stage, 'DRAFT');

  const anonymous = await requestJson(harness.baseUrl, `/api/events/${sourceId}/duplicate`, {
    method: 'POST',
    body: { commandId: commandId() },
  });
  assert.equal(anonymous.status, 401);

  const manager = await requestJson(harness.baseUrl, `/api/events/${sourceId}/duplicate`, {
    method: 'POST',
    cookie: cookies.manager,
    body: { commandId: commandId() },
  });
  assert.equal(manager.status, 403, JSON.stringify(manager.json));

  const missing = await requestJson(harness.baseUrl, `/api/events/unknown-${suffix}/duplicate`, {
    method: 'POST',
    cookie: cookies.agency,
    body: { commandId: commandId() },
  });
  assert.equal(missing.status, 404);
});
