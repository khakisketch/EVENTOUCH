'use strict';

// checkin_records contract: the table is a write-through projection of
// workspace.checks kept in the same transaction, and the 005 migration
// backfills pre-existing history. workspace.checks stays the read authority.

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
  insertEvent,
  insertMembership,
  insertAssignment,
  sessionCookie,
  requestJson,
} = require('./helpers/postgres-api-server.cjs');
const { createDatabase } = require('../server/db');
const { runMigrations } = require('../server/migrate');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const accountIds = { manager: `records-manager-${suffix}`, staff: `records-staff-${suffix}` };
let harness;
let cookies = {};
let fixtureNumber = 0;

function commandId() {
  return `records-${crypto.randomUUID()}`;
}

function makeParticipant(eventId, name) {
  return {
    id: `person-${crypto.randomUUID()}`,
    name,
    phone: `010${String(crypto.randomInt(10000000, 99999999))}`,
    email: '', company: '', group: '일반', status: 'APPROVED',
    inside: false, everIn: false, revoked: false,
    ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
    ticketExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
    paymentStatus: 'FREE', answers: {}, consent: null,
    createdAt: new Date().toISOString(),
  };
}

async function createFixture({ stage = 'LIVE', participants = [] } = {}) {
  fixtureNumber += 1;
  const id = `records-${fixtureNumber}-${suffix}`;
  const slug = `records-${fixtureNumber}-${suffix}`;
  const deskIn = `desk-in-${fixtureNumber}-${suffix}`;
  const deskOut = `desk-out-${fixtureNumber}-${suffix}`;
  await insertEvent(harness.database, {
    id,
    slug,
    payload: {
      id, slug, name: '기록 검증 행사', date: '2026-12-01',
      start: '09:00', end: '17:00', capacity: 100, stage, features: [],
    },
    workspace: {
      participants,
      desks: [
        { id: deskIn, name: '입장 데스크', action: 'IN', mode: 'desk', open: true },
        { id: deskOut, name: '퇴장 데스크', action: 'OUT', mode: 'tablet', open: true },
      ],
      booths: [], assignments: [], checks: [], visits: [], audit: [],
    },
  });
  await insertMembership(harness.database, accountIds.manager, id, ['all']);
  const assignmentId = `assignment-${crypto.randomUUID()}`;
  await insertAssignment(harness.database, {
    id: assignmentId, accountId: accountIds.staff, eventId: id, type: 'DESK', targetId: deskIn,
  });
  const saved = await readWorkspace(id);
  saved.assignments.push({ id: assignmentId, accountId: accountIds.staff, type: 'DESK', targetId: deskIn });
  await writeWorkspace(id, saved);
  return { id, slug, deskIn, deskOut, assignmentId };
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

async function readRecords(eventId) {
  const result = await harness.database.query(
    `SELECT id, event_id, participant_id, name, action, desk_id, actor_id,
            before_inside, before_ever_in, corrected
     FROM checkin_records WHERE event_id = $1 ORDER BY id`,
    [eventId]
  );
  return result.rows;
}

function scan(event, participant, { actor = 'staff', assignmentId = event.assignmentId, deskId, id = commandId() } = {}) {
  return requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST',
    cookie: cookies[actor],
    body: {
      commandId: id, command: 'check.scan',
      assignmentId, payload: { deskId: deskId || event.deskIn, ticket: participant.ticket },
    },
  });
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['manager', 'MANAGER', '행사 매니저'],
    ['staff', 'STAFF', '현장 스태프'],
  ]) {
    await insertAccount(harness.database, {
      id: accountIds[key], role, name, email: `${accountIds[key]}@example.test`,
    });
    cookies[key] = await sessionCookie(harness, accountIds[key]);
  }
});

after(async () => {
  if (harness) await harness.close();
});

test('a-checkin-write-lands-identically-in-the-workspace-and-the-records-table', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '기록 대상');
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  await writeWorkspace(event.id, state);

  const checkId = commandId();
  const entered = await scan(event, person, { id: checkId });
  assert.equal(entered.status, 200, JSON.stringify(entered.json));

  const [check] = (await readWorkspace(event.id)).checks.filter((row) => row.id === checkId);
  const [record] = await readRecords(event.id);
  assert.ok(check, 'workspace holds the check');
  assert.ok(record, 'records table holds the check');
  assert.equal(record.id, check.id);
  assert.equal(record.event_id, event.id);
  assert.equal(record.participant_id, check.participantId);
  assert.equal(record.name, check.name);
  assert.equal(record.action, check.action);
  assert.equal(record.desk_id, check.deskId);
  assert.equal(record.actor_id, check.actor);
  assert.equal(record.before_inside, check.before.inside);
  assert.equal(record.before_ever_in, check.before.everIn);
  assert.equal(record.corrected, false);
});

test('a-correction-flags-the-record-without-duplicating-history', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '정정 대상');
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  await writeWorkspace(event.id, state);

  const checkId = commandId();
  assert.equal((await scan(event, person, { id: checkId })).status, 200);
  const corrected = await requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST',
    cookie: cookies.staff,
    body: {
      commandId: commandId(), command: 'check.correct',
      assignmentId: event.assignmentId, payload: { id: checkId, reason: '잘못 찍음' },
    },
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.json));

  const records = await readRecords(event.id);
  assert.equal(records.length, 1, 'a correction updates the row, it never appends one');
  assert.equal(records[0].corrected, true);
  const [check] = (await readWorkspace(event.id)).checks.filter((row) => row.id === checkId);
  assert.equal(check.corrected, true);
});

test('concurrent-scans-leave-exactly-one-record-row', async () => {
  const event = await createFixture();
  const person = makeParticipant(event.id, '동시 스캔 참가자');
  const state = await readWorkspace(event.id);
  state.participants.push(person);
  await writeWorkspace(event.id, state);

  const results = await Promise.all([
    scan(event, person, { id: commandId() }),
    scan(event, person, { id: commandId() }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await readRecords(event.id)).length, 1);
});

test('migration-005-backfills-checks-written-before-the-table-existed', async () => {
  const admin = createDatabase({ connectionString: databaseUrl });
  const schema = `records_upgrade_${suffix.replace(/-/g, '')}`;
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'records-upgrade-'));
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    const db = createDatabase({ connectionString: scopedUrl.toString() });
    try {
      for (const name of ['001_initial.sql', '002_stored-file-dimensions.sql', '003_login-throttle.sql', '004_message-outbox.sql']) {
        fs.copyFileSync(path.join(__dirname, '..', 'server', 'migrations', name), path.join(tmpd, name));
      }
      await runMigrations(db, tmpd);
      const eventId = `records-legacy-${suffix}`;
      await insertEvent(db, {
        id: eventId,
        slug: `records-legacy-${suffix}`,
        payload: { id: eventId },
        workspace: {
          participants: [{ id: 'p1', name: '이전 기록' }],
          checks: [
            {
              id: 'legacy-1', participantId: 'p1', name: '이전 기록', action: 'IN',
              deskId: 'desk-1', actor: 'actor-1', at: '2026-09-01T09:00:00.000Z',
              before: { inside: false, everIn: false }, corrected: false,
            },
            {
              id: 'legacy-2', participantId: 'p1', name: '이전 기록', action: 'OUT',
              deskId: 'desk-2', actor: 'actor-1', at: '2026-09-01T17:00:00.000Z',
              before: { inside: true, everIn: true }, corrected: true,
            },
          ],
        },
      });
      const applied = await runMigrations(db);
      assert.ok(applied.includes('005_checkin-records.sql'), `applied: ${applied.join(',')}`);

      const rows = await db.query(
        `SELECT id, event_id, participant_id, name, action, desk_id, actor_id,
                before_inside, before_ever_in, corrected
         FROM checkin_records ORDER BY id`
      );
      assert.deepEqual(rows.rows, [
        {
          id: 'legacy-1', event_id: eventId, participant_id: 'p1', name: '이전 기록',
          action: 'IN', desk_id: 'desk-1', actor_id: 'actor-1',
          before_inside: false, before_ever_in: false, corrected: false,
        },
        {
          id: 'legacy-2', event_id: eventId, participant_id: 'p1', name: '이전 기록',
          action: 'OUT', desk_id: 'desk-2', actor_id: 'actor-1',
          before_inside: true, before_ever_in: true, corrected: true,
        },
      ]);
    } finally {
      await db.close();
    }
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.close();
    fs.rmSync(tmpd, { recursive: true, force: true });
  }
});
