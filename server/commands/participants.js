'use strict';

const crypto = require('node:crypto');
const { normalizeEvent, normalizeWorkspace, projectParticipant } = require('../state');

const COMMANDS = new Set([
  'participant.create',
  'participant.update',
  'participant.status',
  'participant.self-update',
  'participant.cancel',
  'ticket.reissue',
  'participant.import',
]);
const GUEST_COMMANDS = new Set(['participant.self-update', 'participant.cancel']);
const TICKET_TOKEN = /^(?:[A-Za-z0-9_-]{32,128}|ET:[A-Za-z0-9_-]{1,80}:T-[A-Za-z0-9_-]{32,128})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function list(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value, max = 500) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function commandIdentifier(value) {
  const id = clean(value, 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw failure(400, '요청 식별자를 확인하세요', 'commandId');
  }
  return id;
}

function normalizedPhone(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
}

function eventCapacity(event) {
  const capacity = Number(event.capacity);
  return Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
}

function ticketFor(event) {
  return `ET:${event.id}:T-${crypto.randomBytes(32).toString('base64url')}`;
}

function ticketExpiry(event, nowMs) {
  const eventEnd = Date.parse(`${clean(event.date, 32)}T23:59:00`);
  return new Date(Math.max(nowMs, Number.isFinite(eventEnd) ? eventEnd : nowMs) + 90 * DAY_MS).toISOString();
}

function isActive(person) {
  return person && person.status !== 'CANCELLED' && person.cancelled !== true;
}

function existingParticipant(workspace, id) {
  return list(workspace.participants).find((person) => person && person.id === id) || null;
}

function validateParticipant(inputValue, workspace, { fields, existing, excludeId } = {}) {
  const input = object(inputValue);
  const name = clean(input.name === undefined && existing ? existing.name : input.name, 60);
  if (!name) throw failure(400, '이름을 입력하세요', 'name');

  const phone = normalizedPhone(input.phone === undefined && existing ? existing.phone : input.phone);
  if (!/^\d{9,15}$/.test(phone)) throw failure(400, '연락처를 숫자 9~15자리로 입력하세요', 'phone');

  const email = clean(input.email === undefined && existing ? existing.email : input.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw failure(400, '이메일 형식을 확인하세요', 'email');
  }
  const company = clean(input.company === undefined && existing ? existing.company : input.company, 200);
  const group = clean(input.group === undefined && existing ? existing.group : input.group, 80) || '일반';

  const duplicate = list(workspace.participants).some((person) =>
    isActive(person) && person.id !== excludeId && normalizedPhone(person.phone) === phone
  );
  if (duplicate) throw failure(409, '동일한 연락처가 이미 등록되어 있습니다', 'phone');

  const suppliedAnswers = object(input.answers);
  const priorAnswers = object(existing && existing.answers);
  const answers = Object.create(null);
  for (const field of list(fields)) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
    const id = clean(field && field.id, 100);
    if (!id || ['name', 'phone', 'company'].includes(id)) continue;
    const hasDirectValue = Object.hasOwn(input, id);
    const hasAnswerValue = Object.hasOwn(suppliedAnswers, id);
    const value = hasDirectValue
      ? input[id]
      : hasAnswerValue
        ? suppliedAnswers[id]
        : Object.hasOwn(priorAnswers, id)
          ? priorAnswers[id]
          : undefined;
    const type = clean(field && field.type, 24).toLowerCase();
    const empty = value === undefined || value === null || value === '' || (type === 'checkbox' && value !== true);
    if (!['text', 'email', 'select', 'checkbox'].includes(type)) {
      throw failure(400, `${clean(field.label, 160) || '항목'} 형식을 확인하세요`, id);
    }
    if (field.required === true && empty) {
      throw failure(400, `${clean(field.label, 160) || '필수 항목'}을(를) 입력하세요`, id);
    }
    if (!empty && type !== 'checkbox' && typeof value !== 'string') {
      throw failure(400, `${clean(field.label, 160) || '항목'} 값을 확인하세요`, id);
    }
    if (type === 'select' && !empty && !list(field.options).includes(value)) {
      throw failure(400, `${clean(field.label, 160) || '선택 항목'}의 선택지를 확인하세요`, id);
    }
    if (type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim())) {
      throw failure(400, `${clean(field.label, 160) || '이메일'} 형식을 확인하세요`, id);
    }
    if (type === 'checkbox' && value !== undefined && value !== null && typeof value !== 'boolean') {
      throw failure(400, `${clean(field.label, 160) || '선택 항목'}을 확인하세요`, id);
    }
    if (value !== undefined) {
      answers[id] = typeof value === 'string' ? value.trim().slice(0, 4000) : value;
    } else if (type === 'checkbox') {
      answers[id] = false;
    } else {
      answers[id] = '';
    }
  }

  return { name, phone, email, company, group, answers };
}

function addPaymentIfNeeded(event, workspace, participant, at) {
  const configuredPrice = Number(workspace.price);
  const price = Number.isFinite(configuredPrice) && configuredPrice > 0 ? configuredPrice : 0;
  const paidFlow = list(event.features).includes('payment') && price > 0;
  participant.paymentStatus = paidFlow ? 'PENDING' : 'FREE';
  if (!paidFlow) return;
  if (!Array.isArray(workspace.payments)) workspace.payments = [];
  workspace.payments.push({
    id: `payment-${crypto.randomUUID()}`,
    participantId: participant.id,
    amount: price,
    status: 'PENDING',
    at,
    provider: 'UNCONNECTED',
  });
}

function createParticipant(event, workspace, input, { registrationType, publicSignup = false, fields, now }) {
  const form = fields || list(publicSignup ? workspace.publishedFields : workspace.fields);
  const values = validateParticipant(input, workspace, { fields: form });
  const visibleConsent = clean(workspace.consentText, 3000).length > 0;
  if (publicSignup && visibleConsent && object(input).consent !== true) {
    throw failure(400, '필수 정보 수집 안내에 동의해주세요', 'consent');
  }

  const capacity = eventCapacity(event);
  const activeCount = list(workspace.participants).filter(isActive).length;
  const full = capacity > 0 && activeCount >= capacity;
  if (full && workspace.approvalRequired !== true) {
    throw failure(409, '등록 정원이 마감되었습니다');
  }

  const nowMs = Date.parse(now);
  const participant = {
    ...values,
    id: `person-${crypto.randomUUID()}`,
    status: full ? 'WAITLIST' : (publicSignup && workspace.approvalRequired === true ? 'PENDING' : 'APPROVED'),
    registrationType,
    inside: false,
    everIn: false,
    revoked: false,
    ticket: ticketFor(event),
    ticketExpiresAt: ticketExpiry(event, nowMs),
    createdAt: now,
    consent: visibleConsent && object(input).consent === true
      ? { version: Number(workspace.consentVersion) || 1, at: now }
      : null,
  };
  addPaymentIfNeeded(event, workspace, participant, now);
  workspace.participants.push(participant);
  return participant;
}

function activeTicketParticipant(workspace, token, nowMs) {
  if (!TICKET_TOKEN.test(String(token || ''))) return null;
  return list(workspace.participants).find((person) => {
    if (!person || person.ticket !== token || person.revoked === true || person.status === 'CANCELLED') return false;
    const expiresAt = Date.parse(person.ticketExpiresAt);
    return Number.isFinite(expiresAt) && expiresAt > nowMs;
  }) || null;
}

function publicSignupEvent(event) {
  return ['READY', 'LIVE'].includes(String(event.stage || '').toUpperCase());
}

async function lockEvent(client, ref, value) {
  const column = ref === 'slug' ? 'e.slug' : 'e.id';
  const result = await client.query(
    `SELECT e.id, e.slug, e.client_id, e.payload, e.revision,
            w.payload AS workspace_payload, w.revision AS workspace_revision
     FROM events e JOIN event_workspaces w ON w.event_id = e.id
     WHERE ${column} = $1
     FOR UPDATE OF e, w`,
    [value]
  );
  return result.rows[0] || null;
}

async function authorizeOperator(client, event, workspace, account, command, assignmentId) {
  if (!account || !account.id) throw failure(401, '로그인이 필요합니다');
  const accountResult = await client.query(
    'SELECT role, active FROM accounts WHERE id = $1 LIMIT 1',
    [String(account.id)]
  );
  const current = accountResult.rows[0];
  if (!current || current.active !== true || !['AGENCY', 'MANAGER', 'STAFF'].includes(current.role)) {
    throw failure(401, '로그인이 필요합니다');
  }
  if (current.role === 'AGENCY') return current.role;
  if (current.role === 'MANAGER') {
    const membership = await client.query(
      'SELECT 1 FROM memberships WHERE account_id = $1 AND event_id = $2 LIMIT 1',
      [String(account.id), event.id]
    );
    if (!membership.rowCount) throw failure(403, '권한을 확인하세요');
    return current.role;
  }

  if (command !== 'participant.create' || !assignmentId) throw failure(403, '권한을 확인하세요');
  const assignment = await client.query(
    `SELECT type, target_id FROM staff_assignments
     WHERE id = $1 AND account_id = $2 AND event_id = $3 AND active = true LIMIT 1`,
    [String(assignmentId), String(account.id), event.id]
  );
  const row = assignment.rows[0];
  if (!row || row.type !== 'DESK' || !list(workspace.desks).some((desk) => desk && String(desk.id) === String(row.target_id))) {
    throw failure(403, '권한을 확인하세요');
  }
  return current.role;
}

function receiptMatches(receipt, { eventId, actorId, operation, ticketToken }) {
  if (!receipt || String(receipt.event_id) !== String(eventId) ||
      (receipt.actor_id == null ? null : String(receipt.actor_id)) !== (actorId == null ? null : String(actorId))) return false;
  const data = object(receipt.result);
  if (data.operation !== operation) return false;
  const tokenHash = ticketToken ? ticketHash(ticketToken) : null;
  return (data.ticketHash || null) === tokenHash;
}

function ticketHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function responseForReceipt(responseValue) {
  const response = structuredClone(object(responseValue));
  const participantIds = [];
  const issuedTicketHashes = {};
  const removeTicket = (participant) => {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant) || !participant.ticket) return;
    const id = String(participant.id);
    participantIds.push(id);
    issuedTicketHashes[id] = ticketHash(participant.ticket);
    delete participant.ticket;
  };
  removeTicket(response.participant);
  for (const participant of list(response.participants)) removeTicket(participant);
  return { response, participantIds, issuedTicketHashes };
}

function responseFromReceipt(receipt, workspace) {
  const data = object(receipt.result);
  const response = structuredClone(object(data.response));
  const issuedTicketHashes = object(data.issuedTicketHashes);
  const tickets = new Map(list(data.participantIds).map((id) => {
    const participant = existingParticipant(workspace, String(id));
    if (!participant || typeof participant.ticket !== 'string' ||
        issuedTicketHashes[String(id)] !== ticketHash(participant.ticket)) {
      throw failure(409, '요청 결과가 변경되었습니다. 현재 티켓을 확인하세요');
    }
    return [String(id), participant.ticket];
  }));
  const restoreTicket = (participant) => {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) return;
    const ticket = tickets.get(String(participant.id));
    if (ticket) participant.ticket = ticket;
  };
  restoreTicket(response.participant);
  for (const participant of list(response.participants)) restoreTicket(participant);
  return response;
}

function reissueTicket(event, person, now) {
  person.ticket = ticketFor(event);
  person.ticketExpiresAt = ticketExpiry(event, Date.parse(now));
  person.revoked = false;
}

function ensureWritableEvent(event) {
  if (['ENDED', 'ARCHIVED'].includes(String(event.stage || '').toUpperCase())) {
    throw failure(409, '종료된 행사는 참가자를 변경할 수 없습니다');
  }
}

function findPerson(workspace, id) {
  const person = existingParticipant(workspace, id);
  if (!person) throw failure(404, '참가자를 찾을 수 없습니다');
  return person;
}

function updateParticipant(workspace, person, input, fields) {
  const changes = validateParticipant(input, workspace, {
    fields,
    existing: person,
    excludeId: person.id,
  });
  changes.answers = { ...object(person.answers), ...object(changes.answers) };
  Object.assign(person, changes);
  return person;
}

function publishedFormInput(inputValue, fields) {
  const input = object(inputValue);
  const fieldIds = new Set(list(fields)
    .filter((field) => field && typeof field === 'object' && !Array.isArray(field))
    .map((field) => clean(field.id, 100))
    .filter(Boolean));
  const editable = {};
  for (const id of fieldIds) {
    if (Object.hasOwn(input, id)) editable[id] = input[id];
  }
  const suppliedAnswers = object(input.answers);
  const answers = {};
  for (const id of fieldIds) {
    if (Object.hasOwn(suppliedAnswers, id)) answers[id] = suppliedAnswers[id];
  }
  if (Object.keys(answers).length) editable.answers = answers;
  return editable;
}

function cancelParticipant(workspace, person) {
  if (person.inside === true || String(person.status || '').toUpperCase() === 'IN') {
    throw failure(409, '입장 중인 참가자는 먼저 퇴장 처리하세요');
  }
  person.status = 'CANCELLED';
  person.revoked = true;
  let refundRequested = false;
  for (const payment of list(workspace.payments)) {
    if (payment && payment.participantId === person.id && payment.status === 'PAID') {
      payment.status = 'REFUND_REQUESTED';
      refundRequested = true;
    }
  }
  if (refundRequested) person.paymentStatus = 'REFUND_REQUESTED';
}

function setParticipantStatus(event, workspace, person, status, now) {
  if (!['APPROVED', 'PENDING', 'WAITLIST', 'CANCELLED'].includes(status)) {
    throw failure(400, '등록 상태를 확인하세요', 'status');
  }
  if (status === 'CANCELLED') {
    cancelParticipant(workspace, person);
    return;
  }
  if (status === 'APPROVED' && person.status !== 'APPROVED') {
    const capacity = eventCapacity(event);
    const approved = list(workspace.participants).filter((item) => item && item.status === 'APPROVED').length;
    if (capacity > 0 && approved >= capacity) throw failure(409, '확정 정원을 초과합니다');
  }
  person.status = status;
  if (person.revoked === true) reissueTicket(event, person, now);
}

function validCommand(command) {
  if (!COMMANDS.has(command)) throw failure(400, '지원하지 않는 참가자 작업입니다', 'command');
}

function createParticipantCommands(database) {
  async function mutate({ ref, value, commandId, operation, command, account, assignmentId, ticketToken, apply }) {
    const id = commandIdentifier(commandId);
    return database.transaction(async (client) => {
      // Serializes reuse of one idempotency key, including attempts against different events.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const row = await lockEvent(client, ref, value);
      if (!row) throw failure(404, '요청한 행사를 찾을 수 없습니다', undefined, 'EVENT_NOT_FOUND');
      const event = normalizeEvent(row);
      const workspace = normalizeWorkspace(row.workspace_payload);

      if (command) await authorizeOperator(client, event, workspace, account, command, assignmentId);

      const receiptResult = await client.query(
        'SELECT event_id, actor_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1',
        [id]
      );
      const receipt = receiptResult.rows[0];
      const actorId = account && account.id ? String(account.id) : null;
      if (receipt) {
        if (!receiptMatches(receipt, { eventId: event.id, actorId, operation, ticketToken })) {
          throw failure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        if (ticketToken) {
          const saved = object(receipt.result);
          const participant = existingParticipant(workspace, saved.participantId);
          const currentTicket = activeTicketParticipant(workspace, ticketToken, Date.now());
          const canceledRetry = operation === 'participant.cancel' && participant &&
            participant.id === saved.participantId && participant.ticket === ticketToken &&
            participant.status === 'CANCELLED' && participant.revoked === true;
          if ((!currentTicket || currentTicket.id !== saved.participantId) && !canceledRetry) {
            throw failure(404, '티켓 링크를 확인할 수 없습니다');
          }
        }
        return { status: 200, body: responseFromReceipt(receipt, workspace), replayed: true };
      }

      const now = new Date().toISOString();
      const response = await apply({ client, event, workspace, now });
      await client.query(
        `UPDATE event_workspaces
         SET payload = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE event_id = $1`,
        [event.id, JSON.stringify(workspace)]
      );
      const savedResponse = responseForReceipt(response.body);
      const receiptData = {
        operation,
        response: savedResponse.response,
        participantIds: savedResponse.participantIds,
        issuedTicketHashes: savedResponse.issuedTicketHashes,
        ticketHash: ticketToken ? ticketHash(ticketToken) : null,
        participantId: response.participantId || null,
      };
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, result)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, event.id, actorId, JSON.stringify(receiptData)]
      );
      return { status: response.status || 200, body: response.body, replayed: false };
    });
  }

  async function signup({ slug, commandId: id, input }) {
    const eventSlug = clean(slug, 100);
    try {
      commandIdentifier(id);
    } catch (error) {
      const exists = await database.query('SELECT 1 FROM events WHERE slug = $1 LIMIT 1', [eventSlug]);
      if (!exists.rowCount) throw failure(404, '요청한 행사를 찾을 수 없습니다', undefined, 'EVENT_NOT_FOUND');
      throw error;
    }
    return mutate({
      ref: 'slug',
      value: eventSlug,
      commandId: id,
      operation: 'public.signup',
      apply: async ({ event, workspace, now }) => {
        if (!publicSignupEvent(event)) throw failure(404, '요청한 행사를 찾을 수 없습니다');
        if (workspace.registrationOpen !== true || !(Number(workspace.publishedVersion) > 0)) {
          throw failure(409, '현재 신청을 받지 않습니다');
        }
        const expectedVersion = Number(workspace.publishedVersion);
        const formInput = object(input);
        if (!Number.isInteger(Number(formInput.formVersion)) || Number(formInput.formVersion) !== expectedVersion) {
          throw failure(409, '등록 양식이 변경되었습니다. 최신 양식을 확인하세요', 'formVersion');
        }
        const participant = createParticipant(event, workspace, input, {
          registrationType: 'PRE',
          publicSignup: true,
          now,
        });
        return {
          status: 201,
          body: { participant: projectParticipant(workspace, event, participant) },
        };
      },
    });
  }

  async function execute({ eventId, commandId: id, command, payload, account, assignmentId: assignedId, ticketToken }) {
    validCommand(command);
    const guest = GUEST_COMMANDS.has(command);
    if (guest) {
      if (!ticketToken) throw failure(401, '티켓 링크를 확인하세요');
    } else if (!account || !account.id) {
      throw failure(401, '로그인이 필요합니다');
    }

    return mutate({
      ref: 'id',
      value: clean(eventId, 100),
      commandId: id,
      operation: command,
      command: guest ? null : command,
      account: guest ? null : account,
      assignmentId: assignedId,
      ticketToken: guest ? ticketToken : null,
      apply: async ({ client, event, workspace, now }) => {
        const input = object(payload);
        const nowMs = Date.parse(now);
        if (guest) {
          const participant = activeTicketParticipant(workspace, ticketToken, nowMs);
          if (!participant) throw failure(404, '티켓 링크를 확인할 수 없습니다');
          if (command === 'participant.self-update') {
            if (workspace.registrationOpen !== true || ['ENDED', 'ARCHIVED'].includes(String(event.stage).toUpperCase())) {
              throw failure(409, '수정 기간이 종료되었습니다. 운영자에게 문의하세요');
            }
            updateParticipant(
              workspace,
              participant,
              publishedFormInput(input, workspace.publishedFields),
              workspace.publishedFields
            );
          } else {
            if (['ENDED', 'ARCHIVED'].includes(String(event.stage).toUpperCase())) {
              throw failure(409, '취소 기간이 종료되었습니다');
            }
            cancelParticipant(workspace, participant);
          }
          return {
            body: { participant: projectParticipant(workspace, event, participant) },
            participantId: participant.id,
          };
        }

        ensureWritableEvent(event);

        if (command === 'participant.create') {
          const participant = createParticipant(event, workspace, input, {
            registrationType: 'ONSITE',
            now,
          });
          return { status: 201, body: { participant: projectParticipant(workspace, event, participant) } };
        }

        if (command === 'participant.update') {
          const person = findPerson(workspace, clean(input.id, 120));
          updateParticipant(workspace, person, input, workspace.fields);
          return { body: { participant: projectParticipant(workspace, event, person) } };
        }

        if (command === 'participant.status') {
          const status = clean(input.status, 24).toUpperCase();
          const ids = Array.isArray(input.ids) ? input.ids : [input.id];
          if (!ids.length || ids.length > 1000 || ids.some((item) => !clean(item, 120))) {
            throw failure(400, '참가자를 선택하세요', 'ids');
          }
          const people = ids.map((personId) => findPerson(workspace, clean(personId, 120)));
          for (const person of people) setParticipantStatus(event, workspace, person, status, now);
          return { body: { participants: people.map((person) => projectParticipant(workspace, event, person)) } };
        }

        if (command === 'ticket.reissue') {
          const person = findPerson(workspace, clean(input.id, 120));
          if (person.status === 'CANCELLED') throw failure(409, '활성 참가자만 티켓을 재발급할 수 있습니다');
          reissueTicket(event, person, now);
          return { body: { participant: projectParticipant(workspace, event, person) } };
        }

        if (command === 'participant.import') {
          const rows = list(input.rows);
          if (!rows.length || rows.length > 1000) throw failure(400, '유효한 가져오기 행을 확인하세요', 'rows');
          const capacity = eventCapacity(event);
          const active = list(workspace.participants).filter(isActive).length;
          if (capacity > 0 && active + rows.length > capacity) {
            throw failure(409, '가져올 인원이 정원을 초과합니다');
          }
          const created = [];
          for (const row of rows) {
            const participant = createParticipant(event, workspace, row, {
              registrationType: 'PRE',
              fields: [],
              now,
            });
            participant.status = 'APPROVED';
            participant.consent = null;
            participant.answers = {};
            created.push(participant);
          }
          return { body: { participants: created.map((person) => projectParticipant(workspace, event, person)) } };
        }

        throw failure(400, '지원하지 않는 참가자 작업입니다');
      },
    });
  }

  return { signup, execute };
}

module.exports = { createParticipantCommands, COMMANDS };
