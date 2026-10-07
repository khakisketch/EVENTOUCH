// Historical JSON/ETKO API characterization. Replaced by the PostgreSQL v9
// server-api.test.cjs plus registration/operations/domain-command suites.
// Preserved as migration reference, not a current product acceptance suite.
// Non-runnable text reference: original relative imports intentionally remain
// unchanged so the historical body can be compared with its pre-migration revision.
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDatabase } = require('../server/db');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

const PORT = 18778;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'eventouch-auth-admin@example.test';
const databaseUrl = testDatabaseUrl();
const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
let child = null;
let dataDir = null;
let db = null;

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

let adminCookie = '';

before(async () => {
  if (!databaseUrl) return;
  db = createDatabase({ connectionString: databaseUrl });
  await db.migrate();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-api-'));
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DATABASE_URL: databaseUrl,
      ADMIN_EMAIL,
      ADMIN_PASSWORD: 'admin-test-pw',
    },
    stdio: 'ignore',
  });
  await waitForHealth();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: 'admin-test-pw' }),
  });
  const raw = res.headers.get('set-cookie') || '';
  const match = /etko_session=([^;]+)/.exec(raw);
  assert.ok(match, 'admin login must work');
  adminCookie = `etko_session=${match[1]}`;
});

after(async () => {
  if (child) child.kill();
  if (db) await db.close();
});

async function api(method, url, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (err) {}
  return { status: res.status, json };
}

test('api-events-list-seeded', async () => {
  const r = await api('GET', '/api/events', undefined, adminCookie);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.events) && r.json.events.length >= 1);
});

test('api-create-event-validates-fields', async () => {
  const bad = await api('POST', '/api/events', { name: '', date: '2026-02-30', venue: '' }, adminCookie);
  assert.equal(bad.status, 400);
  assert.match(bad.json.error || '', /[가-힣]/);
  const good = await api(
    'POST',
    '/api/events',
    { name: '신규행사', date: '2026-12-01', venue: 'B홀' },
    adminCookie
  );
  assert.equal(good.status, 201);
  assert.equal(good.json.event.status, 'PRE');
});

test('api-event-status-forward-only', async () => {
  const created = await api('POST', '/api/events', { name: '상태행사', date: '2026-12-02', venue: 'C홀' }, adminCookie);
  const id = created.json.event.id;
  const skip = await api('PATCH', `/api/events/${id}/status`, { status: 'END' }, adminCookie);
  assert.equal(skip.status, 400);
  assert.match(skip.json.error || '', /순서/);
  const live = await api('PATCH', `/api/events/${id}/status`, { status: 'LIVE' }, adminCookie);
  assert.equal(live.status, 200);
  assert.equal(live.json.event.status, 'LIVE');
});

test('api-unknown-event-fails-closed-korean', async () => {
  const r = await api('GET', '/api/events/evt-999', undefined, adminCookie);
  assert.equal(r.status, 404);
  assert.match(r.json.error || '', /찾을 수 없습니다/);
});

test('api-participant-duplicate-refused', async () => {
  const list = await api('GET', '/api/events/evt-1/participants', undefined, adminCookie);
  assert.equal(list.status, 200);
  assert.ok(list.json.participants.length >= 5);
  const dup = await api(
    'POST',
    '/api/events/evt-1/participants',
    { name: '김민준', phone: '', email: 'x@y.zz' },
    adminCookie
  );
  assert.ok([400, 409].includes(dup.status));
});

test('api-signup-capacity-refused', async () => {
  const created = await api('POST', '/api/events', { name: '정원행사', date: '2026-12-03', venue: 'D홀' }, adminCookie);
  const id = created.json.event.id;
  await api('PATCH', `/api/events/${id}`, { capacity: 1 }, adminCookie);
  await api('POST', `/api/events/${id}/signup`, { name: '첫손님', phone: '010-0000-0001' }, undefined);
  const full = await api('POST', `/api/events/${id}/signup`, { name: '둘째손님', phone: '010-0000-0002' }, undefined);
  assert.equal(full.status, 409);
  assert.match(full.json.error || '', /마감/);
});

test('api-checkin-scan-classifies', async () => {
  const badge = await api('POST', '/api/events/evt-1/checkin', { code: 'BADGE-1', direction: 'IN' }, adminCookie);
  assert.equal(badge.json.key, 'wrong-kind');
  const other = await api('POST', '/api/events/evt-1/checkin', { code: 'ABC-123', direction: 'IN' }, adminCookie);
  assert.equal(other.json.key, 'wrong-event');
  const missing = await api('POST', '/api/events/evt-1/checkin', { code: 'EVT-9999', direction: 'IN' }, adminCookie);
  assert.equal(missing.json.key, 'not-found');
  const ok = await api('POST', '/api/events/evt-1/checkin', { code: 'EVT-1001', direction: 'IN' }, adminCookie);
  assert.equal(ok.json.key, 'success');
  const dup = await api('POST', '/api/events/evt-1/checkin', { code: 'EVT-1001', direction: 'IN' }, adminCookie);
  assert.equal(dup.json.key, 'duplicate');
});

test('api-checkin-offline-queues-and-syncs', async () => {
  const created = await api('POST', '/api/events', { name: '동기화행사', date: '2026-12-04', venue: 'E홀' }, adminCookie);
  const id = created.json.event.id;
  const p = await api('POST', `/api/events/${id}/signup`, { name: '동기손님', phone: '010-0000-0003' }, undefined);
  const queued = await api('POST', `/api/events/${id}/checkin`, { code: p.json.participant.code, direction: 'IN', online: false }, adminCookie);
  assert.equal(queued.json.key, 'queued');
  const sync = await api('POST', `/api/events/${id}/sync`, {}, adminCookie);
  assert.ok(sync.json.applied >= 1);
  const again = await api('POST', `/api/events/${id}/checkin`, { code: p.json.participant.code, direction: 'IN' }, adminCookie);
  assert.equal(again.json.key, 'duplicate');
});

test('api-correction-needs-reason', async () => {
  const short = await api('POST', '/api/events/evt-1/corrections', { code: 'EVT-1003', reason: '짧' }, adminCookie);
  assert.equal(short.status, 400);
  const good = await api(
    'POST',
    '/api/events/evt-1/corrections',
    { code: 'EVT-1003', reason: '데스크 착오로 정정합니다' },
    adminCookie
  );
  assert.equal(good.status, 200);
});

test('api-booth-mode-locks-with-visits', async () => {
  const created = await api('POST', '/api/events', { name: '부스행사', date: '2026-12-05', venue: 'F홀' }, adminCookie);
  const id = created.json.event.id;
  const mode = await api('PUT', `/api/events/${id}/booth-mode`, { mode: 'STAFF' }, adminCookie);
  assert.equal(mode.json.mode, 'STAFF');
  await api('POST', `/api/events/${id}/booths`, { name: '체험부스', code: 'ET:BOOTH:X:b1' }, adminCookie);
  await api('POST', `/api/events/${id}/stamps`, { booth: 'b1', code: 'EVT-1001', eventId: 'evt-1' }, adminCookie).catch(() => null);
  const back = await api('PUT', `/api/events/${id}/booth-mode`, { mode: 'SELF' }, adminCookie);
  assert.ok([200, 409].includes(back.status));
});

test('api-poll-vote-once-while-open', async () => {
  const open = await api('PUT', '/api/events/evt-1/poll', { status: 'OPEN', options: ['A', 'B'] }, adminCookie);
  assert.equal(open.status, 200);
  const v1 = await api('POST', '/api/events/evt-1/poll/votes', { participantId: 'p1', option: 0 }, adminCookie);
  assert.equal(v1.status, 200);
  const v2 = await api('POST', '/api/events/evt-1/poll/votes', { participantId: 'p1', option: 1 }, adminCookie);
  assert.equal(v2.status, 409);
  await api('PUT', '/api/events/evt-1/poll', { status: 'CLOSED' }, adminCookie);
  const late = await api('POST', '/api/events/evt-1/poll/votes', { participantId: 'p2', option: 0 }, adminCookie);
  assert.equal(late.status, 409);
});

test('api-qna-approve-then-select', async () => {
  const asked = await api('POST', '/api/events/evt-1/qna', { participantId: 'p1', body: '질문입니다' }, adminCookie);
  assert.equal(asked.status, 201);
  const early = await api('POST', `/api/events/evt-1/qna/${asked.json.item.id}/select`, {}, adminCookie);
  assert.equal(early.status, 409);
  await api('POST', `/api/events/evt-1/qna/${asked.json.item.id}/approve`, { approved: true }, adminCookie);
  const sel = await api('POST', `/api/events/evt-1/qna/${asked.json.item.id}/select`, {}, adminCookie);
  assert.equal(sel.status, 200);
});

test('api-draw-resolve-and-confirm', async () => {
  const start = await api('POST', '/api/events/evt-1/draw', {}, adminCookie);
  assert.equal(start.status, 200);
  assert.ok(start.json.result && start.json.result.participantId);
  const confirm = await api('POST', '/api/events/evt-1/draw/confirm', {}, adminCookie);
  assert.equal(confirm.status, 200);
});

test('api-survey-once', async () => {
  const first = await api('POST', '/api/events/evt-1/survey', { participantId: 'p1', scores: [5] }, adminCookie);
  assert.ok([200, 201].includes(first.status));
  const second = await api('POST', '/api/events/evt-1/survey', { participantId: 'p1', scores: [4] }, adminCookie);
  assert.equal(second.status, 409);
});

test('api-content-saves-program-notice-venue', async () => {
  const prog = await api('POST', '/api/events/evt-1/program', { time: '10:00', title: '개회' }, adminCookie);
  assert.equal(prog.status, 201);
  const badProg = await api('POST', '/api/events/evt-1/program', { time: '10:00' }, adminCookie);
  assert.equal(badProg.status, 400);
  const notice = await api('POST', '/api/events/evt-1/notices', { title: '공지', body: '내용' }, adminCookie);
  assert.equal(notice.status, 201);
  const venue = await api('PUT', '/api/events/evt-1/venue', { name: 'A홀', address: '서울' }, adminCookie);
  assert.equal(venue.status, 200);
});

test('api-messages-simulation-only', async () => {
  const tpl = await api('POST', '/api/events/evt-1/templates', { name: '안내', body: '내용 {{이름}}' }, adminCookie);
  assert.equal(tpl.status, 201);
  const camp = await api(
    'POST',
    '/api/events/evt-1/campaigns',
    { title: '캠페인', content: '본문', channel: '알림톡' },
    adminCookie
  );
  assert.equal(camp.status, 201);
  const send = await api('POST', `/api/events/evt-1/campaigns/${camp.json.campaign.id}/send`, {}, adminCookie);
  assert.equal(send.json.delivery, 'SIMULATION_ONLY');
});

test('api-reports-snapshot-immutable', async () => {
  const created = await api(
    'POST',
    '/api/events/evt-1/reports',
    { title: '결과 보고서' },
    adminCookie
  );
  assert.equal(created.status, 201);
  assert.ok(created.json.report.metrics);
  const listed = await api('GET', '/api/events/evt-1/reports', undefined, adminCookie);
  assert.ok(listed.json.reports.length >= 1);
});

test('legacy-user-creation-requires-invitation-and-does-not-accept-retired-roles', async () => {
  const denied = await api('POST', '/api/events', { name: '차단', date: '2026-12-06', venue: 'G홀' }, 'etko_session=nope');
  assert.equal(denied.status, 401);
  const legacy = await api(
    'POST',
    '/api/users',
    { id: 'viewer1', name: '조회자', password: 'pw', role: 'VIEWER' },
    adminCookie
  );
  assert.equal(legacy.status, 410);
  assert.match(legacy.json.error || '', /초대/);
});

test('api-qna-ask-requires-session', async () => {
  const anon = await api('POST', '/api/events/evt-1/qna', { participantId: 'p1', body: '스팸?' }, undefined);
  assert.equal(anon.status, 401);
});

test('api-write-route-tampered-cookie-denied', async () => {
  const r = await api('POST', '/api/events', { name: '위조', date: '2026-12-08', venue: 'H홀' }, 'etko_session=forged');
  assert.equal(r.status, 401);
  assert.ok(!JSON.stringify(r.json).includes('admin'), 'denial must not enumerate users');
});

test('api-concurrent-checkins-keep-both', async () => {
  const created = await api('POST', '/api/events', { name: '동시행사', date: '2026-12-09', venue: 'I홀' }, adminCookie);
  const id = created.json.event.id;
  const a = await api('POST', `/api/events/${id}/signup`, { name: '동시A', phone: '010-1111-0001' }, undefined);
  const b = await api('POST', `/api/events/${id}/signup`, { name: '동시B', phone: '010-1111-0002' }, undefined);
  const [r1, r2] = await Promise.all([
    api('POST', `/api/events/${id}/checkin`, { code: a.json.participant.code, direction: 'IN' }, adminCookie),
    api('POST', `/api/events/${id}/checkin`, { code: b.json.participant.code, direction: 'IN' }, adminCookie),
  ]);
  assert.equal(r1.json.key, 'success');
  assert.equal(r2.json.key, 'success');
  const summary = await api('GET', `/api/events/${id}/summary`, undefined, adminCookie);
  assert.equal(summary.json.summary.inside, 2);
});

test('api-unknown-event-sweep', async () => {
  const paths = [
    ['GET', '/api/events/evt-999/participants'],
    ['POST', '/api/events/evt-999/checkin'],
    ['PUT', '/api/events/evt-999/poll'],
    ['POST', '/api/events/evt-999/qna'],
    ['GET', '/api/events/evt-999/reports'],
  ];
  for (const [method, url] of paths) {
    const r = await api(method, url, method === 'GET' ? undefined : {}, adminCookie);
    assert.equal(r.status, 404, url);
    assert.match(r.json.error || '', /찾을 수 없습니다/, url);
  }
});

test('api-patch-date-validates-calendar', async () => {
  const created = await api('POST', '/api/events', { name: '날짜행사', date: '2026-12-10', venue: 'J홀' }, adminCookie);
  const id = created.json.event.id;
  const bad = await api('PATCH', `/api/events/${id}`, { date: '2026-02-30' }, adminCookie);
  assert.equal(bad.status, 400);
});

test('api-patch-stores-recruitment-method', async () => {
  const created = await api('POST', '/api/events', { name: '모집행사', date: '2026-12-11', venue: 'K홀' }, adminCookie);
  const id = created.json.event.id;
  const bad = await api('PATCH', `/api/events/${id}`, { recruitment: 'nope' }, adminCookie);
  assert.equal(bad.status, 400);
  assert.match(bad.json.error || '', /모집 방식/);
  const good = await api('PATCH', `/api/events/${id}`, { recruitment: 'manual', approval: true, capacity: 80 }, adminCookie);
  assert.equal(good.status, 200);
  const fetched = await api('GET', `/api/events/${id}`, undefined, adminCookie);
  assert.equal(fetched.json.event.recruitment, 'manual');
  assert.equal(fetched.json.event.approval, true);
});

test('api-workspace-returns-slices', async () => {
  const r = await api('GET', '/api/events/evt-1/workspace', undefined, adminCookie);
  assert.equal(r.status, 200);
  assert.ok(r.json.workspace.participants.length >= 5);
});

test('manager-api-read-requires-an-active-event-membership', async () => {
  const { hashPassword } = require('../server/auth');
  const accountId = `manager-${crypto.randomUUID()}`;
  const email = `manager-${crypto.randomUUID()}@example.test`;
  const otherEventId = `evt-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO accounts (id, email, name, role, password_hash)
     VALUES ($1, $2, '행사 매니저', 'MANAGER', $3)`,
    [accountId, email, hashPassword('manager-test-password')]
  );
  await db.query(
    'INSERT INTO events (id, slug, payload) VALUES ($1, $2, $3::jsonb), ($4, $5, $6::jsonb) ON CONFLICT (id) DO NOTHING',
    ['evt-1', `api-${crypto.randomUUID()}`, '{}', otherEventId, `api-${crypto.randomUUID()}`, '{}']
  );
  const signedIn = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'manager-test-password' }),
  });
  assert.equal(signedIn.status, 200);
  const cookie = `etko_session=${/etko_session=([^;]+)/.exec(signedIn.headers.get('set-cookie') || '')[1]}`;

  const denied = await api('GET', '/api/events/evt-1', undefined, cookie);
  assert.equal(denied.status, 403);
  await db.query('INSERT INTO memberships (account_id, event_id) VALUES ($1, $2)', [accountId, 'evt-1']);
  const allowed = await api('GET', '/api/events/evt-1', undefined, cookie);
  assert.equal(allowed.status, 200);
  const otherEvent = await api('GET', `/api/events/${otherEventId}`, undefined, cookie);
  assert.equal(otherEvent.status, 403);
  await db.query('DELETE FROM memberships WHERE account_id = $1 AND event_id = $2', [accountId, 'evt-1']);
  const revoked = await api('GET', '/api/events/evt-1', undefined, cookie);
  assert.equal(revoked.status, 403);
});

test('staff-api-read-needs-the-exact-active-assignment-and-stops-after-revocation', async () => {
  const { hashPassword } = require('../server/auth');
  const accountId = `staff-${crypto.randomUUID()}`;
  const email = `staff-${crypto.randomUUID()}@example.test`;
  const assignmentId = `assignment-${crypto.randomUUID()}`;
  const wrongAssignmentId = `assignment-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO accounts (id, email, name, role, password_hash)
     VALUES ($1, $2, '현장 스태프', 'STAFF', $3)`,
    [accountId, email, hashPassword('staff-test-password')]
  );
  await db.query(
    `INSERT INTO staff_assignments (id, account_id, event_id, type, target_id)
     VALUES ($1, $2, 'evt-1', 'DESK', 'desk-1'), ($3, $2, 'evt-1', 'BOOTH', 'booth-1')`,
    [assignmentId, accountId, wrongAssignmentId]
  );
  const signedIn = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'staff-test-password' }),
  });
  assert.equal(signedIn.status, 200);
  const cookie = `etko_session=${/etko_session=([^;]+)/.exec(signedIn.headers.get('set-cookie') || '')[1]}`;
  const exact = await api('GET', `/api/events/evt-1/participants?assignmentId=${assignmentId}`, undefined, cookie);
  assert.equal(exact.status, 200);
  const wrongTarget = await api('GET', `/api/events/evt-1/participants?assignmentId=${wrongAssignmentId}`, undefined, cookie);
  assert.equal(wrongTarget.status, 403);
  await db.query('UPDATE staff_assignments SET active = false WHERE id = $1', [assignmentId]);
  const revoked = await api('GET', `/api/events/evt-1/participants?assignmentId=${assignmentId}`, undefined, cookie);
  assert.equal(revoked.status, 403);
});

test('staff-booth-assignment-cannot-authorize-a-different-booth-target', async () => {
  const { hashPassword } = require('../server/auth');
  const email = `booth-staff-${crypto.randomUUID()}@example.test`;
  const accountId = `staff-${crypto.randomUUID()}`;
  const assignmentId = `assignment-${crypto.randomUUID()}`;
  const created = await api(
    'POST',
    '/api/events',
    { name: '배정 대상 확인 행사', date: '2026-12-12', venue: 'L홀' },
    adminCookie
  );
  assert.equal(created.status, 201);
  const eventId = created.json.event.id;
  await db.query(
    'INSERT INTO events (id, slug, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING',
    [eventId, `booth-auth-${crypto.randomUUID()}`, '{}']
  );

  const assignedBooth = await api(
    'POST',
    `/api/events/${eventId}/booths`,
    { name: '배정 부스', code: 'ASSIGNED' },
    adminCookie
  );
  const differentBooth = await api(
    'POST',
    `/api/events/${eventId}/booths`,
    { name: '다른 부스', code: 'OTHER' },
    adminCookie
  );
  assert.equal(assignedBooth.status, 201);
  assert.equal(differentBooth.status, 201);
  const signup = await api(
    'POST',
    `/api/events/${eventId}/signup`,
    { name: '테스트 참가자', phone: '010-0000-0099' }
  );
  assert.equal(signup.status, 201);

  await db.query(
    `INSERT INTO accounts (id, email, name, role, password_hash)
     VALUES ($1, $2, '부스 스태프', 'STAFF', $3)`,
    [accountId, email, hashPassword('booth-staff-test-password')]
  );
  await db.query(
    `INSERT INTO staff_assignments (id, account_id, event_id, type, target_id)
     VALUES ($1, $2, $3, 'BOOTH', $4)`,
    [assignmentId, accountId, eventId, assignedBooth.json.booth.id]
  );
  const signedIn = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'booth-staff-test-password' }),
  });
  assert.equal(signedIn.status, 200);
  const cookie = `etko_session=${/etko_session=([^;]+)/.exec(signedIn.headers.get('set-cookie') || '')[1]}`;

  const attempted = await api(
    'POST',
    `/api/events/${eventId}/stamps`,
    {
      booth: differentBooth.json.booth.id,
      code: signup.json.participant.code,
      assignmentId,
    },
    cookie
  );
  assert.equal(attempted.status, 403);
  assert.match(attempted.json.error || '', /권한/);

  const assignedTarget = await api(
    'POST',
    `/api/events/${eventId}/stamps`,
    {
      booth: assignedBooth.json.booth.id,
      code: signup.json.participant.code,
      assignmentId,
    },
    cookie
  );
  assert.equal(assignedTarget.status, 201);
});

nodeTest('file-upload-does-not-overwrite-a-checkin-committed-while-authentication-is-pending', async () => {
  const { createHttpServer } = require('../server/server');
  const { openStore } = require('../server/store');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-api-race-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-storage-race-'));
  const previousStorageDir = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storageDir;

  let releaseUploadAuth;
  let signalUploadAuth;
  const uploadAuthStarted = new Promise((resolve) => { signalUploadAuth = resolve; });
  const auth = {
    async sessionFromCookie(cookie) {
      if (cookie === 'etko_session=slow') {
        signalUploadAuth();
        await new Promise((resolve) => { releaseUploadAuth = resolve; });
      }
      return { id: 'test-agency', role: 'AGENCY' };
    },
  };
  const access = { async authorize() { return true; } };
  const server = createHttpServer(openStore(dataDir), auth, access);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const uploadPromise = fetch(`${base}/api/events/evt-1/files?name=sample.pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', cookie: 'etko_session=slow' },
      body: Buffer.from('sample pdf'),
    });
    await uploadAuthStarted;

    const checkin = await fetch(`${base}/api/events/evt-1/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'etko_session=fast' },
      body: JSON.stringify({ code: 'EVT-1001', direction: 'IN' }),
    });
    assert.equal(checkin.status, 200);
    assert.equal((await checkin.json()).key, 'success');

    releaseUploadAuth();
    const uploaded = await uploadPromise;
    assert.equal(uploaded.status, 201);

    const summaryResponse = await fetch(`${base}/api/events/evt-1/summary`, {
      headers: { cookie: 'etko_session=fast' },
    });
    const summary = await summaryResponse.json();
    assert.equal(summary.summary.inside, 3, 'the check-in committed before upload must remain visible');

    const eventStorageDir = path.join(storageDir, 'evt-1');
    const filesBeforeSecondUpload = fs.readdirSync(eventStorageDir).length;
    const http = require('node:http');
    const uploadRequest = http.request(`${base}/api/events/evt-1/files?name=second.pdf`, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'content-length': '10',
        cookie: 'etko_session=fast',
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolveUpload(response.statusCode));
    });
    let resolveUpload;
    const secondUploadPromise = new Promise((resolve, reject) => {
      resolveUpload = resolve;
      uploadRequest.on('error', reject);
    });
    uploadRequest.write('sample');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && fs.readdirSync(eventStorageDir).length <= filesBeforeSecondUpload) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.readdirSync(eventStorageDir).length > filesBeforeSecondUpload, 'upload stream reached storage');

    const secondCheckin = await fetch(`${base}/api/events/evt-1/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'etko_session=fast' },
      body: JSON.stringify({ code: 'EVT-1002', direction: 'IN' }),
    });
    assert.equal(secondCheckin.status, 200);
    assert.equal((await secondCheckin.json()).key, 'success');
    uploadRequest.end(' pdf');
    assert.equal(await secondUploadPromise, 201);

    const workspaceResponse = await fetch(`${base}/api/events/evt-1/workspace`, {
      headers: { cookie: 'etko_session=fast' },
    });
    const workspace = await workspaceResponse.json();
    assert.equal(workspace.workspace.files.length, 2);
    const finalSummaryResponse = await fetch(`${base}/api/events/evt-1/summary`, {
      headers: { cookie: 'etko_session=fast' },
    });
    const finalSummary = await finalSummaryResponse.json();
    assert.equal(finalSummary.summary.inside, 4, 'the check-in during upload must remain visible');
  } finally {
    if (releaseUploadAuth) releaseUploadAuth();
    await new Promise((resolve) => server.close(resolve));
    if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorageDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
