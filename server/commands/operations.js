'use strict';

const crypto = require('node:crypto');
const { normalizeEvent, normalizeWorkspace } = require('../state');

const COMMANDS = new Set([
  'desk.save',
  'desk.set-open',
  'staff.assign',
  'staff.unassign',
  'check.scan',
  'check.correct',
  'booth.save',
  'booth.mode',
  'booth.visit',
]);
const STAFF_ASSIGNMENTS = new Map([
  ['check.scan', 'DESK'],
  ['check.correct', 'DESK'],
  ['booth.visit', 'BOOTH'],
]);

function failure(status, message, field) {
  const error = new Error(message);
  error.status = status;
  if (field) error.field = field;
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

function nextId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function ticketCode(value) {
  const raw = clean(value, 2048);
  if (!raw.includes('ticket=')) return raw;
  try {
    const query = raw.slice(raw.indexOf('?') + 1);
    return new URLSearchParams(query).get('ticket') || raw;
  } catch (error) {
    return raw;
  }
}

function findTicket(workspace, token) {
  return list(workspace.participants).find((person) => person && person.ticket === token) || null;
}

function ensureNotArchived(event) {
  if (String(event.stage || '').toUpperCase() === 'ARCHIVED') {
    throw failure(409, '보관된 행사는 변경할 수 없습니다');
  }
}

function requireLive(event, message) {
  if (String(event.stage || '').toUpperCase() !== 'LIVE') throw failure(409, message);
}

function ticketHash(token) {
  return token ? crypto.createHash('sha256').update(token).digest('hex') : null;
}

function commandReceiptMatches(receipt, { eventId, actorId, command, ticketToken, participantId }) {
  const result = object(receipt && receipt.result);
  const receiptActorId = receipt && receipt.actor_id != null ? String(receipt.actor_id) : null;
  const expectedActorId = actorId == null ? null : String(actorId);
  return receipt && String(receipt.event_id) === String(eventId) &&
    receiptActorId === expectedActorId && result.command === command &&
    (result.ticketHash || null) === ticketHash(ticketToken) &&
    (result.participantId || null) === (participantId || null);
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

async function currentAssignments(client, eventId) {
  const result = await client.query(
    `SELECT id, account_id, type, target_id
     FROM staff_assignments
     WHERE event_id = $1 AND active = true
     ORDER BY created_at, id`,
    [String(eventId)]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    accountId: String(row.account_id),
    type: String(row.type),
    targetId: String(row.target_id),
  }));
}

async function authorize(client, event, workspace, account, command, assignmentId) {
  if (!account || !account.id) throw failure(401, '로그인이 필요합니다');
  const accountResult = await client.query(
    'SELECT role, active FROM accounts WHERE id = $1 LIMIT 1',
    [String(account.id)]
  );
  const current = accountResult.rows[0];
  if (!current || current.active !== true || !['AGENCY', 'MANAGER', 'STAFF'].includes(current.role)) {
    throw failure(401, '로그인이 필요합니다');
  }
  if (current.role === 'AGENCY') return { role: current.role, assignment: null };
  if (current.role === 'MANAGER') {
    const membership = await client.query(
      'SELECT 1 FROM memberships WHERE account_id = $1 AND event_id = $2 LIMIT 1 FOR SHARE',
      [String(account.id), event.id]
    );
    if (!membership.rowCount) throw failure(403, '권한을 확인하세요');
    return { role: current.role, assignment: null };
  }

  const expectedType = STAFF_ASSIGNMENTS.get(command);
  if (!expectedType || !assignmentId) throw failure(403, '권한을 확인하세요');
  const assignmentResult = await client.query(
    `SELECT id, type, target_id
     FROM staff_assignments
     WHERE id = $1 AND account_id = $2 AND event_id = $3 AND active = true
     LIMIT 1 FOR UPDATE`,
    [String(assignmentId), String(account.id), event.id]
  );
  const row = assignmentResult.rows[0];
  const target = String(row && row.target_id || '');
  const targetExists = expectedType === 'DESK'
    ? list(workspace.desks).some((desk) => desk && String(desk.id) === target)
    : list(workspace.booths).some((booth) => booth && String(booth.id) === target);
  if (!row || row.type !== expectedType || !targetExists) throw failure(403, '권한을 확인하세요');
  return {
    role: current.role,
    assignment: { id: String(row.id), type: String(row.type), targetId: target },
  };
}

function activeParticipant(workspace, token) {
  const person = findTicket(workspace, token);
  if (!person || person.revoked === true || String(person.status || '').toUpperCase() === 'CANCELLED') {
    throw failure(404, '티켓 링크를 확인할 수 없습니다.');
  }
  if (String(person.status || '').toUpperCase() !== 'APPROVED') {
    throw failure(409, '입장 가능한 티켓이 아닙니다. 등록 상태를 확인하세요.');
  }
  const expiry = Date.parse(person.ticketExpiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw failure(404, '티켓 링크를 확인할 수 없습니다.');
  }
  if (!['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase())) {
    throw failure(409, '결제가 완료되지 않았습니다. 결제 상태를 확인하세요.');
  }
  return person;
}

function updateDesk(workspace, input) {
  const name = clean(input.name, 60);
  const action = clean(input.action, 8).toUpperCase();
  const mode = clean(input.mode, 16).toLowerCase();
  if (!name) throw failure(400, '데스크 이름을 입력하세요', 'name');
  if (!['IN', 'OUT'].includes(action) || !['desk', 'tablet'].includes(mode)) {
    throw failure(400, '데스크 작업과 화면을 선택하세요');
  }

  const id = clean(input.id, 120);
  const old = id ? list(workspace.desks).find((desk) => desk && String(desk.id) === id) : null;
  if (id && !old) throw failure(404, '데스크를 찾을 수 없습니다');
  const changedDirection = !!old && old.action !== action;
  if (changedDirection && input.confirmDirectionChange !== true) {
    throw failure(400, '입장·퇴장 방향 변경을 확인한 뒤 저장하세요.');
  }

  const desk = old || { id: nextId('desk') };
  Object.assign(desk, {
    id: String(desk.id),
    name,
    action,
    mode,
    open: changedDirection ? false : input.open !== false,
  });
  if (!old) workspace.desks.push(desk);
  return { status: old ? 200 : 201, body: { desk: structuredClone(desk) } };
}

function setDeskOpen(workspace, input) {
  const desk = list(workspace.desks).find((item) => item && String(item.id) === clean(input.id, 120));
  if (!desk) throw failure(404, '데스크를 찾을 수 없습니다.');
  if (typeof input.open !== 'boolean') throw failure(400, '데스크 가동 상태를 지정하세요.');
  desk.open = input.open;
  return { body: { desk: structuredClone(desk) } };
}

async function assignStaff(client, event, workspace, input) {
  const accountId = clean(input.accountId, 120);
  const type = clean(input.type, 12).toUpperCase();
  const targetId = clean(input.targetId, 120);
  if (!accountId || !['DESK', 'BOOTH'].includes(type) || !targetId) {
    throw failure(400, '스태프와 담당 업무를 확인하세요');
  }
  const accountResult = await client.query(
    'SELECT role, active FROM accounts WHERE id = $1 LIMIT 1',
    [accountId]
  );
  const targetExists = type === 'DESK'
    ? list(workspace.desks).some((desk) => desk && String(desk.id) === targetId)
    : list(workspace.booths).some((booth) => booth && String(booth.id) === targetId);
  if (!accountResult.rows[0] || accountResult.rows[0].active !== true || accountResult.rows[0].role !== 'STAFF') {
    throw failure(400, '활성 현장 스태프를 선택하세요.');
  }
  if (!targetExists) throw failure(404, '선택한 업무 대상을 찾을 수 없습니다.');
  if (type === 'BOOTH' && !list(event.features).includes('stamp')) {
    throw failure(409, '이 행사에서 부스 인증 기능을 먼저 켜세요.');
  }

  const existing = await client.query(
    `SELECT id, active FROM staff_assignments
     WHERE event_id = $1 AND account_id = $2 AND type = $3 AND target_id = $4
     LIMIT 1 FOR UPDATE`,
    [event.id, accountId, type, targetId]
  );
  if (existing.rows[0] && existing.rows[0].active === true) {
    throw failure(409, '이미 같은 업무가 배정되어 있습니다.');
  }

  const assignmentId = nextId('assignment');
  if (existing.rows[0]) {
    // Rotate the link on re-assignment so a previously revoked QR never becomes valid again.
    await client.query(
      'UPDATE staff_assignments SET id = $2, active = true, created_at = now() WHERE id = $1',
      [String(existing.rows[0].id), assignmentId]
    );
  } else {
    await client.query(
      `INSERT INTO staff_assignments (id, account_id, event_id, type, target_id, active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [assignmentId, accountId, event.id, type, targetId]
    );
  }
  const assignment = { id: assignmentId, accountId, type, targetId };
  workspace.assignments.push(assignment);
  return { status: 201, body: { assignment } };
}

async function revokeStaff(client, event, workspace, input) {
  const id = clean(input.id, 120);
  const assignment = list(workspace.assignments).find((item) => item && String(item.id) === id);
  if (!assignment) throw failure(404, '해제할 업무 배정을 찾을 수 없습니다.');
  const revoked = await client.query(
    'UPDATE staff_assignments SET active = false WHERE id = $1 AND event_id = $2 AND active = true',
    [id, event.id]
  );
  if (!revoked.rowCount) throw failure(404, '해제할 업무 배정을 찾을 수 없습니다.');
  workspace.assignments = list(workspace.assignments).filter((item) => String(item.id) !== id);
  return { body: { ok: true } };
}

function scan(workspace, event, actor, input, assignment) {
  requireLive(event, '행사 진행 중에 입퇴장을 처리할 수 있습니다. 매니저에게 진행 단계 확인을 요청하세요.');
  const deskId = clean(input.deskId || input.targetId, 120);
  const desk = list(workspace.desks).find((item) => item && String(item.id) === deskId);
  if (!desk) throw failure(400, '등록 데스크를 선택하세요.');
  if (desk.open === false) throw failure(409, '이 데스크는 닫혀 있습니다. 매니저가 다시 열 때까지 입퇴장을 처리하지 않습니다.');
  if (assignment && (assignment.type !== 'DESK' || assignment.targetId !== deskId)) {
    throw failure(403, '배정된 데스크에서만 처리할 수 있습니다.');
  }
  const code = ticketCode(input.ticket);
  let person = null;
  let idPath = false;
  if (code) {
    person = findTicket(workspace, code);
    if (!person) throw failure(404, '이 행사에서 티켓을 찾을 수 없습니다. 다른 행사 또는 잘못된 코드를 확인하세요.');
  } else {
    const participantId = clean(input.participantId, 120);
    if (!participantId) throw failure(400, '티켓 코드를 입력하세요.', 'ticket');
    person = list(workspace.participants).find((item) => item && String(item.id) === participantId) || null;
    if (!person) throw failure(404, '이 행사에서 참가자를 찾을 수 없습니다. 이름으로 다시 검색하세요.');
    idPath = true;
  }
  if (person.revoked === true || String(person.status || '').toUpperCase() !== 'APPROVED') {
    throw failure(409, '입장 가능한 티켓이 아닙니다. 등록 상태를 확인하세요.');
  }
  if (idPath ? clean(person.ticketExpiresAt, 64) !== '' : true) {
    const expiry = Date.parse(person.ticketExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      throw failure(409, '티켓이 만료되었습니다. 운영자에게 재발급을 요청하세요.');
    }
  }
  if (!['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase())) {
    throw failure(409, '결제가 완료되지 않았습니다. 결제 상태를 확인하세요.');
  }
  const action = clean(desk.action, 8).toUpperCase();
  if (!['IN', 'OUT'].includes(action)) throw failure(409, '데스크 작업을 확인하세요.');
  if (action === 'IN' && person.inside === true) throw failure(409, '이미 입장한 참가자입니다. 중복 처리하지 않았습니다.');
  if (action === 'OUT' && person.inside !== true) throw failure(409, '현재 입장 상태가 아닙니다. 퇴장 처리하지 않았습니다.');
  if (action === 'IN' && person.everIn === true && workspace.allowReentry !== true) {
    throw failure(409, '재입장을 허용하지 않는 행사입니다.');
  }

  const before = { inside: person.inside === true, everIn: person.everIn === true };
  person.inside = action === 'IN';
  person.everIn = before.everIn || action === 'IN';
  const row = {
    id: '',
    participantId: String(person.id),
    name: String(person.name || ''),
    action,
    deskId,
    actor: String(actor.id),
    at: '',
    before,
    corrected: false,
  };
  return {
    row,
    body: {
      name: String(person.name || ''),
      id: String(person.id),
      action,
      reentry: action === 'IN' && before.everIn,
    },
  };
}

function correctCheck(workspace, event, actor, input, assignment, now, commandId) {
  ensureNotArchived(event);
  const id = clean(input.id, 120);
  const row = list(workspace.checks).find((check) => check && String(check.id) === id);
  if (!row || row.corrected === true) throw failure(409, '정정할 수 없는 기록입니다.');
  const reason = clean(input.reason, 300);
  if (!reason) throw failure(400, '정정 사유를 입력하세요.', 'reason');
  if (assignment && (assignment.type !== 'DESK' || assignment.targetId !== String(row.deskId) ||
    String(row.actor) !== String(actor.id))) {
    throw failure(403, '본인이 배정된 데스크에서 처리한 기록만 정정할 수 있습니다.');
  }

  row.corrected = true;
  row.correction = { id: commandId, reason, actor: String(actor.id), at: now };
  const person = list(workspace.participants).find((item) => item && String(item.id) === String(row.participantId));
  if (person) {
    const records = list(workspace.checks)
      .filter((check) => check && String(check.participantId) === String(person.id) && check.corrected !== true)
      .reverse();
    person.inside = records.length ? records[records.length - 1].action === 'IN' : false;
    person.everIn = records.some((check) => check.action === 'IN');
  }
  return { body: { check: structuredClone(row) } };
}

function updateBooth(workspace, event, input) {
  if (!list(event.features).includes('stamp')) throw failure(409, '이 행사에서 부스 인증 기능을 먼저 켜세요.');
  const id = clean(input.id, 120);
  const old = id ? list(workspace.booths).find((booth) => booth && String(booth.id) === id) : null;
  if (id && !old) throw failure(404, '부스를 찾을 수 없습니다.');
  const name = clean(input.name, 60);
  const zone = clean(input.zone, 120);
  const status = clean(input.status, 16).toUpperCase();
  const capacity = Number(input.capacity);
  const limit = Number(input.limit);
  if (!name) throw failure(400, '부스명을 입력하세요.', 'name');
  if (!Number.isInteger(capacity) || capacity < 0 || !Number.isInteger(limit) || limit < 1) {
    throw failure(400, '수량은 0 이상, 횟수는 1 이상의 정수로 입력하세요.');
  }
  if (!['WAITING', 'OPEN', 'CLOSED'].includes(status)) throw failure(400, '부스 상태를 선택하세요.', 'status');
  const startsAt = clean(input.startsAt, 64);
  const endsAt = clean(input.endsAt, 64);
  const startMs = startsAt ? Date.parse(startsAt) : null;
  const endMs = endsAt ? Date.parse(endsAt) : null;
  if ((startsAt && !Number.isFinite(startMs)) || (endsAt && !Number.isFinite(endMs)) ||
    (startMs !== null && endMs !== null && startMs >= endMs)) {
    throw failure(400, '종료 시간은 시작 이후여야 합니다.');
  }
  const used = Math.max(0, Number(old && old.used) || 0);
  if (capacity > 0 && capacity < used) throw failure(409, '이미 사용한 수량보다 적게 설정할 수 없습니다.');
  const booth = old || { id: nextId('booth') };
  Object.assign(booth, {
    id: String(booth.id),
    name,
    zone,
    status,
    capacity,
    limit,
    used,
    startsAt,
    endsAt,
  });
  if (!old) workspace.booths.push(booth);
  return { status: old ? 200 : 201, body: { booth: structuredClone(booth) } };
}

function setBoothMode(workspace, input) {
  if (list(workspace.visits).length) throw failure(409, '인증 기록이 있어 방식을 변경할 수 없습니다.');
  const mode = clean(input.mode, 12).toUpperCase();
  if (!['SELF', 'STAFF'].includes(mode) || input.acknowledge !== true) {
    throw failure(400, '인증 방식과 QR 스캔 방향을 확인하세요.');
  }
  workspace.stampMode = mode;
  return { body: { stampMode: mode } };
}

function visitBooth(workspace, event, actor, input, assignment, now, commandId, guestTicketToken) {
  requireLive(event, '현재 스탬프 인증을 진행하지 않습니다.');
  if (!list(event.features).includes('stamp')) throw failure(409, '현재 스탬프 인증을 진행하지 않습니다.');
  let boothId;
  if (guestTicketToken) {
    if (workspace.stampMode !== 'SELF') throw failure(409, '스태프가 티켓을 확인하는 방식입니다. 본인의 티켓을 제시하세요.');
    const prefix = `ET:BOOTH:${event.id}:`;
    const code = clean(input.code, 512);
    if (!code.startsWith(prefix)) throw failure(400, '이 행사의 부스 QR이 아닙니다.');
    boothId = code.slice(prefix.length);
  } else {
    if (workspace.stampMode !== 'STAFF') throw failure(409, '참가자가 부스 QR을 스캔하는 방식입니다.');
    boothId = clean(input.boothId || input.targetId, 120);
  }
  const booth = list(workspace.booths).find((item) => item && String(item.id) === boothId);
  if (!booth) throw failure(404, '부스를 찾을 수 없습니다.');
  if (assignment && (assignment.type !== 'BOOTH' || assignment.targetId !== boothId)) {
    throw failure(403, '배정된 부스만 처리할 수 있습니다.');
  }
  const token = guestTicketToken || ticketCode(input.ticket);
  if (!token) throw failure(400, '참가자 티켓을 입력하세요.', 'ticket');
  const person = findTicket(workspace, token);
  if (!person) throw failure(404, '부스 또는 참가자 티켓을 확인하세요.');
  if (person.revoked === true || String(person.status || '').toUpperCase() !== 'APPROVED') {
    throw failure(409, '사용할 수 없는 참가자 티켓입니다.');
  }
  const expiresAt = Date.parse(person.ticketExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw failure(409, '티켓이 만료되었습니다.');
  if (!['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase())) {
    throw failure(409, '결제가 완료된 참가자만 이용할 수 있습니다.');
  }
  if (person.inside !== true) throw failure(409, '행사 입장 후 부스를 이용할 수 있습니다.');
  if (booth.status !== 'OPEN') {
    throw failure(409, booth.status === 'CLOSED' ? '종료된 부스입니다.' : '아직 운영을 시작하지 않은 부스입니다.');
  }
  const current = Date.now();
  const startsAt = booth.startsAt ? Date.parse(booth.startsAt) : null;
  const endsAt = booth.endsAt ? Date.parse(booth.endsAt) : null;
  if ((startsAt !== null && Number.isFinite(startsAt) && current < startsAt) ||
    (endsAt !== null && Number.isFinite(endsAt) && current > endsAt)) {
    throw failure(409, '부스 운영 시간이 아닙니다.');
  }
  const capacity = Number(booth.capacity) || 0;
  if (capacity > 0 && Number(booth.used || 0) >= capacity) throw failure(409, '부스 수량이 모두 소진되었습니다.');
  const limit = Math.max(1, Number(booth.limit) || 1);
  const priorVisits = list(workspace.visits).filter((visit) =>
    visit && String(visit.boothId) === boothId && String(visit.participantId) === String(person.id)
  ).length;
  if (priorVisits >= limit) throw failure(409, '이 부스의 인증 횟수를 모두 사용했습니다.');

  booth.used = Math.max(0, Number(booth.used) || 0) + 1;
  const row = {
    id: commandId,
    boothId,
    participantId: String(person.id),
    name: String(person.name || ''),
    actor: String(actor.id),
    at: now,
    mode: workspace.stampMode,
  };
  workspace.visits.unshift(row);
  return { status: 201, body: { name: String(person.name || ''), booth: String(booth.name || '') } };
}

function appendAudit(workspace, event, account, command, input, commandId, now) {
  if (!Array.isArray(workspace.audit)) workspace.audit = [];
  workspace.audit.unshift({
    id: commandId,
    type: command,
    actor: String(account.id),
    at: now,
    detail: clean(input.reason || input.name || input.title, 300),
    eventId: event.id,
  });
}

function createOperationsCommands(database) {
  async function execute({ eventId, commandId: rawId, command, payload, account, assignmentId, ticketToken: rawTicketToken }) {
    if (!COMMANDS.has(command)) throw failure(400, '지원하지 않는 현장 운영 작업입니다.', 'command');
    const id = commandIdentifier(rawId);
    const ticketToken = command === 'booth.visit' ? clean(rawTicketToken, 2048) : '';
    const guest = !account && !!ticketToken;
    if ((!account || !account.id) && !guest) throw failure(401, '로그인이 필요합니다');

    return database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const row = await lockEvent(client, eventId);
      if (!row) throw failure(404, '요청한 행사를 찾을 수 없습니다.');
      const event = normalizeEvent(row);
      const workspace = normalizeWorkspace(row.workspace_payload);
      workspace.assignments = await currentAssignments(client, event.id);
      const guestPerson = guest ? activeParticipant(workspace, ticketToken) : null;
      const operationActor = guest ? { id: guestPerson.id } : account;
      const authorized = guest
        ? { role: 'GUEST', assignment: null }
        : await authorize(client, event, workspace, account, command, assignmentId);

      const receiptResult = await client.query(
        'SELECT event_id, actor_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1',
        [id]
      );
      const receipt = receiptResult.rows[0];
      const pendingInput = object(payload);
      const pendingTicket = command === 'check.scan' ? ticketCode(pendingInput.ticket) : '';
      const pendingParticipantId = command === 'check.scan' && !pendingTicket
        ? clean(pendingInput.participantId, 120) || null
        : null;
      if (receipt) {
        if (!commandReceiptMatches(receipt, {
          eventId: event.id,
          actorId: guest ? null : account.id,
          command,
          ticketToken: guest ? ticketToken : null,
          participantId: pendingParticipantId,
        })) {
          throw failure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다.');
        }
        return { status: 200, body: structuredClone(object(receipt.result).response), replayed: true };
      }

      const input = pendingInput;
      const now = new Date().toISOString();
      ensureNotArchived(event);
      let result;
      switch (command) {
        case 'desk.save':
          result = updateDesk(workspace, input);
          break;
        case 'desk.set-open':
          result = setDeskOpen(workspace, input);
          break;
        case 'staff.assign':
          result = await assignStaff(client, event, workspace, input);
          break;
        case 'staff.unassign':
          result = await revokeStaff(client, event, workspace, input);
          break;
        case 'check.scan': {
          const scanResult = scan(workspace, event, account, input, authorized.assignment);
          scanResult.row.id = id;
          scanResult.row.at = now;
          workspace.checks.unshift(scanResult.row);
          result = { body: scanResult.body };
          break;
        }
        case 'check.correct':
          result = correctCheck(workspace, event, account, input, authorized.assignment, now, id);
          break;
        case 'booth.save':
          result = updateBooth(workspace, event, input);
          break;
        case 'booth.mode':
          if (!list(event.features).includes('stamp')) throw failure(409, '이 행사에서 부스 인증 기능을 먼저 켜세요.');
          result = setBoothMode(workspace, input);
          break;
        case 'booth.visit':
          result = visitBooth(
            workspace, event, operationActor, input, authorized.assignment, now, id, guest ? ticketToken : ''
          );
          break;
        default:
          throw failure(400, '지원하지 않는 현장 운영 작업입니다.', 'command');
      }

      appendAudit(workspace, event, operationActor, command, input, id, now);
      await client.query(
        `UPDATE event_workspaces
         SET payload = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE event_id = $1`,
        [event.id, JSON.stringify(workspace)]
      );
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, result)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, event.id, guest ? null : String(account.id), JSON.stringify({
          command,
          response: result.body || {},
          ticketHash: ticketHash(guest ? ticketToken : null),
          participantId: pendingParticipantId,
        })]
      );
      return { status: result.status || 200, body: result.body || {}, replayed: false };
    });
  }

  return {
    execute,
    supports(command) {
      return COMMANDS.has(command);
    },
  };
}

module.exports = { createOperationsCommands, COMMANDS };
