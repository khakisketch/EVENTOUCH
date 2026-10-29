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

// Restart-deduplication verdict for a supplier group read. Three states,
// never two:
//
//   EXISTS  the supplier demonstrably holds the group: the read succeeded
//           AND its listing actually names messages.
//   ABSENT  the supplier explicitly has no record under this id: the provider
//           answered { ok:false, reason:'NOT_FOUND' } or HTTP 404. Only this
//           verdict may re-send.
//   UNKNOWN anything else — including a succeeded but empty listing.
//           Emptiness means "not shown", never "held": the supplier's
//           unknown-group response shape is still unverified against a live
//           account (it may be 200-empty rather than 404), so settling on
//           empty would risk silently dropping a campaign the supplier never
//           saw. The row stays queued on its backoff and a later drain
//           retries. Guessing "held" would hide the send; guessing "absent"
//           would duplicate it.
//
// Absence therefore has exactly one admissible basis: an explicit not-found
// signal. A failed, unparseable, or empty lookup is never absence evidence,
// and never presence evidence either.
function classifyGroupLookup(result) {
  if (!result) return 'UNKNOWN';
  if (!result.ok) {
    if (result.reason === 'NOT_FOUND' || Number(result.status) === 404) return 'ABSENT';
    return 'UNKNOWN';
  }
  const messages = result.messages && typeof result.messages === 'object' ? result.messages : {};
  return Object.keys(messages).length ? 'EXISTS' : 'UNKNOWN';
}

async function safeGroupLookup(provider, groupId) {
  try {
    return classifyGroupLookup(await provider.groupMessages(String(groupId)));
  } catch (error) {
    return 'UNKNOWN';
  }
}

// Reads one claimed row's campaign state under a brief row lock. No network
// happens in here: the supplier consult (safeGroupLookup) always runs after
// this transaction has committed, so a slow or hanging provider can never
// hold the event lock. Returns null when there is nothing to re-send.
async function snapshotClaimedRow(database, eventId, messageId) {
  return database.transaction(async (client) => {
    const locked = await client.query(
      `SELECT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision,
              w.payload AS workspace_payload, w.revision AS workspace_revision
       FROM events e JOIN event_workspaces w ON w.event_id = e.id
       WHERE e.id = $1 FOR UPDATE OF e, w`,
      [String(eventId)]
    );
    if (!locked.rows[0]) return null;
    const { normalizeEvent, normalizeWorkspace } = require('./state');
    const event = normalizeEvent(locked.rows[0]);
    const workspace = normalizeWorkspace(locked.rows[0].workspace_payload);
    const message = Array.isArray(workspace.messages)
      ? workspace.messages.find((item) => item && item.id === String(messageId))
      : null;
    // Outcome already recorded (sent, failed, cancelled, or the campaign is
    // gone): there is nothing to re-send, only the row to drop.
    if (!message || message.status !== 'SENDING') return null;
    return { event, workspace, message };
  });
}
// Replays queued dispatch intents. Safe to run at boot and after restarts:
// rows whose campaign already reached an outcome are settled without
// re-sending, and only campaigns still SENDING are dispatched again.
//
// Restart-deduplication: a crash between supplier acceptance and the local
// settle leaves a SENDING campaign WITH a providerGroupId plus a queued row.
// Blindly re-sending that row would deliver the campaign twice, so the drain
// first asks the supplier whether it already holds the group
// (groupMessages). A group the supplier demonstrably holds (its listing
// names messages) settles the row without another send;
// the campaign itself stays SENDING for the on-demand resolver
// (resolveDelivery). Only an explicit not-found (or a campaign that never
// reached a supplier: no group id, or a provider without a status-query API)
// re-sends. An unknown lookup never sends and never settles: the row keeps
// the backoff the claim already set and a later drain retries.
//
// Locking discipline: the supplier consult runs outside every event-row lock.
// Each row is snapshotted under a brief lock, the network call runs with no
// lock held, and the decision re-checks the campaign under a fresh lock, so
// a concurrent retry, cancel, or second worker cannot slip a duplicate or a
// lost send between the consult and the write.
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
  let reconciled = 0;
  let deferred = 0;
  const { LEGACY_ORG_ID } = require('./tenancy');
  for (const row of claimed) {
    try {
      const snapshot = await snapshotClaimedRow(database, row.event_id, row.message_id);
      if (!snapshot) {
        await settleDispatch(database, row.message_id);
        settled += 1;
        continue;
      }
      // Provider credentials are legacy-org bound and never auto-inherited:
      // another org's campaign is never dispatched through them. The row
      // stays queued on the backoff the claim already wrote. A NULL org only
      // exists on hand-built doubles predating 011; it keeps the old path.
      const snapshotOrg = snapshot.event.orgId;
      if (snapshotOrg && String(snapshotOrg) !== String(LEGACY_ORG_ID)) {
        deferred += 1;
        continue;
      }
      const { message } = snapshot;

      // Supplier consult with no event lock held. Campaigns that never
      // reached a supplier (no group id, or a provider without a group
      // query) skip the consult and go straight to dispatch.
      let verdict = 'ABSENT';
      if (message.providerGroupId && provider && typeof provider.groupMessages === 'function') {
        verdict = await safeGroupLookup(provider, message.providerGroupId);
      }

      if (verdict === 'EXISTS') {
        // The campaign is still in flight AND the supplier's listing
        // demonstrably names this acceptance (crash between acceptance and
        // settle): re-sending would duplicate it, so reconcile instead of
        // dispatching. The campaign stays SENDING for the on-demand
        // delivery resolver.
        await settleDispatch(database, row.message_id);
        settled += 1;
        reconciled += 1;
        continue;
      }
      if (verdict === 'UNKNOWN') {
        // Says nothing about the supplier's state: keep the row queued on
        // the backoff the claim already wrote. A later drain retries; the
        // operator's manual retry path is unaffected.
        deferred += 1;
        continue;
      }
      // Re-check under a fresh lock: the supplier consult ran with no lock
      // held, so a cancel, retry, or second worker may have resolved the
      // campaign meanwhile. Dispatching from a stale snapshot could resend
      // a campaign the operator just cancelled.
      const fresh = await snapshotClaimedRow(database, row.event_id, row.message_id);
      if (!fresh) {
        await settleDispatch(database, row.message_id);
        settled += 1;
        continue;
      }
      const dispatch = buildMessageDispatch(fresh.event, fresh.workspace, fresh.message);
      await dispatchCampaign(database, provider, { ...dispatch, now });
      await settleDispatch(database, row.message_id);
      dispatched += 1;
      settled += 1;
    } catch (error) {
      // The claim already pushed next_attempt_at into the future, so a
      // failing row backs off instead of spinning. It stays queued.
      // (This also covers a dispatch builder that refuses to send, e.g. a
      // ticket-link campaign with no public origin configured: the intent is
      // kept for after the operator fixes the configuration.)
      deferred += 1;
      process.stderr.write(`[eventouch] outbox drain failed for ${row.message_id}: ${error && error.message}\n`);
    }
  }

  return { dispatched, settled, reconciled, deferred, claimed: claimed.length, at: now };
}

module.exports = {
  recordDispatchRequest,
  cancelDispatchRequest,
  settleDispatch,
  drainMessageOutbox,
  classifyGroupLookup,
};
