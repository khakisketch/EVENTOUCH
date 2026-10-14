'use strict';

// Fills tickets.ticket_hash for rows created by the 006 backfill (identity
// only) or by any write path that could not compute a hash.
//
// Why this is a script and not SQL: hashing needs sha256, and the migration
// deliberately does not assume a crypto extension in shared databases. The
// application hash is crypto.createHash('sha256') hex — the same value live
// writes store — so this script uses the same function instead of SQL.
//
//   DATABASE_URL=... node scripts/backfill-ticket-hashes.cjs            # fill
//   DATABASE_URL=... node scripts/backfill-ticket-hashes.cjs --dry-run  # count only
//
// Must run before any future read-switch that trusts tickets.ticket_hash.

const crypto = require('node:crypto');
const path = require('node:path');

function sha256hex(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function fillTicketHashes(database, { dryRun = false } = {}) {
  const pending = await database.query(
    `SELECT t.participant_id, t.event_id, w.payload AS workspace_payload
     FROM tickets t
     JOIN event_workspaces w ON w.event_id = t.event_id
     WHERE t.ticket_hash IS NULL`
  );
  let filled = 0;
  const missing = [];
  for (const row of pending.rows) {
    const workspace = typeof row.workspace_payload === 'string'
      ? JSON.parse(row.workspace_payload)
      : row.workspace_payload;
    const participants = Array.isArray(workspace && workspace.participants) ? workspace.participants : [];
    const person = participants.find((item) => item && String(item.id) === String(row.participant_id));
    if (!person || typeof person.ticket !== 'string' || !person.ticket) {
      // A ticket row whose participant no longer carries a ticket (cancelled
      // and cleared, or data manually changed). Report instead of guessing.
      missing.push(String(row.participant_id));
      continue;
    }
    if (dryRun) {
      filled += 1;
      continue;
    }
    await database.query(
      'UPDATE tickets SET ticket_hash = $2, updated_at = now() WHERE participant_id = $1 AND ticket_hash IS NULL',
      [String(row.participant_id), sha256hex(person.ticket)]
    );
    filled += 1;
  }
  return { pending: pending.rows.length, filled, missing };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { createDatabase } = require(path.join(__dirname, '..', 'server', 'db'));
  const database = createDatabase();
  try {
    const result = await fillTicketHashes(database, { dryRun });
    process.stdout.write(
      `[eventouch] ticket hash backfill${dryRun ? ' (dry run)' : ''}: ` +
      `pending=${result.pending} filled=${result.filled} missing_participant=${result.missing.length}\n`
    );
    for (const id of result.missing) process.stdout.write(`[eventouch] no live ticket for participant ${id}\n`);
  } finally {
    await database.close();
  }
}

module.exports = { fillTicketHashes, sha256hex };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[eventouch] ticket hash backfill failed: ${error && error.message}\n`);
    process.exitCode = 1;
  });
}
