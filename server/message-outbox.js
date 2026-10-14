'use strict';

// Transactional outbox for message dispatch intent.
//
// The gap this closes: a campaign reaches SENDING in the command
// transaction, and the provider call happens after commit. If the process
// dies in between, the campaign used to sit in SENDING forever with no
// record that a send was still owed. Now the intent is queued in the SAME
// transaction (message_outbox row), so crash recovery is just replaying
// queued rows. A row is settled (deleted) once the outcome lands in the
// workspace; the table only ever holds work that still needs doing.
//
// Requires ../commands/content-results lazily inside drainMessageOutbox:
// content-results already requires this module for the in-transaction hook,
// so a top-level require back would observe a half-initialised module.

const { dispatchCampaign } = require('./messaging');

const DRAIN_LIMIT = 20;

function providerConnected(provider) {
  if (!provider) return false;
  if (provider.state && provider.state.connected === false) return false;
  return true;
}

async function recordDispatchRequest(client, eventId, messageId) {
  await client.query(
    `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'PENDING', 0, now())
     ON CONFLICT (message_id) DO UPDATE
     SET event_id = EXCLUDED.event_id, status = 'PENDING', updated_at = now()`
    , [String(messageId), String(eventId)]
  );
}

async function cancelDispatchRequest(client, messageId) {
  await client.query('DELETE FROM message_outbox WHERE message_id = $1', [String(messageId)]);
}

async function settleDispatch(database, messageId) {
  await database.query('DELETE FROM message_outbox WHERE message_id = $1', [String(messageId)]);
}

function backoffInterval(attempts) {
  const step = Math.min(Math.max(Number(attempts) || 1, 1), 12);
  return `${step * 5} minutes`;
}

// Replays queued dispatch intents. Safe to run at boot and after restarts:
// rows whose campaign already reached an outcome are settled without
// re-sending, and only campaigns still SENDING are dispatched again.
async function drainMessageOutbox(database, provider, { now = new Date().toISOString(), limit = DRAIN_LIMIT } = {}) {
  if (!providerConnected(provider)) return { skipped: true, reason: 'NOT_CONNECTED' };
  // Lazy require: see the module header for why this cannot live at the top.
  const { buildMessageDispatch } = require('./commands/content-results');

  const claimed = await database.transaction(async (client) => {
    const rows = await client.query(
      `UPDATE message_outbox
       SET status = 'SENDING', attempts = attempts + 1, updated_at = now(),
           next_attempt_at = now() + (LEAST(attempts + 1, 12) * interval '5 minutes')
       WHERE message_id IN (
         SELECT message_id FROM message_outbox
         WHERE status IN ('PENDING', 'SENDING') AND next_attempt_at <= now()
         ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING message_id, event_id`,
      [Math.max(1, Math.min(Number(limit) || DRAIN_LIMIT, 100))]
    );
    return rows.rows;
  });

  let dispatched = 0;
  let settled = 0;
  for (const row of claimed) {
    try {
      const outcome = await database.transaction(async (client) => {
        const locked = await client.query(
          `SELECT e.id, e.slug, e.client_id, e.payload, e.revision,
                  w.payload AS workspace_payload, w.revision AS workspace_revision
           FROM events e JOIN event_workspaces w ON w.event_id = e.id
           WHERE e.id = $1 FOR UPDATE OF e, w`,
          [String(row.event_id)]
        );
        if (!locked.rows[0]) return { action: 'settle' };
        const { normalizeEvent, normalizeWorkspace } = require('./state');
        const event = normalizeEvent(locked.rows[0]);
        const workspace = normalizeWorkspace(locked.rows[0].workspace_payload);
        const message = Array.isArray(workspace.messages)
          ? workspace.messages.find((item) => item && item.id === String(row.message_id))
          : null;
        // Outcome already recorded (sent, failed, cancelled, or the campaign
        // is gone): there is nothing to re-send, only the row to drop.
        if (!message || message.status !== 'SENDING') return { action: 'settle' };
        return { action: 'dispatch', event, workspace, message };
      });

      if (outcome.action === 'settle') {
        await settleDispatch(database, row.message_id);
        settled += 1;
        continue;
      }
      const dispatch = buildMessageDispatch(outcome.event, outcome.workspace, outcome.message);
      await dispatchCampaign(database, provider, { ...dispatch, now });
      await settleDispatch(database, row.message_id);
      dispatched += 1;
      settled += 1;
    } catch (error) {
      // The claim already pushed next_attempt_at into the future, so a
      // failing row backs off instead of spinning. It stays queued.
      process.stderr.write(`[eventouch] outbox drain failed for ${row.message_id}: ${error && error.message}\n`);
    }
  }

  return { dispatched, settled, claimed: claimed.length, at: now };
}

module.exports = {
  recordDispatchRequest,
  cancelDispatchRequest,
  settleDispatch,
  drainMessageOutbox,
};
