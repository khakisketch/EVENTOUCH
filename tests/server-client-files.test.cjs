'use strict';

// Organization-level client files (logos, registration documents) live on
// the customer record, not on an event: client_id set, event_id null. They
// survive event archival, follow the client on delete, and are AGENCY-only
// on every path. The client record keeps the reference; the bytes stay in
// file storage and travel through the file routes, never the command path.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
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
  agency: `clientfile-agency-${suffix}`,
  manager: `clientfile-manager-${suffix}`,
  staff: `clientfile-staff-${suffix}`,
};
const createdClientIds = [];
let harness;
let storageDir;
let agencyCookie;
let managerCookie;
let staffCookie;

function jpegBytes(size) {
  const buffer = Buffer.alloc(size, 0x00);
  buffer[0] = 0xff; buffer[1] = 0xd8; buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer[4] = 0x00; buffer[5] = 0x0b;
  buffer[6] = 0x08;
  buffer[7] = 0x00; buffer[8] = 0x01;
  buffer[9] = 0x00; buffer[10] = 0x0a;
  buffer[11] = 0x01;
  buffer[12] = 0x01; buffer[13] = 0x11; buffer[14] = 0x00;
  buffer[15] = 0xff; buffer[16] = 0xd9;
  return buffer;
}

function pdfBytes() {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
}

before(async () => {
  if (!databaseUrl) return;
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-clientfiles-'));
  harness = await startApiHarness({ storageDir });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,  id: ids.agency, role: 'AGENCY', name: '고객사 관리자', email: `${ids.agency}@example.test` });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,  id: ids.manager, role: 'MANAGER', name: '행사 매니저', email: `${ids.manager}@example.test` });
  await insertAccount(harness.database, {orgId: LEGACY_ORG,  id: ids.staff, role: 'STAFF', name: '현장 스태프', email: `${ids.staff}@example.test` });
  agencyCookie = await sessionCookie(harness, ids.agency);
  managerCookie = await sessionCookie(harness, ids.manager);
  staffCookie = await sessionCookie(harness, ids.staff);
});

after(async () => {
  if (harness) {
    await deleteFixtureRows(harness.database, { clientIds: createdClientIds, accountIds: [ids.agency, ids.manager, ids.staff] });
    await harness.close();
  }
  if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
});

async function createClient(name, tag) {
  const response = await requestJson(harness.baseUrl, '/api/clients', {
    method: 'POST',
    cookie: agencyCookie,
    body: { commandId: `clientfile-client-${tag}-${suffix}`, name },
  });
  assert.equal(response.status, 201);
  createdClientIds.push(response.json.client.id);
  return response.json.client.id;
}

async function uploadFile(clientId, { name = 'logo.jpg', bytes = jpegBytes(1024), type = 'image/jpeg', cookie = agencyCookie, commandId = crypto.randomUUID() } = {}) {
  const res = await fetch(
    `${harness.baseUrl}/api/clients/${clientId}/files?name=${encodeURIComponent(name)}&commandId=${encodeURIComponent(commandId)}`,
    { method: 'POST', headers: { 'content-type': type, ...(cookie ? { cookie } : {}) }, body: bytes }
  );
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('agency uploads and reads a client logo outside any event', async () => {
  const clientId = await createClient('로고고객사', 'logo');
  const bytes = jpegBytes(2048);
  const up = await uploadFile(clientId, { bytes });
  assert.equal(up.status, 201);
  assert.equal(up.json.file.name, 'logo.jpg');
  assert.equal(up.json.file.type, 'image/jpeg');

  const row = await harness.database.query('SELECT event_id, client_id, content_type FROM stored_files WHERE id = $1', [up.json.file.fileId]);
  assert.equal(row.rows[0].event_id, null);
  assert.equal(row.rows[0].client_id, clientId);

  const read = await fetch(`${harness.baseUrl}/api/clients/${clientId}/files/${up.json.file.fileId}`, { headers: { cookie: agencyCookie } });
  assert.equal(read.status, 200);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
});

test('client files are agency-only and scoped to their client', async () => {
  const clientId = await createClient('권한고객사', 'perm');
  const otherId = await createClient('다른고객사', 'other');
  const up = await uploadFile(clientId, {});
  assert.equal(up.status, 201);

  assert.equal((await uploadFile(clientId, { cookie: managerCookie })).status, 403);
  assert.equal((await uploadFile(clientId, { cookie: staffCookie })).status, 403);
  assert.equal((await uploadFile(clientId, { cookie: '' })).status, 401);
  assert.equal((await uploadFile(`client-missing-${suffix}`, {})).status, 404);

  const read = (actor, target, file) => fetch(
    `${harness.baseUrl}/api/clients/${target}/files/${file}`,
    { headers: actor ? { cookie: actor } : {} }
  ).then((res) => res.status);
  assert.equal(await read(managerCookie, clientId, up.json.file.fileId), 403);
  assert.equal(await read(staffCookie, clientId, up.json.file.fileId), 403);
  assert.equal(await read('', clientId, up.json.file.fileId), 401);
  assert.equal(await read(agencyCookie, otherId, up.json.file.fileId), 404);
  assert.equal(await read(agencyCookie, clientId, `file-missing-${suffix}`), 404);
});

test('oversize and non-document uploads are refused without residue', async () => {
  const clientId = await createClient('검증고객사', 'verify');
  const before = (await harness.database.query('SELECT count(*)::int AS n FROM stored_files')).rows[0].n;
  assert.equal((await uploadFile(clientId, { bytes: jpegBytes(600001) })).status, 413);
  assert.equal((await uploadFile(clientId, { name: 'run.exe', bytes: Buffer.from('MZ'), type: 'application/octet-stream' })).status, 400);
  assert.equal((await uploadFile(clientId, { name: 'fake.jpg', bytes: Buffer.from('not a jpeg'), type: 'image/jpeg' })).status, 400);
  const after = (await harness.database.query('SELECT count(*)::int AS n FROM stored_files')).rows[0].n;
  assert.equal(after, before);
});

test('registration documents and replayed uploads behave', async () => {
  const clientId = await createClient('서류고객사', 'doc');
  const doc = await uploadFile(clientId, { name: 'registration.pdf', bytes: pdfBytes(), type: 'application/pdf' });
  assert.equal(doc.status, 201);
  assert.equal(doc.json.file.type, 'application/pdf');

  const commandId = crypto.randomUUID();
  const first = await uploadFile(clientId, { commandId });
  const replay = await uploadFile(clientId, { commandId });
  assert.deepEqual([first.status, replay.status].sort(), [200, 201]);
  assert.deepEqual(first.json, replay.json);
});

test('client records pin validated file references and clear them', async () => {
  const clientId = await createClient('첨부고객사', 'pin');
  const logo = await uploadFile(clientId, {});
  assert.equal(logo.status, 201);

  const bogus = await requestJson(harness.baseUrl, '/api/clients', {
    method: 'POST',
    cookie: agencyCookie,
    body: { commandId: `clientfile-bogus-${suffix}`, id: clientId, name: '첨부고객사', logoFileId: `file-missing-${suffix}` },
  });
  assert.equal(bogus.status, 404);

  const otherId = await createClient('남의고객사', 'cross');
  const cross = await requestJson(harness.baseUrl, '/api/clients', {
    method: 'POST',
    cookie: agencyCookie,
    body: { commandId: `clientfile-cross-${suffix}`, id: otherId, name: '남의고객사', logoFileId: logo.json.file.fileId },
  });
  assert.equal(cross.status, 404, 'a logo must resolve to a file of the same client');

  const pinned = await requestJson(harness.baseUrl, '/api/clients', {
    method: 'POST',
    cookie: agencyCookie,
    body: { commandId: `clientfile-pin-${suffix}`, id: clientId, name: '첨부고객사', logoFileId: logo.json.file.fileId },
  });
  assert.equal(pinned.status, 201);
  assert.equal(pinned.json.client.logoFileId, logo.json.file.fileId);

  const bootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: agencyCookie });
  const projected = bootstrap.json.state.clients.find((item) => item.id === clientId);
  assert.equal(projected.logoFileId, logo.json.file.fileId);

  const cleared = await requestJson(harness.baseUrl, '/api/clients', {
    method: 'POST',
    cookie: agencyCookie,
    body: { commandId: `clientfile-clear-${suffix}`, id: clientId, name: '첨부고객사', logoFileId: '' },
  });
  assert.equal(cleared.status, 201);
  assert.equal(cleared.json.client.logoFileId, '');
});
