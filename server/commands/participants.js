'use strict';

const crypto = require('node:crypto');
const { normalizeEvent, normalizeWorkspace, workspaceChangesForSave, projectParticipant } = require('../state');
const { ensureConsentNotice } = require('../consent-notices');
const { publicOrigin } = require('../public-origin');
const { managerWriteAllowed } = require('../event-permissions');
const { createAttendeeAccess } = require('../attendees');
const { ticketExpiry, TICKET_TOKEN } = require('../ticket-lifetime');
const { cancellationConflictFingerprint, cancellationConflictIdentity } = require('../cancellation-conflict-review');
const {
  failure,
  object,
  list,
  clean,
  commandIdentifier,
  ticketHash,
} = require('./shared.ts');

const COMMANDS = new Set([
  'participant.create',
  'participant.update',
  'participant.status',
  'participant.bulk-cancel',
  'participant.resolve-cancellation-conflict',
  'participant.self-update',
  'participant.cancel',
  'ticket.reissue',
  'ticket.reissue-reviewed',
  'participant.import',
]);
const GUEST_COMMANDS = new Set(['participant.self-update', 'participant.cancel']);

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

// Columns an import row carries on their own; they are never an extra field.
// `answers` is the carrier of the extra fields' values.
const IMPORT_OWN_FIELD_IDS = new Set(['name', 'phone', 'email', 'company', 'group', 'answers']);

// The event's own extra form fields (식사 선택, 부서 ...), as operator
// registration sees them (the draft form). An import row may carry answers for
// them; only the ones a row actually carries are checked, so a required field
// the file did not include never blocks every row.
function importFieldsFor(workspace, carried) {
  return list(workspace.fields).filter((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
    const id = clean(field.id, 100);
    return Boolean(id) && !IMPORT_OWN_FIELD_IDS.has(id) && Object.hasOwn(carried, id);
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
  if (publicSignup && participant.consent) {
    const notice = ensureConsentNotice(workspace, now);
    if (notice) participant.consent.noticeId = notice.id;
  }
  addPaymentIfNeeded(event, workspace, participant, now);
  workspace.participants.push(participant);
  return participant;
}

function activeTicketParticipant(workspace, token, nowMs) {
  if (!TICKET_TOKEN.test(String(token || ''))) return null;
  return list(workspace.participants).find((person) => {
    if (!person || person.ticket !== token || person.revoked === true || person.cancelled === true || String(person.status || '').toUpperCase() === 'CANCELLED') return false;
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
    `SELECT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision,
            w.payload AS workspace_payload, w.revision AS workspace_revision
     FROM events e JOIN event_workspaces w ON w.event_id = e.id
     WHERE ${column} = $1
     FOR UPDATE OF e, w`,
    [value]
  );
  return result.rows[0] || null;
}

// Grant verdicts run AFTER the receipt lookup (AGENTS order). Scope
// (identity/org/event) is verified pre-receipt via resolveEventAuthority at
// the call site.
async function authorizeGrants(client, event, workspace, account, command, assignmentId, org) {
  const current = { role: org.role, active: true };
  if (!['AGENCY', 'MANAGER', 'STAFF'].includes(current.role)) {
    throw failure(401, '로그인이 필요합니다');
  }
  if (account && typeof account === 'object') account.orgId = org.orgId;
  if (current.role === 'AGENCY') return current.role;
  if (current.role === 'MANAGER') {
    const membership = await client.query(
      'SELECT write_permissions FROM memberships WHERE account_id = $1 AND event_id = $2 LIMIT 1 FOR SHARE',
      [String(account.id), event.id]
    );
    if (!membership.rowCount) throw failure(403, '권한을 확인하세요');
    // Operator commands need their write scope (server/event-permissions.js).
    // Guest commands pass command=null and skip this entirely.
    if (!managerWriteAllowed(membership.rows[0].write_permissions, command)) {
      throw failure(403, '권한을 확인하세요');
    }
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

// A retry must be bound to the exact reviewed cancellation, not merely the
// actor, event and command name. Never expose the saved targets on mismatch.
function cancellationReceiptMatches(receipt, payload) {
  const input = object(payload), saved = object(object(receipt.result).response).cancellationReview;
  if (input.status !== 'CANCELLED' || !Array.isArray(input.ids) || !Array.isArray(input.expectedCancellations) ||
      !saved || saved.status !== 'CANCELLED' || !Array.isArray(saved.targets) ||
      input.ids.length !== saved.targets.length || input.expectedCancellations.length !== saved.targets.length) return false;
  return saved.targets.every((target, index) => {
    const expected = input.expectedCancellations[index];
    return target && expected && input.ids[index] === target.id && expected.id === target.id &&
      expected.status === target.status && expected.inside === target.inside &&
      Array.isArray(expected.paidPaymentIds) && expected.paidPaymentIds.every((item) => typeof item === 'string') &&
      Array.isArray(target.paidPaymentIds) && JSON.stringify([...expected.paidPaymentIds].sort()) === JSON.stringify([...target.paidPaymentIds].sort());
  });
}

function conflictReviewProof(inputValue) {
  const input = object(inputValue);
  if (typeof input.id !== 'string' || !input.id || input.id.length > 120 ||
      typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
      typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 300 || input.confirmed !== true) return null;
  return crypto.createHash('sha256').update(JSON.stringify([input.id, input.fingerprint, input.reason.trim(), true])).digest('hex');
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

function responseFromReceipt(receipt, workspace) {  const data = object(receipt.result);
  const response = structuredClone(object(data.response));
  const issuedTicketHashes = object(data.issuedTicketHashes);
  if (data.operation === 'public.signup') {
    const original = object(response.participant);
    const current = existingParticipant(workspace, String(original.id || ''));
    if (!current || normalizedPhone(current.phone) !== normalizedPhone(original.phone) ||
        !activeTicketParticipant(workspace, current.ticket, Date.now())) {
      throw failure(409, '신청이 처리된 뒤 참가 정보가 변경되었습니다. 티켓을 다시 확인하세요', undefined, 'SIGNUP_RESULT_SUPERSEDED');
    }
  }
  const tickets = new Map(list(data.participantIds).map((id) => {
    const participant = existingParticipant(workspace, String(id));
    if (!participant || typeof participant.ticket !== 'string' ||
        issuedTicketHashes[String(id)] !== ticketHash(participant.ticket) ||
        (['ticket.reissue', 'ticket.reissue-reviewed'].includes(data.operation) && !activeTicketParticipant(workspace, participant.ticket, Date.now()))) {
      throw failure(409, '요청 결과가 변경되었습니다. 현재 티켓을 확인하세요', undefined,
        ['ticket.reissue', 'ticket.reissue-reviewed'].includes(data.operation) ? 'TICKET_RESULT_SUPERSEDED' : undefined);
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

async function syncTicketRows(client, event, workspace, participantIds) {
  for (const rawId of participantIds) {
    const person = existingParticipant(workspace, String(rawId));
    if (!person || typeof person.ticket !== 'string' || !person.ticket) continue;
    await client.query(
      `INSERT INTO tickets (participant_id, event_id, ticket_hash, revoked, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, NULLIF($5, '')::timestamptz, now())
       ON CONFLICT (participant_id) DO UPDATE
       SET event_id = EXCLUDED.event_id,
           ticket_hash = EXCLUDED.ticket_hash,
           revoked = EXCLUDED.revoked,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
      [
        String(person.id),
        String(event.id),
        ticketHash(person.ticket),
        person.revoked === true,
        String(person.ticketExpiresAt || ''),
      ]
    );
  }
}

function ticketRevision(person) {
  return Number.isSafeInteger(person.ticketRevision) && person.ticketRevision >= 0 ? person.ticketRevision : 0;
}

function reissueTicket(event, person, now) {
  person.ticket = ticketFor(event);
  person.ticketRevision = ticketRevision(person) + 1;
  person.ticketExpiresAt = ticketExpiry(event, Date.parse(now));
  person.revoked = false;
  if (person.ticketNeedsExplicitReissue === true) person.ticketNeedsExplicitReissue = false;
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
  if (Object.hasOwn(person, 'inside') && typeof person.inside !== 'boolean') {
    throw failure(409, '입장 상태를 확인할 수 없습니다. 현장 기록을 확인한 뒤 상태를 변경하세요.', undefined, 'PARTICIPANT_PRESENCE_UNKNOWN');
  }
  if (person.inside === true || String(person.status || '').toUpperCase() === 'IN') {
    throw failure(409, '입장 중인 참가자는 먼저 퇴장 처리하세요', undefined, 'PARTICIPANT_INSIDE');
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
  if (person.cancelled === true) {
    throw failure(409, '신청 상태와 취소 기록을 확인한 뒤 상태를 변경하세요. 시스템 관리자에게 문의하세요.', undefined, 'TICKET_STATUS_CONFLICT');
  }
  // A person who has entered must remain eligible for the OUT desk. Changing
  // approval first would strand their presence record until an operator
  // notices and restores approval. Check under the event lock, not just in
  // the roster, because the person may enter after that screen was loaded.
  if (status === 'PENDING' || status === 'WAITLIST') {
    if (Object.hasOwn(person, 'inside') && typeof person.inside !== 'boolean') {
      throw failure(409, '입장 상태를 확인할 수 없습니다. 현장 기록을 확인한 뒤 상태를 변경하세요.', undefined, 'PARTICIPANT_PRESENCE_UNKNOWN');
    }
    if (person.inside === true) {
      throw failure(409, '입장 중인 참가자입니다. 먼저 퇴장 처리한 뒤 참가 상태를 변경하세요.', undefined, 'PARTICIPANT_INSIDE');
    }
  }
  if (status === 'APPROVED' && person.status !== 'APPROVED') {
    const capacity = eventCapacity(event);
    const approved = list(workspace.participants).filter((item) => item && item.status === 'APPROVED').length;
    if (capacity > 0 && approved >= capacity) throw failure(409, '확정 정원을 초과합니다');
  }
  person.status = status;
  if (person.revoked === true && person.ticketNeedsExplicitReissue !== true) reissueTicket(event, person, now);
}

function validCommand(command) {
  if (!COMMANDS.has(command)) throw failure(400, '지원하지 않는 참가자 작업입니다', 'command');
}

function createParticipantCommands(database) {
  // Verification grants and session revocation live here; the SMS transport
  // itself is owned by the API layer (server/attendees is transport-free).
  const attendeeAccess = createAttendeeAccess(database);
  async function mutate({ ref, value, commandId, operation, command, account, assignmentId, ticketToken, cookieHeader, reviewInput, apply }) {
    const id = commandIdentifier(commandId);
    return database.transaction(async (client) => {
      // Serializes reuse of one idempotency key, including attempts against different events.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const row = await lockEvent(client, ref, value);
      if (!row) throw failure(404, '요청한 행사를 찾을 수 없습니다', undefined, 'EVENT_NOT_FOUND');
      const event = normalizeEvent(row);
      const workspace = normalizeWorkspace(row.workspace_payload);

      // A signup receipt and its browser grant must use the same locked
      // participant state. A session write failure should not discard a
      // committed signup, so isolate the optional write with a savepoint.
      async function signupSession(body) {
        if (operation !== 'public.signup') return null;
        const participantId = body && body.participant && body.participant.id;
        if (!participantId) return null;
        await client.query('SAVEPOINT attendee_session_optional');
        try {
          const merged = await attendeeAccess.mergeGrant({
            client, cookieHeader,
            event: { id: event.id, payload: row.payload || {} },
            participantId: String(participantId), phone: normalizedPhone(body.participant.phone),
          });
          await client.query('RELEASE SAVEPOINT attendee_session_optional');
          return { token: merged.token, expiresAt: merged.expiresAt, eventId: event.id };
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT attendee_session_optional');
          await client.query('RELEASE SAVEPOINT attendee_session_optional');
          process.stderr.write('[eventouch] signup session merge failed\n');
          return null;
        }
      }

      let partScope = null;
      if (command) {
        const { resolveEventAuthority } = require('../tenancy');
        try {
          partScope = await resolveEventAuthority(client, account, event.id);
        } catch (error) {
          throw failure(error.status || 403, error.message || '권한을 확인하세요', undefined, error.code);
        }
        if (account && typeof account === 'object') account.orgId = partScope.orgId;
      }

      const receiptResult = await client.query(
        'SELECT event_id, actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1',
        [id]
      );
      const receipt = receiptResult.rows[0];
      const actorId = account && account.id ? String(account.id) : null;
      if (receipt) {
        const { checkReceiptScope } = require('../tenancy');
        try {
          checkReceiptScope(receipt, (account && account.orgId) || event.orgId || undefined);
        } catch (scopeError) {
          throw failure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다', undefined, scopeError.code);
        }
        if (!receiptMatches(receipt, { eventId: event.id, actorId, operation, ticketToken })) {
          throw failure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        if (command === 'participant.bulk-cancel' && !cancellationReceiptMatches(receipt, reviewInput)) {
          throw failure(409, '이 요청 식별자는 다른 취소 검토에 사용되었습니다. 원래 요청을 확인하세요', undefined, 'CANCELLATION_RECEIPT_MISMATCH');
        }
        if (command === 'participant.resolve-cancellation-conflict') {
          const proof = conflictReviewProof(reviewInput);
          if (!proof || proof !== object(receipt.result).conflictReviewProof) {
            throw failure(409, '이 요청 식별자는 다른 확인에 사용되었습니다. 원래 요청을 확인하세요.', undefined, 'CANCELLATION_CONFLICT_RECEIPT_MISMATCH');
          }
          await authorizeGrants(client, event, workspace, account, command, assignmentId, partScope);
        }
        if (command === 'ticket.reissue-reviewed') {
          const original = object(object(receipt.result).response);
          const requested = object(reviewInput);
          if (object(original.participant).id !== clean(requested.id, 120) ||
              !Number.isSafeInteger(requested.expectedTicketRevision) ||
              original.ticketRevision !== requested.expectedTicketRevision + 1) {
            throw failure(409, '이 요청 식별자는 다른 티켓 검토에 사용되었습니다. 원래 요청을 확인하세요', undefined, 'TICKET_REVIEW_MISMATCH');
          }
        }
        if (command === 'ticket.reissue') {
          const original = object(object(receipt.result).response);
          if (!clean(object(original.participant).id, 120) ||
              clean(object(original.participant).id, 120) !== clean(object(reviewInput).id, 120)) {
            throw failure(409, '이 요청 식별자는 다른 티켓 재발급에 사용되었습니다. 원래 요청을 확인하세요', undefined, 'TICKET_REISSUE_MISMATCH');
          }
        }
        if (command === 'ticket.reissue' || command === 'ticket.reissue-reviewed') {
          // A replay can reveal a bearer ticket, even for the old API. Check
          // the actor's current grant after the receipt is matched.
          await authorizeGrants(client, event, workspace, account, command, assignmentId, partScope);
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
        const body = responseFromReceipt(receipt, workspace);
        const session = await signupSession(body);
        return { status: 200, body, replayed: true, session };
      }

      // Grant verdicts only when no receipt matched (see authorizeGrants).
      if (command) await authorizeGrants(client, event, workspace, account, command, assignmentId, partScope);

      // A malformed explicit payment collection must not be normalized into
      // zero reviewed payments for the guarded command. Receipt replay stays
      // ahead of this check; legacy commands retain their existing behavior.
      if (command === 'participant.bulk-cancel' && Object.hasOwn(object(row.workspace_payload), 'payments') &&
          !Array.isArray(object(row.workspace_payload).payments)) {
        throw failure(409, '결제 내역을 확인할 수 없습니다. 최신 명단과 결제 내역을 확인하세요', undefined, 'CANCELLATION_REVIEW_UNAVAILABLE');
      }

      const now = new Date().toISOString();
      const workspaceBefore = structuredClone(workspace);
      const response = await apply({ client, event, workspace, rawWorkspace: row.workspace_payload, commandId: id, now });
      const revoked = Array.isArray(response.revokedParticipantIds)
        ? [...new Set(response.revokedParticipantIds.map(String))] : [];
      if (revoked.length) {
        await attendeeAccess.revokeParticipants(client, event.id, revoked,
          Array.isArray(response.revokedPhones) ? response.revokedPhones : []);
      }
      await client.query(
        `UPDATE event_workspaces
         SET payload = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE event_id = $1`,
        [event.id, JSON.stringify(workspaceChangesForSave(row.workspace_payload, workspaceBefore, workspace))]
      );
      const savedResponse = responseForReceipt(response.body);
      // Write-through projection of ticket identity (see 006_tickets): same
      // transaction as the workspace write, so the two cannot drift. The
      // JSONB participant list stays the read authority.
      await syncTicketRows(client, event, workspace, [...new Set([...savedResponse.participantIds, ...list(response.ticketSyncParticipantIds).map(String)])]);
      const receiptData = {
        operation,
        response: savedResponse.response,
        participantIds: savedResponse.participantIds,
        issuedTicketHashes: savedResponse.issuedTicketHashes,
        ticketHash: ticketToken ? ticketHash(ticketToken) : null,
        participantId: response.participantId || null,
        ...(response.conflictReviewProof ? { conflictReviewProof: response.conflictReviewProof } : {}),
      };
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [id, event.id, actorId, (account && account.orgId) || event.orgId || null, JSON.stringify(receiptData)]
      );
      const session = await signupSession(response.body);
      return {
        status: response.status || 200,
        body: response.body,
        replayed: false,
        session,
      };
    });
  }

  async function signup({ slug, commandId: id, input, cookieHeader }) {
    const eventSlug = clean(slug, 100);
    try {
      commandIdentifier(id);
    } catch (error) {
      const exists = await database.query('SELECT 1 FROM events WHERE slug = $1 LIMIT 1', [eventSlug]);
      if (!exists.rowCount) throw failure(404, '요청한 행사를 찾을 수 없습니다', undefined, 'EVENT_NOT_FOUND');
      throw error;
    }
    const formInput = object(input);
    const signupPhone = normalizedPhone(formInput.phone);
    const result = await mutate({
      ref: 'slug',
      value: eventSlug,
      commandId: id,
      operation: 'public.signup',
      cookieHeader,
      apply: async ({ client, event, workspace, now }) => {
        if (String(event.stage || '').toUpperCase() === 'ENDED') {
          throw failure(409, '종료된 행사에서는 신청할 수 없습니다');
        }
        if (!publicSignupEvent(event)) throw failure(404, '요청한 행사를 찾을 수 없습니다');
        if (workspace.registrationOpen !== true || !(Number(workspace.publishedVersion) > 0)) {
          throw failure(409, '현재 신청을 받지 않습니다');
        }
        const expectedVersion = Number(workspace.publishedVersion);
        if (!Number.isInteger(Number(formInput.formVersion)) || Number(formInput.formVersion) !== expectedVersion) {
          throw failure(409, '등록 양식이 변경되었습니다. 최신 양식을 확인하세요', 'formVersion', 'SIGNUP_FORM_CHANGED');
        }
        if (workspace.verificationRequired === true) {
          await attendeeAccess.consumeGrant(client, { token: formInput.verificationGrant, eventId: event.id, phone: signupPhone });
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
    return result;
  }

  async function execute({ eventId, commandId: id, command, payload, account, assignmentId: assignedId, ticketToken }) {
    validCommand(command);
    const guest = GUEST_COMMANDS.has(command);
    if (guest) {
      if (!ticketToken) throw failure(401, '티켓 링크를 확인하세요');
    } else if (!account || !account.id) {
      throw failure(401, '로그인이 필요합니다');
    }

    const result = await mutate({
      ref: 'id',
      value: clean(eventId, 100),
      commandId: id,
      operation: command,
      command: guest ? null : command,
      reviewInput: payload,
      account: guest ? null : account,
      assignmentId: assignedId,
      ticketToken: guest ? ticketToken : null,
      apply: async ({ client, event, workspace, rawWorkspace, commandId: lockedCommandId, now }) => {
        const input = object(payload);
        const nowMs = Date.parse(now);
        const revokedParticipantIds = [];
        const revokedPhones = [];
        if (guest) {
          const participant = activeTicketParticipant(workspace, ticketToken, nowMs);
          if (!participant) throw failure(404, '티켓 링크를 확인할 수 없습니다');
          if (command === 'participant.self-update') {
            if (workspace.registrationOpen !== true || ['ENDED', 'ARCHIVED'].includes(String(event.stage).toUpperCase())) {
              throw failure(409, '수정 기간이 종료되었습니다. 운영자에게 문의하세요');
            }
            const beforePhone = normalizedPhone(participant.phone);
            updateParticipant(
              workspace,
              participant,
              publishedFormInput(input, workspace.publishedFields),
              workspace.publishedFields
            );
            // A changed number breaks the recovery binding: the browser must
            // re-verify the new number before it reads as this participant.
            if (normalizedPhone(participant.phone) !== beforePhone) {
              revokedParticipantIds.push(participant.id);
              revokedPhones.push(beforePhone, normalizedPhone(participant.phone));
            }
          } else {
            if (['ENDED', 'ARCHIVED'].includes(String(event.stage).toUpperCase())) {
              throw failure(409, '취소 기간이 종료되었습니다');
            }
            cancelParticipant(workspace, participant);
            revokedParticipantIds.push(participant.id);
            revokedPhones.push(normalizedPhone(participant.phone));
          }
          return {
            body: { participant: projectParticipant(workspace, event, participant) },
            participantId: participant.id,
            revokedParticipantIds,
            revokedPhones,
          };
        }

        ensureWritableEvent(event);

        if (command === 'participant.create') {
          // How the roster was collected stays on the record: PRE for a list
          // the agency had in advance, ONSITE for a walk-in at the door.
          const requestedType = String(input.registrationType || '').trim().toUpperCase();
          if (requestedType && !['PRE', 'ONSITE'].includes(requestedType)) {
            throw failure(400, '등록 방식을 확인하세요', 'registrationType');
          }
          const participant = createParticipant(event, workspace, input, {
            registrationType: requestedType === 'PRE' ? 'PRE' : 'ONSITE',
            now,
          });
          return { status: 201, body: { participant: projectParticipant(workspace, event, participant) } };
        }

        if (command === 'participant.update') {
          const person = findPerson(workspace, clean(input.id, 120));
          // New editors can compare only the values they intend to change.
          // Older callers may omit these guards and retain their API behavior.
          if (input.expectedFormVersion !== undefined &&
              (!Number.isSafeInteger(input.expectedFormVersion) || input.expectedFormVersion < 0 ||
               input.expectedFormVersion !== (Number(workspace.formVersion) || 0))) {
            throw failure(409, '신청 항목이 변경되었습니다. 최신 항목을 확인한 뒤 다시 저장하세요', 'expectedFormVersion');
          }
          if (input.expectedValues !== undefined) {
            if (!input.expectedValues || typeof input.expectedValues !== 'object' || Array.isArray(input.expectedValues)) {
              throw failure(400, '수정 기준을 확인하세요', 'expectedValues');
            }
            const expected = input.expectedValues;
            const actual = {
              name: clean(person.name, 60), phone: normalizedPhone(person.phone), email: clean(person.email, 120),
              company: clean(person.company, 200), group: clean(person.group, 80) || '일반',
            };
            for (const key of Object.keys(actual)) {
              if (Object.hasOwn(expected, key) && expected[key] !== actual[key]) {
                throw failure(409, '참가자 정보가 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장하세요', 'expectedValues');
              }
            }
            if (expected.answers !== undefined) {
              if (!expected.answers || typeof expected.answers !== 'object' || Array.isArray(expected.answers)) {
                throw failure(400, '수정 기준을 확인하세요', 'expectedValues');
              }
              const currentAnswers = object(person.answers);
              for (const [key, value] of Object.entries(expected.answers)) {
                if ((currentAnswers[key] ?? null) !== value) {
                  throw failure(409, '참가자 답변이 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장하세요', 'expectedValues');
                }
              }
            }
          }
          const beforePhone = normalizedPhone(person.phone);
          updateParticipant(workspace, person, input, workspace.fields);
          if (normalizedPhone(person.phone) !== beforePhone) {
            revokedParticipantIds.push(person.id);
            revokedPhones.push(beforePhone, normalizedPhone(person.phone));
          }
          return { body: { participant: projectParticipant(workspace, event, person) }, revokedParticipantIds, revokedPhones };
        }

        if (command === 'participant.resolve-cancellation-conflict') {
          const proof = conflictReviewProof(input);
          if (!proof) throw failure(400, '확인 사유와 참가 의사를 확인하세요.', 'reason');
          const person = findPerson(workspace, input.id);
          const fingerprint = cancellationConflictFingerprint(workspace, rawWorkspace, event, person);
          if (!fingerprint || fingerprint !== input.fingerprint) {
            throw failure(409, '참가자 또는 관련 기록이 변경되었습니다. 최신 정보를 다시 확인하세요.', undefined, 'CANCELLATION_CONFLICT_REVIEW_CHANGED');
          }
          if (!['DRAFT', 'READY', 'LIVE'].includes(String(event.stage || '').toUpperCase()) ||
              (person.revoked !== undefined && typeof person.revoked !== 'boolean') ||
              (person.ticketRevision !== undefined && (!Number.isSafeInteger(person.ticketRevision) || person.ticketRevision < 0))) {
            throw failure(409, '행사 또는 티켓 상태를 먼저 확인하세요.', undefined, 'CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE');
          }
          const phone = normalizedPhone(person.phone);
          if (typeof person.name !== 'string' || !clean(person.name, 60) || typeof person.phone !== 'string' ||
              (person.company !== undefined && typeof person.company !== 'string') || !/^\d{9,15}$/.test(phone)) {
            throw failure(409, '참가자의 이름과 연락처를 먼저 확인하세요.', undefined, 'CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE');
          }
          if (list(workspace.participants).filter(item => item && cancellationConflictIdentity(item) === cancellationConflictIdentity(person)).length !== 1) {
            throw failure(409, '표시된 이름과 소속, 연락처가 같은 참가자가 있습니다. 대상을 먼저 구분하세요.', undefined, 'CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE');
          }
          if ((Object.hasOwn(person, 'inside') && typeof person.inside !== 'boolean') || person.inside === true) {
            throw failure(409, '입장 상태를 확인하고 필요한 경우 퇴장 기록을 먼저 처리하세요.', undefined, 'CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE');
          }
          if (list(workspace.participants).some(item => item && String(item.id) !== person.id && isActive(item) && normalizedPhone(item.phone) === phone)) {
            throw failure(409, '같은 연락처의 다른 참가자가 있습니다. 중복 신청을 먼저 확인하세요.', undefined, 'CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE');
          }
          const paymentStatus = String(person.paymentStatus || '').toUpperCase();
          const payments = list(workspace.payments).filter(item => item && String(item.participantId) === person.id);
          if (!['FREE', 'PAID', 'PENDING'].includes(paymentStatus) || payments.some(item => !['PAID', 'PENDING'].includes(String(item.status || '').toUpperCase()))) {
            throw failure(409, '결제 또는 환불 내역을 먼저 확인하세요.', undefined, 'CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE');
          }
          const capacity = eventCapacity(event);
          if (person.status === 'APPROVED' && capacity > 0 && list(workspace.participants).filter(item => item && String(item.id) !== person.id && isActive(item) && item.status === 'APPROVED').length >= capacity) {
            throw failure(409, '참가 확정 정원이 가득 찼습니다. 정원을 먼저 확인하세요.', undefined, 'CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE');
          }
          // Clearing the old flag must never reactivate an old bearer link or
          // an existing attendee session. Reissue remains a separate review.
          person.cancelled = false;
          person.revoked = true;
          person.ticketNeedsExplicitReissue = true;
          person.ticketRevision = ticketRevision(person) + 1;
          if (!Array.isArray(workspace.audit)) workspace.audit = [];
          workspace.audit.unshift({ id: lockedCommandId, type: command, actor: String(account.id), at: now,
            detail: `${clean(person.name, 60)} · ${input.reason.trim()}`, eventId: event.id,
            cancellationResolution: { participantId: person.id, participantName: clean(person.name, 60), status: person.status, reason: input.reason.trim(), previousCancelled: true, ticketRevoked: true } });
          return { body: { review: { participantId: person.id, resolutionId: lockedCommandId, status: person.status, ticketRevoked: true,
            reviewedName: clean(person.name, 60), reviewedCompany: clean(person.company, 100), reviewedMaskedPhone: `${phone.slice(0, 3)}-****-${phone.slice(-4)}` } },
            conflictReviewProof: proof, ticketSyncParticipantIds: [person.id], revokedParticipantIds: [person.id], revokedPhones: [phone] };
        }

        if (command === 'participant.status' || command === 'participant.bulk-cancel') {
          const status = clean(input.status, 24).toUpperCase();
          const ids = Array.isArray(input.ids) ? input.ids : [input.id];
          if (!ids.length || ids.length > 1000 || ids.some((item) => !clean(item, 120))) {
            throw failure(400, '참가자를 선택하세요', 'ids');
          }
          const people = ids.map((personId) => findPerson(workspace, clean(personId, 120)));
          let cancellationReview = null;
          if (command === 'participant.bulk-cancel') {
            const reviewed = input.expectedCancellations;
            const cleanIds = ids.map((personId) => clean(personId, 120));
            if (status !== 'CANCELLED' || !Array.isArray(reviewed) || reviewed.length !== people.length ||
                new Set(cleanIds).size !== cleanIds.length || reviewed.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
                  typeof item.id !== 'string' || !item.id || !['PENDING', 'APPROVED', 'WAITLIST'].includes(item.status) ||
                  typeof item.inside !== 'boolean' || !Array.isArray(item.paidPaymentIds) ||
                  item.paidPaymentIds.some((paymentId) => typeof paymentId !== 'string' || !paymentId || paymentId.length > 120))) {
              throw failure(400, '취소 대상의 참가 상태와 결제 내역을 다시 확인하세요', 'expectedCancellations');
            }
            const byId = new Map(reviewed.map((item) => [item.id, item]));
            if (byId.size !== cleanIds.length || cleanIds.some((personId) => !byId.has(personId))) {
              throw failure(400, '취소 대상의 참가 상태와 결제 내역을 다시 확인하세요', 'expectedCancellations');
            }
            const targets = people.map((person) => {
              const expected = byId.get(String(person.id));
              if (Object.hasOwn(person, 'inside') && typeof person.inside !== 'boolean') {
                throw failure(409, '입장 상태를 확인할 수 없습니다. 현장 기록을 확인하세요', undefined, 'CANCELLATION_REVIEW_UNAVAILABLE');
              }
              const paid = list(workspace.payments).filter((payment) => payment && payment.participantId === person.id && payment.status === 'PAID');
              if (paid.some((payment) => typeof payment.id !== 'string' || !payment.id || payment.id.length > 120)) {
                throw failure(409, '결제 내역을 확인할 수 없습니다. 최신 명단과 결제 내역을 확인하세요', undefined, 'CANCELLATION_REVIEW_UNAVAILABLE');
              }
              const paidPaymentIds = paid.map((payment) => payment.id).sort();
              if (String(person.status || '').toUpperCase() !== expected.status || (person.inside === true) !== expected.inside ||
                  JSON.stringify(paidPaymentIds) !== JSON.stringify([...expected.paidPaymentIds].sort())) {
                throw failure(409, '참가 상태, 입장 또는 결제 내역이 바뀌었습니다. 최신 내용을 확인하세요', undefined, 'CANCELLATION_REVIEW_CHANGED');
              }
              return { id: String(person.id), status: expected.status, inside: expected.inside, paidPaymentIds };
            });
            cancellationReview = { status: 'CANCELLED', targets };
          }
          if (Object.hasOwn(input, 'expectedStatus')) {
            const expectedStatus = clean(input.expectedStatus, 24).toUpperCase();
            if (!['APPROVED', 'PENDING', 'WAITLIST', 'CANCELLED'].includes(expectedStatus)) {
              throw failure(400, '확인한 참가 상태를 다시 불러오세요', 'expectedStatus');
            }
            if (people.some((person) => String(person.status || '').toUpperCase() !== expectedStatus)) {
              throw failure(409, '참가 상태가 바뀌었습니다. 명단을 다시 확인하세요.', undefined, 'PARTICIPANT_STATUS_CHANGED');
            }
          }
          for (const person of people) setParticipantStatus(event, workspace, person, status, now);
          for (const person of people) {
            if (person.status === 'CANCELLED') {
              revokedParticipantIds.push(person.id);
              revokedPhones.push(normalizedPhone(person.phone));
            }
          }
          return { body: { participants: people.map((person) => projectParticipant(workspace, event, person)),
            ...(cancellationReview ? { cancellationReview } : {}) }, revokedParticipantIds, revokedPhones };
        }

        if (command === 'ticket.reissue' || command === 'ticket.reissue-reviewed') {
          const person = findPerson(workspace, clean(input.id, 120));
          const expected = input.expectedTicketRevision;
          if (command === 'ticket.reissue-reviewed' && (!Number.isSafeInteger(expected) || expected < 0)) {
            throw failure(400, '확인한 티켓 상태를 다시 불러오세요', 'expectedTicketRevision');
          }
          if (expected !== undefined) {
            if (!Number.isSafeInteger(expected) || expected < 0) {
              throw failure(400, '확인한 티켓 상태를 다시 불러오세요', 'expectedTicketRevision');
            }
            if (expected !== ticketRevision(person) || person.status === 'CANCELLED') {
              throw failure(409, '티켓 또는 참가 상태가 변경되었습니다. 최신 참가자 정보를 확인하세요', undefined, 'TICKET_REVISION_CHANGED');
            }
          }
          if (person.cancelled === true && String(person.status || '').toUpperCase() !== 'CANCELLED') {
            throw failure(409, '신청 상태와 취소 기록이 일치하지 않습니다. 시스템 관리자에게 확인하세요.', undefined, 'TICKET_STATUS_CONFLICT');
          }
          if (String(person.status || '').toUpperCase() === 'CANCELLED') throw failure(409, '활성 참가자만 티켓을 재발급할 수 있습니다');
          reissueTicket(event, person, now);
          return { body: { participant: projectParticipant(workspace, event, person), ticketRevision: ticketRevision(person) } };
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
            try {
              // Rebuild the input from the columns an import row may carry, so
              // a row-level key (the file row number `line`, for one) can never
              // be mistaken for the answer of a form field with the same id.
              const source = object(row);
              const carried = object(source.answers);
              const participant = createParticipant(event, workspace, {
                name: source.name, phone: source.phone, email: source.email, company: source.company, group: source.group,
                answers: carried,
              }, {
                registrationType: 'PRE',
                fields: importFieldsFor(workspace, carried),
                now,
              });
              participant.status = 'APPROVED';
              participant.consent = null;
              created.push(participant);
            } catch (error) {
              // Bulk import processes the previewed rows in order. Name the
              // file row so the operator can find it in a large roster.
              const line = row && Number.isSafeInteger(row.line) && row.line > 0 ? `파일 ${row.line}번째 행: ` : '';
              const message = error && error.message ? error.message : '참가자를 등록하지 못했습니다';
              const status = error && Number.isSafeInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 400;
              throw failure(status, `${line}${message}`, error && error.field, error && error.code);
            }
          }
          return { body: { participants: created.map((person) => projectParticipant(workspace, event, person)) } };
        }

        throw failure(400, '지원하지 않는 참가자 작업입니다');
      },
    });
    return ['ticket.reissue', 'ticket.reissue-reviewed'].includes(command) ? { ...result, body: { ...result.body, ticketPublicBase: publicOrigin() } } : result;
  }

  return { signup, execute };
}

module.exports = { createParticipantCommands, COMMANDS };
