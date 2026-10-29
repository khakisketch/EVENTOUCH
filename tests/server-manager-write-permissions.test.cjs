'use strict';

// Manager write-permission enforcement: memberships.write_permissions is an
// allow-list ('all' or the feature keys in server/event-permissions.js).
// A scoped manager may run only the commands in its grant (403 otherwise),
// an empty grant keeps reads but allows no writes, and AGENCY is unaffected.

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
const ids = {
  agency: `perm-agency-${suffix}`,
  participants: `perm-manager-participants-${suffix}`,
  page: `perm-manager-page-${suffix}`,
  onsite: `perm-manager-onsite-${suffix}`,
  settings: `perm-manager-settings-${suffix}`,
  results: `perm-manager-results-${suffix}`,
  messages: `perm-manager-messages-${suffix}`,
  empty: `perm-manager-empty-${suffix}`,
  all: `perm-manager-all-${suffix}`,
  event: `perm-event-${suffix}`,
};
let harness;
let cookies = {};
const extraAccountIds = [];

function commandId() {
  return `perm-${crypto.randomUUID()}`;
}

function run(cookie, command, payload) {
  return requestJson(harness.baseUrl, `/api/events/${ids.event}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: commandId(), command, payload },
  });
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: ids.agency, role: 'AGENCY', name: '조직 소유자', email: `${ids.agency}@example.test`,
  });
  for (const key of ['participants', 'page', 'onsite', 'settings', 'results', 'messages', 'empty', 'all']) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,
      id: ids[key], role: 'MANAGER', name: `매니저 ${key}`, email: `${ids[key]}@example.test`,
    });
  }
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: ids.event,
    slug: ids.event,
    payload: {
      id: ids.event, slug: ids.event, name: '권한 집행 행사', clientId: null,
      date: '2026-12-01', start: '10:00', end: '17:00', capacity: 100,
      stage: 'READY', features: [],
    },
    workspace: {},
  });
  const grants = {
    participants: ['participants'],
    page: ['page'],
    onsite: ['onsite'],
    settings: ['settings'],
    results: ['results'],
    messages: ['messages'],
    empty: [],
    all: ['all'],
  };
  const agencyCookie = await sessionCookie(harness, ids.agency);
  cookies.agency = agencyCookie;
  for (const [key, write] of Object.entries(grants)) {
    const granted = await requestJson(harness.baseUrl, `/api/events/${ids.event}/members`, {
      method: 'POST',
      cookie: agencyCookie,
      body: { accountId: ids[key], enabled: true, write, commandId: commandId() },
    });
    assert.equal(granted.status, 201, JSON.stringify(granted.json));
    cookies[key] = await sessionCookie(harness, ids[key]);
  }
});

after(async () => {
  if (!harness) return;
  await deleteFixtureRows(harness.database, {
    eventIds: [ids.event],
    accountIds: Object.values(ids).filter((id) => id !== ids.event).concat(extraAccountIds),
  });
  await harness.close();
});

test('participants-scoped manager writes the roster but nothing else', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const created = await run(cookies.participants, 'participant.create', {
    name: '허용된 등록', phone: '01011112222',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const notice = await run(cookies.participants, 'notice.save', { title: 'x', body: 'y' });
  assert.equal(notice.status, 403, JSON.stringify(notice.json));

  const desk = await run(cookies.participants, 'desk.save', { name: '입구', action: 'IN', mode: 'desk' });
  assert.equal(desk.status, 403, JSON.stringify(desk.json));
});

test('page-scoped manager writes notices but not the roster', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const notice = await run(cookies.page, 'notice.save', { title: '허용된 공지', body: '내용입니다' });
  assert.equal(notice.status, 201, JSON.stringify(notice.json));

  const created = await run(cookies.page, 'participant.create', { name: '차단된 등록', phone: '01011113333' });
  assert.equal(created.status, 403, JSON.stringify(created.json));
});

test('onsite-scoped manager writes desks but not the roster', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const desk = await run(cookies.onsite, 'desk.save', { name: '허용된 데스크', action: 'IN', mode: 'desk' });
  assert.ok([200, 201].includes(desk.status), JSON.stringify(desk.json));

  const created = await run(cookies.onsite, 'participant.create', { name: '차단된 등록', phone: '01011114444' });
  assert.equal(created.status, 403, JSON.stringify(created.json));
});

test('settings-scoped manager changes features but not the roster', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const features = await run(cookies.settings, 'event.features', { features: [] });
  assert.equal(features.status, 200, JSON.stringify(features.json));

  const created = await run(cookies.settings, 'participant.create', { name: '차단된 등록', phone: '01011115555' });
  assert.equal(created.status, 403, JSON.stringify(created.json));
});

test('results-scoped manager writes reports but not the roster', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const report = await run(cookies.results, 'report.create', { title: '허용된 보고서' });
  assert.equal(report.status, 201, JSON.stringify(report.json));

  const created = await run(cookies.results, 'participant.create', { name: '차단된 등록', phone: '01011116666' });
  assert.equal(created.status, 403, JSON.stringify(created.json));
});

test('messages-scoped manager writes templates but not the roster', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const template = await run(cookies.messages, 'template.save', {
    name: '허용된 템플릿', channel: 'SMS', body: '안내입니다',
  });
  assert.ok([200, 201].includes(template.status), JSON.stringify(template.json));

  const created = await run(cookies.messages, 'participant.create', { name: '차단된 등록', phone: '01011117777' });
  assert.equal(created.status, 403, JSON.stringify(created.json));
});

test('empty grant keeps reads but allows no writes', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const created = await run(cookies.empty, 'participant.create', { name: '차단된 등록', phone: '01011118888' });
  assert.equal(created.status, 403, JSON.stringify(created.json));

  const notice = await run(cookies.empty, 'notice.save', { title: 'x', body: 'y' });
  assert.equal(notice.status, 403, JSON.stringify(notice.json));

  // Reads are membership-gated, not grant-gated: the event stays visible.
  const bootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookies.empty });
  assert.equal(bootstrap.status, 200);
  assert.ok(bootstrap.json.state.events.some((item) => item.id === ids.event));
});

test('all grant and agency keep full write access', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const created = await run(cookies.all, 'participant.create', { name: '전체 허용', phone: '01011119999' });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const notice = await run(cookies.all, 'notice.save', { title: '전체 허용 공지', body: '내용입니다' });
  assert.equal(notice.status, 201, JSON.stringify(notice.json));

  const agencyNotice = await run(cookies.agency, 'notice.save', { title: '소유자 공지', body: '내용입니다' });
  assert.equal(agencyNotice.status, 201, JSON.stringify(agencyNotice.json));
});

test('omitted write on registration defaults to full access', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const accountId = `perm-manager-omitted-${suffix}`;
  extraAccountIds.push(accountId);
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: accountId, role: 'MANAGER', name: '생략 등록 매니저', email: `${accountId}@example.test`,
  });
  const granted = await requestJson(harness.baseUrl, `/api/events/${ids.event}/members`, {
    method: 'POST',
    cookie: cookies.agency,
    body: { accountId, enabled: true, commandId: commandId() },
  });
  assert.equal(granted.status, 201, JSON.stringify(granted.json));
  assert.deepEqual(granted.json.membership.write, ['all']);
  const stored = await harness.database.query(
    'SELECT write_permissions FROM memberships WHERE account_id = $1 AND event_id = $2',
    [accountId, ids.event]
  );
  assert.deepEqual(stored.rows[0].write_permissions, ['all']);

  const cookie = await sessionCookie(harness, accountId);
  const created = await requestJson(harness.baseUrl, `/api/events/${ids.event}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: commandId(), command: 'participant.create', payload: { name: '생략 허용', phone: '01022223333' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
});

test('invitation acceptance grants a writing manager membership', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');
  const email = `perm-invite-${suffix}@example.test`;
  const invited = await requestJson(harness.baseUrl, '/api/auth/invitations', {
    method: 'POST',
    cookie: cookies.agency,
    body: { commandId: commandId(), name: '초대 매니저', email, role: 'MANAGER', eventId: ids.event },
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.json));

  const password = 'invite-accept-password-1';
  const accepted = await requestJson(harness.baseUrl, `/api/auth/invitations/${invited.json.token}/accept`, {
    method: 'POST',
    body: { password },
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
  extraAccountIds.push(accepted.json.account.id);

  const stored = await harness.database.query(
    'SELECT write_permissions FROM memberships WHERE account_id = $1 AND event_id = $2',
    [accepted.json.account.id, ids.event]
  );
  assert.equal(stored.rowCount, 1);
  assert.deepEqual(stored.rows[0].write_permissions, ['all']);

  const cookie = await sessionCookie(harness, accepted.json.account.id);
  const created = await requestJson(harness.baseUrl, `/api/events/${ids.event}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: commandId(), command: 'participant.create', payload: { name: '초대 허용', phone: '01022224444' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
});
