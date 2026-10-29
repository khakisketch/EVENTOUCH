'use strict';

// Opt-in message maintenance: periodic outbox replay, delivery resolution,
// and due-schedule auto-enqueue in one auditable pass.
//
// Default is OFF and inert: nothing here changes the product's manual
// reservation meaning or its live-send mode. Both the worker itself and the
// due-schedule auto-send are separately gated, so enabling the worker still
// never auto-sends unless the operator also opts into auto-send:
//
//   EVENTOUCH_MESSAGE_MAINTENANCE=1   run the worker at all (default: off)
//   EVENTOUCH_MESSAGE_AUTO_SEND_DUE=1 auto-enqueue due SCHEDULED campaigns
//                                    inside the worker (default: off)
//
// With only the first flag set, the worker drains the outbox and resolves
// deliveries but merely REPORTS due schedules (duePending) without touching
// them; the operator keeps sending those by hand exactly as before.
//
// Safety rules, all verified by tests/message-maintenance.test.cjs:
//
//  - A disconnected supplier means no progress at all: the worker returns
//    { skipped: true } before any read-for-write or state change.
//  - Auto-enqueue mirrors message.retry's pre-send guards (due time passed,
//    ticket-link origin present, lucky numbers preassigned). A campaign that
//    the operator's own retry would refuse is left SCHEDULED with a reason.
//  - Cancelled campaigns are never touched: only SCHEDULED rows observed
//    under the event row lock are transitioned.
//  - Sends still happen after commit only: enqueue flips state and queues
//    the outbox row in one transaction; the actual provider call happens in
//    the drain step (or a later one), never inside the event lock.
//  - Concurrent workers are safe: outbox claims use SKIP LOCKED, and a
//    second worker re-reading an event under its lock sees the first
//    worker's SENDING flip and skips. Enqueue is idempotent on top of that
//    (recordDispatchRequest upserts).
//  - Unknown supplier answers never send and never settle: drainMessageOutbox
//    keeps those rows queued on their backoff.
//
// Wiring (owned by main; this module only exports): call
// runMessageMaintenance(database, activeProvider(), { enabled, autoSendDue })
// from a scheduler. server/server.js, env, and docs stay untouched here.

const { drainMessageOutbox, recordDispatchRequest } = require('./message-outbox');
const { resolveDelivery } = require('./messaging');
// Pre-send guards are owned by the command path (server/commands/
// content-results.js): the worker reuses dueScheduleGuards verbatim so an
// automatic run can never accept a campaign the operator's own retry would
// refuse. No command, receipt, or permission flow is duplicated here.
const { dueScheduleGuards } = require('./commands/content-results');

const DEFAULT_BATCH_LIMIT = 50;

function flagOn(value) {
  return String(value == null ? '' : value).trim() === '1';
}

function maintenanceConfig(env = process.env) {
  const source = env || {};
  return {
    enabled: flagOn(source.EVENTOUCH_MESSAGE_MAINTENANCE),
    autoSendDue: flagOn(source.EVENTOUCH_MESSAGE_AUTO_SEND_DUE),
  };
}

function providerConnected(provider) {
  if (!provider) return false;
  if (provider.state && provider.state.connected === false) return false;
  return true;
}

// Candidate events holding at least one campaign in the given status.
// Time filtering happens in JS per event (Date.parse, same as the command
// path), so an odd stored value can never abort the whole scan.
// The worker enumerates candidate events without an org predicate (the same
// scan as before), but every state-changing step below re-checks the event's
// org under its row lock and skips non-legacy events: the deployment provider
// credentials are legacy-org bound and never auto-inherited. The per-event
// gate keeps this working with the same query shapes as before.
async function scanCandidateEvents(database, status, limit) {
  const result = await database.query(
    `SELECT e.id FROM events e JOIN event_workspaces w ON w.event_id = e.id
     WHERE jsonb_typeof(COALESCE(w.payload->'messages', '[]'::jsonb)) = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(w.payload->'messages', '[]'::jsonb)) m
         WHERE m->>'status' = $1
       )
     ORDER BY e.id LIMIT $2`,
    [String(status), Math.max(1, Math.min(Number(limit) || DEFAULT_BATCH_LIMIT, 500))]
  );
  return (result.rows || []).map((row) => String(row.id));
}

// Legacy-org gate for a locked event row. A NULL org_id only exists on
// hand-built fixtures predating 011 (migration backfills every real row);
// it is treated as legacy there so unit doubles keep their old behaviour,
// while every real database enforces the predicate.
function lockedEventOrgId(lockedRow) {
  const raw = lockedRow && lockedRow.org_id;
  if (raw === undefined || raw === null) return require('./tenancy').LEGACY_ORG_ID;
  return String(raw);
}

function foreignOrgSkipped(eventId, messageId, reason) {
  return { enqueued: 0, duePending: 0, skipped: [{ messageId, reason }] };
}

// Transitions due SCHEDULED campaigns to SENDING and queues their outbox
// rows, one event transaction at a time. Guards are shared with
// message.retry (dueScheduleGuards in server/commands/content-results.js),
// not mirrored.
async function enqueueDueScheduled(database, { now, limit, eventIds } = {}) {
  const candidates = Array.isArray(eventIds) && eventIds.length
    ? eventIds.map(String)
    : await scanCandidateEvents(database, 'SCHEDULED', limit);
  let enqueued = 0;
  let duePending = 0;
  const skippedDue = [];
  for (const eventId of candidates.slice(0, Math.max(1, Math.min(Number(limit) || DEFAULT_BATCH_LIMIT, 500)))) {
    const outcome = await database.transaction(async (client) => {
      const locked = await client.query(
        `SELECT e.id, e.org_id, e.payload AS event_payload,
                w.payload AS workspace_payload
         FROM events e JOIN event_workspaces w ON w.event_id = e.id
         WHERE e.id = $1 FOR UPDATE OF e`,
        [String(eventId)]
      );
      if (!locked.rows[0]) return { enqueued: 0, duePending: 0, skipped: [] };
      if (lockedEventOrgId(locked.rows[0]) !== String(require('./tenancy').LEGACY_ORG_ID)) {
        return { enqueued: 0, duePending: 0, skipped: [], foreignOrg: true, eventId: String(eventId) };
      }
      const raw = locked.rows[0].workspace_payload;
      const workspace = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!workspace || !Array.isArray(workspace.messages)) return { enqueued: 0, duePending: 0, skipped: [] };
      let made = 0;
      let pending = 0;
      const skipped = [];
      for (const message of workspace.messages) {
        if (!message || message.status !== 'SCHEDULED') continue;
        // Same guards as the operator's message.retry: a campaign the
        // operator could not send stays SCHEDULED with its reason. A future
        // schedule is simply not due yet: not counted, not reported.
        // (EVENTOUCH_PUBLIC_URL is the shared front origin for all orgs;
        // only the provider credentials are legacy-bound.)
        const guard = dueScheduleGuards(message, workspace, { now: Date.parse(now) });
        if (guard && guard.reason === 'NOT_DUE') continue;
        pending += 1;
        if (message.simulate === true) {
          skipped.push({ messageId: message.id, reason: 'SIMULATED' });
          continue;
        }
        if (guard) {
          skipped.push({ messageId: message.id, reason: guard.reason });
          continue;
        }
        message.attempts = (Number(message.attempts) || 0) + 1;
        message.status = 'SENDING';
        message.dispatchedAt = now;
        for (const delivery of (Array.isArray(message.deliveries) ? message.deliveries : [])) {
          delivery.status = 'SENDING';
          delivery.at = now;
        }
        if (!Array.isArray(workspace.audit)) workspace.audit = [];
        workspace.audit.unshift({
          id: `maintenance-${Date.parse(now) || Date.now()}`,
          type: 'message.retry',
          actor: 'maintenance',
          at: now,
          detail: String(message.title || ''),
          eventId: String(eventId),
          maintenance: true,
        });
        await recordDispatchRequest(client, eventId, message.id);
        made += 1;
      }
      if (!made) return { enqueued: 0, duePending: pending, skipped };
      await client.query(
        'UPDATE event_workspaces SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE event_id = $1',
        [String(eventId), JSON.stringify(workspace)]
      );
      return { enqueued: made, duePending: pending, skipped };
    });
    enqueued += outcome.enqueued;
    duePending += outcome.duePending;
    skippedDue.push(...outcome.skipped);
  }
  return { enqueued, duePending, skippedDue };
}

async function countDueScheduled(database, { now, limit, eventIds } = {}) {
  const candidates = Array.isArray(eventIds) && eventIds.length
    ? eventIds.map(String)
    : await scanCandidateEvents(database, 'SCHEDULED', limit);
  let duePending = 0;
  for (const eventId of candidates.slice(0, Math.max(1, Math.min(Number(limit) || DEFAULT_BATCH_LIMIT, 500)))) {
    const result = await database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [String(eventId)]);
    if (!result.rows[0]) continue;
    const raw = result.rows[0].payload;
    const workspace = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!workspace || !Array.isArray(workspace.messages)) continue;
    for (const message of workspace.messages) {
      if (!message || message.status !== 'SCHEDULED') continue;
      if (message.scheduled && Date.parse(message.scheduled) > Date.parse(now)) continue;
      duePending += 1;
    }
  }
  return duePending;
}

async function resolvePendingDeliveries(database, provider, { now, limit, eventIds } = {}) {
  const candidates = Array.isArray(eventIds) && eventIds.length
    ? eventIds.map(String)
    : await scanCandidateEvents(database, 'SENDING', limit);
  let resolved = 0;
  let pending = 0;
  let events = 0;
  for (const eventId of candidates.slice(0, Math.max(1, Math.min(Number(limit) || DEFAULT_BATCH_LIMIT, 500)))) {
    const outcome = await resolveDelivery(database, provider, eventId, { now });
    if (outcome && outcome.skipped) continue;
    resolved += Number(outcome.resolved) || 0;
    pending += Number(outcome.pending) || 0;
    events += 1;
  }
  return { resolved, pending, events };
}

async function runMessageMaintenance(database, provider, options = {}) {
  const config = maintenanceConfig(options.env);
  const enabled = options.enabled === undefined ? config.enabled : Boolean(options.enabled);
  if (!enabled) return { skipped: true, reason: 'DISABLED' };
  if (!providerConnected(provider)) return { skipped: true, reason: 'NOT_CONNECTED' };
  const now = options.now || new Date().toISOString();
  const limit = options.limit || DEFAULT_BATCH_LIMIT;
  const autoSendDue = options.autoSendDue === undefined ? config.autoSendDue : Boolean(options.autoSendDue);

  // Enqueue first so this same pass can drain what it just queued: the
  // enqueue commits before the drain reads, preserving commit-then-send.
  // With autoSendDue off this step is read-only reporting.
  let enqueued = 0;
  let duePending = 0;
  let skippedDue = [];
  if (autoSendDue) {
    const queued = await enqueueDueScheduled(database, { now, limit, eventIds: options.eventIds });
    enqueued = queued.enqueued;
    duePending = queued.duePending;
    skippedDue = queued.skippedDue;
  } else {
    duePending = await countDueScheduled(database, { now, limit, eventIds: options.eventIds });
  }

  const drain = await drainMessageOutbox(database, provider, { now, limit });
  const resolved = await resolvePendingDeliveries(database, provider, { now, limit, eventIds: options.eventIds });

  return { at: now, enabled: true, autoSendDue, enqueued, duePending, skippedDue, drain, resolved };
}

module.exports = {
  maintenanceConfig,
  runMessageMaintenance,
  enqueueDueScheduled,
  countDueScheduled,
  resolvePendingDeliveries,
};
