'use strict';

const { isCalendarDate, toCapacityNumber, isIntegerCapacity } = require('../validation');

const COMMANDS = new Set([
  'event.update',
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
  'notice.delete',
  'program.save',
  'program.delete',
  'venue.save',
  'branding.save',
  'attendee.page.save',
  'attendee.page.publish',
]);

const FEATURES = new Set([
  'poll', 'quiz', 'qa', 'draw', 'survey', 'stamp', 'photo', 'board', 'venue', 'screen', 'payment', 'reward',
]);
const STAGES = ['DRAFT', 'READY', 'LIVE', 'ENDED', 'ARCHIVED'];
const FIELD_TYPES = new Set(['text', 'email', 'select', 'checkbox']);

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

async function activeDeskAssignment(client, eventId) {
  const result = await client.query(
    `SELECT 1
     FROM staff_assignments sa
     JOIN accounts a ON a.id = sa.account_id
     WHERE sa.event_id = $1 AND sa.type = 'DESK' AND sa.active = true
       AND a.role = 'STAFF' AND a.active = true
     LIMIT 1`,
    [eventId]
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
    if (!ctx.workspace.desks.length || !(await activeDeskAssignment(ctx.client, ctx.event.id))) {
      throw ctx.fail(409, '등록 데스크와 활성 스태프를 먼저 배정하세요');
    }
  }
  if (stage === 'ARCHIVED' &&
    (ctx.workspace.registrationOpen || ctx.workspace.modules.some((module) => module.status === 'OPEN'))) {
    throw ctx.fail(409, '접수와 참여 프로그램을 닫은 뒤 보관하세요');
  }
  ctx.event.stage = stage;
}

async function updateEvent(ctx, input) {
  const { event, workspace } = ctx;
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

  const clientId = input.clientId || event.clientId || null;
  if (clientId) {
    const client = await ctx.client.query('SELECT 1 FROM clients WHERE id = $1 LIMIT 1', [String(clientId)]);
    if (!client.rowCount) throw ctx.fail(400, '유효한 고객사를 선택하세요', 'clientId');
  }
  await transitionStage(ctx, input.stage === undefined ? event.stage : input.stage);
  Object.assign(event, { name, slug, date: eventDate, start, end, capacity, clientId });
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
  return { eventChanged: true, body: { event: { ...event } } };
}

async function updateFeatures(ctx, input) {
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
  if (existing) Object.assign(existing, field);
  else ctx.workspace.fields.push(field);
  ctx.workspace.formVersion = (Number(ctx.workspace.formVersion) || 0) + 1;
  return { body: { field } };
}

function moveField(ctx, input) {
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
  const id = ctx.clean(input.id, 100);
  if (['name', 'phone'].includes(id)) throw ctx.fail(400, '이름과 연락처는 삭제할 수 없습니다');
  const index = ctx.workspace.fields.findIndex((field) => field.id === id);
  if (index < 0) throw ctx.fail(404, '등록 항목을 찾을 수 없습니다');
  ctx.workspace.fields.splice(index, 1);
  ctx.workspace.formVersion = (Number(ctx.workspace.formVersion) || 0) + 1;
  return { body: { fields: ctx.workspace.fields } };
}

function publishForm(ctx, input) {
  if (['ENDED', 'ARCHIVED'].includes(ctx.event.stage)) throw ctx.fail(409, '종료된 행사에서는 접수를 열 수 없습니다');
  if (!ctx.workspace.fields.some((field) => field.id === 'name') ||
    !ctx.workspace.fields.some((field) => field.id === 'phone')) {
    throw ctx.fail(409, '이름과 연락처 항목을 구성하세요');
  }
  if (input.consentText !== undefined) {
    const consentText = requireText(ctx, input.consentText, '동의 안내', 3000, 'consentText');
    if (consentText !== ctx.workspace.consentText) {
      ctx.workspace.consentText = consentText;
      ctx.workspace.consentVersion = (Number(ctx.workspace.consentVersion) || 0) + 1;
    }
  }
  ctx.workspace.publishedFields = structuredClone(ctx.workspace.fields);
  ctx.workspace.publishedVersion = Number(ctx.workspace.formVersion) || 1;
  ctx.workspace.registrationOpen = true;
  return { body: { publishedVersion: ctx.workspace.publishedVersion } };
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
  participants.forEach((person) => { person.group = group; });
  return { body: { participantIds: ids, group } };
}

function saveNotice(ctx, input) {
  const id = ctx.clean(input.id || ctx.makeId('notice'), 120);
  const notice = {
    id,
    title: requireText(ctx, input.title, '공지 제목', 100, 'title'),
    body: requireText(ctx, input.body, '공지 내용', 3000, 'body'),
    published: input.published === true,
    pinned: input.pinned === true,
    at: ctx.now,
  };
  const old = ctx.workspace.notices.find((item) => item.id === id);
  if (old) Object.assign(old, notice);
  else ctx.workspace.notices.unshift(notice);
  return { status: old ? 200 : 201, body: { notice } };
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
  let attachment = old ? old.attachment || null : null;
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
  if (old) Object.assign(old, program);
  else ctx.workspace.program.push(program);
  ctx.workspace.program.sort((left, right) => (left.date + left.start).localeCompare(right.date + right.start));
  return { status: old ? 200 : 201, body: { program } };
}

function deleteProgram(ctx, input) {
  const index = ctx.workspace.program.findIndex((item) => item.id === ctx.clean(input.id, 120));
  if (index < 0) throw ctx.fail(404, '프로그램을 찾을 수 없습니다');
  ctx.workspace.program.splice(index, 1);
  return { body: { ok: true } };
}

function saveVenue(ctx, input) {
  if (!ctx.event.features.includes('venue')) throw ctx.fail(409, '행사 설정에서 장소 안내 기능을 먼저 켜세요');
  ctx.workspace.venue = {
    name: ctx.clean(input.name, 100),
    address: ctx.clean(input.address, 200),
    directions: ctx.clean(input.directions, 400),
    contact: ctx.clean(input.contact, 120),
    description: ctx.clean(input.description, 400),
  };
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
  const draft = { ...defaults, ...ctxObject(source.draft) };
  const published = { ...defaults, ...ctxObject(source.published) };
  return { ...source, draft, published, publishedAt: source.publishedAt || null };
}

function ctxObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function saveAttendeePage(ctx, input) {
  const current = pageState(ctx.workspace);
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
  ctx.workspace.pageExperience = { ...current, draft };
  return { body: { draft } };
}

function publishAttendeePage(ctx) {
  const state = pageState(ctx.workspace);
  const draft = { ...state.draft };
  draft.intro = requireText(ctx, draft.intro, '행사 소개', 160, 'intro');
  if (!/^#[0-9a-f]{6}$/i.test(String(draft.accent || ''))) throw ctx.fail(400, '강조색을 확인하세요', 'accent');
  ctx.workspace.pageExperience = { ...state, draft, published: structuredClone(draft), publishedAt: ctx.now };
  ctx.workspace.branding = {
    ...ctx.workspace.branding,
    tagline: draft.intro,
    logo: draft.logo || null,
    keyvisual: draft.keyvisual || null,
  };
  return { body: { published: draft } };
}

async function apply(ctx) {
  const input = ctx.input;
  switch (ctx.command) {
    case 'event.update': return updateEvent(ctx, input);
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
    case 'notice.save': return saveNotice(ctx, input);
    case 'notice.delete': return deleteNotice(ctx, input);
    case 'program.save': return saveProgram(ctx, input);
    case 'program.delete': return deleteProgram(ctx, input);
    case 'venue.save': return saveVenue(ctx, input);
    case 'branding.save': return saveBranding(ctx, input);
    case 'attendee.page.save': return saveAttendeePage(ctx, input);
    case 'attendee.page.publish': return publishAttendeePage(ctx);
    default: throw ctx.fail(400, '지원하지 않는 준비 작업입니다', 'command');
  }
}

module.exports = { COMMANDS, apply };
