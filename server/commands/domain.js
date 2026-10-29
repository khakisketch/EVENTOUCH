'use strict';

const { normalizeEvent, normalizeWorkspace } = require('../state');
const { managerWriteAllowed } = require('../event-permissions');
const {
  failure,
  object,
  clean,
  commandIdentifier,
  nextId,
  hashTicket,
  findTicket,
} = require('./shared.ts');
const preparation = require('./preparation');
const engagement = require('./engagement');
const contentResults = require('./content-results');
const boothMap = require('./booth-map');
const eventEvidence = require('./event-evidence');
const attendeeExperience = require('./attendee-experience');
const { createMessagingProvider, dispatchCampaign } = require('../messaging');
const { settleDispatch } = require('../message-outbox');

const COMMANDS = new Set([
  ...preparation.COMMANDS,
  ...engagement.COMMANDS,
  ...contentResults.COMMANDS,
  ...boothMap.COMMANDS,
  ...eventEvidence.COMMANDS,
  ...attendeeExperience.COMMANDS,
]);

const GUEST_COMMANDS = new Set([
  'response.submit',
  'question.submit',
  'question.like',
  'photo.submit',
  'post.submit',
  'payment.simulate',
  'payment.refund-request',
  ...attendeeExperience.GUEST_COMMANDS,
]);

function activeTicket(workspace, token, { allowPendingPayment = false } = {}) {
  const participant = findTicket(workspace, token);
  if (!participant || participant.revoked === true || String(participant.status || '').toUpperCase() === 'CANCELLED') {
    throw failure(404, '티켓 링크를 확인할 수 없습니다');
  }
  const expiry = Date.parse(participant.ticketExpiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw failure(404, '티켓 링크를 확인할 수 없습니다');
  const status = String(participant.status || '').toUpperCase();
  if (status !== 'APPROVED' && !(allowPendingPayment && status === 'PENDING')) {
    throw failure(409, '참가 확정 후 이용할 수 있습니다');
  }
  const payment = String(participant.paymentStatus || '').toUpperCase();
  if (!allowPendingPayment && !['FREE', 'PAID'].includes(payment)) {
    throw failure(409, '결제가 완료된 참가자만 이용할 수 있습니다');
  }
  return participant;
}

async function lockEvent(client, eventId) {
  const result = await client.query(
    `SELECT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision,
            w.payload AS workspace_payload, w.revision AS workspace_revision
     FROM events e JOIN event_workspaces w ON w.event_id = e.id
     WHERE e.id = $1
     FOR UPDATE OF e, w`,
    [String(eventId)]
  );
  return result.rows[0] || null;
}

// Grant verdicts run AFTER the receipt lookup (AGENTS order: idlock ->
// rowlock -> receipt -> permission -> apply), so a committed write retried
// after a permission change still replays. The org boundary (identity, org,
// event-in-org) runs before the receipt via resolveEventAuthority.
async function authorizeGrants(client, event, account, command, org) {
  if (!['AGENCY', 'MANAGER'].includes(org.role)) {
    throw failure(403, '권한을 확인하세요');
  }
  if (org.role === 'MANAGER') {
    const membership = await client.query(
      'SELECT write_permissions FROM memberships WHERE account_id = $1 AND event_id = $2 LIMIT 1 FOR SHARE',
      [String(account.id), event.id]
    );
    if (!membership.rowCount) throw failure(403, '권한을 확인하세요');
    // Same allow-list as the route pre-check (server/event-permissions.js):
    // the executor is authoritative, so an unmapped command is denied here
    // even if a caller bypassed the route gate.
    if (!managerWriteAllowed(membership.rows[0].write_permissions, command)) {
      throw failure(403, '권한을 확인하세요');
    }
  }
  return { id: String(account.id), role: org.role, orgId: org.orgId };
}

async function resolveStoredFile(client, input, { eventId, contentTypes, maxBytes }) {
  if (typeof input === 'string') input = { fileId: input };
  const source = object(input);
  if (Object.hasOwn(source, 'data') || Object.hasOwn(source, 'url') || Object.hasOwn(source, 'path')) {
    throw failure(400, '파일은 업로드된 파일 ID로 지정하세요');
  }
  const id = clean(source.fileId || source.id, 160);
  if (!id) throw failure(400, '업로드된 파일을 선택하세요', 'fileId');
  const result = await client.query(
    `SELECT id, original_name, content_type, size_bytes, width_px, height_px
     FROM stored_files WHERE id = $1 AND event_id = $2 LIMIT 1`,
    [id, String(eventId)]
  );
  const row = result.rows[0];
  if (!row) throw failure(404, '행사에 등록된 파일을 찾을 수 없습니다');
  const size = Number(row.size_bytes);
  if (!contentTypes.includes(String(row.content_type)) || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw failure(400, '파일 형식 또는 크기를 확인하세요', 'fileId');
  }
  return {
    fileId: String(row.id),
    name: String(row.original_name),
    type: String(row.content_type),
    size,
    ...(row.width_px && row.height_px ? {width:row.width_px,height:row.height_px} : {}),
  };
}

function appendAudit(workspace, event, actorId, command, input, id, now, guest) {
  if (!Array.isArray(workspace.audit)) workspace.audit = [];
  const detail = clean(input.reason || input.name || input.title || input.text, 300);
  workspace.audit.unshift({
    id,
    type: command,
    actor: String(actorId),
    at: now,
    detail,
    eventId: String(event.id),
    ...(guest ? { guest: true } : {}),
  });
}

function serializableEvent(event) {
  const payload = { ...event };
  delete payload.revision;
  return payload;
}

function createDomainCommands(database, options = {}) {
  // A provider is optional: without one every campaign stays SIMULATED or
  // NEEDS_CONNECTION exactly as before.
  const provider = options.messaging || createMessagingProvider(require('../messaging').providerConfig(options.env));
  async function execute({
    eventId,
    commandId: rawId,
    command,
    payload,
    account,
    ticketToken: rawTicketToken,
  }) {
    if (!COMMANDS.has(command)) throw failure(400, '지원하지 않는 행사 작업입니다', 'command');
    const id = commandIdentifier(rawId);
    const ticketToken = GUEST_COMMANDS.has(command) ? clean(rawTicketToken, 2048) : '';
    const guest = GUEST_COMMANDS.has(command);
    if (guest && !ticketToken) throw failure(401, '티켓 링크를 확인하세요');
    if (!guest && (!account || !account.id)) throw failure(401, '로그인이 필요합니다');

    const outcome = await database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const row = await lockEvent(client, eventId);
      if (!row) throw failure(404, '요청한 행사를 찾을 수 없습니다');
      const event = normalizeEvent(row);
      const workspace = normalizeWorkspace(row.workspace_payload);

      let scope = null;
      let actor = null;
      if (!guest) {
        const { resolveEventAuthority } = require('../tenancy');
        try {
          scope = await resolveEventAuthority(client, account, event.id);
        } catch (error) {
          throw failure(error.status || 403, error.message || '권한을 확인하세요', undefined, error.code);
        }
      }

      const receiptResult = await client.query(
        'SELECT event_id, actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1',
        [id]
      );
      const receipt = receiptResult.rows[0];
      if (receipt) {
        const { checkReceiptScope } = require('../tenancy');
        const receiptScope = guest ? String(event.orgId || event.org_id || '') : String(scope.orgId || '');
        try {
          checkReceiptScope(receipt, receiptScope || undefined);
        } catch (error) {
          throw failure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다', undefined, error.code);
        }
        const stored = object(receipt.result);
        const storedActorId = receipt.actor_id == null ? null : String(receipt.actor_id);
        const expectedActorId = guest ? null : String(account.id);
        if (String(receipt.event_id) !== String(event.id) || storedActorId !== expectedActorId ||
          stored.command !== command || (stored.ticketHash || null) !== hashTicket(guest ? ticketToken : null)) {
          throw failure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        if (guest) {
          const participant = findTicket(workspace, ticketToken);
          if (!participant || (stored.participantId && String(stored.participantId) !== String(participant.id))) {
            throw failure(404, '티켓 링크를 확인할 수 없습니다');
          }
          const expiry = Date.parse(participant.ticketExpiresAt);
          const active = participant.revoked !== true && participant.status !== 'CANCELLED' &&
            Number.isFinite(expiry) && expiry > Date.now();
          const paymentReplay = command.startsWith('payment.');
          if (!active && !paymentReplay) throw failure(404, '티켓 링크를 확인할 수 없습니다');
          actor = participant;
        }
        return { status: 200, body: structuredClone(object(stored.response)), replayed: true };
      }

      // Grant verdicts only when no receipt matched (see authorizeGrants).
      if (guest) {
        actor = activeTicket(workspace, ticketToken, { allowPendingPayment: command === 'payment.simulate' });
      } else {
        actor = await authorizeGrants(client, event, account, command, scope);
      }

      const input = object(payload);
      const now = new Date().toISOString();
      const ctx = {
        client,
        event,
        workspace,
        actor,
        input,
        command,
        commandId: id,
        now,
        guest,
        ticketToken: guest ? ticketToken : null,
        participant: guest ? actor : null,
        clean,
        fail: failure,
        // The deployment provider credentials are legacy-org bound: a new
        // org's campaign never sends through them, it records NEEDS_CONNECTION.
        messaging: { connected: Boolean(provider && provider.state && provider.state.connected) &&
          String(event.orgId || '') === String(require('../tenancy').LEGACY_ORG_ID) },
        makeId: nextId,
        resolveFile: (file, rules) => resolveStoredFile(client, file, rules),
      };

      if (String(event.stage).toUpperCase() === 'ARCHIVED') {
        throw failure(409, '보관된 행사는 변경할 수 없습니다');
      }
      const result = boothMap.COMMANDS.has(command)
        ? await boothMap.apply(ctx)
        : preparation.COMMANDS.has(command)
        ? await preparation.apply(ctx)
        : engagement.COMMANDS.has(command)
          ? await engagement.apply(ctx)
          : eventEvidence.COMMANDS.has(command)
            ? await eventEvidence.apply(ctx)
            : attendeeExperience.COMMANDS.has(command)
              ? await attendeeExperience.apply(ctx)
              : await contentResults.apply(ctx);

      appendAudit(workspace, event, guest ? actor.id : actor.id, command, input, id, now, guest);
      await client.query(
        `UPDATE event_workspaces
         SET payload = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE event_id = $1`,
        [event.id, JSON.stringify(workspace)]
      );
      if (result.eventChanged) {
        try {
          await client.query(
            `UPDATE events
             SET slug = $2, client_id = $3, payload = $4::jsonb,
                 revision = revision + 1, updated_at = now()
             WHERE id = $1`,
            [event.id, event.slug, event.clientId, JSON.stringify(serializableEvent(event))]
          );
        } catch (error) {
          // Concurrent settings updates on different events pass the
          // pre-check SELECT together (per-event row locks do not serialize
          // a shared slug), so the UNIQUE(slug) constraint is the arbiter.
          // Translate it to the same 409 contract as the pre-check instead
          // of leaking a raw database error as 500.
          if (error && error.code === '23505') {
            throw failure(409, '이미 사용 중인 행사 주소 코드입니다', 'slug');
          }
          throw error;
        }
      }
      const response = result.body || {};
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [id, event.id, guest ? null : actor.id, guest ? (event.orgId || event.org_id || null) : (actor.orgId || actor.org_id || null), JSON.stringify({
          command,
          response,
          ticketHash: hashTicket(guest ? ticketToken : null),
          participantId: guest ? actor.id : null,
        })]
      );
      return { status: result.status || 200, body: response, replayed: false, dispatch: result.dispatch || null, resolvePending: result.resolvePending === true };
    });

    // The provider call happens after commit on purpose. Failing to send
    // must not roll back a command the operator already saw succeed; it
    // leaves a campaign they can retry.
    // Delivery confirmation talks to the provider, so it runs after commit
    // for the same reason the send does.
    if (outcome.resolvePending && provider && eventId) {
      try {
        const resolved = await require('../messaging').resolveDelivery(database, provider, eventId);
        if (outcome.body) {
          outcome.body.sync = { resolved: resolved.resolved, pending: resolved.pending, total: resolved.total };
          // Answer with the state polling just established rather than the
          // pre-poll snapshot, or the operator would keep seeing SENDING.
          const wanted = outcome.body.message && outcome.body.message.id;
          const actual = (resolved.messages || []).find((item) => item.id === wanted);
          if (actual) outcome.body.message = actual;
        }
      } catch (error) {
        process.stderr.write('[eventouch] delivery resolve failed: ' + (error && error.message) + '\n');
      }
    }

    if (outcome.dispatch && provider) {
      try {
        const sent = await dispatchCampaign(database, provider, outcome.dispatch);
        // Answer with the outcome the operator actually cares about rather
        // than the intermediate SENDING state.
        if (sent && sent.message && outcome.body && outcome.body.message) {
          outcome.body.message = sent.message;
        }
        // The outcome is now recorded in the workspace, so the queued intent
        // is settled. A settle failure must not fail the response the send
        // already completed; the drain treats a leftover row whose campaign
        // already has an outcome as settled without re-sending.
        try {
          await settleDispatch(database, outcome.dispatch.messageId);
        } catch (settleError) {
          process.stderr.write('[eventouch] outbox settle failed: ' + (settleError && settleError.message) + '\n');
        }
      } catch (error) {
        process.stderr.write('[eventouch] campaign dispatch failed: ' + (error && error.message) + '\n');
        // The outcome was NOT recorded, so the outbox row stays queued: a
        // later drain replays the send instead of losing it silently.
      }
    }
    return outcome;
  }

  return {
    execute,
    supports(command) {
      return COMMANDS.has(command);
    },
    isGuestCommand(command) {
      return GUEST_COMMANDS.has(command);
    },
  };
}

module.exports = { createDomainCommands, COMMANDS, GUEST_COMMANDS };
