'use strict';

// The customer list is organisation-level data, so it had to grow its own
// server route: the console's client.save only existed in the local store,
// which meant server mode rejected it with an unrelated participants error
// and every event stayed unlinked.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  sessionCookie,
  requestJson,
  deleteFixtureRows,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const ids = {
  agency: `client-agency-${suffix}`,
  manager: `client-manager-${suffix}`,
};
const createdClientIds = [];
let harness;
let agencyCookie;
let managerCookie;

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    id: ids.agency,
    role: 'AGENCY',
    name: '고객사 관리자',
    email: `${ids.agency}@example.test`,
  });
  await insertAccount(harness.database, {
    id: ids.manager,
    role: 'MANAGER',
    name: '행사 매니저',
    email: `${ids.manager}@example.test`,
  });
  agencyCookie = await sessionCookie(harness, ids.agency);
  managerCookie = await sessionCookie(harness, ids.manager);
});

after(async () => {
  if (!harness) return;
  await deleteFixtureRows(harness.database, {
    clientIds: createdClientIds,
    accountIds: [ids.agency, ids.manager],
  });
  await harness.close();
});

function saveClient(body, cookie = agencyCookie) {
  return requestJson(harness.baseUrl, '/api/clients', { method: 'POST', cookie, body });
}

test('customer save persists a new client and replays the same command id', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');

  const commandId = `client-save-${suffix}`;
  const response = await saveClient({
    name: '한빛 제약',
    contact: '박실무',
    email: 'client@example.test',
    commandId,
  });
  assert.equal(response.status, 201);
  const clientId = response.json.client.id;
  createdClientIds.push(clientId);
  assert.equal(response.json.client.name, '한빛 제약');

  const stored = await harness.database.query('SELECT payload FROM clients WHERE id = $1', [clientId]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].payload.name, '한빛 제약');
  assert.equal(stored.rows[0].payload.contact, '박실무');

  // A retry after a lost response must return the same record, not a copy.
  const replay = await saveClient({
    name: '한빛 제약',
    contact: '박실무',
    email: 'client@example.test',
    commandId,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.client.id, clientId);
  const count = await harness.database.query('SELECT count(*)::int AS total FROM clients');
  assert.equal(count.rows[0].total, 1);

  const bootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: agencyCookie });
  assert.ok(bootstrap.json.state.clients.some((item) => item.id === clientId && item.name === '한빛 제약'));
});

test('customer save edits in place and keeps fields the command does not own', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');

  const created = await saveClient({ name: '이름 변경 전', contact: '최담당', email: 'before@example.test', commandId: `client-edit-${suffix}` });
  const clientId = created.json.client.id;
  createdClientIds.push(clientId);

  // A linked contact is not part of this form; editing a name must not drop it.
  await harness.database.query(
    "UPDATE clients SET payload = payload || '{\"contactAccountId\":\"linked-account\"}'::jsonb WHERE id = $1",
    [clientId]
  );

  const edited = await saveClient({ id: clientId, name: '이름 변경 후', contact: '최담당', email: 'after@example.test', commandId: `client-edit-2-${suffix}` });
  assert.equal(edited.status, 201);
  assert.equal(edited.json.client.id, clientId);
  assert.equal(edited.json.client.name, '이름 변경 후');
  assert.equal(edited.json.client.contactAccountId, 'linked-account');

  const missing = await saveClient({ id: `client-missing-${suffix}`, name: '없는 고객사', contact: '', email: '', commandId: `client-missing-${suffix}` });
  assert.equal(missing.status, 404);
});

test('customer save refuses a manager and rejects a malformed contact email', async (t) => {
  if (!databaseUrl) return t.skip('set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database');

  const denied = await saveClient({ name: '권한 없는 저장', contact: '', email: '', commandId: `client-denied-${suffix}` }, managerCookie);
  assert.equal(denied.status, 403);

  const invalid = await saveClient({ name: '이메일 확인', contact: '담당', email: 'not-an-email', commandId: `client-invalid-${suffix}` });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.field, 'email');

  const blank = await saveClient({ name: '   ', contact: '', email: '', commandId: `client-blank-${suffix}` });
  assert.equal(blank.status, 400);
  assert.equal(blank.json.field, 'name');
});
