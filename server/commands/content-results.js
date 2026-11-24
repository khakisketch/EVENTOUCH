'use strict';

const crypto = require('node:crypto');
const { recordDispatchRequest } = require('../message-outbox');
const { typedFor, renderText, messageSubject } = require('../messaging-solapi');
const { findSmsTextIssue } = require('../../apps/web/lib/sms-text-validation.cjs');
const { attendanceNeedsReview, indexLatestChecks } = require('../../apps/web/lib/attendance-state.cjs');
const { cancellationNeedsReview } = require('../../apps/web/lib/cancellation-state.cjs');
const { publicOrigin } = require('../public-origin');
const { ticketReviewState } = require('../ticket-lifetime');
const { reportSourceAvailability } = require('../report-source-availability');
const { normalizeScheduleAnchor, anchorInstant } = require('../message-schedule-anchor');

const COMMANDS = new Set([
  'template.save',
  'template.archive',
  'message.create',
  'message.create-reviewed',
  'message.create-charset-reviewed',
  'message.cancel',
  'message.retry',
  'message.retry-charset-reviewed',
  'message.sync',
  'message.record-provider-check',
  'payment.simulate',
  'payment.refund-request',
  'payment.refund',
  'reward.create',
  'reward.assign',
  'reward.fulfill',
  'reward.cancel',
  'report.create',
  'report.update',
  'report.publish',
  'report.successor',
]);

// Preserve explicit legacy LMS/MMS records. New ordinary text uses SMS and
// the dispatcher classifies after substitutions; MMS still requires the
// stored photo up front and Alimtalk requires its approved template id.
const MESSAGE_CHANNELS = new Set(['SMS', 'LMS', 'MMS', 'ALIMTALK']);
const TEMPLATE_VARIABLES = new Set(['이름', '행사명', '행사일', '티켓링크', '럭키번호']);
const REPORT_SECTIONS = new Set(['overview', 'attendance', 'programs', 'survey', 'photos']);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function requireText(ctx, value, label, max, field) {
  const text = ctx.clean(value, max);
  if (!text) throw ctx.fail(400, `${label}을(를) 입력하세요`, field);
  return text;
}

function requireFeature(ctx, feature) {
  if (!list(ctx.event.features).includes(feature)) throw ctx.fail(409, '행사 설정에서 이 기능을 먼저 켜세요');
}

// Reservations must identify an instant on every server, including after a
// deployment moves between timezones. Date.parse alone accepts local times
// and normalizes impossible dates, so validate the complete value first.
function explicitScheduleInstant(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) return NaN;
  const [, y, m, d, h, minute, second, , offset] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(h) > 23 || Number(minute) > 59 || (second && Number(second) > 59)) return NaN;
  if (offset.toUpperCase() !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return NaN;
  }
  return Date.parse(value);
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function saveTemplate(ctx, input) {
  if (!Array.isArray(ctx.workspace.templates)) ctx.workspace.templates = [];
  const id = ctx.clean(input.id || ctx.makeId('template'), 120);
  const old = ctx.workspace.templates.find((item) => item.id === id);
  if (old && old.archived === true) throw ctx.fail(409, '보관된 템플릿은 복원한 뒤 수정하세요', 'id');
  if (input.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw ctx.fail(400, '템플릿 버전을 확인하세요', 'expectedVersion');
    if (!old || templateVersion(old) !== input.expectedVersion) throw ctx.fail(409, '템플릿이 변경됐습니다. 목록을 새로고침한 뒤 다시 확인하세요', 'expectedVersion');
  }
  const channel = ctx.clean(input.channel, 16).toUpperCase();
  if (!MESSAGE_CHANNELS.has(channel)) throw ctx.fail(400, '메시지 채널을 선택하세요', 'channel');
  const template = {
    id,
    name: requireText(ctx, input.name, '템플릿 이름', 80, 'name'),
    channel,
    body: requireText(ctx, input.body, '메시지 내용', 2000, 'body'),
    // Solapi alimtalk can only send a template approved in their console, so
    // the product template must point at that approved id.
    solapiTemplateId: ctx.clean(input.solapiTemplateId, 120) || old?.solapiTemplateId || null,
    version: templateVersion(old) + 1,
    archived: false,
  };
  if (channel === 'ALIMTALK' && !template.solapiTemplateId) {
    // Without an approved id an alimtalk send is impossible; catching it here
    // is better than accepting a campaign that can never go out.
    throw ctx.fail(400, '알림톡 템플릿은 Solapi 승인 템플릿 ID가 필요합니다', 'solapiTemplateId');
  }
  if (old) Object.assign(old, template);
  else ctx.workspace.templates.push(template);
  return { body: { template } };
}

// Old workspace records have no version or archived flag. Additive metadata
// keeps them active, and pins archive/restore confirmation to the viewed text.
function templateVersion(template) {
  return Number.isSafeInteger(template?.version) && template.version >= 0 ? template.version : 0;
}

function archiveTemplate(ctx, input) {
  if (typeof input.archived !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw ctx.fail(400, '템플릿의 보관 상태와 버전을 확인하세요', 'expectedVersion');
  }
  const template = list(ctx.workspace.templates).find(item => item.id === ctx.clean(input.id, 120));
  if (!template) throw ctx.fail(404, '템플릿을 찾을 수 없습니다', 'id');
  const version = templateVersion(template);
  if (version !== input.expectedVersion) throw ctx.fail(409, '템플릿이 변경됐습니다. 목록을 새로고침한 뒤 다시 확인하세요', 'expectedVersion');
  template.archived = input.archived;
  template.version = version + 1;
  return { body: { template } };
}

// Builds the substitution values for one recipient. Called only while a
// dispatch is in flight so the ticket bearer never lands in stored history.
function messageVariables(ctx, liveParticipant, snapshot, workspace, prepared = {}) {
  const base = {
    이름: (liveParticipant && liveParticipant.name) || snapshot.name || '',
    행사명: ctx.event.name || '',
    행사일: ctx.event.date || '',
  };
  const origin = Object.hasOwn(prepared, 'origin') ? prepared.origin : publicOrigin();
  const ticket = liveParticipant && liveParticipant.ticket;
  // Without a configured public origin no link can be built, so the key is
  // omitted and the template keeps its own text rather than a broken URL.
  // (Campaigns requesting {{티켓링크}} are refused before enqueue without a
  // valid origin, so this omission is only a backstop, never a send path.)
  // The link lands on the new app's attendee home, where the bearer is
  // consumed once into tab memory; the legacy hash route is not used.
  if (origin && ticket && ctx.event.slug) {
    base.티켓링크 = origin + '/event/' + encodeURIComponent(ctx.event.slug) + '/home?ticket=' + encodeURIComponent(ticket);
  }
  // Lucky numbers are preassigned by the operator before invitation messaging
  // (lucky.preassign): message.retry refuses a {{럭키번호}} campaign while
  // any recipient still lacks one, so this is a real number at send time.
  const numbers = workspace && Array.isArray(workspace.luckyNumbers) ? workspace.luckyNumbers : [];
  const own = liveParticipant && (prepared.luckyById
    ? prepared.luckyById.get(liveParticipant.id)
    : numbers.find((item) => item && item.participantId === liveParticipant.id));
  base.럭키번호 = own && Number.isInteger(own.number) ? String(own.number) : '';
  return base;
}

function messageVariableLookup(workspace) {
  const luckyById = new Map();
  for (const item of list(workspace?.luckyNumbers)) {
    if (item && !luckyById.has(item.participantId)) luckyById.set(item.participantId, item);
  }
  return { origin: publicOrigin(), luckyById };
}

function participantLookup(workspace) {
  const participants = new Map();
  for (const person of list(workspace?.participants)) {
    if (person && !participants.has(person.id)) participants.set(person.id, person);
  }
  return participants;
}

function validateTemplateVariables(ctx, body) {
  const tokens = String(body).match(/\{\{[^{}]*\}\}/g) || [];
  if (tokens.some((token) => !TEMPLATE_VARIABLES.has(token.slice(2, -2)))) {
    throw ctx.fail(400, '지원하지 않는 메시지 변수가 있습니다', 'body');
  }
}

async function requireMmsImage(ctx, fileId) {
  const id = ctx.clean(fileId, 160);
  if (!id) throw ctx.fail(400, 'MMS는 JPG 이미지(200KB 이하)를 첨부해야 합니다', 'imageFileId');
  let rows = [];
  try {
    const result = await ctx.client.query(
      'SELECT id, original_name, content_type, size_bytes FROM stored_files WHERE id = $1 AND event_id = $2',
      [id, ctx.event.id]
    );
    rows = (result && result.rows) || [];
  } catch (error) {
    throw ctx.fail(500, '첨부 이미지를 확인하지 못했습니다', 'imageFileId');
  }
  const row = rows[0];
  if (!row) throw ctx.fail(404, '첨부 이미지 파일을 찾을 수 없습니다', 'imageFileId');
  if (row.content_type !== 'image/jpeg') {
    throw ctx.fail(400, 'MMS 이미지는 JPG 형식을 사용하세요', 'imageFileId');
  }
  if (Number(row.size_bytes) > 200 * 1024) {
    throw ctx.fail(400, 'MMS 이미지는 JPG 200KB 이하만 가능합니다', 'imageFileId');
  }
  return {
    fileId: String(row.id),
    name: String(row.original_name || ''),
    contentType: String(row.content_type || ''),
    sizeBytes: Number(row.size_bytes) || 0,
  };
}

function recipientReviewVersion(person) {
  return crypto.createHash('sha256').update(JSON.stringify([
    person.id, person.name, person.company, person.phone, person.group, person.status,
  ])).digest('hex');
}

// The operator chose recipients while seeing their participation status and
// group. Preserve those routing facts without copying extra personal data.
function recipientRoutingParts(person) {
  return [
    String(person?.status ?? '').trim().toUpperCase(),
    String(person?.group ?? '').trim() || '일반',
  ];
}
function recipientRoutingVersion(person) {
  return crypto.createHash('sha256').update(JSON.stringify(recipientRoutingParts(person))).digest('hex');
}

// The same assessment drives dispatch protection and the operator's
// explanation, so a reason cannot drift from the actual send guard.
function messageRecipientChangeAssessment(message, workspace, { details = false } = {}) {
  const snapshot = list(message.recipientSnapshot);
  if (message.simulate === true) return { count: 0, available: true, changes: [] };
  const usesRecipientName = typeof message.body === 'string' && message.body.includes('{{이름}}');
  const protectedRouting = Object.hasOwn(message, 'recipientRoutingReviewVersion');
  // Even an older personalized request must prove who was reviewed before
  // its names can be compared. Otherwise a missing snapshot can look like
  // an empty, successfully processed recipient list.
  if (protectedRouting || usesRecipientName) {
    const ids = message.recipientIds;
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    if ((protectedRouting && message.recipientRoutingReviewVersion !== 1) || !Array.isArray(ids) || !ids.length ||
      !Array.isArray(message.recipientSnapshot) || snapshot.length !== ids.length ||
      ids.some(id => typeof id !== 'string' || !id) || idSet.size !== ids.length ||
      snapshot.some(person => !person || typeof person.id !== 'string' || !idSet.has(person.id)) ||
      new Set(snapshot.map(person => person.id)).size !== ids.length) return { count: 1, available: false, changes: [] };
  } else if (!snapshot.length) return { count: 0, available: true, changes: [] };
  const current = new Map(), duplicateIds = new Set();
  for (const person of list(workspace.participants)) {
    if (!person) continue;
    if (current.has(person.id)) duplicateIds.add(person.id);
    current.set(person.id, person);
  }
  let count = 0;
  const changes = [];
  const mask = value => {
    const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
    return digits.length >= 8 ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}` : '연락처 확인 필요';
  };
  for (const person of snapshot) {
    if (!person || typeof person.id !== 'string') return { count: 1, available: false, changes: [] };
    const live = current.get(person.id);
    const reasons = [];
    if (!live) reasons.push('missing');
    else if ((protectedRouting || usesRecipientName) && duplicateIds.has(person.id)) reasons.push('ambiguous');
    else {
      if (String(live.status || '').toUpperCase() === 'CANCELLED' || live.cancelled === true || live.revoked === true) reasons.push('cancelled');
      if (usesRecipientName) {
        if (typeof person.name !== 'string' || !person.name.trim() || typeof live.name !== 'string' || !live.name.trim()) reasons.push('name-unavailable');
        else if (person.name !== live.name) reasons.push('name');
      }
      if (protectedRouting && (typeof person.routingVersion !== 'string' || !/^[a-f0-9]{64}$/.test(person.routingVersion))) reasons.push('unavailable');
      else if (protectedRouting && recipientRoutingVersion(live) !== person.routingVersion) {
        const priorAvailable = typeof person.routingStatus === 'string' && typeof person.routingGroup === 'string' &&
          recipientRoutingVersion({ status: person.routingStatus, group: person.routingGroup }) === person.routingVersion;
        const [status, group] = recipientRoutingParts(live);
        const [priorStatus, priorGroup] = recipientRoutingParts({ status: person.routingStatus, group: person.routingGroup });
        if (!priorAvailable) reasons.push('routing');
        else {
          if (status !== priorStatus) reasons.push('status');
          if (group !== priorGroup) reasons.push('group');
        }
      }
      if (String(live.phone || '').replace(/\D/g, '') !== String(person.phone || '').replace(/\D/g, '')) reasons.push('phone');
    }
    if (!reasons.length) continue;
    count++;
    if (details) {
      if (duplicateIds.has(person.id)) reasons.splice(0, reasons.length, 'ambiguous');
      const [status, group] = live && !duplicateIds.has(person.id) ? recipientRoutingParts(live) : ['', ''];
      const [priorStatus, priorGroup] = recipientRoutingParts({ status: person.routingStatus, group: person.routingGroup });
      changes.push({ id: person.id, name: typeof person.name === 'string' && person.name.trim() ? person.name : '이름 확인 필요',
        currentName: live && !duplicateIds.has(person.id) && typeof live.name === 'string' && live.name.trim() ? live.name : null,
        identityPhone: mask(person.phone), reasons,
        beforeStatus: reasons.includes('status') ? priorStatus : null, afterStatus: reasons.includes('status') ? status : null,
        beforeGroup: reasons.includes('group') ? priorGroup : null, afterGroup: reasons.includes('group') ? group : null,
        beforePhone: reasons.includes('phone') ? mask(person.phone) : null, afterPhone: reasons.includes('phone') ? mask(live?.phone) : null });
    }
  }
  return { count, available: true, changes };
}
function messageRecipientChangeCount(message, workspace) {
  return messageRecipientChangeAssessment(message, workspace).count;
}

// Link-bearing messages must not promise a ticket the recipient cannot use.
// Check the actual dispatch snapshot, not only the currently selected UI rows.
// This helper is also called immediately before an outbox provider invocation.
function ticketLinkGuard(message, workspace, { now = Date.now() } = {}) {
  if (message?.simulate === true || !String(message?.body || '').includes('{{티켓링크}}')) return null;
  const snapshot = message && message.recipientSnapshot;
  if (!Array.isArray(snapshot) || !snapshot.length || snapshot.some(person => !person || typeof person.id !== 'string' || !person.id) ||
      new Set(snapshot.map(person => person.id)).size !== snapshot.length) {
    return { reason: 'TICKET_RECIPIENTS_UNAVAILABLE', missing: 0 };
  }
  const current = new Map(list(workspace?.participants).filter(Boolean).map(person => [person.id, person]));
  const missing = snapshot.filter(person => ticketReviewState(current.get(person.id), now) !== 'valid').length;
  return missing ? { reason: 'TICKET_UNAVAILABLE', missing } : null;
}

// Check exactly the recipient-specific text the Solapi adapter will submit.
// This deliberately identifies only the characters the shared validator can
// prove unsupported; it does not claim to implement all of EUC-KR. Never
// return rendered text, ticket links or participant details in the result.
function smsCharacterGuard(message, workspace, { event, providerKind } = {}) {
  if (providerKind !== 'solapi' || !message || message.simulate === true) return null;
  const channel = String(message.channel || '').toUpperCase();
  if (!['SMS', 'LMS', 'MMS', 'ALIMTALK'].includes(channel)) return null;
  // Dispatch builds provider recipients from the snapshot but the review and
  // delivery history name recipientIds/deliveries. A partial or mismatched
  // legacy record cannot prove that all reviewed recipients were checked;
  // fail closed before deciding that this batch is safe to submit.
  const ids = Array.isArray(message.recipientIds) ? message.recipientIds : [];
  const recipients = Array.isArray(message.recipientSnapshot) ? message.recipientSnapshot : [];
  const deliveries = Array.isArray(message.deliveries) ? message.deliveries : [];
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 120;
  const idSet = new Set(ids);
  const snapshotIds = recipients.map(person => person && person.id);
  const deliveryIds = deliveries.map(delivery => delivery && delivery.participantId);
  if (!ids.length || ids.some(id => !validId(id)) || idSet.size !== ids.length ||
      snapshotIds.length !== ids.length || snapshotIds.some(id => !validId(id) || !idSet.has(id)) ||
      new Set(snapshotIds).size !== ids.length ||
      deliveryIds.length !== ids.length || deliveryIds.some(id => !validId(id) || !idSet.has(id)) ||
      new Set(deliveryIds).size !== ids.length) {
    return { reason: 'SMS_CHARSET_REVIEW_UNAVAILABLE', missing: 0, field: 'ids' };
  }
  if (channel === 'ALIMTALK' && message.smsFallback === false) return null;
  const live = participantLookup(workspace);
  const prepared = messageVariableLookup(workspace);
  const rawBodyHasIssue = Boolean(findSmsTextIssue(message.body));
  const title = messageSubject(message.title);
  const titleHasIssue = Boolean(findSmsTextIssue(title));
  let missing = 0, bodyProblem = false, titleProblem = false, personalizedProblem = false;
  for (const snapshot of recipients) {
    const variables = messageVariables({ event: event || {} }, live.get(snapshot.id), snapshot, workspace, prepared);
    const rendered = renderText(message.body, variables);
    const bodyIssue = findSmsTextIssue(rendered);
    // The adapter never sends a subject for SMS or Alimtalk. LMS and MMS do.
    const actualType = channel === 'ALIMTALK' ? 'ATA' : typedFor(channel, rendered).type;
    const badTitle = titleHasIssue && (actualType === 'LMS' || actualType === 'MMS');
    if (!bodyIssue && !badTitle) continue;
    missing += 1;
    if (bodyIssue && rawBodyHasIssue) bodyProblem = true;
    if (bodyIssue && !rawBodyHasIssue) personalizedProblem = true;
    if (badTitle) titleProblem = true;
  }
  if (!missing) return null;
  return { reason: 'SMS_CHARSET_UNSUPPORTED', missing,
    field: bodyProblem ? 'body' : titleProblem ? 'title' : 'ids',
    personalized: personalizedProblem };
}

async function createMessage(ctx, input) {
  const ids = Array.isArray(input.ids) ? input.ids.map((id) => ctx.clean(id, 120)) : [];
  if (!ids.length || ids.length > 5000 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw ctx.fail(400, '발송 대상을 선택하세요', 'ids');
  }
  const participantsById = new Map(list(ctx.workspace.participants).filter(person => person && typeof person.id === 'string').map(person => [person.id, person]));
  const recipients = ids.map(id => participantsById.get(id));
  const expected = input.expectedRecipientVersions;
  if (['message.create-reviewed', 'message.create-charset-reviewed'].includes(ctx.command) && expected === undefined) {
    throw ctx.fail(400, '수신자 검토 정보를 다시 확인하세요', 'expectedRecipientVersions');
  }
  if (expected !== undefined && (!Array.isArray(expected) || expected.length !== ids.length ||
    expected.some(version => typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))) {
    throw ctx.fail(400, '수신자 검토 정보를 다시 확인하세요', 'expectedRecipientVersions');
  }
  if (recipients.some((person, index) => !person || String(person.status || '').toUpperCase() === 'CANCELLED' || person.cancelled === true ||
    (expected !== undefined && recipientReviewVersion(person) !== expected[index]))) {
    throw ctx.fail(409, '검토 후 수신자 정보가 변경되었습니다. 최신 대상을 다시 확인하세요',
      expected === undefined ? undefined : 'expectedRecipientVersions');
  }
  const channel = ctx.clean(input.channel, 16).toUpperCase();
  if (!MESSAGE_CHANNELS.has(channel)) throw ctx.fail(400, '발송 채널을 선택하세요', 'channel');
  if (ctx.command === 'message.create-charset-reviewed' && channel === 'ALIMTALK' && typeof input.smsFallback !== 'boolean') {
    throw ctx.fail(400, '알림톡 미전달 시 문자 대체 여부를 선택하세요', 'smsFallback');
  }
  // Alimtalk cannot be sent from free text, so the campaign must name the
  // approved template it will use. Failing here beats dispatching a campaign
  // that was never able to go out.
  const templateId = ctx.clean(input.templateId, 120) || null;
  const boundTemplate = templateId
    ? list(ctx.workspace.templates).find((item) => item.id === templateId)
    : null;
  if (boundTemplate?.archived === true) throw ctx.fail(409, '보관된 템플릿입니다. 복원하거나 다른 템플릿을 선택하세요', 'templateId');
  if (channel === 'ALIMTALK' && !(boundTemplate && boundTemplate.channel === 'ALIMTALK' && boundTemplate.solapiTemplateId)) {
    throw ctx.fail(400, '알림톡은 Solapi 승인 템플릿을 선택해야 발송할 수 있습니다', 'templateId');
  }
  const title = requireText(ctx, input.title, '캠페인 제목', 100, 'title');
  const body = requireText(ctx, input.body, '내용', 2000, 'body');
  validateTemplateVariables(ctx, body);
  if (channel === 'ALIMTALK' && body !== String(boundTemplate.body || '').trim()) {
    throw ctx.fail(409, '알림톡 문구가 선택한 템플릿과 다릅니다. 최신 템플릿을 다시 선택하세요', 'templateId');
  }
  // Variable-bearing messages are checked on their fully rendered content by
  // the provider. Plain over-limit text can be caught before recording a send.
  if (!/\{\{[^{}]*\}\}/.test(body) && typedFor(channel, body).reason === 'TOO_LONG') {
    throw ctx.fail(400, channel === 'ALIMTALK' ? '알림톡은 1,000자 이내의 승인 문구를 사용하세요' : '문자 내용이 2,000byte를 넘었습니다. 내용을 줄여 주세요', 'body');
  }


  // MMS photo: pinned to a stored event file now so dispatch can upload that
  // exact file to the provider once per campaign. Only the file id is kept
  // on the message; bytes stay in file storage.
  let image = null;
  if (channel === 'MMS') {
    image = await requireMmsImage(ctx, input.imageFileId);
  }

  // A malformed reservation must never silently become an immediate send.
  if (input.scheduled !== undefined && input.scheduled !== null &&
      (typeof input.scheduled !== 'string' || input.scheduled.length > 64 || (input.scheduled !== '' && !input.scheduled.trim()))) {
    throw ctx.fail(400, '예약 시각과 시간대를 확인하고 현재 이후로 설정하세요', 'scheduled');
  }
  const scheduled = input.scheduled ? ctx.clean(input.scheduled, 64) : '';
  const scheduledAt = scheduled ? explicitScheduleInstant(scheduled) : NaN;
  if (scheduled && (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now())) {
    throw ctx.fail(400, '예약 시각과 시간대를 확인하고 현재 이후로 설정하세요', 'scheduled');
  }
  // Event-relative reservations keep their rule so a later event-date change
  // can move them. The rule must reproduce the instant the operator reviewed
  // against the event date stored now; a stale editor is rejected, never
  // silently re-timed.
  let scheduleAnchor = null;
  if (input.scheduleAnchor !== undefined && input.scheduleAnchor !== null) {
    scheduleAnchor = normalizeScheduleAnchor(input.scheduleAnchor);
    if (!scheduleAnchor || !scheduled) throw ctx.fail(400, '행사 기준 예약 설정을 확인하세요', 'scheduleAnchor');
    const expectedInstant = anchorInstant(ctx.event.date, scheduleAnchor);
    if (!expectedInstant || Date.parse(expectedInstant) !== scheduledAt) {
      throw ctx.fail(409, '행사 날짜가 바뀌었거나 예약 시각이 맞지 않습니다. 행사 정보를 새로 불러온 뒤 다시 설정하세요', 'scheduleAnchor');
    }
  }
  const simulated = input.simulate === true;
  if (!simulated) {
    assertDispatchGuard(ctx, ticketLinkGuard({ body, recipientSnapshot: recipients }, ctx.workspace));
  }
  const scheduleMode = input.scheduleMode === undefined ? 'MANUAL' : ctx.clean(input.scheduleMode, 16).toUpperCase();
  if (!['MANUAL', 'AUTO'].includes(scheduleMode) || (scheduleMode === 'AUTO' && (!scheduled || simulated))) {
    throw ctx.fail(400, '예약 실행 방식을 확인하세요', 'scheduleMode');
  }
  const immediateConnected = !scheduled && !simulated && ctx.messaging?.connected === true;
  const status = scheduled ? 'SCHEDULED' : simulated ? 'SIMULATED' : immediateConnected ? 'SENDING' : 'NEEDS_CONNECTION';
  const message = {
    id: ctx.commandId,
    title,
    body,
    channel,
    ...(channel === 'ALIMTALK' && typeof input.smsFallback === 'boolean' ? { smsFallback: input.smsFallback } : {}),
    recipientIds: recipients.map((person) => person.id),
    recipientRoutingReviewVersion: 1,
    // Never duplicate attendee ticket bearers into campaign history.
    recipientSnapshot: recipients.map((person) => ({
      id: person.id,
      name: String(person.name || ''),
      phone: String(person.phone || ''),
      routingVersion: recipientRoutingVersion(person),
      routingStatus: recipientRoutingParts(person)[0],
      routingGroup: recipientRoutingParts(person)[1],
    })),
    scheduled,
    ...(scheduled && scheduleAnchor ? { scheduleAnchor } : {}),
    ...(scheduled ? { scheduleMode, ...(scheduleMode === 'AUTO' ? { autoScheduleIntent: 'confirmed-v1' } : {}) } : {}),
    status,
    simulate: simulated,
    templateId,
    solapiTemplateId: boundTemplate ? boundTemplate.solapiTemplateId : null,
    ...(image ? { image } : {}),
    at: ctx.now,
    cost: null,
    attempts: status === 'SCHEDULED' ? 0 : 1,
    deliveries: recipients.map((person) => ({
      participantId: person.id,
      name: String(person.name || ''),
      status: status === 'SIMULATED' ? 'SIMULATED' : status === 'NEEDS_CONNECTION' ? 'UNCONNECTED' : status === 'SENDING' ? 'SENDING' : 'WAITING',
      at: ctx.now,
    })),
  };
  assertDispatchGuard(ctx, smsCharacterGuard(message, ctx.workspace, { event: ctx.event, providerKind: ctx.messaging?.provider }));
  if (immediateConnected) {
    // Apply exactly the same pre-send checks as manual and automatic sends.
    // The outbox intent and receipt commit with the campaign; the provider
    // is contacted only after the transaction commits in domain.execute.
    assertDispatchGuard(ctx, dueScheduleGuards(message, ctx.workspace, { now: Date.now(), event: ctx.event, providerKind: ctx.messaging?.provider }));
    await recordDispatchRequest(ctx.client, ctx.event.id, message.id, { claimed: true });
  }
  ctx.workspace.messages.unshift(message);
  return { status: 201, body: { message, ...(['message.create-reviewed', 'message.create-charset-reviewed'].includes(ctx.command) ? { messageRequestVersion: 1 } : {}), ...(ctx.command === 'message.create-charset-reviewed' ? { messageCharsetPolicyVersion: 1 } : {}) }, ...(immediateConnected ? { dispatch: { eventId: ctx.event.id, messageId: message.id } } : {}) };
}

function cancelMessage(ctx, input) {
  const message = list(ctx.workspace.messages).find((item) => item.id === ctx.clean(input.id, 120));
  if (!message || !['SCHEDULED', 'DRAFT', 'NEEDS_CONNECTION'].includes(message.status)) {
    throw ctx.fail(409, '취소할 수 없는 상태입니다');
  }
  // A blocked reservation needs a safe path back to the composer after it
  // is cancelled. Cancellation overwrites delivery statuses, so establish
  // that it has never been submitted *before* changing them. Unknown or
  // inconsistent legacy records never acquire this permission.
  const snapshots = Array.isArray(message.recipientSnapshot) ? message.recipientSnapshot : [];
  const deliveries = Array.isArray(message.deliveries) ? message.deliveries : [];
  const recipientIds = Array.isArray(message.recipientIds) ? message.recipientIds : [];
  const snapshotIds = new Set(snapshots.map(person => person && person.id));
  const deliveryIds = new Set(deliveries.map(delivery => delivery && delivery.participantId));
  const recipientIdSet = new Set(recipientIds);
  const definitelyUnsent = message.status === 'SCHEDULED' && message.attempts === 0 &&
    !message.providerSubmission && !message.providerGroupId && !message.deliveryUnconfirmed &&
    !message.genericSubmissionUnconfirmed && !message.genericAttemptActive && !message.dispatchedAt &&
    (message.acceptedCount == null || message.acceptedCount === 0) && snapshots.length > 0 &&
    snapshots.every(person => person && typeof person.id === 'string' && Boolean(person.id)) &&
    snapshotIds.size === snapshots.length && recipientIds.length === snapshots.length &&
    recipientIdSet.size === recipientIds.length && recipientIds.every(id => typeof id === 'string' && Boolean(id) && snapshotIds.has(id)) &&
    deliveries.length === snapshots.length &&
    deliveryIds.size === deliveries.length && deliveries.every(delivery => delivery &&
      snapshotIds.has(delivery.participantId) && delivery.status === 'WAITING' &&
      !delivery.solapiMessageId && !delivery.providerMessageId && !delivery.sentType && !delivery.resultMatchUnconfirmed);
  if (definitelyUnsent) {
    const textIssue = smsCharacterGuard(message, ctx.workspace, { event: ctx.event, providerKind: ctx.messaging?.provider });
    if (textIssue) {
      message.smsTextProblemCount = textIssue.missing;
      message.smsTextProblemField = textIssue.field;
      message.smsTextProblemUnknown = textIssue.reason === 'SMS_CHARSET_REVIEW_UNAVAILABLE';
      message.smsTextReloadSafe = true;
    }
  }
  const changed = messageRecipientChangeCount(message, ctx.workspace);
  if (changed) message.recipientChangeCount = changed;
  message.status = 'CANCELLED';
  list(message.deliveries).forEach((delivery) => { delivery.status = 'CANCELLED'; });
  return { body: { message } };
}

// Delivery can only be confirmed by asking Solapi what happened to the
// messages it accepted, so this marks the campaign for the post-commit
// resolver rather than touching the network inside the transaction.
function syncMessage(ctx, input) {
  const messages = list(ctx.workspace.messages);
  const targeted = Object.hasOwn(input, 'id');
  const targetId = ctx.clean(input.id, 120);
  const message = targeted
    ? messages.find((item) => item.id === targetId)
    : messages.find((item) => item.status === 'SENDING');
  if (!message && targeted) throw ctx.fail(404, '선택한 발송 건을 찾을 수 없습니다. 발송 기록을 다시 확인하세요.', 'id');
  if (!message) throw ctx.fail(409, '확인할 발송 건이 없습니다');
  return { body: { message, pending: true }, resolvePending: true, resolveCampaignId: targeted ? message.id : null };
}

// This is an operator's record of their own external provider check, not a
// system verification and not proof of delivery to the recipient device.
function recordProviderCheck(ctx, input) {
  const message = list(ctx.workspace.messages).find(item => item && item.id === ctx.clean(input.id, 120));
  if (!message || message.status !== 'SENDING' ||
      !(message.genericTransport === true || message.providerSubmission?.kind === 'HTTP' || message.genericSubmissionUnconfirmed === true)) {
    throw ctx.fail(409, '이 발송은 공급사 확인 기록 대상이 아닙니다. 발송 내역을 다시 확인하세요', 'id', 'PROVIDER_CHECK_CHANGED');
  }
  if (message.genericAttemptActive !== false) {
    throw ctx.fail(409, '이전 발송의 종료 여부를 확인할 수 없습니다. 공급사 내역과 운영 상태를 확인하세요', 'id', 'PROVIDER_ATTEMPT_ACTIVE');
  }
  const expected = input.expectedSubmissionId;
  const submissionId = message.providerSubmission?.id || null;
  if (!(expected === null || (typeof expected === 'string' && expected.length > 0 && expected.length <= 160)) || expected !== submissionId ||
      typeof input.participantId !== 'string' || !input.participantId ||
      !['ACCEPTED', 'NOT_ACCEPTED'].includes(input.outcome)) {
    throw ctx.fail(409, '발송 상태가 변경되었습니다. 내역을 다시 확인하세요', 'id', 'PROVIDER_CHECK_CHANGED');
  }
  const matches = list(message.deliveries).filter(item => item && item.participantId === input.participantId);
  if (matches.length !== 1 || matches[0].status !== 'SENDING' || matches[0].genericProviderResult === 'ACCEPTED' || matches[0].manualProviderReview) {
    throw ctx.fail(409, '수신자의 확인 상태가 변경되었습니다. 내역을 다시 확인하세요', 'id', 'PROVIDER_CHECK_CHANGED');
  }
  const delivery = matches[0];
  delivery.manualProviderReview = { outcome: input.outcome, actorId: String(ctx.actor.id), at: ctx.now };
  delivery.genericProviderResult = input.outcome;
  delivery.status = input.outcome === 'ACCEPTED' ? 'ACCEPTED' : 'FAILED';
  delivery.error = input.outcome === 'ACCEPTED' ? null : '운영자가 공급사 미접수를 확인해 기록했습니다';
  delivery.at = ctx.now;
  message.genericTransport = true;
  const unresolved = list(message.deliveries).some(item => item?.status === 'SENDING');
  const accepted = list(message.deliveries).filter(item => item?.status === 'ACCEPTED').length;
  message.acceptedCount = accepted;
  message.genericSubmissionUnconfirmed = unresolved;
  message.deliveryUnconfirmed = unresolved || accepted > 0;
  if (!unresolved) {
    message.status = accepted ? 'ACCEPTED' : 'FAILED';
    delete message.providerSubmission;
  }
  return { body: { message, providerCheck: { id: message.id, participantId: input.participantId, outcome: input.outcome, expectedSubmissionId: expected } } };
}

// Pre-send guards shared by the operator path (retryMessage) and the
// opt-in maintenance worker (enqueueDueScheduled). One pure function, so a
// guard added or tightened here applies to both and cannot drift between a
// hand tap and an automatic run. Returns null when the campaign may proceed,
// otherwise { reason, missing } with one of:
//   NOT_DUE / INVALID_SCHEDULE / RECIPIENT_CHANGED / NO_PUBLIC_ORIGIN / LUCKY_NUMBER_MISSING
// Status handling (SCHEDULED vs NEEDS_CONNECTION) and simulate marking stay
// with each caller: their semantics legitimately differ.
function dueScheduleGuards(message, workspace, { now = Date.now(), origin, event, providerKind } = {}) {
  const at = Number(now) || Date.now();
  const scheduled = message && message.scheduled ? explicitScheduleInstant(message.scheduled) : NaN;
  // An older reservation can also be NEEDS_CONNECTION after a failed
  // dispatch. Its retained scheduled value must not bypass this check.
  if (message && (message.status === 'SCHEDULED' || message.scheduled) && !Number.isFinite(scheduled)) return { reason: 'INVALID_SCHEDULE', missing: 0 };
  if (Number.isFinite(scheduled) && scheduled > at) return { reason: 'NOT_DUE', missing: 0 };
  const changed = message ? messageRecipientChangeCount(message, workspace) : 0;
  // When a changed personalized value also cannot be sent by the provider,
  // report the actionable text problem first. Both checks still block.
  const changedTextGuard = changed ? smsCharacterGuard(message, workspace, { event, providerKind }) : null;
  if (changedTextGuard) return changedTextGuard;
  if (changed) return { reason: 'RECIPIENT_CHANGED', missing: changed };
  const resolvedOrigin = origin === undefined ? publicOrigin() : origin;
  if (String(message && message.body).includes('{{티켓링크}}') && !resolvedOrigin) {
    return { reason: 'NO_PUBLIC_ORIGIN', missing: 0 };
  }
  const invalidTickets = ticketLinkGuard(message, workspace, { now: at });
  if (invalidTickets) return invalidTickets;
  if (String(message && message.body).includes('{{럭키번호}}')) {
    const numbers = Array.isArray(workspace && workspace.luckyNumbers) ? workspace.luckyNumbers : [];
    const recipients = Array.isArray(message && message.recipientIds) ? message.recipientIds : [];
    const assigned = new Set(numbers.filter((item) => item && Number.isInteger(item.number)).map((item) => item.participantId));
    const missing = recipients.filter((id) => !assigned.has(id)).length;
    if (missing) return { reason: 'LUCKY_NUMBER_MISSING', missing };
  }
  const characterGuard = smsCharacterGuard(message, workspace, { event, providerKind });
  if (characterGuard) return characterGuard;
  return null;
}

function assertDispatchGuard(ctx, guard) {
  if (!guard) return;
  if (guard.reason === 'NOT_DUE') throw ctx.fail(409, '예약 시각 전입니다');
  if (guard.reason === 'INVALID_SCHEDULE') throw ctx.fail(409, '예약 시각을 확인할 수 없습니다. 예약을 취소하고 다시 등록하세요');
  if (guard.reason === 'RECIPIENT_CHANGED') {
    throw ctx.fail(409, '수신자의 이름·참가 상태·그룹·연락처가 달라졌거나 확인할 수 없습니다. 기존 요청을 취소하고 대상을 다시 확인하세요', 'recipientChange');
  }
  if (guard.reason === 'NO_PUBLIC_ORIGIN') {
    throw ctx.fail(409, '참가자 초대 링크를 만들 공개 주소가 설정되지 않았습니다. EVENTOUCH_PUBLIC_URL을 http(s) 주소로 설정하세요');
  }
  if (guard.reason === 'TICKET_UNAVAILABLE') {
    throw ctx.fail(409, `티켓을 사용할 수 없는 수신자가 ${guard.missing}명입니다. 참가자 명단에서 티켓을 확인하고 다시 시도하세요`, 'ids', 'TICKET_UNAVAILABLE');
  }
  if (guard.reason === 'TICKET_RECIPIENTS_UNAVAILABLE') {
    throw ctx.fail(409, '수신자와 티켓 상태를 확인할 수 없습니다. 기존 요청을 취소하고 대상을 다시 선택하세요', 'ids', 'TICKET_RECIPIENTS_UNAVAILABLE');
  }
  if (guard.reason === 'SMS_CHARSET_UNSUPPORTED') {
    throw ctx.fail(409, `문자로 보낼 수 없는 글자가 ${guard.missing}명의 내용에 있습니다. 문구와 수신자 정보를 확인하세요`, guard.field || 'body', 'SMS_CHARSET_UNSUPPORTED');
  }
  if (guard.reason === 'SMS_CHARSET_REVIEW_UNAVAILABLE') {
    throw ctx.fail(409, '문자 수신자를 확인할 수 없습니다. 기존 요청을 취소하고 대상을 다시 선택하세요', 'ids', 'SMS_CHARSET_REVIEW_UNAVAILABLE');
  }
  throw ctx.fail(409, `럭키번호가 배정되지 않은 대상이 ${guard.missing}명 있습니다. 먼저 럭키번호를 배정하세요`, 'ids');
}

// The dispatcher needs a reachable address per recipient; the snapshot
// is the only place the phone number is kept. Variables are computed here
// and never persisted: a ticket link is a bearer credential, and campaign
// history must not retain one.
function buildMessageDispatch(event, workspace, message) {
  // A requested ticket link with no valid public origin must never reach the
  // provider as a literal placeholder — not even when the environment
  // changed after enqueue. Throwing here keeps the outbox row queued (the
  // drain treats it as a retryable failure) instead of sending a broken text.
  if (String(message.body).includes('{{티켓링크}}') && !publicOrigin()) {
    throw Object.assign(
      new Error('참가자 초대 링크를 만들 공개 주소가 설정되지 않았습니다. EVENTOUCH_PUBLIC_URL을 http(s) 주소로 설정하세요'),
      { status: 409 }
    );
  }
  const live = participantLookup(workspace);
  const prepared = messageVariableLookup(workspace);
  return {
    eventId: event.id,
    messageId: message.id,
    providerGroupId: message.providerGroupId || null,
    channel: message.channel,
    ...(typeof message.smsFallback === 'boolean' ? { smsFallback: message.smsFallback } : {}),
    subject: message.title,
    text: message.body,
    templateId: message.solapiTemplateId || null,
    imageFileId: (message.image && message.image.fileId) || null,
    recipients: list(message.recipientSnapshot).map((person) => {
      const livePerson = live.get(person.id);
      return {
        participantId: person.id,
        name: person.name,
        phone: person.phone,
        variables: messageVariables({ event }, livePerson, person, workspace, prepared),
      };
    }),
  };
}

async function retryMessage(ctx, input) {
  const message = list(ctx.workspace.messages).find((item) => item.id === ctx.clean(input.id, 120));
  if (!message || !['SCHEDULED', 'NEEDS_CONNECTION'].includes(message.status)) {
    throw ctx.fail(409, '실행할 수 없는 상태입니다');
  }
  // Pre-send guards are shared with the maintenance worker
  // (dueScheduleGuards): the operator's tap and an automatic run refuse the
  // same broken campaigns. Refused here means before enqueue: no attempts
  // increment, no outbox row.
  assertDispatchGuard(ctx, dueScheduleGuards(message, ctx.workspace, { now: Date.now(), event: ctx.event, providerKind: ctx.messaging?.provider }));

  message.attempts = (Number(message.attempts) || 0) + 1;

  // A connected provider makes this a real send. The network call must not
  // run inside the surrounding transaction: a slow provider would hold the
  // event row lock, and a provider that accepted a message we then rolled
  // back would be unrecorded. The transaction records the intent as SENDING
  // and queues the send in the outbox; the dispatcher sends after commit
  // and writes the outcome back. If the process dies first, the queued row
  // is what a later drain replays.
  if (message.simulate !== true && ctx.messaging && ctx.messaging.connected) {
    message.status = 'SENDING';
    list(message.deliveries).forEach((delivery) => {
      delivery.status = 'SENDING';
      delivery.at = ctx.now;
    });
    await recordDispatchRequest(ctx.client, ctx.event.id, message.id, { claimed: true });
    return { body: { message, ...(ctx.command === 'message.retry-charset-reviewed' ? { messageCharsetPolicyVersion: 1 } : {}) }, dispatch: { eventId: ctx.event.id, messageId: message.id } };
  }

  message.status = message.simulate === true ? 'SIMULATED' : 'NEEDS_CONNECTION';
  list(message.deliveries).forEach((delivery) => {
    delivery.status = message.simulate === true ? 'SIMULATED' : 'UNCONNECTED';
    delivery.at = ctx.now;
  });
  return { body: { message, ...(ctx.command === 'message.retry-charset-reviewed' ? { messageCharsetPolicyVersion: 1 } : {}) } };
}

function findPayment(ctx, id) {
  const payment = list(ctx.workspace.payments).find((item) => item.id === ctx.clean(id, 120));
  if (!payment) throw ctx.fail(404, '결제 내역을 찾을 수 없습니다');
  return payment;
}

function simulatePayment(ctx, input) {
  requireFeature(ctx, 'payment');
  const payment = findPayment(ctx, input.id);
  if (payment.participantId !== ctx.participant.id || !['PENDING', 'FAILED'].includes(payment.status)) {
    throw ctx.fail(409, '처리할 결제 대기 건이 없습니다');
  }
  const status = ctx.clean(input.status, 24).toUpperCase();
  if (!['PAID', 'FAILED', 'CANCELLED'].includes(status)) throw ctx.fail(400, '결제 처리 상태를 확인하세요', 'status');
  payment.status = status;
  payment.simulated = true;
  payment.updatedAt = ctx.now;
  ctx.participant.paymentStatus = status;
  if (status === 'CANCELLED') {
    ctx.participant.status = 'CANCELLED';
    ctx.participant.revoked = true;
  }
  return { body: { payment: { ...payment } } };
}

function requestRefund(ctx, input) {
  requireFeature(ctx, 'payment');
  const payment = findPayment(ctx, input.id);
  if (payment.participantId !== ctx.participant.id || payment.status !== 'PAID') {
    throw ctx.fail(409, '환불 요청할 결제가 없습니다');
  }
  if (ctx.participant.inside === true) throw ctx.fail(409, '입장 중에는 안내 데스크에 환불을 문의하세요');
  payment.status = 'REFUND_REQUESTED';
  payment.reason = requireText(ctx, input.reason, '환불 사유', 300, 'reason');
  payment.updatedAt = ctx.now;
  ctx.participant.paymentStatus = 'REFUND_REQUESTED';
  return { body: { payment: { ...payment } } };
}

function refundPayment(ctx, input) {
  requireFeature(ctx, 'payment');
  const payment = findPayment(ctx, input.id);
  if (payment.status !== 'REFUND_REQUESTED') throw ctx.fail(409, '환불 요청을 선택하세요');
  payment.status = 'REFUNDED';
  payment.simulated = true;
  payment.updatedAt = ctx.now;
  const person = list(ctx.workspace.participants).find((item) => item.id === payment.participantId);
  if (person) {
    person.paymentStatus = 'REFUNDED';
    person.status = 'CANCELLED';
    person.revoked = true;
  }
  return { body: { payment: { ...payment } } };
}

function createReward(ctx, input) {
  requireFeature(ctx, 'reward');
  const recipients = list(ctx.workspace.participants).filter((item) => item && item.id === ctx.clean(input.participantId, 120));
  const person = recipients.length === 1 ? recipients[0] : null;
  if (!person || person.status !== 'APPROVED' || person.cancelled === true) throw ctx.fail(404, '참가 확정자를 선택하세요');
  const method = ctx.clean(input.method, 16).toUpperCase();
  if (!['ONSITE', 'GIFT'].includes(method)) throw ctx.fail(400, '지급 방식을 선택하세요', 'method');
  const reward = {
    id: ctx.commandId,
    participantId: person.id,
    name: requireText(ctx, input.name, '경품명', 80, 'name'),
    method,
    status: 'READY',
    at: ctx.now,
    code: method === 'GIFT' ? `DEMO-${randomId('gift')}` : '',
    claim: null,
  };
  ctx.workspace.rewards.push(reward);
  return { status: 201, body: { reward: { ...reward } } };
}

// Company-draw entitlements stay pending until the operator names an
// explicit recipient: imported data never identifies the company head, so the
// server must not pick one. The recipient must belong to the winning company
// and be approved; assignment flips PENDING to READY, which is what makes
// the existing fulfill/collect paths accept it.
function assignReward(ctx, input) {
  requireFeature(ctx, 'reward');
  const reward = list(ctx.workspace.rewards).find((item) => item.id === ctx.clean(input.id, 120));
  if (!reward) throw ctx.fail(404, '경품을 찾을 수 없습니다');
  if (reward.status !== 'PENDING' || reward.participantId) {
    throw ctx.fail(409, '수령자를 지정할 경품이 아닙니다');
  }
  const recipients = list(ctx.workspace.participants).filter((item) => item && item.id === ctx.clean(input.participantId, 120));
  const person = recipients.length === 1 ? recipients[0] : null;
  if (!person || person.cancelled === true || String(person.status || '').toUpperCase() !== 'APPROVED') {
    throw ctx.fail(404, '참가 확정자를 선택하세요');
  }
  if (reward.company && String(person.company || '') !== String(reward.company)) {
    throw ctx.fail(400, '당첨 업체 소속 참가자를 선택하세요', 'participantId');
  }
  reward.participantId = person.id;
  reward.status = 'READY';
  reward.assignedAt = ctx.now;
  reward.assignedBy = ctx.actor.id;
  const source = reward.source && typeof reward.source === 'object' ? reward.source : {};
  if (source.kind === 'draw' && source.programId) {
    const program = list(ctx.workspace.drawPrograms).find((item) => item && item.id === source.programId);
    const winner = program && list(program.winners)[Number(source.winnerIndex)];
    if (winner && !winner.recipientId) {
      winner.recipientId = person.id;
      winner.recipientName = String(person.name || '');
    }
  }
  return { body: { reward: { ...reward } } };
}

function fulfillReward(ctx, input) {
  requireFeature(ctx, 'reward');
  const reward = list(ctx.workspace.rewards).find((item) => item.id === ctx.clean(input.id, 120));
  if (!reward || !['READY', 'FAILED'].includes(reward.status)) throw ctx.fail(409, '지급 대기 경품을 선택하세요');
  const participantId = typeof reward.participantId === 'string' || Number.isSafeInteger(reward.participantId) ? String(reward.participantId) : '';
  const recipients = participantId ? list(ctx.workspace.participants).filter((person) => person &&
    (typeof person.id === 'string' || Number.isSafeInteger(person.id)) && String(person.id) === participantId) : [];
  if (recipients.length !== 1 || recipients[0].cancelled === true || String(recipients[0].status || '').toUpperCase() !== 'APPROVED') {
    throw ctx.fail(409, '수령자의 참가 상태를 확인한 뒤 다시 처리하세요', undefined, 'REWARD_PARTICIPANT_CHANGED');
  }
  reward.status = reward.method === 'GIFT' ? 'NEEDS_CONNECTION' : 'RECEIVED';
  reward.claim = { actor: ctx.actor.id, at: ctx.now, simulated: true };
  return { body: { reward: { ...reward } } };
}

function cancelReward(ctx, input) {
  requireFeature(ctx, 'reward');
  const reward = list(ctx.workspace.rewards).find((item) => item.id === ctx.clean(input.id, 120));
  if (!reward || reward.status === 'RECEIVED') throw ctx.fail(409, '이미 수령한 경품은 취소할 수 없습니다');
  reward.status = 'CANCELLED';
  return { body: { reward: { ...reward } } };
}

// Normalization makes absent legacy collections usable, but it also replaces
// malformed collections with empty ones. Never freeze those replacements as
// real results: validate the locked source before calculating a new snapshot.
function guardReportSources(ctx) {
  const available = reportSourceAvailability(ctx.rawWorkspace);
  const labels = { venue: '행사 장소', participants: '참가자', checks: '입장 기록', responses: '응답', modules: '참여 콘텐츠', groups: '참가자 그룹', booths: '부스', questions: '질문', photos: '사진', survey: '설문 응답', draw: '추첨' };
  const missing = Object.keys(labels).find((key) => !available[key]);
  if (missing) throw ctx.fail(409, `${labels[missing]} 자료를 확인할 수 없어 보고서를 만들 수 없습니다. 시스템 관리자에게 문의하세요.`, undefined, 'REPORT_SOURCE_UNAVAILABLE');
}

async function reportSnapshot(ctx) {
  guardReportSources(ctx);
  const participants = list(ctx.workspace.participants).filter((person) => String(person.status || '').toUpperCase() !== 'CANCELLED');
  const attendanceChecks = indexLatestChecks(ctx.workspace.checks);
  const event = ctx.event;
  let clientName = '';
  if (event.clientId) {
    const result = await ctx.client.query('SELECT payload FROM clients WHERE id = $1 LIMIT 1', [event.clientId]);
    const payload = result.rows[0] && result.rows[0].payload;
    clientName = String(payload && payload.name || '');
  }
  const responses = list(ctx.workspace.responses);
  const modules = list(ctx.workspace.modules);
  const survey = modules.filter((module) => module.type === 'survey').map((module) => {
    const moduleResponses = responses.filter((response) => response.moduleId === module.id);
    const values = moduleResponses.flatMap((response) => Object.values(response.ratings || {}).map(Number));
    const average = values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1) : null;
    const questions = list(module.questions).map((question) => {
      const ratings = moduleResponses
        .map((response) => response.ratings && response.ratings[question])
        .filter((value) => value !== undefined)
        .map(Number);
      return {
        name: String(question),
        count: ratings.length,
        average: ratings.length
          ? (ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1)
          : null,
      };
    });
    return { name: String(module.title || ''), count: moduleResponses.length, average, questions };
  });
  return {
    event: {
      id: event.id,
      name: event.name,
      date: event.date,
      start: event.start,
      end: event.end,
      venue: String(ctx.workspace.venue.name || ''),
      client: clientName,
    },
    metrics: {
      total: participants.length,
      pending: participants.filter((person) => person.status === 'PENDING').length,
      approved: participants.filter((person) => person.status === 'APPROVED').length,
      checked: participants.filter((person) => person.everIn === true).length,
      inside: participants.filter((person) => person.inside === true).length,
      attendanceReview: participants.filter((person) => attendanceNeedsReview(person, attendanceChecks)).length,
      attendanceReviewVersion: 2,
      cancellationReview: participants.filter(cancellationNeedsReview).length,
      responses: responses.length,
      rate: participants.length
        ? Math.round(participants.filter((person) => person.everIn === true).length / participants.length * 100)
        : 0,
    },
    groups: list(ctx.workspace.groups).map((name) => ({
      name,
      count: participants.filter((person) => person.group === name).length,
    })),
    booths: list(ctx.workspace.booths).map((booth) => ({
      name: String(booth.name || ''),
      used: Number(booth.used) || 0,
      capacity: Number(booth.capacity) || 0,
    })),
    programs: modules.map((module) => ({
      name: String(module.title || ''),
      type: String(module.type || ''),
      responses: module.type === 'qa'
        ? list(ctx.workspace.questions).filter((question) => question.moduleId === module.id).length
        : module.type === 'draw'
          ? list(module.drawHistory).reduce((sum, result) => sum + list(result.winners).length, 0)
          : responses.filter((response) => response.moduleId === module.id).length,
    })),
    survey,
    photos: list(ctx.workspace.photos)
      .filter((photo) => photo.status === 'APPROVED')
      .map((photo) => ({ image: photo.image ? { ...photo.image } : null, caption: String(photo.caption || '') })),
    capturedAt: ctx.now,
    revision: Number(event.revision) || 0,
  };
}

function reportSections(ctx, value) {
  const sections = value === undefined
    ? ['overview', 'attendance', 'programs', 'survey', 'photos']
    : Array.isArray(value) ? value : [];
  if (sections.some((item) => typeof item !== 'string' || !REPORT_SECTIONS.has(item))) {
    throw ctx.fail(400, '보고서 항목을 확인하세요', 'sections');
  }
  const selected = [...new Set(sections)];
  if (!selected.length) throw ctx.fail(400, '보고서 항목을 하나 이상 선택하세요', 'sections');
  return selected;
}

function guardReportAttendance(ctx, input, snapshot) {
  // Older callers did not review cancellation conflicts. They may keep
  // creating ordinary reports, but cannot freeze a known conflict unseen.
  if (snapshot.metrics.cancellationReview > 0 &&
      (!input.expectedAttendance || !Object.hasOwn(input.expectedAttendance, 'cancellationReview'))) {
    throw ctx.fail(409, '취소 기록 확인이 필요한 참가자가 있습니다. 최신 화면에서 참가 집계를 확인하세요.', undefined, 'REPORT_CANCELLATION_REVIEW_REQUIRED');
  }
  if (input.expectedAttendance === undefined) return;
  const expected = input.expectedAttendance;
  const keys = ['total', 'approved', 'checked', 'inside'];
  if (expected && Object.hasOwn(expected, 'pending')) keys.push('pending');
  // Older callers did not review this field. New callers guard it as well,
  // so a newly ambiguous record cannot slip into their frozen report.
  if (expected && Object.hasOwn(expected, 'attendanceReview')) keys.push('attendanceReview');
  if (expected && Object.hasOwn(expected, 'cancellationReview')) keys.push('cancellationReview');
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      keys.some(key => !Number.isSafeInteger(expected[key]) || expected[key] < 0)) {
    throw ctx.fail(400, '검토한 참가 집계를 확인하세요', 'expectedAttendance');
  }
  if (keys.some(key => expected[key] !== snapshot.metrics[key])) {
    throw ctx.fail(409, '참가 집계가 바뀌었습니다. 최신 집계를 확인한 뒤 다시 저장하세요', 'expectedAttendance');
  }
}

async function createReport(ctx, input) {
  const report = {
    id: ctx.commandId,
    title: requireText(ctx, input.title, '보고서 제목', 100, 'title'),
    subtitle: ctx.clean(input.subtitle, 100),
    coverNote: ctx.clean(input.coverNote, 500),
    summary: ctx.clean(input.summary, 2000),
    sections: reportSections(ctx, input.sections),
    snapshot: await reportSnapshot(ctx),
    color: /^#[0-9a-f]{6}$/i.test(String(input.color || '')) ? String(input.color).toUpperCase() : '#E76D26',
    status: 'DRAFT',
    version: 1,
    createdAt: ctx.now,
    publishedAt: null,
  };
  guardReportAttendance(ctx, input, report.snapshot);
  ctx.workspace.reports.unshift(report);
  return { status: 201, body: { report: { ...report } } };
}

function findReport(ctx, id) {
  const report = list(ctx.workspace.reports).find((item) => item.id === ctx.clean(id, 120));
  if (!report) throw ctx.fail(404, '보고서를 찾을 수 없습니다');
  return report;
}

function guardReportVersion(ctx, input, report) {
  if (input.expectedVersion === undefined) return;
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw ctx.fail(400, '검토한 보고서 버전을 확인하세요', 'expectedVersion');
  }
  if (input.expectedVersion !== (Number(report.version) || 1) || report.status === 'PUBLISHED') {
    throw ctx.fail(409, '보고서가 변경됐습니다. 최신 내용을 확인하세요', 'expectedVersion');
  }
}

function updateReport(ctx, input) {
  const report = findReport(ctx, input.id);
  guardReportVersion(ctx, input, report);
  if (report.status === 'PUBLISHED') throw ctx.fail(409, '공유한 버전은 수정할 수 없습니다. 새 보고서 버전을 만드세요');
  report.title = requireText(ctx, input.title, '제목', 100, 'title');
  if (input.subtitle !== undefined) report.subtitle = ctx.clean(input.subtitle, 100);
  if (input.coverNote !== undefined) report.coverNote = ctx.clean(input.coverNote, 500);
  report.summary = ctx.clean(input.summary, 2000);
  report.sections = reportSections(ctx, input.sections === undefined ? report.sections : input.sections);
  if (input.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(input.color))) throw ctx.fail(400, '보고서 색상을 확인하세요', 'color');
    report.color = String(input.color).toUpperCase();
  }
  report.version = (Number(report.version) || 1) + 1;
  return { body: { report: { ...report } } };
}

function publishReport(ctx, input) {
  const report = findReport(ctx, input.id);
  guardReportVersion(ctx, input, report);
  if (report.status !== 'DRAFT') throw ctx.fail(409, '초안 보고서만 공개할 수 있습니다');
  report.status = 'PUBLISHED';
  report.publishedAt = ctx.now;
  return { body: { report: { ...report } } };
}

async function createSuccessor(ctx, input) {
  const source = findReport(ctx, input.id);
  if (source.status !== 'PUBLISHED') throw ctx.fail(409, '공유된 보고서를 선택하세요');
  const familyId = source.familyId || source.id;
  const family = list(ctx.workspace.reports).filter((item) => (item.familyId || item.id) === familyId);
  const version = Math.max(...family.map((item) => Number(item.version) || 1)) + 1;
  let snapshot;
  if (input.source === 'current') {
    snapshot = await reportSnapshot(ctx);
    guardReportAttendance(ctx, input, snapshot);
  }
  else if (input.source === undefined || input.source === 'snapshot') snapshot = structuredClone(source.snapshot);
  else throw ctx.fail(400, '보고서 버전 기준을 확인하세요', 'source');
  const report = {
    id: ctx.commandId,
    familyId,
    parentId: source.id,
    version,
    title: String(source.title || ''),
    subtitle: String(source.subtitle || ''),
    coverNote: String(source.coverNote || ''),
    summary: String(source.summary || ''),
    sections: structuredClone(list(source.sections)),
    snapshot,
    color: String(source.color || '#E76D26'),
    status: 'DRAFT',
    createdAt: ctx.now,
    publishedAt: null,
  };
  ctx.workspace.reports.unshift(report);
  return { status: 201, body: { report: { ...report } } };
}

async function apply(ctx) {
  switch (ctx.command) {
    case 'template.save': return saveTemplate(ctx, ctx.input);
    case 'template.archive': return archiveTemplate(ctx, ctx.input);
    case 'message.create': return createMessage(ctx, ctx.input);
    case 'message.create-reviewed': return createMessage(ctx, ctx.input);
    case 'message.create-charset-reviewed': return createMessage(ctx, ctx.input);
    case 'message.cancel': return cancelMessage(ctx, ctx.input);
    case 'message.retry': return retryMessage(ctx, ctx.input);
    case 'message.retry-charset-reviewed': return retryMessage(ctx, ctx.input);
    case 'message.sync': return syncMessage(ctx, ctx.input);
    case 'message.record-provider-check': return recordProviderCheck(ctx, ctx.input);
    case 'payment.simulate': return simulatePayment(ctx, ctx.input);
    case 'payment.refund-request': return requestRefund(ctx, ctx.input);
    case 'payment.refund': return refundPayment(ctx, ctx.input);
    case 'reward.create': return createReward(ctx, ctx.input);
    case 'reward.assign': return assignReward(ctx, ctx.input);
    case 'reward.fulfill': return fulfillReward(ctx, ctx.input);
    case 'reward.cancel': return cancelReward(ctx, ctx.input);
    case 'report.create': return createReport(ctx, ctx.input);
    case 'report.update': return updateReport(ctx, ctx.input);
    case 'report.publish': return publishReport(ctx, ctx.input);
    case 'report.successor': return createSuccessor(ctx, ctx.input);
    default: throw ctx.fail(400, '지원하지 않는 결과 작업입니다', 'command');
  }
}

module.exports = { COMMANDS, apply, buildMessageDispatch, dueScheduleGuards, explicitScheduleInstant, messageRecipientChangeCount, messageRecipientChangeAssessment, recipientReviewVersion, ticketLinkGuard, smsCharacterGuard };
