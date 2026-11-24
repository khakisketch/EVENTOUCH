'use strict';

const { archivePreconditions } = require('../archive-preconditions');

const { ticketExpiry, ticketReviewState } = require('../ticket-lifetime');
const { hashTicket } = require('./shared.ts');

const { isCalendarDate, toCapacityNumber, isIntegerCapacity } = require('../validation');
const {
  defaultHomeStyle,
  normalizeHomeStyle,
  validateHomeStyleUpdate,
  assertPublishableHomeStyle,
} = require('../attendee-home-style');
const { normalizeHomeMenus, validateHomeMenus } = require('../attendee-home-menus');
const { parseEventFormatInput } = require('../state');
const { contentDraft, saveContent, publishContent, publishReviewedContent } = require('../content-publication');
const { ensureConsentNotice } = require('../consent-notices');
const { followEventDate } = require('../message-schedule-anchor');
const { bodyImageIds, MAX_BODY_IMAGES } = require('../rich-text');

const COMMANDS = new Set([
  'event.update',
  'event.basics.save',
  'event.features',
  'event.stage',
  'field.save',
  'field.move',
  'field.delete',
  'form.publish',
  'form.close',
  'group.save',
  'group.assign',
  'notice.save',
  'notice.publish',
  'notice.publish-reviewed',
  'notice.delete',
  'program.save',
  'program.publish',
  'program.publish-reviewed',
  'program.delete',
  'venue.save',
  'venue.publish',
  'venue.publish-reviewed',
  'branding.save',
  'attendee.page.save',
  'attendee.page.publish',
  'attendee.page.publish-reviewed',
]);

const FEATURES = new Set([
  'poll', 'quiz', 'qa', 'draw', 'survey', 'stamp', 'photo', 'board', 'venue', 'screen', 'payment', 'reward',
]);
const STAGES = ['DRAFT', 'READY', 'LIVE', 'ENDED', 'ARCHIVED'];
const FIELD_TYPES = new Set(['text', 'email', 'select', 'checkbox']);

// Optional guard for newer editors. Legacy callers that omit it keep their
// existing contract; receipt replay still precedes command execution.
function guardFormVersion(ctx, input) {
  if (input.expectedFormVersion === undefined) return;
  if (!Number.isSafeInteger(input.expectedFormVersion) || input.expectedFormVersion < 0) {
    throw ctx.fail(400, '양식 버전을 확인하세요', 'expectedFormVersion');
  }
  if (input.expectedFormVersion !== (Number(ctx.workspace.formVersion) || 0)) {
    throw ctx.fail(409, '신청 항목이 변경되었습니다. 최신 항목을 확인한 뒤 다시 저장하세요', 'expectedFormVersion');
  }
}

function requireText(ctx, value, label, max, field) {
  const result = ctx.clean(value, max);
  if (!result) throw ctx.fail(400, `${label}을(를) 입력하세요`, field);
  return result;
}

function time(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function options(value) {
  const rows = Array.isArray(value)
    ? value
    : String(value || '').split(/\r?\n/);
  return rows.map((item) => String(item || '').trim()).filter(Boolean);
}

async function activeDeskAssignment(client, eventId, orgId) {
  // Authority is the org membership, never the global accounts.role: a
  // shared account that is AGENCY in one org and STAFF here staffs this
  // org's desks like anyone else. Global active still applies to everyone.
  const result = await client.query(
    `SELECT 1
     FROM staff_assignments sa
     JOIN accounts a ON a.id = sa.account_id
     JOIN organization_memberships m
       ON m.account_id = sa.account_id AND m.active = true AND m.role = 'STAFF'
     JOIN events e ON e.id = sa.event_id
     WHERE sa.event_id = $1 AND sa.type = 'DESK' AND sa.active = true
       AND a.active = true AND m.org_id = e.org_id
       AND ($2::text IS NULL OR e.org_id = $2)
     LIMIT 1`,
    [eventId, orgId || null]
  );
  return result.rowCount > 0;
}

async function transitionStage(ctx, nextStage) {
  const stage = ctx.clean(nextStage, 24).toUpperCase();
  const current = ctx.clean(ctx.event.stage, 24).toUpperCase();
  const currentIndex = STAGES.indexOf(current);
  const nextIndex = STAGES.indexOf(stage);
  if (nextIndex < 0) throw ctx.fail(400, '진행 단계를 확인하세요', 'stage');
  if (nextIndex < currentIndex) throw ctx.fail(409, '행사 진행 단계는 이전 상태로 되돌릴 수 없습니다');
  if (stage === 'LIVE' && current !== 'LIVE') {
    if (!ctx.workspace.desks.length || !(await activeDeskAssignment(ctx.client, ctx.event.id, ctx.event.orgId || null))) {
      throw ctx.fail(409, '등록 데스크와 활성 스태프를 먼저 배정하세요');
    }
  }
  if (stage === 'ARCHIVED') {
    const preconditions = archivePreconditions(ctx.rawWorkspace);
    if (!preconditions.participantsAvailable || !preconditions.registrationAvailable || !preconditions.modulesAvailable) {
      const missing = [!preconditions.participantsAvailable ? '참가자' : '', !preconditions.registrationAvailable ? '접수' : '', !preconditions.modulesAvailable ? '참여 콘텐츠' : ''].filter(Boolean).join(' · ');
      throw ctx.fail(409, `${missing} 상태를 확인할 수 없어 보관하지 못했습니다. 조직 관리자에게 문의하세요.`, undefined, 'ARCHIVE_PRECONDITIONS_UNAVAILABLE');
    }
    if (preconditions.registrationOpen || preconditions.openModules > 0) {
      throw ctx.fail(409, '접수와 참여 콘텐츠를 닫은 뒤 보관하세요');
    }
  }
  ctx.event.stage = stage;
}

// A postponement must not invalidate issued tickets before the new event.
// Only currently valid bearers may be extended: an expired, cancelled,
// revoked or malformed record is never brought back to life by editing dates.
async function extendValidTickets(ctx, eventDate) {
  const now = Date.parse(ctx.now);
  const expiry = ticketExpiry({ date: eventDate }, now);
  const expiryMs = Date.parse(expiry);
  const rows = [];
  const people = [];
  let review = 0;
  for (const person of ctx.workspace.participants) {
    if (!person || typeof person !== 'object' || Array.isArray(person) || typeof person.id !== 'string' || !person.id) {
      throw ctx.fail(409, '확인할 수 없는 참가자 기록이 있어 일정을 저장할 수 없습니다. 참가자 정보를 확인하세요.', 'date', 'TICKET_PROJECTION_CONFLICT');
    }
    const state = ticketReviewState(person, now);
    if (state === 'cancelled') {
      // An active registration carrying a legacy cancellation flag is not a
      // normal cancellation. Keep it untouched but include it in the review
      // count so the operator can reconcile the conflicting record.
      if (String(person.status || '').toUpperCase() !== 'CANCELLED') review += 1;
      continue;
    }
    if (state !== 'valid') {
      review += 1;
      continue;
    }
    const currentExpiry = Date.parse(person.ticketExpiresAt);
    if (currentExpiry >= expiryMs) continue;
    rows.push({ id: person.id, hash: hashTicket(person.ticket), expiry });
    people.push(person);
  }
  if (rows.length) {
    let result;
    try {
      result = await ctx.client.query(
        `INSERT INTO tickets (participant_id, event_id, ticket_hash, revoked, expires_at, updated_at)
         SELECT row.id, $2, row.hash, false, row.expiry::timestamptz, now()
         FROM jsonb_to_recordset($1::jsonb) AS row(id text, hash text, expiry text)
         ON CONFLICT (participant_id) DO UPDATE
         SET ticket_hash = COALESCE(tickets.ticket_hash, EXCLUDED.ticket_hash),
             expires_at = EXCLUDED.expires_at, updated_at = now()
         WHERE tickets.event_id = EXCLUDED.event_id AND tickets.revoked = false
           AND (tickets.ticket_hash IS NULL OR tickets.ticket_hash = EXCLUDED.ticket_hash)
         RETURNING participant_id`, [JSON.stringify(rows), String(ctx.event.id)]);
    } catch (error) {
      if (error && ['23505', '21000'].includes(error.code)) {
        throw ctx.fail(409, '티켓 기록이 일치하지 않아 일정을 저장할 수 없습니다. 참가자 정보를 확인하세요.', 'date', 'TICKET_PROJECTION_CONFLICT');
      }
      throw error;
    }
    if (result.rowCount !== rows.length) {
      throw ctx.fail(409, '티켓 기록이 일치하지 않아 일정을 저장할 수 없습니다. 참가자 정보를 확인하세요.', 'date', 'TICKET_PROJECTION_CONFLICT');
    }
    for (const person of people) person.ticketExpiresAt = expiry;
  }
  return { extended: rows.length, review };
}

async function updateEvent(ctx, input) {
  const { event, workspace } = ctx;
  // Compare the editor's actual baseline, not the workspace revision: signups,
  // check-ins, and other unrelated work also change that revision. Older API
  // consumers may omit the optional guard. Receipt replay happens before here.
  if (ctx.command === 'event.basics.save' && input.expectedBasics === undefined) {
    throw ctx.fail(400, '확인한 행사 기본 정보를 다시 불러오세요', 'expectedBasics');
  }
  if (input.expectedBasics !== undefined) {
    const expected = input.expectedBasics;
    const text = (value) => typeof value === 'string' ? value : '';
    const current = {
      name: text(event.name), slug: text(event.slug), clientId: text(event.clientId),
      date: text(event.date), start: text(event.start) || '09:00', end: text(event.end) || '18:00',
      capacity: Number(event.capacity) || 0, price: Number(workspace.price) || 0,
      format: ['offline', 'online', 'hybrid'].includes(text(event.format)) ? text(event.format) : '',
      approvalRequired: workspace.approvalRequired === true,
      allowReentry: workspace.allowReentry !== false,
      verificationRequired: workspace.verificationRequired === true,
    };
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(current).some((key) => !Object.hasOwn(expected, key) ||
        typeof expected[key] !== typeof current[key] ||
        (typeof current[key] === 'number' && !Number.isFinite(expected[key])))) {
      throw ctx.fail(400, '확인한 행사 기본 정보가 올바르지 않습니다', 'expectedBasics');
    }
    if (Object.keys(current).some((key) => expected[key] !== current[key])) {
      throw ctx.fail(409, '행사 기본 정보가 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장하세요', 'expectedBasics', 'EVENT_BASICS_CHANGED');
    }
  }
  const name = requireText(ctx, input.name, '행사명', 100, 'name');
  const slug = requireText(ctx, input.slug === undefined ? event.slug : input.slug, '행사 주소 코드', 50, 'slug');
  const eventDate = requireText(ctx, input.date, '날짜', 10, 'date');
  const start = requireText(ctx, input.start, '시작 시간', 5, 'start');
  const end = requireText(ctx, input.end, '종료 시간', 5, 'end');
  const capacity = toCapacityNumber(input.capacity);
  const price = Number(input.price === undefined ? workspace.price : input.price);
  if (!/^[a-z0-9-]+$/.test(slug)) throw ctx.fail(400, '행사 주소 코드를 확인하세요', 'slug');
  if (slug !== event.slug) {
    const duplicate = await ctx.client.query('SELECT 1 FROM events WHERE slug = $1 AND id <> $2 LIMIT 1', [slug, event.id]);
    if (duplicate.rowCount) throw ctx.fail(409, '이미 사용 중인 행사 주소 코드입니다', 'slug');
  }
  if (!isCalendarDate(eventDate)) throw ctx.fail(400, '행사 날짜 형식이 올바르지 않습니다', 'date');
  if (!time(start) || !time(end) || start >= end) throw ctx.fail(400, '종료 시간은 시작 시간보다 늦어야 합니다', 'end');
  if (!isIntegerCapacity(capacity)) throw ctx.fail(400, '정원은 0 이상의 정수로 입력하세요', 'capacity');
  const activeCount = workspace.participants.filter((person) => person.status !== 'CANCELLED').length;
  if (capacity > 0 && capacity < activeCount) throw ctx.fail(409, '현재 참가자 수보다 정원을 줄일 수 없습니다');
  if (!Number.isFinite(price) || price < 0) throw ctx.fail(400, '참가비는 0 이상이어야 합니다', 'price');

  // Format is display metadata only: omitted leaves the stored payload
  // untouched (legacy absent stays absent, stored values stay), '' deletes
  // the key (explicit clear to unspecified), and only the three lowercase
  // kinds store. Nothing else changes.
  const formatInput = parseEventFormatInput(input.format);
  if (formatInput !== undefined) {
    if (formatInput === null) {
      delete event.format;
    } else {
      event.format = formatInput;
    }
  }

  const clientId = input.clientId || event.clientId || null;
  if (clientId) {
    const client = await ctx.client.query('SELECT org_id FROM clients WHERE id = $1 LIMIT 1', [String(clientId)]);
    if (!client.rowCount) throw ctx.fail(400, '유효한 고객사를 선택하세요', 'clientId');
    const eventOrg = event.orgId || null;
    const clientOrg = client.rows[0].org_id || null;
    if (eventOrg && clientOrg && String(eventOrg) !== String(clientOrg)) {
      throw Object.assign(ctx.fail(409, '다른 조직의 고객사는 연결할 수 없습니다', 'clientId'), { code: 'ORGANIZATION_CONTEXT_CHANGED' });
    }
  }
  await transitionStage(ctx, input.stage === undefined ? event.stage : input.stage);
  const ticketImpact = (!isCalendarDate(event.date) || eventDate > event.date)
    ? await extendValidTickets(ctx, eventDate) : null;
  const dateChanged = eventDate !== event.date;
  Object.assign(event, { name, slug, date: eventDate, start, end, capacity, clientId });
  // Event-relative reservations follow the new date; see message-schedule-anchor.
  const scheduleFollow = dateChanged ? followEventDate(workspace, eventDate, { now: Date.now() }) : null;
  workspace.approvalRequired = input.approvalRequired === undefined
    ? workspace.approvalRequired === true
    : input.approvalRequired === true;
  workspace.allowReentry = input.allowReentry === undefined
    ? workspace.allowReentry !== false
    : input.allowReentry === true;
  workspace.verificationRequired = input.verificationRequired === undefined
    ? workspace.verificationRequired === true
    : input.verificationRequired === true;
  workspace.price = price;
  return { eventChanged: true, body: { event: { ...event },
    ...(ctx.command === 'event.basics.save' ? { ticketPolicyVersion: 1, ticketImpact } : ticketImpact ? { ticketImpact } : {}),
    ...(scheduleFollow && (scheduleFollow.moved || scheduleFollow.cancelled) ? { scheduleFollow: { moved: scheduleFollow.moved, cancelled: scheduleFollow.cancelled } } : {}) } };
}

async function updateFeatures(ctx, input) {
  // Compare only the feature selection the editor saw, not unrelated event
  // or workspace revisions. The editor also carries hidden legacy features.
  // Legacy clients may omit this guard; receipt replay has already run.
  if (input.expectedFeatures !== undefined) {
    if (!Array.isArray(input.expectedFeatures) || input.expectedFeatures.some((feature) => typeof feature !== 'string')) {
      throw ctx.fail(400, '확인한 운영 기능 목록이 올바르지 않습니다', 'expectedFeatures');
    }
    const expected = new Set(input.expectedFeatures);
    const current = new Set(ctx.event.features);
    if (expected.size !== current.size || [...expected].some((feature) => !current.has(feature))) {
      throw ctx.fail(409, '운영 기능이 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장하세요', 'expectedFeatures', 'EVENT_FEATURES_CHANGED');
    }
  }
  if (input.features !== undefined && !Array.isArray(input.features)) {
    throw ctx.fail(400, '기능 목록 형식이 올바르지 않습니다', 'features');
  }
  const supplied = Array.isArray(input.features) ? input.features : [];
  if (supplied.some((feature) => typeof feature !== 'string' || !FEATURES.has(feature))) {
    throw ctx.fail(400, '알 수 없는 기능입니다', 'features');
  }
  const features = [...new Set(supplied)];
  ctx.event.features = features;
  return { eventChanged: true, body: { features } };
}

function saveField(ctx, input) {
  guardFormVersion(ctx, input);
  const id = ctx.clean(input.id || ctx.makeId('field'), 100);
  const label = requireText(ctx, input.label, '항목명', 60, 'label');
  const type = ctx.clean(input.type, 24).toLowerCase();
  if (!FIELD_TYPES.has(type)) throw ctx.fail(400, '지원하지 않는 항목 형식입니다', 'type');
  if (['name', 'phone'].includes(id) && type !== 'text') {
    throw ctx.fail(400, '이름과 연락처는 짧은 답변 형식을 유지하세요', 'type');
  }
  const choices = options(input.options);
  if (type === 'select' && (choices.length < 2 || choices.length > 30 || new Set(choices).size !== choices.length)) {
    throw ctx.fail(400, '선택지는 중복 없이 두 개 이상 입력하세요', 'options');
  }
  if (choices.some((item) => item.length > 200)) throw ctx.fail(400, '선택지 길이를 확인하세요', 'options');
  const field = {
    id,
    label,
    type,
    required: ['name', 'phone'].includes(id) || input.required === true,
    options: type === 'select' ? choices : [],
  };
  const existing = ctx.workspace.fields.find((item) => item.id === id);
  if (input.protectExistingAnswers === true && existing) {
    if (['name', 'phone', 'company'].includes(id) && type !== 'text') throw ctx.fail(400, '기본 항목은 짧은 답변 형식을 유지하세요', 'type');
    const used = ctx.workspace.participants.map((person) => person && person.answers && person.answers[id])
      .filter((value) => value !== undefined && value !== null && value !== '');
    if (used.length && existing.type !== type) throw ctx.fail(409, '기존 답변이 있어 형식을 바꿀 수 없습니다. 새 항목을 추가하세요', 'type');
    if (type === 'select' && used.some((value) => !choices.includes(value))) {
      throw ctx.fail(409, '기존 답변에 사용된 선택지는 제거할 수 없습니다. 새 항목을 추가하세요', 'options');
    }
  }
  if (existing) Object.assign(existing, field);
  else ctx.workspace.fields.push(field);
  ctx.workspace.formVersion = (Number(ctx.workspace.formVersion) || 0) + 1;
  return { body: { field } };
}

function moveField(ctx, input) {
  guardFormVersion(ctx, input);
  const id = ctx.clean(input.id, 100);
  const delta = Number(input.delta);
  const fields = ctx.workspace.fields;
  const from = fields.findIndex((field) => field.id === id);
  const to = from + delta;
  if (!Number.isInteger(delta) || Math.abs(delta) !== 1 || from < 0 || to < 0 || to >= fields.length) {
    throw ctx.fail(400, '항목을 이동할 수 없습니다');
  }
  [fields[from], fields[to]] = [fields[to], fields[from]];
  ctx.workspace.formVersion = (Number(ctx.workspace.formVersion) || 0) + 1;
  return { body: { fields } };
}

function deleteField(ctx, input) {
  guardFormVersion(ctx, input);
  const id = ctx.clean(input.id, 100);
  if (['name', 'phone'].includes(id)) throw ctx.fail(400, '이름과 연락처는 삭제할 수 없습니다');
  const index = ctx.workspace.fields.findIndex((field) => field.id === id);
  if (index < 0) throw ctx.fail(404, '등록 항목을 찾을 수 없습니다');
  ctx.workspace.fields.splice(index, 1);
  ctx.workspace.formVersion = (Number(ctx.workspace.formVersion) || 0) + 1;
  return { body: { fields: ctx.workspace.fields } };
}

function publishForm(ctx, input) {
  guardFormVersion(ctx, input);
  const reviewedFormVersion = Number(ctx.workspace.formVersion) || 0;
  const reviewedPublishedVersion = Number(ctx.workspace.publishedVersion) || 0;
  const reviewedConsentVersion = Number(ctx.workspace.consentVersion) || 1;
  const reviewedConsentText = ctx.clean(ctx.workspace.consentText, 3000);
  if (input.expectedConsentVersion !== undefined &&
      (!Number.isSafeInteger(input.expectedConsentVersion) || input.expectedConsentVersion !== reviewedConsentVersion)) {
    throw ctx.fail(409, '동의 안내가 변경되었습니다. 최신 내용을 확인한 뒤 다시 게시하세요', 'expectedConsentVersion');
  }
  if (input.expectedConsentText !== undefined &&
      (typeof input.expectedConsentText !== 'string' || ctx.clean(input.expectedConsentText, 3000) !== reviewedConsentText)) {
    throw ctx.fail(409, '동의 안내가 변경되었습니다. 최신 내용을 확인한 뒤 다시 게시하세요', 'expectedConsentText');
  }
  if (['ENDED', 'ARCHIVED'].includes(ctx.event.stage)) throw ctx.fail(409, '종료된 행사에서는 접수를 열 수 없습니다');
  if (!ctx.workspace.fields.some((field) => field.id === 'name') ||
    !ctx.workspace.fields.some((field) => field.id === 'phone')) {
    throw ctx.fail(409, '이름과 연락처 항목을 구성하세요');
  }
  let consentChanged = false;
  if (input.consentText !== undefined) {
    const consentText = requireText(ctx, input.consentText, '동의 안내', 3000, 'consentText');
    if (consentText !== reviewedConsentText) {
      consentChanged = true;
      ctx.workspace.consentText = consentText;
      if (reviewedConsentVersion >= Number.MAX_SAFE_INTEGER) throw ctx.fail(409, '동의 버전을 갱신할 수 없습니다. 운영자에게 문의하세요');
      ctx.workspace.consentVersion = reviewedConsentVersion + 1;
      // Consent is part of the public application, even though its own
      // audit version is independent of the editable field list. A browser
      // that saw the previous notice must not submit against the new one.
      // This also protects existing clients that only send formVersion.
      const draftVersion = Number(ctx.workspace.formVersion);
      const publishedVersion = Number(ctx.workspace.publishedVersion);
      const currentVersion = Math.max(
        Number.isSafeInteger(draftVersion) && draftVersion >= 0 ? draftVersion : 0,
        Number.isSafeInteger(publishedVersion) && publishedVersion >= 0 ? publishedVersion : 0,
      );
      if (currentVersion >= Number.MAX_SAFE_INTEGER) throw ctx.fail(409, '양식 버전을 갱신할 수 없습니다. 운영자에게 문의하세요');
      ctx.workspace.formVersion = currentVersion + 1;
    }
  }
  ctx.workspace.publishedFields = structuredClone(ctx.workspace.fields);
  ctx.workspace.publishedVersion = Number(ctx.workspace.formVersion) || 1;
  ctx.workspace.registrationOpen = true;
  // Preserve the exact publicly visible notice under the same event lock as
  // publication; do not backfill historical participants or invent text.
  ensureConsentNotice(ctx.workspace, ctx.now);
  return { body: { publishedVersion: ctx.workspace.publishedVersion,
    reviewedFormVersion, reviewedPublishedVersion, reviewedConsentVersion, reviewedConsentText,
    consentVersion: Number(ctx.workspace.consentVersion) || 1,
    consentText: ctx.clean(ctx.workspace.consentText, 3000), consentChanged } };
}

function saveGroup(ctx, input) {
  const name = requireText(ctx, input.name, '그룹명', 40, 'name');
  if (ctx.workspace.groups.includes(name)) throw ctx.fail(409, '이미 등록된 그룹명입니다');
  ctx.workspace.groups.push(name);
  return { status: 201, body: { group: name } };
}

function assignGroup(ctx, input) {
  const group = ctx.clean(input.group, 40);
  const ids = Array.isArray(input.ids) ? input.ids.map((id) => ctx.clean(id, 120)) : [];
  if (!ctx.workspace.groups.includes(group)) throw ctx.fail(400, '그룹을 선택하세요', 'group');
  if (!ids.length || ids.length > 1000 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw ctx.fail(400, '참가자를 선택하세요', 'ids');
  }
  const participants = ids.map((id) => {
    const person = ctx.workspace.participants.find((item) => item.id === id);
    if (!person) throw ctx.fail(404, '선택한 참가자를 찾을 수 없습니다');
    return person;
  });
  // Compare the values the operator reviewed, not the workspace revision:
  // unrelated check-ins and edits must not block this assignment. Older
  // callers may omit the guard. Receipt replay happens before this handler.
  if (input.expectedGroups !== undefined) {
    if (!Array.isArray(input.expectedGroups) || input.expectedGroups.length !== ids.length ||
        input.expectedGroups.some((row) => !row || typeof row !== 'object' || Array.isArray(row) ||
          typeof row.id !== 'string' || typeof row.group !== 'string')) {
      throw ctx.fail(400, '확인한 참가자 그룹을 다시 확인하세요', 'expectedGroups');
    }
    const expected = new Map(input.expectedGroups.map((row) => [row.id, row.group]));
    if (expected.size !== ids.length || ids.some((id) => !expected.has(id))) {
      throw ctx.fail(400, '확인한 참가자 그룹을 다시 확인하세요', 'expectedGroups');
    }
    if (participants.some((person) => expected.get(person.id) !== (ctx.clean(person.group, 80) || '일반'))) {
      throw ctx.fail(409, '참가자의 그룹이 변경되었습니다. 최신 명단을 확인하세요.', 'expectedGroups', 'PARTICIPANT_GROUP_CHANGED');
    }
  }
  participants.forEach((person) => { person.group = group; });
  return { body: { participantIds: ids, group } };
}

async function saveNotice(ctx, input) {
  const id = ctx.clean(input.id || ctx.makeId('notice'), 120);
  const body = requireText(ctx, input.body, '공지 내용', 3000, 'body');
  // Images in the body must be this event's uploaded pictures; a bare
  // reference to anything else never reaches attendees.
  const imageIds = bodyImageIds(body);
  if (imageIds.length > MAX_BODY_IMAGES) throw ctx.fail(400, `공지 이미지는 ${MAX_BODY_IMAGES}장까지 넣을 수 있습니다`, 'body');
  for (const fileId of imageIds) {
    await ctx.resolveFile({ fileId }, { eventId: ctx.event.id, contentTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 600000 });
  }
  const notice = {
    id,
    title: requireText(ctx, input.title, '공지 제목', 100, 'title'),
    body,
    published: input.published === true,
    pinned: input.pinned === true,
    at: ctx.now,
  };
  const old = ctx.workspace.notices.find((item) => item.id === id);
  const saved = saveContent(ctx, 'notice', input, old, notice);
  if (!old) ctx.workspace.notices.unshift(saved);
  return { status: old ? 200 : 201, body: { notice: saved } };
}

function deleteNotice(ctx, input) {
  const index = ctx.workspace.notices.findIndex((item) => item.id === ctx.clean(input.id, 120));
  if (index < 0) throw ctx.fail(404, '공지를 찾을 수 없습니다');
  const [notice] = ctx.workspace.notices.splice(index, 1);
  if (ctx.workspace.display.noticeId === notice.id) ctx.workspace.display = { type: 'idle', moduleId: null };
  return { body: { ok: true } };
}

async function saveProgram(ctx, input) {
  const id = ctx.clean(input.id || ctx.makeId('session'), 120);
  const old = ctx.workspace.program.find((item) => item.id === id);
  const title = requireText(ctx, input.title, '프로그램명', 100, 'title');
  const eventDate = ctx.clean(input.date || ctx.event.date, 10);
  const start = requireText(ctx, input.start, '시작 시간', 5, 'start');
  const end = requireText(ctx, input.end, '종료 시간', 5, 'end');
  if (!isCalendarDate(eventDate) || !time(start) || !time(end) || start >= end) {
    throw ctx.fail(400, '일정 날짜와 종료 시간을 확인하세요');
  }
  let attachment = old ? (input.mode === 'draft' ? contentDraft('program', old).attachment : old.attachment) || null : null;
  if (Object.hasOwn(input, 'attachment')) {
    attachment = input.attachment === null ? null : await ctx.resolveFile(input.attachment, {
      eventId: ctx.event.id,
      contentTypes: ['application/pdf'],
      maxBytes: 600000,
    });
  }
  const program = {
    id,
    title,
    date: eventDate,
    start,
    end,
    place: ctx.clean(input.place, 160),
    description: ctx.clean(input.description, 4000),
    published: input.published === true,
    attachment,
  };
  const saved = saveContent(ctx, 'program', input, old, program);
  if (!old) ctx.workspace.program.push(saved);
  ctx.workspace.program.sort((left, right) => (left.date + left.start).localeCompare(right.date + right.start));
  return { status: old ? 200 : 201, body: { program: saved } };
}

function deleteProgram(ctx, input) {
  const index = ctx.workspace.program.findIndex((item) => item.id === ctx.clean(input.id, 120));
  if (index < 0) throw ctx.fail(404, '프로그램을 찾을 수 없습니다');
  ctx.workspace.program.splice(index, 1);
  return { body: { ok: true } };
}

async function saveVenue(ctx, input) {
  if (!ctx.event.features.includes('venue')) throw ctx.fail(409, '행사 설정에서 장소 안내 기능을 먼저 켜세요');
  // Omission by an older client preserves the existing map. Removing it is
  // an explicit null; any replacement must belong to this event.
  let map = (input.mode === 'draft' ? contentDraft('venue', ctx.workspace.venue).map : ctx.workspace.venue?.map) || null;
  if (Object.hasOwn(input, 'map')) {
    if (Object.hasOwn(input, 'expectedMap')) {
      const expected = input.expectedMap;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
          typeof expected.fileId !== 'string' || typeof expected.alt !== 'string') {
        throw ctx.fail(400, '이전 안내도 상태를 확인하세요', 'map');
      }
      const currentFile = map && map.image && typeof map.image.fileId === 'string' ? map.image.fileId : '';
      const currentAlt = map && typeof map.alt === 'string' ? map.alt : '';
      if (currentFile !== expected.fileId || currentAlt !== expected.alt) {
        throw ctx.fail(409, '다른 운영자가 안내도를 변경했습니다. 최신 내용을 확인한 뒤 다시 저장하세요', 'map');
      }
    }
    if (input.map === null) map = null;
    else {
      if (!input.map || typeof input.map !== 'object' || Array.isArray(input.map) ||
          typeof input.map.alt !== 'string' || !input.map.alt.trim() || input.map.alt.length > 240) {
        throw ctx.fail(400, '안내도에 대한 설명을 입력하세요', 'mapAlt');
      }
      const image = await ctx.resolveFile(input.map.image, {
        eventId: ctx.event.id, contentTypes: ['image/png', 'image/jpeg'], maxBytes: 499999,
      });
      map = { image, alt: input.map.alt.trim() };
    }
  }
  const venue = {
    name: ctx.clean(input.name, 100),
    address: ctx.clean(input.address, 200),
    directions: ctx.clean(input.directions, 400),
    contact: ctx.clean(input.contact, 120),
    description: ctx.clean(input.description, 400),
    ...(map ? { map } : {}),
  };
  ctx.workspace.venue = saveContent(ctx, 'venue', input, ctx.workspace.venue, venue);
  return { body: { venue: ctx.workspace.venue } };
}

async function saveBranding(ctx, input) {
  const tagline = requireText(ctx, input.tagline, '행사 소개', 160, 'tagline');
  const branding = { ...ctx.workspace.branding, tagline };
  for (const key of ['logo', 'keyvisual']) {
    if (!Object.hasOwn(input, key)) continue;
    branding[key] = input[key] === null ? null : await ctx.resolveFile(input[key], {
      eventId: ctx.event.id,
      contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
      maxBytes: 600000,
    });
  }
  ctx.workspace.branding = branding;
  return { body: { branding } };
}

function pageDefaults(workspace) {
  return {
    accent: '#E76D26',
    intro: String(workspace.branding.tagline || '참가에 필요한 안내와 내 티켓을 확인하세요.'),
    showAnnouncements: true,
    showSchedule: true,
    showVenue: true,
    showPrograms: true,
    logo: workspace.branding.logo || null,
    keyvisual: workspace.branding.keyvisual || null,
  };
}

function pageState(workspace) {
  const defaults = pageDefaults(workspace);
  const source = ctxObject(workspace.pageExperience);
  const draftSource = ctxObject(source.draft);
  const publishedSource = ctxObject(source.published);
  const draft = { ...defaults, ...draftSource };
  const published = { ...defaults, ...publishedSource };
  // homeStyle merges field-by-field over the single backend default so
  // legacy or partially stored styles keep working; malformed stored JSON
  // degrades to the default safe allowlist instead of failing the read.
  draft.homeStyle = normalizeHomeStyle(draftSource.homeStyle);
  published.homeStyle = normalizeHomeStyle(publishedSource.homeStyle);
  draft.homeMenus = normalizeHomeMenus(draftSource.homeMenus);
  published.homeMenus = normalizeHomeMenus(publishedSource.homeMenus);
  const draftVersion = Number.isSafeInteger(source.draftVersion) && source.draftVersion >= 0
    ? source.draftVersion
    : 0;
  return { ...source, draft, published, publishedAt: source.publishedAt || null, draftVersion };
}

function checkDraftVersion(ctx, input, current) {
  const expected = input.expectedDraftVersion;
  if (expected === undefined || expected === null) return;
  if (expected !== current) {
    throw ctx.fail(409, '최신 초안을 새로고침한 뒤 다시 시도하세요', 'expectedDraftVersion');
  }
}

function ctxObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function saveAttendeePage(ctx, input) {
  const current = pageState(ctx.workspace);
  checkDraftVersion(ctx, input, current.draftVersion);
  const draft = {
    ...current.draft,
    accent: /^#[0-9a-f]{6}$/i.test(String(input.accent || '')) ? String(input.accent).toUpperCase() : current.draft.accent,
    intro: requireText(ctx, input.intro, '행사 소개', 160, 'intro'),
    showAnnouncements: input.showAnnouncements === true,
    showSchedule: input.showSchedule === true,
    showVenue: input.showVenue === true,
    showPrograms: input.showPrograms === true,
  };
  for (const [key, clearKey] of [['logo', 'clearLogo'], ['keyvisual', 'clearKeyvisual']]) {
    if (input[clearKey] === true) draft[key] = null;
    else if (Object.hasOwn(input, key)) {
      draft[key] = input[key] === null ? null : await ctx.resolveFile(input[key], {
        eventId: ctx.event.id,
        contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
        maxBytes: 600000,
      });
    }
  }
  // homeStyle is the only partially updatable section: omitting it preserves
  // the stored style, an explicit null resets the whole style to defaults
  // (documented return contract), and a supplied object merges its known
  // fields over the stored style without resetting unrelated fields.
  // Unknown keys are ignored by allowlist.
  if (Object.hasOwn(input, 'homeStyle')) {
    draft.homeStyle = input.homeStyle === null
      ? defaultHomeStyle()
      : validateHomeStyleUpdate(input.homeStyle, current.draft.homeStyle, ctx.fail);
  } else {
    draft.homeStyle = current.draft.homeStyle;
  }
  draft.homeMenus = Object.hasOwn(input, 'homeMenus')
    ? validateHomeMenus(input.homeMenus, ctx.fail)
    : current.draft.homeMenus;
  const draftVersion = current.draftVersion + 1;
  ctx.workspace.pageExperience = { ...current, draft, draftVersion };
  return { body: { draft, draftVersion } };
}

function publishAttendeePage(ctx, input = {}) {
  const state = pageState(ctx.workspace);
  checkDraftVersion(ctx, input, state.draftVersion);
  const draft = { ...state.draft };
  draft.intro = requireText(ctx, draft.intro, '행사 소개', 160, 'intro');
  if (!/^#[0-9a-f]{6}$/i.test(String(draft.accent || ''))) throw ctx.fail(400, '강조색을 확인하세요', 'accent');
  // A malformed stored draft style is rejected here rather than silently
  // published; legacy drafts without a style publish with defaults.
  draft.homeStyle = assertPublishableHomeStyle(
    ctxObject(ctxObject(ctx.workspace.pageExperience).draft).homeStyle,
    ctx.fail
  );
  draft.homeMenus = normalizeHomeMenus(draft.homeMenus);
  ctx.workspace.pageExperience = {
    ...state,
    draft,
    published: structuredClone(draft),
    publishedAt: ctx.now,
    publishedVersion: state.draftVersion,
  };
  ctx.workspace.branding = {
    ...ctx.workspace.branding,
    tagline: draft.intro,
    logo: draft.logo || null,
    keyvisual: draft.keyvisual || null,
  };
  return { body: { published: draft, publishedVersion: state.draftVersion, draftVersion: state.draftVersion } };
}

// The operator reviewed whether this page is publicly reachable and where.
// Check that exact context under the same event lock as publication. Older
// clients keep their original command; new clients fail closed on old servers.
function publishReviewedAttendeePage(ctx, input = {}) {
  const expected = input.expectedDestinations;
  if (!Number.isSafeInteger(input.expectedDraftVersion) || input.expectedDraftVersion < 0) {
    throw ctx.fail(400, '검토한 초안 버전을 확인하세요', 'expectedDraftVersion');
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).length !== 2 || typeof expected.slug !== 'string' || !expected.slug || expected.slug.length > 120 ||
      typeof expected.public !== 'boolean') {
    throw ctx.fail(400, '검토한 게시 위치를 확인하세요', 'expectedDestinations');
  }
  const stage = String(ctx.event.stage || '').toUpperCase();
  if (!STAGES.includes(stage)) throw ctx.fail(409, '행사 공개 상태를 확인할 수 없습니다. 최신 상태를 확인하세요.', 'expectedDestinations', 'PAGE_PUBLICATION_CONTEXT_CHANGED');
  const current = { slug: ctx.event.slug, public: ['READY', 'LIVE', 'ENDED'].includes(stage) };
  if (expected.slug !== current.slug || expected.public !== current.public) {
    throw ctx.fail(409, '행사 공개 상태 또는 주소가 변경되었습니다. 최신 상태를 확인하고 다시 검토하세요.', 'expectedDestinations', 'PAGE_PUBLICATION_CONTEXT_CHANGED');
  }
  const result = publishAttendeePage(ctx, input);
  result.body.reviewedDestinations = current;
  return result;
}

async function apply(ctx) {
  const input = ctx.input;
  switch (ctx.command) {
    case 'event.update':
    case 'event.basics.save': return updateEvent(ctx, input);
    case 'event.features': return updateFeatures(ctx, input);
    case 'event.stage':
      await transitionStage(ctx, input.stage);
      return { eventChanged: true, body: { event: { id: ctx.event.id, stage: ctx.event.stage } } };
    case 'field.save': return saveField(ctx, input);
    case 'field.move': return moveField(ctx, input);
    case 'field.delete': return deleteField(ctx, input);
    case 'form.publish': return publishForm(ctx, input);
    case 'form.close':
      ctx.workspace.registrationOpen = false;
      return { body: { registrationOpen: false } };
    case 'group.save': return saveGroup(ctx, input);
    case 'group.assign': return assignGroup(ctx, input);
    case 'notice.publish': return publishContent(ctx, 'notice', input);
    case 'notice.publish-reviewed': return publishReviewedContent(ctx, 'notice', input);
    case 'notice.save': return saveNotice(ctx, input);
    case 'notice.delete': return deleteNotice(ctx, input);
    case 'program.publish': return publishContent(ctx, 'program', input);
    case 'program.publish-reviewed': return publishReviewedContent(ctx, 'program', input);
    case 'program.save': return saveProgram(ctx, input);
    case 'program.delete': return deleteProgram(ctx, input);
    case 'venue.publish': return publishContent(ctx, 'venue', input);
    case 'venue.publish-reviewed': return publishReviewedContent(ctx, 'venue', input);
    case 'venue.save': return saveVenue(ctx, input);
    case 'branding.save': return saveBranding(ctx, input);
    case 'attendee.page.save': return saveAttendeePage(ctx, input);
    case 'attendee.page.publish': return publishAttendeePage(ctx, input);
    case 'attendee.page.publish-reviewed': return publishReviewedAttendeePage(ctx, input);
    default: throw ctx.fail(400, '지원하지 않는 준비 작업입니다', 'command');
  }
}

module.exports = { COMMANDS, apply };
