'use strict';

const { normalizeEvent, normalizeWorkspace, workspaceChangesForSave, operatorDeskProjection, operatorBoothTime } = require('../state');
const { managerWriteAllowed } = require('../event-permissions');
const { attendanceNeedsReview, indexLatestChecks } = require('../../apps/web/lib/attendance-state.cjs');
const { reconciliationIndex, ownValue } = require('../attendance-reconciliation');
const { attendanceSourceAvailability } = require('../attendance-source-availability');
const {
  failure,
  object,
  list,
  clean,
  commandIdentifier,
  nextId,
  ticketHash,
  findTicket,
  ticketCode,
} = require('./shared.ts');

const COMMANDS = new Set([
  'desk.save',
  'desk.set-open',
  'staff.assign',
  'staff.unassign',
  'check.scan',
  'check.correct',
  'check.reviewed-exit',
  'check.reconcile',
  'booth.save',
  'booth.mode',
  'booth.mode-reviewed',
  'booth.visit',
  'reward.lookup',
  'reward.collect',
]);
const STAFF_ASSIGNMENTS = new Map([
  ['check.scan', 'DESK'],
  ['check.correct', 'DESK'],
  ['booth.visit', 'BOOTH'],
  ['reward.lookup', 'DESK'],
  ['reward.collect', 'DESK'],
]);

function ensureNotArchived(event) {
  if (String(event.stage || '').toUpperCase() === 'ARCHIVED') {
    throw failure(409, '보관된 행사는 변경할 수 없습니다');
  }
}

function requireLive(event, message) {
  if (String(event.stage || '').toUpperCase() !== 'LIVE') throw failure(409, message);
}

function commandReceiptMatches(receipt, { eventId, actorId, command, ticketToken, participantId }) {  const result = object(receipt && receipt.result);
  const receiptActorId = receipt && receipt.actor_id != null ? String(receipt.actor_id) : null;
  const expectedActorId = actorId == null ? null : String(actorId);
  return receipt && String(receipt.event_id) === String(eventId) &&
    receiptActorId === expectedActorId && result.command === command &&
    (result.ticketHash || null) === ticketHash(ticketToken) &&
    (result.participantId || null) === (participantId || null);
}

function manualIdentityKey(person) {
  return `${String(person?.name || '').trim().toLowerCase()}\u0000${String(person?.company || '').trim().toLowerCase()}`;
}

function manualIdentityHash(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.name !== 'string' || typeof value.company !== 'string' ||
      !value.name.trim() || !value.company.trim() || value.name.length > 60 || value.company.length > 200) return null;
  return ticketHash(manualIdentityKey(value));
}

function scanRequestMatches(stored, workspace, { id, input, assignmentId, ticket }) {
  const response = object(stored.response);
  if (typeof response.id !== 'string' || (Object.hasOwn(input, 'expectedAction') && input.expectedAction !== response.action)) return false;
  const deskId = clean(input.deskId || input.targetId, 120);
  if (stored.scanRequest) {
    const request = stored.scanRequest;
    return request.deskId === deskId && request.assignmentId === assignmentId && request.ticketHash === ticketHash(ticket) &&
      (!request.manualIdentityHash || request.manualIdentityHash === manualIdentityHash(input.expectedIdentity));
  }
  // Older receipts predate the request proof. Their committed check still
  // identifies the desk and participant, including after a grant change.
  const check = list(workspace.checks).find(item => item && String(item.id) === id);
  if (!check || String(check.deskId) !== deskId || String(check.participantId) !== response.id) return false;
  if (!ticket) return true; // The caller already matched the manual participant ID.
  return stored.rewardVerification?.ticketHash === ticketHash(ticket) ||
    String(findTicket(workspace, ticket)?.id || '') === response.id;
}

// A receipt is only a retry of the same certification: a changed booth,
// ticket or assignment must never reuse another person's successful result.
// No ticket bearer is saved in the receipt. Legacy rows can be checked only
// when their persisted visit proves the same booth/person and no original
// assignment id needs to be inferred; otherwise fail closed.
function boothRequestMatches(stored, workspace, { id, eventId, actorId, input, assignmentId, ticketToken, guest }) {
  const prefix = `ET:BOOTH:${eventId}:`;
  const code = guest ? clean(input.code, 512) : '';
  if (guest && !code.startsWith(prefix)) return false;
  const boothId = guest ? code.slice(prefix.length) : clean(input.boothId || input.targetId, 120);
  const token = guest ? ticketToken : ticketCode(input.ticket);
  if (!boothId || !token) return false;
  if (Object.hasOwn(stored, 'boothRequest')) {
    const proof = object(stored.boothRequest);
    return proof.boothId === boothId && proof.assignmentId === assignmentId &&
      proof.ticketHash === ticketHash(token) && proof.mode === (guest ? 'SELF' : 'STAFF');
  }
  if (assignmentId !== null) return false;
  const matches = list(workspace.visits).filter((visit) => visit && String(visit.id) === id);
  if (matches.length !== 1) return false;
  const visit = matches[0];
  const people = list(workspace.participants).filter((person) => person && person.ticket === token);
  if (people.length !== 1 || String(people[0].id) !== String(visit.participantId)) return false;
  return String(visit.boothId) === boothId && visit.mode === (guest ? 'SELF' : 'STAFF') &&
    String(visit.actor || '') === String(guest ? visit.participantId : actorId || '');
}

// Bind a reward receipt to the actual lookup or handoff, not merely the
// actor and command. Ticket bearers never leave the request: only a digest
// is recorded. A status-only receipt cannot prove a different target.
function rewardRequest(command, input, assignmentId) {
  if (command === 'reward.collect') return {
    assignmentId, kind: 'collect', id: clean(input.id, 120), verificationId: clean(input.verificationId, 128),
    expectedParticipantId: clean(input.expectedParticipantId, 120),
  };
  const ticket = ticketCode(input.ticket);
  return ticket
    ? { assignmentId, kind: 'ticket', ticketHash: ticketHash(ticket) }
    : { assignmentId, kind: 'participant', id: clean(input.participantId, 120), verificationId: clean(input.verificationId, 128) };
}

function rewardRequestMatches(stored, workspace, { command, input, assignmentId, actorId }) {
  const requested = rewardRequest(command, input, assignmentId);
  if (Object.hasOwn(stored, 'rewardRequest')) {
    const proof = object(stored.rewardRequest);
    return Object.keys(requested).every((key) => proof[key] === requested[key]) &&
      Object.keys(proof).length === Object.keys(requested).length;
  }
  const response = object(stored.response);
  if (command === 'reward.lookup') {
    // An old proof identifies the result's person and ticket at the time,
    // but not whether the original lookup used a ticket or verification id.
    return false;
  }
  // A legacy staffed collection did not save its assignment or verification
  // id; the response alone is insufficient to prove the original handoff.
  if (assignmentId !== null || requested.verificationId) return false;
  const reward = object(response.reward), claim = object(reward.claim);
  return reward.id === requested.id && reward.status === 'RECEIVED' && String(claim.actor || '') === String(actorId || '') &&
    (!requested.expectedParticipantId || reward.participantId === requested.expectedParticipantId);
}

function latestUncorrectedCheck(checks, participantId) {
  return checks.find((check) => check && check.corrected !== true && String(check.participantId) === participantId);
}

// A reviewed exit is an operator's attestation about a real departure, not
// ticket validation, approval, or a reward handoff. The exact reviewed
// identity and entry are bound to the receipt without retaining them there.
function reviewedExitRequest(input) {
  const expected = object(input.expected);
  const expectedEntry = object(input.expectedEntry);
  const participantId = clean(input.participantId, 120), entryId = clean(input.entryId, 120);
  const fields = ['name', 'company', 'phone', 'status', 'paymentStatus', 'ticketExpiresAt'];
  if (!participantId || !entryId || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 300 ||
      input.confirmed !== true || fields.some((field) => typeof expected[field] !== 'string') ||
      ['at', 'name', 'deskId'].some((field) => typeof expectedEntry[field] !== 'string') ||
      typeof expected.revoked !== 'boolean' || !Number.isSafeInteger(expected.ticketRevision) || expected.ticketRevision < 0) {
    throw failure(400, '참가자와 입장 기록을 확인하고 퇴장 확인 및 사유를 입력하세요.');
  }
  const values = fields.map((field) => expected[field]);
  const reason = input.reason.trim();
  return { participantId, entryId, expected, expectedEntry, reason,
    proof: ticketHash(JSON.stringify([participantId, entryId, ...values, expected.revoked, expected.ticketRevision,
      expectedEntry.at, expectedEntry.name, expectedEntry.deskId, reason, true])) };
}

function reviewedExitIdentityKey(person) {
  const phone = String(person?.phone || '').replace(/\D/g, '');
  return JSON.stringify([String(person?.name || '').trim().toLowerCase(), String(person?.company || '').trim().toLowerCase(), phone.slice(0, 3), phone.slice(-4)]);
}

function reviewedExit(workspace, event, actor, input, now, commandId) {
  requireLive(event, '행사 진행 중에만 확인 퇴장을 기록할 수 있습니다.');
  const request = reviewedExitRequest(input);
  const matches = list(workspace.participants).filter((person) => person && String(person.id) === request.participantId);
  if (matches.length !== 1) throw failure(409, '참가자 정보를 확인할 수 없습니다. 최신 명단을 확인하세요.', undefined, 'REVIEWED_EXIT_CHANGED');
  const person = matches[0], expected = request.expected;
  const text = (value) => typeof value === 'string' ? value : '';
  const revision = Number.isSafeInteger(person.ticketRevision) && person.ticketRevision >= 0 ? person.ticketRevision : 0;
  const revoked = person.revoked === true;
  if (person.inside !== true || !text(person.name).trim() || !/^\d{9,15}$/.test(text(person.phone).replace(/\D/g, '')) ||
      (person.revoked !== undefined && typeof person.revoked !== 'boolean') ||
      (person.ticketRevision !== undefined && (!Number.isSafeInteger(person.ticketRevision) || person.ticketRevision < 0)) ||
      ['name', 'company', 'phone', 'status', 'paymentStatus', 'ticketExpiresAt'].some((field) => text(person[field]) !== expected[field]) ||
      revoked !== expected.revoked || revision !== expected.ticketRevision) {
    throw failure(409, '참가자 정보 또는 입장 상태가 바뀌었습니다. 최신 기록을 다시 확인하세요.', undefined, 'REVIEWED_EXIT_CHANGED');
  }
  if (list(workspace.participants).filter((item) => item && reviewedExitIdentityKey(item) === reviewedExitIdentityKey(person)).length !== 1) {
    throw failure(409, '표시된 이름·소속·연락처가 같은 참가자가 있습니다. 현장 기록으로 대상을 구분해 주세요.', undefined, 'REVIEWED_EXIT_AMBIGUOUS');
  }
  const entry = latestUncorrectedCheck(list(workspace.checks), request.participantId);
  if (!entry || String(entry.id) !== request.entryId || entry.action !== 'IN' ||
      (entry.corrected !== undefined && entry.corrected !== false) || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) ||
      entry.at !== request.expectedEntry.at || text(entry.name) !== request.expectedEntry.name || text(entry.deskId) !== request.expectedEntry.deskId) {
    throw failure(409, '최근 입장 기록을 확인할 수 없거나 변경됐습니다. 현장 기록을 다시 확인하세요.', undefined, 'REVIEWED_EXIT_CHANGED');
  }
  const before = { inside: true, everIn: person.everIn === true };
  person.inside = false;
  // The verified IN record proves prior attendance even if an old workspace
  // lost the aggregate flag; preserve the re-entry policy after this exit.
  person.everIn = true;
  const row = { id: commandId, participantId: request.participantId, name: text(person.name), action: 'OUT', deskId: '',
    actor: String(actor.id), at: now, before, corrected: false, source: 'REVIEWED_EXIT', entryId: request.entryId, reason: request.reason };
  workspace.checks.unshift(row);
  return { row, proof: request.proof, body: { exitReview: { participantId: request.participantId, entryId: request.entryId, exitId: commandId, action: 'OUT' } } };
}

function reconciliationRequest(input) {
  const participantId = clean(input.participantId, 120), checkId = clean(input.checkId, 120);
  if (!participantId || !checkId || !['IN', 'OUT'].includes(input.action) ||
      typeof input.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(input.fingerprint) ||
      input.confirmed !== true || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 300) {
    throw failure(400, '참가자와 출입 기록, 실제 현장 상태 및 확인 사유를 확인하세요.');
  }
  const reason = input.reason.trim();
  return { participantId, checkId, action: input.action, fingerprint: input.fingerprint, reason,
    proof: ticketHash(JSON.stringify([participantId, checkId, input.action, input.fingerprint, reason, true])) };
}

function reconcileAttendance(workspace, event, input, commandId) {
  requireLive(event, '행사 진행 중에만 출입 상태를 확인할 수 있습니다.');
  const request = reconciliationRequest(input);
  const matches = list(workspace.participants).filter(person => person && String(person.id) === request.participantId);
  const person = matches.length === 1 ? matches[0] : null;
  const candidate = person ? reconciliationIndex(workspace)(person) : null;
  if (!candidate || candidate.checkId !== request.checkId || candidate.action !== request.action || candidate.fingerprint !== request.fingerprint) {
    throw failure(409, '참가자 또는 출입 기록이 바뀌었거나 확인할 수 없습니다. 최신 기록을 다시 확인하세요.', undefined, 'ATTENDANCE_RECONCILIATION_CHANGED');
  }
  const before = { inside: ownValue(person, 'inside'), everIn: ownValue(person, 'everIn') };
  person.inside = request.action === 'IN';
  person.everIn = true;
  return { proof: request.proof, audit: { participantId: request.participantId, participantName: person.name, checkId: request.checkId, action: request.action,
    before, after: { inside: person.inside, everIn: person.everIn } },
    body: { reconciliation: { id: commandId, participantId: request.participantId, checkId: request.checkId,
      action: request.action, inside: person.inside, everIn: true } } };
}

function scanReplayStatus(workspace, checkId, participantId) {
  const checks = list(workspace.checks);
  const record = checks.find((check) => check && String(check.id) === checkId);
  if (!record || String(record.participantId) !== participantId) return 'UNAVAILABLE';
  if (record.corrected === true) return 'CORRECTED';
  const person = list(workspace.participants).find((item) => item && String(item.id) === participantId);
  if (!person || person.revoked === true || person.cancelled === true || String(person.status || '').toUpperCase() !== 'APPROVED') return 'PARTICIPANT_CHANGED';
  if (latestUncorrectedCheck(checks, participantId) !== record) return 'SUPERSEDED';
  // The receipt confirms the original scan, not the current aggregate.
  // Do not present an old successful scan as current when those disagree.
  if (attendanceNeedsReview(person) || person.everIn !== true ||
      (record.action === 'IN' ? person.inside !== true : record.action === 'OUT' ? person.inside !== false : true)) return 'UNAVAILABLE';
  return null;
}

async function lockEvent(client, eventId) {  const result = await client.query(
    `SELECT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision,
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

// Grant verdicts run AFTER the receipt lookup (AGENTS order), so a committed
// write retried after a permission change still replays. Scope (identity,
// org, event, assignment existence) is verified pre-receipt via
// resolveEventAuthority at the call site.
async function authorizeGrants(client, event, workspace, account, command, assignmentId, org) {
  const current = { role: org.role, active: true };
  if (!['AGENCY', 'MANAGER', 'STAFF'].includes(current.role)) {
    throw failure(401, '로그인이 필요합니다');
  }
  if (current.role === 'AGENCY') return { role: current.role, assignment: null, orgId: org.orgId };
  if (current.role === 'MANAGER') {
    const membership = await client.query(
      'SELECT write_permissions FROM memberships WHERE account_id = $1 AND event_id = $2 LIMIT 1 FOR SHARE',
      [String(account.id), event.id]
    );
    if (!membership.rowCount) throw failure(403, '권한을 확인하세요');
    // Field commands need their write scope (server/event-permissions.js);
    // an unmapped command is denied rather than passed through.
    if (!managerWriteAllowed(membership.rows[0].write_permissions, command)) {
      throw failure(403, '권한을 확인하세요');
    }
    return { role: current.role, assignment: null, orgId: org.orgId };
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
    orgId: org.orgId,
  };
}

function activeParticipant(workspace, token) {
  const person = findTicket(workspace, token);
  if (!person || person.revoked === true || person.cancelled === true || String(person.status || '').toUpperCase() === 'CANCELLED') {
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

function guardDeskSnapshot(desk, expected) {
  if (expected === undefined) return;
  if (!desk || !expected || typeof expected !== 'object' || Array.isArray(expected) ||
      !(expected.name === null || typeof expected.name === 'string') ||
      !(expected.action === null || typeof expected.action === 'string') ||
      typeof expected.mode !== 'string' || typeof expected.open !== 'boolean') {
    throw failure(400, '확인한 데스크 정보를 다시 불러오세요.', 'expectedDesk');
  }
  const current = {
    name: typeof desk.name === 'string' ? desk.name : null,
    action: typeof desk.action === 'string' ? desk.action : null,
    mode: typeof desk.mode === 'string' && desk.mode ? desk.mode : 'desk',
    open: desk.open !== false,
  };
  if (Object.keys(current).some((key) => expected[key] !== current[key])) {
    throw failure(409, '데스크 정보가 변경되었습니다. 최신 내용을 확인한 뒤 다시 진행하세요.', 'expectedDesk', 'DESK_CHANGED');
  }
}

function updateDesk(workspace, input) {
  const name = clean(input.name, 60);
  const action = clean(input.action, 8).toUpperCase();
  const mode = clean(input.mode, 16).toLowerCase() || 'desk';
  if (!name) throw failure(400, '데스크 이름을 입력하세요', 'name');
  if (!['IN', 'OUT'].includes(action) || !['desk', 'tablet'].includes(mode)) {
    throw failure(400, '데스크 작업과 화면을 선택하세요');
  }

  const id = clean(input.id, 120);
  const old = id ? list(workspace.desks).find((desk) => desk && String(desk.id) === id) : null;
  if (id && !old) throw failure(404, '데스크를 찾을 수 없습니다');
  // New editors submit the whole snapshot they opened, not just the open
  // flag: a different name, direction or mode can also make an old edit
  // destructive. The event/workspace row is already locked here and an
  // existing command receipt has already been replayed. Older callers may
  // omit the guard and retain their original behavior.
  guardDeskSnapshot(old, input.expectedDesk);
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
  // A stopped IN desk can become a stopped OUT desk while the operator is
  // deciding to start it; matching the open flag alone would miss that.
  guardDeskSnapshot(desk, input.expectedDesk);
  if (input.expectedOpen !== undefined) {
    if (typeof input.expectedOpen !== 'boolean') {
      throw failure(400, '확인한 데스크 가동 상태를 다시 불러오세요.', 'expectedOpen');
    }
    if ((desk.open !== false) !== input.expectedOpen) {
      throw failure(409, '데스크 가동 상태가 변경되었습니다. 최신 상태를 확인하세요.', 'expectedOpen', 'DESK_OPEN_CHANGED');
    }
  }
  // An operator may always stop an incomplete legacy desk, but starting it
  // without the same information required by the console can strand staff
  // or make them work at an unidentified desk. Missing mode historically
  // means the regular desk interface; missing name or direction does not.
  // Receipt replay is handled before this check, so a committed operation
  // remains confirmable even when its desk is changed later.
  if (input.open === true) {
    if (typeof desk.name !== 'string' || !desk.name.trim()) {
      throw failure(409, '데스크 이름을 입력한 뒤 가동하세요.', 'name', 'DESK_INCOMPLETE');
    }
    if (!['IN', 'OUT'].includes(desk.action)) {
      throw failure(409, '데스크의 입장·퇴장 방향을 선택한 뒤 가동하세요.', 'action', 'DESK_INCOMPLETE');
    }
    const mode = typeof desk.mode === 'string' && desk.mode ? desk.mode : 'desk';
    if (!['desk', 'tablet'].includes(mode)) {
      throw failure(409, '데스크 화면을 선택한 뒤 가동하세요.', 'mode', 'DESK_INCOMPLETE');
    }
  }
  desk.open = input.open;
  // A guarded client must be able to distinguish a complete legacy result
  // from a truncated success response. Persist exactly this normalized result
  // in its new receipt. Existing unguarded calls retain their old response.
  const responseDesk = input.expectedDesk === undefined ? desk : operatorDeskProjection(desk);
  return { body: { desk: structuredClone(responseDesk) } };
}

async function assignStaff(client, event, workspace, input) {
  const accountId = clean(input.accountId, 120);
  const type = clean(input.type, 12).toUpperCase();
  const targetId = clean(input.targetId, 120);
  if (!accountId || !['DESK', 'BOOTH'].includes(type) || !targetId) {
    throw failure(400, '스태프와 담당 업무를 확인하세요');
  }
  // Assignment targets resolve through the EVENT's org membership, never the
  // global accounts.role: a shared account staffs here when it is STAFF in
  // this org, whatever it is elsewhere. Global active still applies.
  const accountResult = await client.query(
    `SELECT a.active AS active, m.role AS role, m.active AS member_active
     FROM accounts a
     LEFT JOIN organization_memberships m
       ON m.account_id = a.id AND m.org_id = (SELECT org_id FROM events WHERE id = $2 LIMIT 1)
     WHERE a.id = $1 LIMIT 1`,
    [accountId, event.id]
  );
  const targetExists = type === 'DESK'
    ? list(workspace.desks).some((desk) => desk && String(desk.id) === targetId)
    : list(workspace.booths).some((booth) => booth && String(booth.id) === targetId);
  if (!accountResult.rows[0] || accountResult.rows[0].active !== true ||
      accountResult.rows[0].role !== 'STAFF' || accountResult.rows[0].member_active !== true) {
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

// What a desk shows when the same ticket is scanned in again: who it is and
// when they first got in (earliest scan that was not corrected away). The scan
// already passed ticket, state and attendance checks, so this reveals nothing
// the successful scan would not have.
function alreadyCheckedInDetails(workspace, person) {
  let first = null;
  let firstMs = Infinity;
  for (const check of list(workspace.checks)) {
    if (!check || check.corrected === true || check.action !== 'IN' || String(check.participantId) !== String(person.id)) continue;
    const ms = Date.parse(check.at);
    if (Number.isFinite(ms) && ms < firstMs) { first = check.at; firstMs = ms; }
  }
  return { name: String(person.name || ''), firstCheckedInAt: first };
}

function scan(workspace, event, actor, input, assignment) {
  requireLive(event, '행사 진행 중에 입퇴장을 처리할 수 있습니다. 매니저에게 진행 단계 확인을 요청하세요.');
  const deskId = clean(input.deskId || input.targetId, 120);
  const desk = list(workspace.desks).find((item) => item && String(item.id) === deskId);
  if (!desk) throw failure(400, '등록 데스크를 선택하세요.');
  if (assignment && (assignment.type !== 'DESK' || assignment.targetId !== deskId)) {
    throw failure(403, '배정된 데스크에서만 처리할 수 있습니다.');
  }
  if (desk.open === false) {
    throw failure(409, '이 데스크는 닫혀 있습니다. 운영자가 다시 가동한 뒤 상태를 확인하세요.', undefined, 'DESK_CLOSED');
  }
  const action = clean(desk.action, 8).toUpperCase();
  if (!['IN', 'OUT'].includes(action)) throw failure(409, '데스크 작업을 확인하세요.');
  if (Object.hasOwn(input, 'expectedAction')) {
    if (input.expectedAction !== 'IN' && input.expectedAction !== 'OUT') {
      throw failure(400, '입장 또는 퇴장 방향을 확인하세요.', 'expectedAction');
    }
    if (input.expectedAction !== action) {
      throw failure(409, '데스크의 입장·퇴장 방향이 바뀌었습니다.', undefined, 'DESK_ACTION_CHANGED');
    }
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
  if (idPath && (assignment || Object.hasOwn(input, 'expectedIdentity'))) {
    const expected = Object.hasOwn(input, 'expectedIdentity') ? manualIdentityHash(input.expectedIdentity) : null;
    if (Object.hasOwn(input, 'expectedIdentity') && !expected) {
      throw failure(400, '확인한 참가자 이름과 소속을 다시 확인하세요.', 'expectedIdentity');
    }
    const current = manualIdentityKey(person);
    const ambiguous = list(workspace.participants).filter((item) => item && manualIdentityKey(item) === current).length !== 1;
    if (ambiguous || (expected && expected !== ticketHash(current))) {
      throw failure(409, '참가자 정보가 바뀌었거나 같은 이름과 소속이 있습니다. 명단을 다시 확인하세요.', undefined, 'MANUAL_IDENTITY_CHANGED');
    }
  }
  if (person.revoked === true || person.cancelled === true || String(person.status || '').toUpperCase() !== 'APPROVED') {
    if (action === 'OUT' && person.inside === true) throw failure(409, '퇴장 기록에 확인이 필요합니다. 현장 책임자에게 요청하세요.', undefined, 'CHECK_OUT_REVIEW_REQUIRED');
    if (person.cancelled === true && String(person.status || '').toUpperCase() === 'APPROVED') {
      throw failure(409, '신청 상태와 취소 기록이 일치하지 않습니다. 현장 책임자에게 확인을 요청하세요.', undefined, 'TICKET_STATUS_CONFLICT');
    }
    throw failure(409, '입장 가능한 티켓이 아닙니다. 등록 상태를 확인하세요.');
  }
  if (idPath ? clean(person.ticketExpiresAt, 64) !== '' : true) {
    const expiry = Date.parse(person.ticketExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      if (action === 'OUT' && person.inside === true) throw failure(409, '퇴장 기록에 확인이 필요합니다. 현장 책임자에게 요청하세요.', undefined, 'CHECK_OUT_REVIEW_REQUIRED');
      throw failure(409, '티켓이 만료되었습니다. 운영자에게 재발급을 요청하세요.');
    }
  }
  if (!['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase())) {
    if (action === 'OUT' && person.inside === true) throw failure(409, '퇴장 기록에 확인이 필요합니다. 현장 책임자에게 요청하세요.', undefined, 'CHECK_OUT_REVIEW_REQUIRED');
    throw failure(409, '결제가 완료되지 않았습니다. 결제 상태를 확인하세요.');
  }
  // A scan must not turn unknown or contradictory attendance into a clean
  // entry/exit: that would hide the uncertainty and can bypass re-entry or
  // duplicate-entry checks. Leave the original data and history intact.
  if (attendanceNeedsReview(person, indexLatestChecks(workspace.checks))) {
    throw failure(409, '출입 기록을 확인할 수 없어 처리하지 않았습니다. 현장 책임자에게 확인을 요청하세요.', undefined, 'CHECK_ATTENDANCE_REVIEW_REQUIRED');
  }
  if (action === 'IN' && person.inside === true) throw failure(409, '이미 입장한 참가자입니다. 중복 처리하지 않았습니다.', undefined, 'ALREADY_CHECKED_IN', alreadyCheckedInDetails(workspace, person));
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
    person,
    body: {
      name: String(person.name || ''),
      id: String(person.id),
      action,
      reentry: action === 'IN' && before.everIn,
      // The scanned person's own reward entitlements only: an OUT desk is
      // the prize handoff point, and STAFF bootstrap deliberately carries no
      // global reward list. Nothing about other participants is included.
      rewards: rewardsFor(workspace, String(person.id)),
    },
  };
}

function rewardsFor(workspace, participantId) {
  return list(workspace.rewards)
    .filter((reward) => reward && String(reward.participantId) === String(participantId))
    .map((reward) => ({
      id: String(reward.id || ''),
      name: String(reward.name || ''),
      status: String(reward.status || ''),
      method: String(reward.method || ''),
    }));
}

function findScannedPerson(workspace, input) {
  const code = ticketCode(input.ticket);
  if (code) {
    const person = findTicket(workspace, code);
    if (!person) throw failure(404, '이 행사에서 티켓을 찾을 수 없습니다. 다른 행사 또는 잘못된 코드를 확인하세요.');
    return person;
  }
  const participantId = clean(input.participantId, 120);
  if (!participantId) throw failure(400, '티켓 코드를 입력하세요.', 'ticket');
  const person = list(workspace.participants).find((item) => item && String(item.id) === participantId) || null;
  if (!person) throw failure(404, '이 행사에서 참가자를 찾을 수 없습니다. 이름으로 다시 검색하세요.');
  return person;
}

function requireRewardDesk(workspace, assignment) {
  if (!assignment) return;
  const desk = list(workspace.desks).find((item) => item && String(item.id) === assignment.targetId);
  if (desk?.open === false || clean(desk?.action, 8).toUpperCase() !== 'OUT') {
    throw failure(409, '가동 중인 퇴장 데스크에서만 경품을 처리할 수 있습니다.', undefined, 'REWARD_DESK_CHANGED');
  }
}

function requireRewardPerson(person, ticketRequired = false) {
  const expiry = clean(person?.ticketExpiresAt, 64);
  if (!person || person.revoked === true || person.cancelled === true || clean(person.status, 16).toUpperCase() !== 'APPROVED' ||
      !['FREE', 'PAID'].includes(clean(person.paymentStatus, 16).toUpperCase()) ||
      ((ticketRequired || expiry) && !(Date.parse(expiry) > Date.now()))) {
    throw failure(409, '참가 상태 또는 티켓이 바뀌었습니다. 현재 티켓으로 경품을 다시 확인하세요.', undefined, 'REWARD_VERIFICATION_CHANGED');
  }
}

async function requireRewardVerification(client, event, actor, assignment, person, input) {
  const verificationId = input.verificationId;
  if (typeof verificationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(verificationId)) {
    throw failure(409, '현재 티켓으로 경품을 다시 확인하세요.', undefined, 'REWARD_VERIFICATION_CHANGED');
  }
  requireRewardPerson(person);
  const found = await client.query(
    `SELECT result FROM command_receipts WHERE command_id = $1 AND event_id = $2 AND actor_id = $3 AND org_id = $4`,
    [verificationId, event.id, String(actor.id), event.orgId]
  );
  const receipt = object(found.rows[0]?.result);
  const proof = object(receipt.rewardVerification);
  if (!['check.scan', 'reward.lookup'].includes(receipt.command) || proof.assignmentId !== assignment.id ||
      proof.participantId !== String(person.id) || proof.ticketHash !== ticketHash(person.ticket)) {
    throw failure(409, '참가 상태 또는 티켓이 바뀌었습니다. 현재 티켓으로 경품을 다시 확인하세요.', undefined, 'REWARD_VERIFICATION_CHANGED');
  }
}

// Tightly-scoped prize lookup for an assigned DESK: exactly one participant
// (by ticket code or id) and only their reward entitlements. No contact
// details, no ticket bearer, nobody else's rewards.
async function lookupRewards(client, workspace, event, actor, assignment, input) {
  if (!list(event.features).includes('reward')) throw failure(409, '이 행사에서 경품 기능을 먼저 켜세요.');
  requireRewardDesk(workspace, assignment);
  const code = ticketCode(input.ticket);
  const person = assignment && code ? findTicket(workspace, code) : findScannedPerson(workspace, input);
  if (assignment) {
    if (code) requireRewardPerson(person, true);
    else await requireRewardVerification(client, event, actor, assignment, person, input);
  }
  return {
    rewardPerson: person,
    body: {
      participant: {
        id: String(person.id),
        name: String(person.name || ''),
        company: String(person.company || ''),
        group: String(person.group || ''),
        status: String(person.status || ''),
        inside: person.inside === true,
        everIn: person.everIn === true,
      },
      rewards: rewardsFor(workspace, String(person.id)),
    },
  };
}

// Permitted STAFF fulfillment through the same reward record the operator
// path uses: READY becomes RECEIVED once, and a second collection of the
// same reward is refused. Idempotent by commandId like every other command.
async function collectReward(client, workspace, event, actor, assignment, input) {
  if (!list(event.features).includes('reward')) throw failure(409, '이 행사에서 경품 기능을 먼저 켜세요.');
  requireRewardDesk(workspace, assignment);
  const reward = list(workspace.rewards).find((item) => item && String(item.id) === clean(input.id, 120));
  if (!reward) throw failure(404, '경품을 찾을 수 없습니다');
  const participantId = typeof reward.participantId === 'string' || Number.isSafeInteger(reward.participantId) ? String(reward.participantId) : '';
  const matches = participantId ? list(workspace.participants).filter((item) => item &&
    (typeof item.id === 'string' || Number.isSafeInteger(item.id)) && String(item.id) === participantId) : [];
  const person = matches.length === 1 ? matches[0] : null;
  if (Object.hasOwn(input, 'expectedParticipantId') &&
      (typeof input.expectedParticipantId !== 'string' || !input.expectedParticipantId || input.expectedParticipantId !== String(reward.participantId))) {
    throw failure(409, '경품 수령 대상이 변경되었습니다. 티켓과 경품을 다시 확인하세요.', undefined, 'REWARD_VERIFICATION_CHANGED');
  }
  if (assignment) await requireRewardVerification(client, event, actor, assignment, person, input);
  const method = clean(reward.method, 16).toUpperCase();
  if (method && method !== 'ONSITE') {
    throw failure(409, '지급 방식을 운영자에게 확인하세요.', undefined, 'REWARD_ONSITE_ONLY');
  }
  if (reward.status === 'RECEIVED') {
    throw failure(409, '이미 수령 완료된 경품입니다.', undefined, 'REWARD_ALREADY_RECEIVED');
  }
  if (reward.status === 'CANCELLED') {
    throw failure(409, '취소된 경품입니다.', undefined, 'REWARD_CANCELLED');
  }
  if (reward.status === 'PENDING' || !reward.participantId) {
    throw failure(409, '수령자를 먼저 지정하세요');
  }
  if (reward.status !== 'READY') throw failure(409, '지급 대기 경품을 선택하세요');
  if (!person || person.cancelled === true || String(person.status || '').toUpperCase() !== 'APPROVED') {
    throw failure(409, '참가 확정자를 선택하세요');
  }
  reward.status = 'RECEIVED';
  reward.claim = { actor: String(actor.id), at: new Date().toISOString(), simulated: true };
  return { body: { reward: structuredClone(reward) } };
}

function correctCheck(workspace, event, actor, input, assignment, now, commandId) {
  ensureNotArchived(event);
  const id = clean(input.id, 120);
  const checks = list(workspace.checks);
  const row = checks.find((check) => check && String(check.id) === id);
  if (!row) throw failure(409, '정정할 수 없는 기록입니다.');
  const reason = clean(input.reason, 300);
  if (!reason) throw failure(400, '정정 사유를 입력하세요.', 'reason');
  if (assignment && (assignment.type !== 'DESK' || assignment.targetId !== String(row.deskId) ||
    String(row.actor) !== String(actor.id))) {
    throw failure(403, '본인이 배정된 데스크에서 처리한 기록만 정정할 수 있습니다.');
  }
  const person = list(workspace.participants).find((item) => item && String(item.id) === String(row.participantId));
  if (assignment && (!person || person.cancelled === true || String(person.status || '').toUpperCase() === 'CANCELLED' ||
    latestUncorrectedCheck(checks, String(row.participantId)) !== row)) {
    throw failure(409, '이 참가자의 최신 출입 기록이 변경됐습니다.', undefined, 'CHECK_CORRECTION_STALE');
  }
  if (row.corrected === true) throw failure(409, '정정할 수 없는 기록입니다.');

  row.corrected = true;
  row.correction = { id: commandId, reason, actor: String(actor.id), at: now };
  if (person) {
    const records = checks
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
  // The editable settings, not the visit counter, are the operator's
  // baseline. A visit that changes `used` must not make an otherwise valid
  // edit conflict; a changed status, limit or schedule must never be
  // silently overwritten. Older callers may omit the optional guard.
  if (input.expectedBooth !== undefined) {
    const expected = input.expectedBooth;
    const strings = ['name', 'zone', 'status', 'startsAt', 'endsAt'];
    const numbers = ['capacity', 'limit'];
    if (!old || !expected || typeof expected !== 'object' || Array.isArray(expected) ||
        strings.some((key) => typeof expected[key] !== 'string') ||
        numbers.some((key) => typeof expected[key] !== 'number' || !Number.isFinite(expected[key]))) {
      throw failure(400, '확인한 부스 정보를 다시 불러오세요.', 'expectedBooth');
    }
    const text = (value) => typeof value === 'string' ? value : '';
    const current = {
      name: text(old.name), zone: text(old.zone), status: text(old.status) || 'WAITING',
      capacity: Number(old.capacity) || 0, limit: Number(old.limit) || 1,
      startsAt: operatorBoothTime(old.startsAt), endsAt: operatorBoothTime(old.endsAt),
    };
    // Equivalent ISO offsets describe the same schedule. Preserve malformed
    // historical strings as-is so they are never silently considered equal.
    const sameTime = (a, b) => {
      if (a === b) return true;
      const first = boothScheduleTime(a), second = boothScheduleTime(b);
      return first !== null && second !== null && Number.isFinite(first) && Number.isFinite(second) && first === second;
    };
    if (Object.keys(current).some((key) => ['startsAt', 'endsAt'].includes(key)
      ? !sameTime(expected[key], current[key]) : expected[key] !== current[key])) {
      throw failure(409, '부스 정보가 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장하세요.', 'expectedBooth', 'BOOTH_CHANGED');
    }
  }
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
  // Existing editors do not expose scheduling. Omitting a field preserves
  // its stored value verbatim; an explicitly empty string clears it. Older
  // data may have an invalid value: an unrelated edit must neither erase it
  // nor trap the operator. Once either time is changed, validate the pair.
  const changesStart = Object.hasOwn(input, 'startsAt');
  const changesEnd = Object.hasOwn(input, 'endsAt');
  const startsAt = changesStart ? clean(input.startsAt, 64) : old && Object.hasOwn(old, 'startsAt') ? old.startsAt : '';
  const endsAt = changesEnd ? clean(input.endsAt, 64) : old && Object.hasOwn(old, 'endsAt') ? old.endsAt : '';
  const startMs = boothScheduleTime(startsAt);
  const endMs = boothScheduleTime(endsAt);
  if ((!old || changesStart || changesEnd) &&
    ((startMs !== null && !Number.isFinite(startMs)) || (endMs !== null && !Number.isFinite(endMs)))) {
    throw failure(400, '시작·종료 시간은 올바른 날짜와 시간대를 포함해 입력하세요.');
  }
  if ((!old || changesStart || changesEnd) && startMs !== null && endMs !== null && startMs >= endMs) {
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
  const result = structuredClone(booth);
  // New guarded editors must be able to confirm what was saved without
  // exposing arbitrary malformed JSON or misreading it as a missing field.
  // Existing clients retain the original result shape and saved raw values.
  if (input.expectedBooth !== undefined) {
    result.startsAt = operatorBoothTime(booth.startsAt);
    result.endsAt = operatorBoothTime(booth.endsAt);
  }
  return { status: old ? 200 : 201, body: { booth: result } };
}

function setBoothMode(workspace, input) {
  if (list(workspace.visits).length) throw failure(409, '인증 기록이 있어 방식을 변경할 수 없습니다.', undefined, 'BOOTH_VISITS_EXIST');
  const mode = clean(input.mode, 12).toUpperCase();
  if (!['SELF', 'STAFF'].includes(mode) || input.acknowledge !== true) {
    throw failure(400, '인증 방식과 QR 스캔 방향을 확인하세요.');
  }
  workspace.stampMode = mode;
  return { body: { stampMode: mode } };
}

function reviewedBoothModeRequest(input) {
  const expectedMode = input.expectedMode, mode = input.mode;
  if (!['SELF', 'STAFF'].includes(expectedMode) || !['SELF', 'STAFF'].includes(mode) ||
      mode === expectedMode || input.acknowledge !== true) {
    throw failure(400, '현재 인증 방식과 바꿀 방식, QR 스캔 방향을 확인하세요.');
  }
  return { expectedMode, mode, proof: ticketHash(JSON.stringify([expectedMode, mode, true])) };
}

// A local timestamp without an offset is not a specific instant. Interpreting
// it in the server's timezone makes the same booth open or close when the
// process moves to another machine. Unknown legacy values must be reviewed,
// not silently guessed. Missing values still mean no boundary.
function boothScheduleTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const offset = match[8];
  if (offset.toUpperCase() !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return NaN;
  }
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(hourText) > 23 || Number(minuteText) > 59 || (secondText && Number(secondText) > 59)) return NaN;
  return Date.parse(value);
}

function boothUnavailableMessage(booth, current) {
  if (booth.status !== 'OPEN') {
    return booth.status === 'CLOSED' ? '종료된 부스입니다.' : '아직 운영을 시작하지 않은 부스입니다.';
  }
  const startsAt = boothScheduleTime(booth.startsAt);
  const endsAt = boothScheduleTime(booth.endsAt);
  if ((startsAt !== null && !Number.isFinite(startsAt)) || (endsAt !== null && !Number.isFinite(endsAt)) ||
      (startsAt !== null && endsAt !== null && startsAt >= endsAt)) {
    return '부스 운영 시간을 확인해 주세요.';
  }
  if ((startsAt !== null && current < startsAt) || (endsAt !== null && current > endsAt)) return '부스 운영 시간이 아닙니다.';
  const capacity = Number(booth.capacity) || 0;
  if (capacity > 0 && Number(booth.used || 0) >= capacity) return '부스 수량이 모두 소진되었습니다.';
  return null;
}

function boothVisitLimit(booth) {
  return Math.max(1, Number(booth.limit) || 1);
}

function visitBooth(workspace, event, actor, input, assignment, now, commandId, guestTicketToken) {
  if (String(event.stage || '').toUpperCase() !== 'LIVE' || !list(event.features).includes('stamp')) {
    throw failure(409, '현재 스탬프 인증을 진행하지 않습니다.', undefined, 'BOOTH_UNAVAILABLE');
  }
  let boothId;
  if (guestTicketToken) {
    if (workspace.stampMode !== 'SELF') throw failure(409, '스태프가 티켓을 확인하는 방식입니다. 본인의 티켓을 제시하세요.', undefined, 'BOOTH_MODE_CHANGED');
    const prefix = `ET:BOOTH:${event.id}:`;
    const code = clean(input.code, 512);
    if (!code.startsWith(prefix)) throw failure(400, '이 행사의 부스 QR이 아닙니다.');
    boothId = code.slice(prefix.length);
  } else {
    if (workspace.stampMode !== 'STAFF') throw failure(409, '참가자가 부스 QR을 스캔하는 방식입니다.', undefined, 'BOOTH_MODE_CHANGED');
    boothId = clean(input.boothId || input.targetId, 120);
  }
  const booth = list(workspace.booths).find((item) => item && String(item.id) === boothId);
  if (!booth) throw failure(404, '부스를 찾을 수 없습니다.', undefined, 'BOOTH_UNAVAILABLE');
  if (assignment && (assignment.type !== 'BOOTH' || assignment.targetId !== boothId)) {
    throw failure(403, '배정된 부스만 처리할 수 있습니다.');
  }
  const token = guestTicketToken || ticketCode(input.ticket);
  if (!token) throw failure(400, '참가자 티켓을 입력하세요.', 'ticket');
  const person = findTicket(workspace, token);
  if (!person) throw failure(404, '부스 또는 참가자 티켓을 확인하세요.');
  if (person.revoked === true || person.cancelled === true || String(person.status || '').toUpperCase() !== 'APPROVED') {
    throw failure(409, '사용할 수 없는 참가자 티켓입니다.');
  }
  const expiresAt = Date.parse(person.ticketExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw failure(409, '티켓이 만료되었습니다.');
  if (!['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase())) {
    throw failure(409, '결제가 완료된 참가자만 이용할 수 있습니다.');
  }
  if (person.inside !== true) throw failure(409, '행사 입장 후 부스를 이용할 수 있습니다.');
  const current = Date.now();
  const unavailable = boothUnavailableMessage(booth, current);
  if (unavailable) throw failure(409, unavailable, undefined, 'BOOTH_UNAVAILABLE');
  const visitsByBooth = new Map();
  for (const visit of list(workspace.visits)) {
    if (!visit || String(visit.participantId) !== String(person.id)) continue;
    const id = String(visit.boothId);
    visitsByBooth.set(id, (visitsByBooth.get(id) || 0) + 1);
  }
  if ((visitsByBooth.get(boothId) || 0) >= boothVisitLimit(booth)) {
    if (!guestTicketToken) {
      throw failure(409, '이 참가자는 이 부스의 인증 횟수를 모두 사용했습니다.', undefined, 'BOOTH_LIMIT_REACHED');
    }
    const alternatives = list(workspace.booths).filter((item) =>
      item && item.id != null && String(item.id) !== '' && String(item.id) !== boothId &&
      !boothUnavailableMessage(item, current) && (visitsByBooth.get(String(item.id)) || 0) < boothVisitLimit(item)
    ).length;
    const nextStep = alternatives
      ? `지금 인증할 수 있는 다른 부스는 ${alternatives}곳입니다.`
      : '지금 인증할 수 있는 다른 부스가 없습니다.';
    throw failure(409, `이 부스의 인증 횟수를 모두 사용했습니다. ${nextStep}`, undefined, 'BOOTH_LIMIT_REACHED');
  }

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
  return { status: 201, body: { name: String(person.name || ''), booth: String(booth.name || ''),
    visitId: commandId, boothId, participantId: String(person.id) } };
}

function appendAudit(workspace, event, account, command, input, commandId, now, reconciliation) {
  if (!Array.isArray(workspace.audit)) workspace.audit = [];
  workspace.audit.unshift({
    id: commandId,
    type: command,
    actor: String(account.id),
    at: now,
    detail: clean(input.reason || input.name || input.title, 300),
    eventId: event.id,
    ...(reconciliation ? { reconciliation } : {}),
  });
}

// Write-through projection of the check history (see 005_checkin-records).
// Runs in the SAME transaction as the workspace update, so the JSONB checks
// array (still the read authority) and checkin_records cannot drift. Reads
// stay on the workspace until the report path is switched over deliberately.
async function projectCheckinRecord(client, eventId, row) {
  await client.query(
    `INSERT INTO checkin_records
       (id, event_id, participant_id, name, action, desk_id, actor_id, at,
        before_inside, before_ever_in, corrected)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             COALESCE(NULLIF($8, '')::timestamptz, now()), $9, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      String(row.id),
      String(eventId),
      String(row.participantId),
      String(row.name || ''),
      String(row.action),
      String(row.deskId || ''),
      row.actor ? String(row.actor) : null,
      String(row.at || ''),
      Boolean(row.before && row.before.inside),
      Boolean(row.before && row.before.everIn),
      row.corrected === true,
    ]
  );
}

async function markCheckinCorrected(client, eventId, check) {
  const updated = await client.query(
    'UPDATE checkin_records SET corrected = true WHERE id = $1',
    [String(check.id)]
  );
  // A check written straight to the workspace (fixtures, pre-projection
  // data missed by backfill) still gets its row rather than going missing.
  if (!updated.rowCount) await projectCheckinRecord(client, eventId, check);
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
      // Scope boundary pre-receipt; grant verdicts post-receipt (see
      // authorizeGrants): a committed write retried after a permission change
      // still replays.
      let opScope = null;
      if (!guest) {
        const { resolveEventAuthority } = require('../tenancy');
        try {
          opScope = await resolveEventAuthority(client, account, event.id);
        } catch (error) {
          throw failure(error.status || 403, error.message || '권한을 확인하세요', undefined, error.code);
        }
      }
      const authorized = guest
        ? { role: 'GUEST', assignment: null, orgId: null }
        : { role: null, assignment: null, orgId: opScope.orgId, deferred: opScope };

      const receiptResult = await client.query(
        'SELECT event_id, actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1',
        [id]
      );
      const receipt = receiptResult.rows[0];
      if (receipt) {
        const { checkReceiptScope } = require('../tenancy');
        const receiptScope = guest ? event.orgId : authorized.orgId;
        try {
          checkReceiptScope(receipt, receiptScope || undefined);
        } catch (scopeError) {
          throw failure(409, '같은 작업이 이미 다른 내용으로 처리되었습니다. 화면을 새로 고쳐 결과를 확인하세요.', undefined, scopeError.code);
        }
      }
      const pendingInput = object(payload);
      const pendingTicket = command === 'check.scan' ? ticketCode(pendingInput.ticket) : '';
      const pendingParticipantId = ['check.reviewed-exit', 'check.reconcile'].includes(command)
        ? clean(pendingInput.participantId, 120) || null
        : command === 'check.scan' && !pendingTicket
        ? clean(pendingInput.participantId, 120) || null
        : null;
      const scanAssignmentId = command === 'check.scan' && assignmentId != null ? String(assignmentId) : null;
      const boothAssignmentId = command === 'booth.visit' && assignmentId != null ? String(assignmentId) : null;
      const rewardAssignmentId = (command === 'reward.lookup' || command === 'reward.collect') && assignmentId != null ? String(assignmentId) : null;
      if (receipt) {
        if (!commandReceiptMatches(receipt, {
          eventId: event.id,
          actorId: guest ? null : account.id,
          command,
          ticketToken: guest ? ticketToken : null,
          participantId: pendingParticipantId,
        })) {
          throw failure(409, '같은 작업이 이미 다른 내용으로 처리되었습니다. 화면을 새로 고쳐 결과를 확인하세요.');
        }
        const stored = object(receipt.result);
        if (command === 'check.reviewed-exit' && stored.exitRequestProof !== reviewedExitRequest(pendingInput).proof) {
          throw failure(409, '이전 퇴장 확인 요청의 대상이나 내용이 다릅니다. 현장 기록을 확인하세요.', undefined, 'REVIEWED_EXIT_RECEIPT_MISMATCH');
        }
        if (command === 'check.reconcile' && stored.reconciliationProof !== reconciliationRequest(pendingInput).proof) {
          throw failure(409, '이전 출입 확인 요청의 대상이나 내용이 다릅니다. 현장 기록을 확인하세요.', undefined, 'ATTENDANCE_RECONCILIATION_RECEIPT_MISMATCH');
        }
        if (command === 'booth.mode-reviewed' && stored.boothModeProof !== reviewedBoothModeRequest(pendingInput).proof) {
          throw failure(409, '이전 인증 방식 변경 요청의 내용이 다릅니다. 기존 요청을 확인하세요.', undefined, 'BOOTH_MODE_RECEIPT_MISMATCH');
        }
        if (command === 'check.scan' && !scanRequestMatches(stored, workspace, {
          id, input: pendingInput, assignmentId: scanAssignmentId, ticket: pendingTicket,
        })) throw failure(409, '이전 요청의 티켓 또는 데스크가 다릅니다. 현장 기록을 확인하세요.');
        if (command === 'booth.visit' && !boothRequestMatches(stored, workspace, {
          id, eventId: event.id, actorId: guest ? null : account.id, input: pendingInput,
          assignmentId: boothAssignmentId, ticketToken, guest,
        })) throw failure(409, '이전 요청의 참가자 또는 부스가 다르거나 확인할 수 없습니다. 현장 기록을 확인하세요.', undefined, 'BOOTH_RECEIPT_MISMATCH');
        if ((command === 'reward.lookup' || command === 'reward.collect') && !rewardRequestMatches(stored, workspace, {
          command, input: pendingInput, assignmentId: rewardAssignmentId, actorId: account.id,
        })) throw failure(409, '이전 경품 요청의 대상이나 업무를 확인할 수 없습니다. 경품 내역을 확인하세요.', undefined, 'REWARD_RECEIPT_MISMATCH');
        const body = structuredClone(stored.response);
        if ((command === 'reward.lookup' || command === 'reward.collect') && !Object.hasOwn(stored, 'rewardRequest')) {
          // Only legacy receipts whose stored proof identifies the same
          // target and assignment reach this point.
          body.rewardRequestVersion = 1;
        }
        if (command === 'booth.visit' && !Object.hasOwn(stored, 'boothRequest')) {
          // Only proven legacy SELF / unassigned operator visits reach here.
          // Supply their identifiers from the matched durable record without
          // changing the original receipt or guessing an old assignment.
          const visit = list(workspace.visits).find((item) => item && String(item.id) === id);
          body.visitId = id;
          body.boothId = String(visit.boothId);
          body.participantId = String(visit.participantId);
        }
        if (command === 'check.scan') {
          body.checkId = id;
          const sources = attendanceSourceAvailability(row.workspace_payload);
          const recordStatus = sources.participants && sources.checks
            ? scanReplayStatus(workspace, id, body.id) : 'UNAVAILABLE';
          if (recordStatus) body.recordStatus = recordStatus;
        }
        return { status: 200, body, replayed: true };
      }

      const granted = guest
        ? authorized
        : await authorizeGrants(client, event, workspace, account, command, assignmentId, authorized.deferred);
      Object.assign(authorized, granted);

      const input = pendingInput;
      const now = new Date().toISOString();
      const workspaceBefore = structuredClone(workspace);
      ensureNotArchived(event);
      if (['check.scan', 'check.correct', 'check.reviewed-exit', 'check.reconcile'].includes(command)) {
        const sources = attendanceSourceAvailability(row.workspace_payload);
        if (!sources.participants || !sources.checks) {
          throw failure(409, '참가자 명단 또는 출입 기록을 확인할 수 없어 처리하지 않았습니다. 현장 책임자에게 문의하세요.', undefined, 'CHECK_SOURCE_UNAVAILABLE');
        }
      }
      let result;
      let scanRequest = null;
      let boothRequest = null;
      let exitRequestProof = null;
      let reconciliationProof = null;
      let boothModeProof = null;
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
          await projectCheckinRecord(client, event.id, scanResult.row);
          result = { body: { ...scanResult.body, checkId: id } };
          scanRequest = { deskId: scanResult.row.deskId, assignmentId: scanAssignmentId, ticketHash: ticketHash(pendingTicket) };
          if (pendingParticipantId && Object.hasOwn(input, 'expectedIdentity')) {
            scanRequest.manualIdentityHash = manualIdentityHash(input.expectedIdentity);
          }
          if (scanResult.row.action === 'OUT' && list(event.features).includes('reward')) {
            result.rewardPerson = scanResult.person;
          }
          break;
        }
        case 'check.correct':
          result = correctCheck(workspace, event, account, input, authorized.assignment, now, id);
          await markCheckinCorrected(client, event.id, result.body.check);
          break;
        case 'check.reviewed-exit': {
          const reviewed = reviewedExit(workspace, event, account, input, now, id);
          await projectCheckinRecord(client, event.id, reviewed.row);
          exitRequestProof = reviewed.proof;
          result = { body: reviewed.body };
          break;
        }
        case 'check.reconcile': {
          const original = object(row.workspace_payload);
          if (Object.hasOwn(original, 'audit') && !Array.isArray(original.audit)) {
            throw failure(409, '출입 확인 내역을 보존할 수 없습니다. 행사 기록을 먼저 확인하세요.', undefined, 'ATTENDANCE_RECONCILIATION_CHANGED');
          }
          const reconciled = reconcileAttendance(workspace, event, input, id);
          reconciliationProof = reconciled.proof;
          result = { body: reconciled.body, reconciliationAudit: reconciled.audit };
          break;
        }
        case 'booth.save':
          result = updateBooth(workspace, event, input);
          break;
        case 'booth.mode':
        case 'booth.mode-reviewed': {
          if (!list(event.features).includes('stamp')) throw failure(409, '이 행사에서 부스 인증 기능을 먼저 켜세요.');
          const original = object(row.workspace_payload);
          if (Object.hasOwn(original, 'visits') && !Array.isArray(original.visits)) {
            throw failure(409, '부스 인증 기록을 확인할 수 없습니다. 조직 관리자에게 문의하세요.', undefined, 'BOOTH_VISITS_UNAVAILABLE');
          }
          if (!['STAFF', 'SELF'].includes(workspace.stampMode)) {
            throw failure(409, '현재 부스 인증 방식을 확인할 수 없습니다. 조직 관리자에게 문의하세요.', undefined, 'BOOTH_MODE_UNAVAILABLE');
          }
          const reviewed = command === 'booth.mode-reviewed' ? reviewedBoothModeRequest(input) : null;
          if (reviewed && reviewed.expectedMode !== workspace.stampMode) {
            throw failure(409, '인증 방식이 변경되었습니다. 최신 상태를 확인하고 다시 선택하세요.', undefined, 'BOOTH_MODE_CHANGED');
          }
          result = setBoothMode(workspace, input);
          if (reviewed) { boothModeProof = reviewed.proof; result.body.previousMode = reviewed.expectedMode; }
          break;
        }
        case 'booth.visit':
          result = visitBooth(
            workspace, event, operationActor, input, authorized.assignment, now, id, guest ? ticketToken : ''
          );
          boothRequest = { boothId: result.body.boothId, assignmentId: boothAssignmentId,
            ticketHash: ticketHash(guest ? ticketToken : ticketCode(input.ticket)), mode: guest ? 'SELF' : 'STAFF' };
          break;
        case 'reward.lookup':
          result = await lookupRewards(client, workspace, event, operationActor, authorized.assignment, input);
          break;
        case 'reward.collect':
          result = await collectReward(client, workspace, event, operationActor, authorized.assignment, input);
          break;
        default:
          throw failure(400, '지원하지 않는 현장 운영 작업입니다.', 'command');
      }

      const rewardVerification = authorized.assignment && result.rewardPerson ? {
        assignmentId: authorized.assignment.id,
        participantId: String(result.rewardPerson.id),
        ticketHash: ticketHash(result.rewardPerson.ticket),
      } : null;
      if (rewardVerification) result.body.rewardVerificationId = id;
      if (command === 'reward.lookup' || command === 'reward.collect') result.body.rewardRequestVersion = 1;

      appendAudit(workspace, event, operationActor, command, input, id, now, result.reconciliationAudit);
      const persistedWorkspace = workspaceChangesForSave(row.workspace_payload, workspaceBefore, workspace);
      await client.query(
        `UPDATE event_workspaces
         SET payload = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE event_id = $1`,
        [event.id, JSON.stringify(persistedWorkspace)]
      );
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [id, event.id, guest ? null : String(account.id), guest ? event.orgId : authorized.orgId, JSON.stringify({
          command,
          response: result.body || {},
          ticketHash: ticketHash(guest ? ticketToken : null),
          participantId: pendingParticipantId,
          ...(scanRequest ? { scanRequest } : {}),
          ...(exitRequestProof ? { exitRequestProof } : {}),
          ...(reconciliationProof ? { reconciliationProof } : {}),
          ...(boothModeProof ? { boothModeProof } : {}),
          ...(boothRequest ? { boothRequest } : {}),
          ...((command === 'reward.lookup' || command === 'reward.collect') ? { rewardRequest: rewardRequest(command, input, rewardAssignmentId) } : {}),
          ...(rewardVerification ? { rewardVerification } : {}),
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
