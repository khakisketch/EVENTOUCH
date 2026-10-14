'use strict';

// tickets contract: the table is a write-through projection of participant
// ticket identity kept in the same transaction, and the 006 migration
// backfills pre-existing tickets. workspace.participants stays the read
// authority.

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
  sessionCookie,
  requestJson,
} = require('./helpers/postgres-api-server.cjs');
const { createDatabase } = require('../server/db');
const { runMigrations } = require('../server/migrate');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const accountIds = { agency: `tickets-agency-${suffix}`, manager: `tickets-manager-${suffix}` };
let harness;
let cookies = {};
let fixtureNumber = 0;

function commandId() {
  return `tickets-${crypto.randomUUID()}`;
}

function sha256(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createFixture() {
  fixtureNumber += 1;
  const id = `tickets-${fixtureNumber}-${suffix}`;
  const slug = `tickets-${fixtureNumber}-${suffix}`;
  await insertEvent(harness.database, {
    id,
    slug,
    payload: {
      id, slug, name: '티켓 검증 행사', date: '2026-12-01',
      start: '09:00', end: '17:00', capacity: 100, stage: 'READY', features: [],
    },
    workspace: {
      participants: [],
      fields: [], publishedFields: [], formVersion: 1, publishedVersion: 1,
      registrationOpen: true, approvalRequired: false, consentText: '', consentVersion: 1,
      notices: [], program: [], venue: {}, groups: ['일반'],
      desks: [], booths: [], assignments: [], checks: [], visits: [],
      modules: [], responses: [], questions: [], photos: [], posts: [],
      messages: [], reports: [], payments: [], rewards: [], audit: [],
      display: { type: 'idle', moduleId: null }, branding: {},
      stampMode: 'STAFF', allowReentry: true, price: 0,
    },
  });
  await insertMembership(harness.database, accountIds.manager, id, ['all']);
  return { id, slug };
}

function operator(eventId, command, payload, { actor = 'agency', id = commandId() } = {}) {
  return requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie: cookies[actor],
    body: { commandId: id, command, payload },
  });
}

async function ticketRow(participantId) {
  const result = await harness.database.query(
    'SELECT participant_id, event_id, ticket_hash, revoked FROM tickets WHERE participant_id = $1',
    [participantId]
  );
  return result.rows[0] || null;
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '운영사 관리자'],
    ['manager', 'MANAGER', '행사 매니저'],
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

test('signup-indexes-the-issued-ticket-hash', async () => {
  const event = await createFixture();
  const phone = `010${String(crypto.randomInt(10000000, 99999999))}`;
  const signup = await requestJson(harness.baseUrl, `/api/events/${event.slug}/signup`, {
    method: 'POST',
    body: {
      commandId: commandId(), formVersion: 1,
      name: '티켓 대상', phone,
    },
  });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  const person = signup.json.participant;

  const row = await ticketRow(person.id);
  assert.ok(row, 'a tickets row is written in the signup transaction');
  assert.equal(row.event_id, event.id);
  assert.equal(row.ticket_hash, sha256(person.ticket));
  assert.equal(row.revoked, false);
});

test('reissue-rotates-the-indexed-hash-and-cancel-marks-revoked', async () => {
  const event = await createFixture();
  const phone = `010${String(crypto.randomInt(10000000, 99999999))}`;
  const signup = await requestJson(harness.baseUrl, `/api/events/${event.slug}/signup`, {
    method: 'POST',
    body: {
      commandId: commandId(), formVersion: 1,
      name: '재발급 대상', phone,
    },
  });
  const person = signup.json.participant;
  const before = await ticketRow(person.id);
  assert.equal(before.ticket_hash, sha256(person.ticket));

  const reissued = await operator(event.id, 'ticket.reissue', { id: person.id });
  assert.equal(reissued.status, 200, JSON.stringify(reissued.json));
  const after = await ticketRow(person.id);
  assert.notEqual(after.ticket_hash, before.ticket_hash);
  assert.equal(after.ticket_hash, sha256(reissued.json.participant.ticket));
  assert.equal(after.revoked, false);

  const cancelled = await operator(event.id, 'participant.status', { id: person.id, status: 'CANCELLED' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal((await ticketRow(person.id)).revoked, true);
});

test('migration-006-backfills-tickets-written-before-the-table-existed', async () => {
  const admin = createDatabase({ connectionString: databaseUrl });
  const schema = `tickets_upgrade_${suffix.replace(/-/g, '')}`;
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-upgrade-'));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    const db = createDatabase({ connectionString: scopedUrl.toString() });
    try {
      for (const name of ['001_initial.sql', '002_stored-file-dimensions.sql', '003_login-throttle.sql', '004_message-outbox.sql', '005_checkin-records.sql']) {
        fs.copyFileSync(path.join(__dirname, '..', 'server', 'migrations', name), path.join(tmpd, name));
      }
      await runMigrations(db, tmpd);
      const eventId = `tickets-legacy-${suffix}`;
      const oldTicket = `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`;
      await insertEvent(db, {
        id: eventId,
        slug: `tickets-legacy-${suffix}`,
        payload: { id: eventId },
        workspace: {
          participants: [
            {
              id: 'legacy-person', name: '이전 참가자', ticket: oldTicket,
              revoked: false, ticketExpiresAt: '2026-12-31T00:00:00.000Z', status: 'APPROVED',
            },
          ],
        },
      });
      const applied = await runMigrations(db);
      assert.ok(applied.includes('006_tickets.sql'), `applied: ${applied.join(',')}`);

      // Pre-006 rows carry identity; their hashes complete on first mutation
      // (SQL migrations assume no crypto extension in shared databases).
      const rows = await db.query(
        'SELECT participant_id, event_id, ticket_hash, revoked FROM tickets ORDER BY participant_id'
      );
      assert.deepEqual(rows.rows, [{
        participant_id: 'legacy-person',
        event_id: eventId,
        ticket_hash: null,
        revoked: false,
      }]);
    } finally {
      await db.close();
    }
  } finally {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.close();
    fs.rmSync(tmpd, { recursive: true, force: true });
  }
});
