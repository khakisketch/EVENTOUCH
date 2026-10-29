'use strict';

// Ticket projection parity: the tickets table is a write-through projection
// of workspace participants kept in the same transaction, and the hash
// backfill script fills exactly the rows live writes could not hash.
// Workspace participants stay the read authority; these tests are the
// documented precondition for any future read-switch to the table.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  sessionCookie,
  requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { fillTicketHashes } = require('../scripts/backfill-ticket-hashes.cjs');
const { hashTicket } = require('../server/commands/shared.ts');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const managerId = `ticket-proj-manager-${suffix}`;
const eventId = `ticket-proj-event-${suffix}`;
let harness;
let cookie;

function commandId() {
  return `ticket-proj-${crypto.randomUUID()}`;
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {orgId: LEGACY_ORG,
    id: managerId,
    role: 'AGENCY',
    name: 'Ticket Projection',
    email: `ticket-proj-${suffix}@example.test`,
  });
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: eventId,
    slug: `ticket-proj-${suffix}`,
    payload: { id: eventId, slug: `ticket-proj-${suffix}`, name: '티켓 투영 검증', stage: 'LIVE', features: [] },
    workspace: { participants: [] },
  });
  await insertMembership(harness.database, managerId, eventId, ['all']);
  cookie = await sessionCookie(harness, managerId);
});

after(async () => {
  if (harness) await harness.close();
});

async function createParticipant(name, phone) {
  const response = await requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: commandId(), command: 'participant.create', payload: { name, phone } },
  });
  assert.equal(response.status, 201);
  return response.json.participant;
}

async function readWorkspace() {
  const result = await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]);
  return result.rows[0].payload;
}

async function readTickets() {
  const result = await harness.database.query(
    'SELECT participant_id, event_id, ticket_hash, revoked, expires_at FROM tickets WHERE event_id = $1 ORDER BY participant_id',
    [eventId]
  );
  return result.rows;
}

test('live writes keep the ticket projection in step with the workspace', async () => {
  const first = await createParticipant('투영일', '01011112222');
  const second = await createParticipant('투영이', '01033334444');

  const cancelled = await requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: commandId(), command: 'participant.status', payload: { id: second.id, status: 'CANCELLED' } },
  });
  assert.equal(cancelled.status, 200);

  const workspace = await readWorkspace();
  const tickets = await readTickets();
  assert.equal(tickets.length, 2, 'one row per participant, including the cancelled one');

  for (const row of tickets) {
    const person = workspace.participants.find((item) => item.id === row.participant_id);
    assert.ok(person, `projection row resolves to a workspace participant (${row.participant_id})`);
    assert.equal(row.event_id, eventId);
    assert.equal(row.ticket_hash, hashTicket(person.ticket), 'hash matches the live ticket');
    assert.equal(row.revoked, person.status === 'CANCELLED');
  }
  const live = tickets.find((row) => row.participant_id === first.id);
  assert.ok(live.expires_at, 'expiry is projected for live tickets');
});

test('the hash backfill fills exactly the unhashed rows and reports the rest', async () => {
  const person = await createParticipant('투영삼', '01055556666');

  await harness.database.query('UPDATE tickets SET ticket_hash = NULL WHERE participant_id = $1', [person.id]);
  const dry = await fillTicketHashes(harness.database, { dryRun: true });
  assert.equal(dry.pending, 1);
  assert.equal(dry.filled, 1);
  assert.deepEqual(dry.missing, []);
  const stillNull = await harness.database.query('SELECT ticket_hash FROM tickets WHERE participant_id = $1', [person.id]);
  assert.equal(stillNull.rows[0].ticket_hash, null, 'dry runs change nothing');

  const filled = await fillTicketHashes(harness.database, { dryRun: false });
  assert.equal(filled.filled, 1);
  const row = await harness.database.query('SELECT ticket_hash FROM tickets WHERE participant_id = $1', [person.id]);
  const workspace = await readWorkspace();
  const live = workspace.participants.find((item) => item.id === person.id);
  assert.equal(row.rows[0].ticket_hash, hashTicket(live.ticket));

  await harness.database.query(
    'INSERT INTO tickets (participant_id, event_id, revoked) VALUES ($1, $2, false)',
    [`ticket-ghost-${suffix}`, eventId]
  );
  const ghost = await fillTicketHashes(harness.database, { dryRun: false });
  assert.deepEqual(ghost.missing, [`ticket-ghost-${suffix}`]);
  await harness.database.query('DELETE FROM tickets WHERE participant_id = $1', [`ticket-ghost-${suffix}`]);
});
