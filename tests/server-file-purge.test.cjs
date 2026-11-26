'use strict';

// A deleted file is unservable the moment its row is marked, and its bytes are
// unlinked by the purge run. The run is the retry path: a missing object is a
// success, so a crash between marking and unlinking is repaired, never retried
// forever or reported as a failure.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { createFileService } = require('../server/files');
const { createFileStorage } = require('../server/file-storage');
const { floorplanPng } = require('./helpers/floorplan-image.cjs');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);
const suffix = crypto.randomUUID().replace(/-/g, '');
const eventId = `purge-event-${suffix}`;
let harness;
let storageDir;
let files;
let cookie;

before(async () => {
  if (!databaseUrl) return;
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-purge-'));
  harness = await startApiHarness({ storageDir });
  await insertAccount(harness.database, { orgId: LEGACY_ORG, id: `agency-${suffix}`, role: 'AGENCY', name: 'agency', email: `agency-${suffix}@example.test` });
  await insertEvent(harness.database, { orgId: LEGACY_ORG, id: eventId, slug: eventId, payload: { id: eventId, slug: eventId, stage: 'LIVE', features: ['stamp'] }, workspace: {} });
  files = createFileService(harness.database, { fileStorage: createFileStorage({ storageDir }) });
  const { sessionCookie } = require('./helpers/postgres-api-server.cjs');
  cookie = await sessionCookie(harness, `agency-${suffix}`);
});
after(async () => {
  if (!databaseUrl) return;
  await harness?.close();
  if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
});

async function store(name, bytes) {
  const account = { id: `agency-${suffix}` };
  return files.upload({ account, eventId, commandId: crypto.randomUUID(), name, contentType: 'image/png', bytes });
}

test('a marked file stops being served and loses its bytes on the purge run', async () => {
  const { file } = await store('삭제될 사진.jpg', floorplanPng());
  const storageKey = (await harness.database.query('SELECT storage_key FROM stored_files WHERE id = $1', [file.fileId])).rows[0].storage_key;
  assert.ok(fs.existsSync(path.join(storageDir, storageKey)), 'the bytes exist before deletion');

  // A participant deletion marks the row inside its transaction.
  await harness.database.query('UPDATE stored_files SET deleted_at = now() WHERE id = $1', [file.fileId]);
  await assert.rejects(
    () => files.readOperator({ account: { id: `agency-${suffix}` }, eventId, fileId: file.fileId }),
    (error) => error.status === 404,
    'a marked file is never served again'
  );

  const first = await files.purgeDeletedFiles({ write: () => {} });
  assert.ok(first.purged >= 1);
  assert.equal(fs.existsSync(path.join(storageDir, storageKey)), false, 'the bytes are gone');
  const row = (await harness.database.query('SELECT deleted_at, bytes_purged_at FROM stored_files WHERE id = $1', [file.fileId])).rows[0];
  assert.ok(row.deleted_at && row.bytes_purged_at, 'both timestamps are recorded');

  // Idempotent: a second run has nothing left to do and does not fail.
  const second = await files.purgeDeletedFiles({ write: () => {} });
  assert.equal(second.purged, 0);
});

test('a file whose bytes are already missing is still finished, not retried', async () => {
  const { file } = await store('이미 사라진 사진.jpg', floorplanPng());
  const storageKey = (await harness.database.query('SELECT storage_key FROM stored_files WHERE id = $1', [file.fileId])).rows[0].storage_key;
  await harness.database.query('UPDATE stored_files SET deleted_at = now() WHERE id = $1', [file.fileId]);
  fs.rmSync(path.join(storageDir, storageKey));
  const lines = [];
  const result = await files.purgeDeletedFiles({ write: (line) => lines.push(line) });
  assert.ok(result.purged >= 1, 'ENOENT is the outcome the purge wanted');
  assert.deepEqual(lines, [], 'nothing is reported as failed');
  assert.ok((await harness.database.query('SELECT bytes_purged_at FROM stored_files WHERE id = $1', [file.fileId])).rows[0].bytes_purged_at);
});

test('a live file is neither marked nor touched by the purge run', async () => {
  const { file } = await store('남아 있을 사진.jpg', floorplanPng());
  const storageKey = (await harness.database.query('SELECT storage_key FROM stored_files WHERE id = $1', [file.fileId])).rows[0].storage_key;
  await files.purgeDeletedFiles({ write: () => {} });
  assert.ok(fs.existsSync(path.join(storageDir, storageKey)), 'an undeleted file keeps its bytes');
  const served = await files.readOperator({ account: { id: `agency-${suffix}` }, eventId, fileId: file.fileId });
  assert.equal(served.fileId, file.fileId);
});
