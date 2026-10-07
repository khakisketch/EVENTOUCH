'use strict';

const crypto = require('node:crypto');
const { normalizeEvent, normalizeWorkspace } = require('../state');
const preparation = require('./preparation');
const engagement = require('./engagement');
const contentResults = require('./content-results');

const COMMANDS = new Set([
  ...preparation.COMMANDS,
  ...engagement.COMMANDS,
  ...contentResults.COMMANDS,
]);

const GUEST_COMMANDS = new Set([
  'response.submit',
  'question.submit',
  'question.like',
  'photo.submit',
  'post.submit',
  'payment.simulate',
  'payment.refund-request',
]);

function failure(status, message, field, code) {
  const error = new Error(message);
  error.status = status;
  if (field) error.field = field;
  if (code) error.code = code;
  return error;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value, max = 500) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function commandIdentifier(value) {
  const id = clean(value, 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw failure(400, '요청 식별자를 확인하세요', 'commandId');
  return id;
}

function nextId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashTicket(token) {
  return token ? crypto.createHash('sha256').update(token).digest('hex') : null;
}

function findTicket(workspace, token) {
  return workspace.participants.find((person) => person && person.ticket === token) || null;
}

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
    `SELECT e.id, e.slug, e.client_id, e.payload, e.revision,
            w.payload AS workspace_payload, w.revision AS workspace_revision
     FROM events e JOIN event_workspaces w ON w.event_id = e.id
     WHERE e.id = $1
     FOR UPDATE OF e, w`,
    [String(eventId)]
  );
  return result.rows[0] || null;
}

async function authorizeOperator(client, event, account) {
  if (!account || !account.id) throw failure(401, '로그인이 필요합니다');
  const result = await client.query(
    'SELECT role, active FROM accounts WHERE id = $1 LIMIT 1 FOR SHARE',
    [String(account.id)]
  );
  const current = result.rows[0];
  if (!current || current.active !== true || !['AGENCY', 'MANAGER'].includes(current.role)) {
    throw failure(current ? 403 : 401, current ? '권한을 확인하세요' : '로그인이 필요합니다');
  }
  if (current.role === 'MANAGER') {
    const membership = await client.query(
      'SELECT 1 FROM memberships WHERE account_id = $1 AND event_id = $2 LIMIT 1 FOR SHARE',
      [String(account.id), event.id]
    );
    if (!membership.rowCount) throw failure(403, '권한을 확인하세요');
  }
  return { id: String(account.id), role: current.role };
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
    `SELECT id, original_name, content_type, size_bytes
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

function createDomainCommands(database) {
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

    return database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const row = await lockEvent(client, eventId);
      if (!row) throw failure(404, '요청한 행사를 찾을 수 없습니다');
      const event = normalizeEvent(row);
      const workspace = normalizeWorkspace(row.workspace_payload);

      let actor = guest ? null : await authorizeOperator(client, event, account);

      const receiptResult = await client.query(
        'SELECT event_id, actor_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1',
        [id]
      );
      const receipt = receiptResult.rows[0];
      if (receipt) {
        const stored = object(receipt.result);
        const storedActorId = receipt.actor_id == null ? null : String(receipt.actor_id);
        const expectedActorId = guest ? null : String(actor.id);
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

      if (guest) actor = activeTicket(workspace, ticketToken, { allowPendingPayment: command === 'payment.simulate' });

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
        makeId: nextId,
        resolveFile: (file, rules) => resolveStoredFile(client, file, rules),
      };

      if (String(event.stage).toUpperCase() === 'ARCHIVED') {
        throw failure(409, '보관된 행사는 변경할 수 없습니다');
      }
      const result = preparation.COMMANDS.has(command)
        ? await preparation.apply(ctx)
        : engagement.COMMANDS.has(command)
          ? await engagement.apply(ctx)
          : await contentResults.apply(ctx);

      appendAudit(workspace, event, guest ? actor.id : actor.id, command, input, id, now, guest);
      await client.query(
        `UPDATE event_workspaces
         SET payload = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE event_id = $1`,
        [event.id, JSON.stringify(workspace)]
      );
      if (result.eventChanged) {
        await client.query(
          `UPDATE events
           SET slug = $2, client_id = $3, payload = $4::jsonb,
               revision = revision + 1, updated_at = now()
           WHERE id = $1`,
          [event.id, event.slug, event.clientId, JSON.stringify(serializableEvent(event))]
        );
      }
      const response = result.body || {};
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, result)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, event.id, guest ? null : actor.id, JSON.stringify({
          command,
          response,
          ticketHash: hashTicket(guest ? ticketToken : null),
          participantId: guest ? actor.id : null,
        })]
      );
      return { status: result.status || 200, body: response, replayed: false };
    });
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
