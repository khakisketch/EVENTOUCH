'use strict';

// Evidence photos backend slice: operator-only domain commands
// (evidence.photo.add/move/remove) plus the two additive operator-only ZIP
// archives. Uses the shared DB fixture helpers; runs in the normal
// `npm test` serial suite (skips without EVENTOUCH_TEST_DATABASE_URL like
// every other PostgreSQL integration test).

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { unzipSync } = require('fflate');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  insertAssignment,
  sessionCookie,
  requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { floorplanPng } = require('./helpers/floorplan-image.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const SECTIONS = [
  'SPACE', 'STAGE', 'PARTICIPANT_BOOTH', 'ONSITE_DIRECTION',
  'PRE_SETUP', 'ARRIVAL_REGISTRATION', 'PROGRAM', 'AWARDS',
];

let harness;
let storageDir;
const cookie = {};

function commandId() {
  return `evidence-${crypto.randomUUID()}`;
}

function evidenceCommand(eventId, command, payload, { actor = 'manager', id = commandId() } = {}) {
  const options = { method: 'POST', body: { commandId: id, command, payload } };
  if (actor) options.cookie = cookie[actor];
  return requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, options);
}

async function addStoredFile(eventId, { type = 'image/jpeg', name = 'evidence.jpg', bytes, createdBy } = {}) {
  const content = bytes || Buffer.from(`evidence-bytes-${crypto.randomUUID()}`);
  const id = `file-${crypto.randomUUID()}`;
  await harness.database.query(
    `INSERT INTO stored_files (id, event_id, storage_key, original_name, content_type, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, eventId, id, name, type, content.length, createdBy === undefined ? 'evidence-manager' : createdBy]
  );
  fs.writeFileSync(path.join(storageDir, id), content);
  return { fileId: id, name, type, size: content.length, bytes: content };
}

async function readWorkspace(eventId) {
  const result = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]
  );
  return result.rows[0].payload;
}

async function writeWorkspace(eventId, workspace) {
  await harness.database.query(
    'UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [eventId, JSON.stringify(workspace)]
  );
}

async function fetchZip(url, actor) {
  const headers = {};
  if (actor) headers.cookie = actor;
  const res = await fetch(`${harness.baseUrl}${url}`, { headers });
  return {
    status: res.status,
    headers: res.headers,
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

async function uploadOperatorImage({ eventId = 'evidence-manager', actor = 'manager', id = commandId() } = {}) {
  const response = await fetch(
    `${harness.baseUrl}/api/events/${eventId}/files?name=${encodeURIComponent('현장증빙.png')}&commandId=${encodeURIComponent(id)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'image/png', cookie: cookie[actor] },
      body: floorplanPng(),
    }
  );
  return { status: response.status, json: await response.json() };
}

function zipEntries(bytes) {
  const raw = unzipSync(new Uint8Array(bytes));
  return Object.fromEntries(
    Object.entries(raw).map(([name, data]) => [name, Buffer.from(data)])
  );
}

before(async () => {
  if (!databaseUrl) return;
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-evidence-'));
  harness = await startApiHarness({ storageDir });
  for (const [key, role] of [
    ['agency', 'AGENCY'],
    ['manager', 'MANAGER'],
    ['outsider', 'MANAGER'],
    ['staff', 'STAFF'],
  ]) {
    const id = `evidence-${key}`;
    await insertAccount(harness.database, {orgId: LEGACY_ORG,  id, role, name: key, email: `${id}@example.test` });
    cookie[key] = await sessionCookie(harness, id);
  }
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: 'evidence-manager',
    slug: 'evidence-manager',
    payload: {
      id: 'evidence-manager', slug: 'evidence-a', name: '증빙 검증 행사',
      date: '2026-12-01', start: '09:00', end: '17:00', capacity: 100,
      stage: 'LIVE', features: ['photo'],
    },
    workspace: {},
  });
  // Public slug differs from the id on purpose: the public leak tests must
  // prove the slug path exposes nothing even when the event is LIVE.
  await harness.database.query('UPDATE events SET slug = $2 WHERE id = $1', ['evidence-manager', 'evidence-a']);
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: 'evidence-other',
    slug: 'evidence-other',
    payload: {
      id: 'evidence-other', slug: 'evidence-other', name: '다른 행사',
      date: '2026-12-01', start: '09:00', end: '17:00', capacity: 50,
      stage: 'LIVE', features: [],
    },
    workspace: {},
  });
  await insertMembership(harness.database, 'evidence-manager', 'evidence-manager', ['all']);
});

after(async () => {
  if (harness) await harness.close();
  if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
});

test('evidence add accepts all eight fixed sections and stays out of the attendee wall', async () => {
  await writeWorkspace('evidence-manager', {});
  for (const section of SECTIONS) {
    const file = await addStoredFile('evidence-manager');
    const added = await evidenceCommand('evidence-manager', 'evidence.photo.add', {
      section, image: { fileId: file.fileId },
    });
    assert.equal(added.status, 201, `${section}: ${JSON.stringify(added.json)}`);
    assert.equal(added.json.photo.section, section);
    assert.equal(added.json.photo.image.fileId, file.fileId);
    assert.match(added.json.photo.uploadedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(added.json.photo.uploadedBy, 'evidence-manager');
  }
  const workspace = await readWorkspace('evidence-manager');
  assert.equal(workspace.evidencePhotos.length, 8);
  assert.deepEqual(
    workspace.evidencePhotos.map((photo) => photo.section).sort(),
    [...SECTIONS].sort()
  );
  assert.deepEqual(workspace.photos || [], []);
});

test('operator file upload then evidence attach uses separate replay-safe receipts', async () => {
  await writeWorkspace('evidence-manager', {});
  const uploadId = commandId();
  const uploaded = await uploadOperatorImage({ id: uploadId });
  assert.equal(uploaded.status, 201);
  const replayedUpload = await uploadOperatorImage({ id: uploadId });
  assert.equal(replayedUpload.status, 200);
  assert.deepEqual(replayedUpload.json, uploaded.json);

  const image = uploaded.json.file;
  const attached = await evidenceCommand('evidence-manager', 'evidence.photo.add', {
    section: 'SPACE', image,
  });
  assert.equal(attached.status, 201);
  assert.equal(attached.json.photo.image.fileId, image.fileId);
  const stored = await harness.database.query(
    'SELECT created_by FROM stored_files WHERE id = $1', [image.fileId]
  );
  assert.equal(stored.rows[0].created_by, 'evidence-manager');
  assert.equal((await readWorkspace('evidence-manager')).evidencePhotos.length, 1);
});

test('evidence add rejects invalid section, type, size, cross-event and guest-uploaded refs', async () => {
  const image = await addStoredFile('evidence-manager');
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.add', { section: 'LOBBY', image })).status,
    400
  );
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.add', { image })).status,
    400
  );
  const pdf = await addStoredFile('evidence-manager', {
    type: 'application/pdf', name: 'doc.pdf', bytes: Buffer.from('%PDF-1.4 tiny'),
  });
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.add', { section: 'SPACE', image: pdf })).status,
    400
  );
  const hugeId = `file-${crypto.randomUUID()}`;
  await harness.database.query(
    `INSERT INTO stored_files (id, event_id, storage_key, original_name, content_type, size_bytes, created_by)
     VALUES ($1, 'evidence-manager', $2, 'huge.jpg', 'image/jpeg', $3, 'evidence-manager')`,
    [hugeId, hugeId, 9 * 1024 * 1024]
  );
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.add', {
      section: 'SPACE', image: { fileId: hugeId },
    })).status,
    400
  );
  const foreign = await addStoredFile('evidence-other');
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.add', {
      section: 'SPACE', image: { fileId: foreign.fileId },
    })).status,
    404
  );
  const guest = await addStoredFile('evidence-manager', { createdBy: null });
  const guestRow = await harness.database.query(
    'SELECT created_by FROM stored_files WHERE id = $1', [guest.fileId]
  );
  assert.equal(guestRow.rows[0].created_by, null);
  const rejected = await evidenceCommand('evidence-manager', 'evidence.photo.add', {
    section: 'SPACE', image: { fileId: guest.fileId },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.field, 'image');
});

test('duplicate evidence commandId replays one record', async () => {
  await writeWorkspace('evidence-manager', {});
  const image = await addStoredFile('evidence-manager');
  const id = commandId();
  const first = await evidenceCommand('evidence-manager', 'evidence.photo.add', {
    section: 'STAGE', image: { fileId: image.fileId },
  }, { id });
  assert.equal(first.status, 201);
  const replay = await evidenceCommand('evidence-manager', 'evidence.photo.add', {
    section: 'STAGE', image: { fileId: image.fileId },
  }, { id });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, first.json);
  assert.equal((await readWorkspace('evidence-manager')).evidencePhotos.length, 1);
});

test('evidence move corrects the section idempotently; remove drops metadata only', async () => {
  await writeWorkspace('evidence-manager', {});
  const image = await addStoredFile('evidence-manager');
  const added = await evidenceCommand('evidence-manager', 'evidence.photo.add', {
    section: 'SPACE', image: { fileId: image.fileId },
  });
  const recordId = added.json.photo.id;
  const moved = await evidenceCommand('evidence-manager', 'evidence.photo.move', {
    id: recordId, section: 'PROGRAM',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.photo.section, 'PROGRAM');
  assert.equal((await readWorkspace('evidence-manager')).evidencePhotos[0].section, 'PROGRAM');
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.move', { id: recordId, section: 'PROGRAM' })).status,
    200
  );
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.move', { id: recordId, section: 'LOBBY' })).status,
    400
  );
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.move', { id: 'missing-record', section: 'SPACE' })).status,
    404
  );
  const removeId = commandId();
  const removed = await evidenceCommand('evidence-manager', 'evidence.photo.remove', { id: recordId }, { id: removeId });
  assert.equal(removed.status, 200);
  assert.equal((await readWorkspace('evidence-manager')).evidencePhotos.length, 0);
  // Metadata only: the shared file bytes stay for other references.
  assert.equal(
    (await harness.database.query('SELECT 1 FROM stored_files WHERE id = $1', [image.fileId])).rowCount,
    1
  );
  const removeReplay = await evidenceCommand('evidence-manager', 'evidence.photo.remove', { id: recordId }, { id: removeId });
  assert.equal(removeReplay.status, 200);
  assert.deepEqual(removeReplay.json, removed.json);
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.remove', { id: recordId })).status,
    404
  );
});

test('only agency and event-member managers can write evidence', async () => {
  await writeWorkspace('evidence-manager', {});
  const asAgency = await evidenceCommand('evidence-manager', 'evidence.photo.add', {
    section: 'AWARDS', image: await addStoredFile('evidence-manager'),
  }, { actor: 'agency' });
  assert.equal(asAgency.status, 201);
  const outsiderFile = await addStoredFile('evidence-manager');
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.add', {
      section: 'AWARDS', image: outsiderFile,
    }, { actor: 'outsider' })).status,
    403
  );
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.add', {
      section: 'AWARDS', image: outsiderFile,
    }, { actor: 'staff' })).status,
    403
  );
  assert.equal(
    (await evidenceCommand('evidence-manager', 'evidence.photo.add', {
      section: 'AWARDS', image: outsiderFile,
    }, { actor: null })).status,
    401
  );
  assert.equal((await readWorkspace('evidence-manager')).evidencePhotos.length, 1);
});

test('attendee archive exports only approved wall photos with safe generated names', async () => {
  const approvedA = await addStoredFile('evidence-manager', { bytes: Buffer.from('approved-wall-a') });
  const approvedB = await addStoredFile('evidence-manager', {
    type: 'image/png', name: 'wall.png', bytes: Buffer.from('approved-wall-b'),
  });
  const pending = await addStoredFile('evidence-manager', { bytes: Buffer.from('pending-wall') });
  const hidden = await addStoredFile('evidence-manager', { bytes: Buffer.from('hidden-wall') });
  const evidenceFile = await addStoredFile('evidence-manager', { bytes: Buffer.from('evidence-bytes') });
  await writeWorkspace('evidence-manager', {
    photos: [
      {
        id: 'wall-approved-a', participantId: 'person-1', name: '김참가',
        image: approvedA, caption: '승인됨', status: 'APPROVED', at: '2026-12-01T10:00:00.000Z',
      },
      {
        id: 'wall-approved-b', participantId: 'person-2', name: '이참가',
        image: approvedB, caption: '승인됨', status: 'APPROVED', at: '2026-12-01T11:00:00.000Z',
      },
      {
        id: 'wall-pending', participantId: 'person-3', name: '박대기',
        image: pending, caption: '대기', status: 'PENDING', at: '2026-12-01T12:00:00.000Z',
      },
      {
        id: 'wall-hidden', participantId: 'person-4', name: '최숨김',
        image: hidden, caption: '숨김', status: 'HIDDEN', at: '2026-12-01T13:00:00.000Z',
      },
    ],
    evidencePhotos: [{
      id: 'evidence-record', section: 'SPACE', image: evidenceFile,
      uploadedAt: '2026-12-01T14:00:00.000Z', uploadedBy: 'evidence-manager',
    }],
  });
  const archive = await fetchZip('/api/events/evidence-manager/attendee-photos.zip', cookie.manager);
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  assert.match(archive.headers.get('content-disposition') || '', /attachment; filename="attendee-photos\.zip"/);
  assert.equal(archive.headers.get('cache-control'), 'no-store');
  const entries = zipEntries(archive.bytes);
  assert.deepEqual(Object.keys(entries).sort(), ['attendee-photo-0001.jpg', 'attendee-photo-0002.png']);
  assert.deepEqual(entries['attendee-photo-0001.jpg'], approvedA.bytes);
  assert.deepEqual(entries['attendee-photo-0002.png'], approvedB.bytes);
  for (const name of Object.keys(entries)) {
    assert.match(name, /^[a-z0-9-]+\.(jpg|png|webp)$/);
    assert.equal(name.includes('..') || name.includes('/'), false);
  }
  const payload = archive.bytes.toString('latin1');
  for (const leaked of ['김참가', '이참가', '박대기', 'person-1', 'wall-approved', 'evidence-bytes']) {
    assert.equal(payload.includes(leaked), false, `archive leaks ${leaked}`);
  }
});

test('evidence archive filters by exact section and rejects missing or invalid sections', async () => {
  const spaceA = await addStoredFile('evidence-manager', { bytes: Buffer.from('space-a') });
  const spaceB = await addStoredFile('evidence-manager', { bytes: Buffer.from('space-b') });
  const stage = await addStoredFile('evidence-manager', { bytes: Buffer.from('stage-only') });
  await writeWorkspace('evidence-manager', {
    photos: [],
    evidencePhotos: [
      { id: 'ev-space-a', section: 'SPACE', image: spaceA, uploadedAt: '2026-12-01T10:00:00.000Z', uploadedBy: 'x' },
      { id: 'ev-space-b', section: 'SPACE', image: spaceB, uploadedAt: '2026-12-01T11:00:00.000Z', uploadedBy: 'x' },
      { id: 'ev-stage', section: 'STAGE', image: stage, uploadedAt: '2026-12-01T12:00:00.000Z', uploadedBy: 'x' },
    ],
  });
  const space = await fetchZip('/api/events/evidence-manager/evidence-photos.zip?section=SPACE', cookie.manager);
  assert.equal(space.status, 200);
  assert.equal(space.headers.get('content-type'), 'application/zip');
  assert.match(space.headers.get('content-disposition') || '', /attachment; filename="evidence-photos-space\.zip"/);
  const spaceEntries = zipEntries(space.bytes);
  assert.deepEqual(Object.keys(spaceEntries).sort(), ['evidence-space-0001.jpg', 'evidence-space-0002.jpg']);
  assert.deepEqual(spaceEntries['evidence-space-0001.jpg'], spaceA.bytes);
  assert.deepEqual(spaceEntries['evidence-space-0002.jpg'], spaceB.bytes);
  const stageArchive = await fetchZip('/api/events/evidence-manager/evidence-photos.zip?section=STAGE', cookie.manager);
  assert.equal(stageArchive.status, 200);
  assert.deepEqual(Object.keys(zipEntries(stageArchive.bytes)), ['evidence-stage-0001.jpg']);
  assert.equal(
    (await fetchZip('/api/events/evidence-manager/evidence-photos.zip', cookie.manager)).status,
    400
  );
  assert.equal(
    (await fetchZip('/api/events/evidence-manager/evidence-photos.zip?section=LOBBY', cookie.manager)).status,
    400
  );
  assert.equal(
    (await fetchZip('/api/events/evidence-manager/evidence-photos.zip?section=space', cookie.manager)).status,
    400
  );
});

test('archives fail closed instead of silently omitting stale photo references', async () => {
  const existing = await addStoredFile('evidence-manager', { bytes: Buffer.from('available-photo') });
  const missingFileId = `file-${crypto.randomUUID()}`;
  await writeWorkspace('evidence-manager', {
    photos: [
      { id: 'wall-approved-existing', status: 'APPROVED', image: existing },
      { id: 'wall-approved-stale', status: 'APPROVED', image: { fileId: missingFileId } },
    ],
    evidencePhotos: [
      { id: 'evidence-existing', section: 'SPACE', image: existing },
      { id: 'evidence-stale', section: 'SPACE', image: { fileId: missingFileId } },
    ],
  });

  for (const url of [
    '/api/events/evidence-manager/attendee-photos.zip',
    '/api/events/evidence-manager/evidence-photos.zip?section=SPACE',
  ]) {
    const response = await fetchZip(url, cookie.manager);
    assert.equal(response.status, 409, `${url} should not return a partial ZIP`);
    assert.equal(response.headers.has('content-disposition'), false);
    const body = JSON.parse(response.bytes.toString('utf8'));
    assert.match(body.error, /사진 원본 일부를 찾을 수 없어 ZIP을 만들지 못했습니다/u);
  }
});

test('archives deny staff, outsiders, cross-event readers and missing events', async () => {
  await writeWorkspace('evidence-manager', { photos: [], evidencePhotos: [] });
  assert.equal((await fetchZip('/api/events/evidence-manager/attendee-photos.zip', cookie.agency)).status, 200);
  for (const [url, actor, want] of [
    ['/api/events/evidence-manager/attendee-photos.zip', cookie.staff, 403],
    ['/api/events/evidence-manager/evidence-photos.zip?section=SPACE', cookie.staff, 403],
    ['/api/events/evidence-manager/attendee-photos.zip', cookie.outsider, 403],
    ['/api/events/evidence-manager/evidence-photos.zip?section=SPACE', cookie.outsider, 403],
    ['/api/events/evidence-other/attendee-photos.zip', cookie.manager, 403],
    ['/api/events/evidence-other/evidence-photos.zip?section=SPACE', cookie.manager, 403],
    // Unknown ids answer exactly like invisible ones: membership probing
    // through error shapes is closed, so the manager sees 404 here.
    ['/api/events/missing-event/attendee-photos.zip', cookie.manager, 404],
  ]) {
    assert.equal((await fetchZip(url, actor)).status, want, `${url} as ${actor === cookie.manager ? 'manager' : 'other'}`);
  }
  assert.equal((await fetchZip('/api/events/evidence-manager/attendee-photos.zip', null)).status, 401);
  assert.equal((await fetchZip('/api/events/evidence-manager/evidence-photos.zip?section=SPACE', null)).status, 401);
});

test('public projection and public files never expose evidence', async () => {
  const evidenceFile = await addStoredFile('evidence-manager', { bytes: Buffer.from('never-public') });
  const wallFile = await addStoredFile('evidence-manager', { bytes: Buffer.from('public-wall') });
  await writeWorkspace('evidence-manager', {
    photos: [{
      id: 'wall-public', participantId: 'person-9', name: '공개 참가자',
      image: wallFile, caption: '공개', status: 'APPROVED', at: '2026-12-01T10:00:00.000Z',
    }],
    evidencePhotos: [{
      id: 'ev-awards', section: 'AWARDS', image: evidenceFile,
      uploadedAt: '2026-12-01T10:00:00.000Z', uploadedBy: 'evidence-manager',
    }],
  });
  const managerBootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookie.manager });
  assert.equal(managerBootstrap.status, 200);
  assert.equal(managerBootstrap.json.state.workspaces['evidence-manager'].evidencePhotos[0].id, 'ev-awards');
  const projected = await requestJson(harness.baseUrl, '/api/public/events/evidence-a');
  assert.equal(projected.status, 200);
  assert.equal(Object.hasOwn(projected.json.workspace, 'evidencePhotos'), false);
  assert.equal(projected.json.workspace.photos.length, 1);
  assert.equal(projected.json.workspace.photos[0].image.fileId, wallFile.fileId);
  assert.equal(
    (await requestJson(harness.baseUrl, `/api/public/events/evidence-a/files/${evidenceFile.fileId}`)).status,
    404
  );
  await insertAssignment(harness.database, {
    id: 'evidence-staff-assignment', accountId: 'evidence-staff',
    eventId: 'evidence-manager', type: 'DESK', targetId: 'evidence-desk',
  });
  const staffBootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookie.staff });
  assert.equal(staffBootstrap.status, 200);
  assert.equal(
    Object.hasOwn(staffBootstrap.json.state.workspaces['evidence-manager'], 'evidencePhotos'),
    false,
    'staff bootstrap must not expose private evidence-photo references'
  );
  const wall = await fetch(`${harness.baseUrl}/api/public/events/evidence-a/files/${wallFile.fileId}`);
  assert.equal(wall.status, 200);
});
