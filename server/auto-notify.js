'use strict';

// 자동 안내 (2026-11-24): 두 가지 규칙을 행사별로 켜고 끌 수 있다.
//   confirmed  참가 확정된 사람에게 한 번 안내한다 (켠 시점 이후 확정된 사람부터).
//   reminder   행사 N일 전 HH:MM(한국 시간)에 참가 확정자 전원에게 한 번 안내한다.
// 기본은 꺼짐이다. 이 모듈은 발송하지 않는다. 켜진 규칙이 있을 때 유지보수 루프가 "즉시 실행"
// 예약 캠페인(AUTO)을 만들고, 실제 발송은 기존 예약 자동 실행 경로(enqueueDueScheduled →
// 아웃박스 → 제공자)가 같은 가드로 맡는다. 그래서 배포의 자동 실행 옵트인
// (EVENTOUCH_MESSAGE_MAINTENANCE=1, EVENTOUCH_MESSAGE_AUTO_SEND_DUE=1)이 모두 켜져 있어야만 동작한다.

const crypto = require('node:crypto');
const { anchorInstant, normalizeScheduleAnchor } = require('./message-schedule-anchor');

const KINDS = ['confirmed', 'reminder'];
const REMINDER_WINDOW_MS = 30 * 60 * 1000; // 예정 시각 이후 이 시간 안에서만 만든다 (뒤늦은 소급 발송 금지).
const PASS_RECIPIENT_LIMIT = 500;
const NOTIFIED_LIMIT = 5000;
const SLOT_HISTORY_LIMIT = 20;
const TITLES = { confirmed: '참가 확정 안내 (자동)', reminder: '행사 리마인드 (자동)' };

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function emptyAutoNotify() {
  return { rules: {}, notified: { confirmed: [] }, reminderSlots: [] };
}

function stored(workspace) {
  const raw = workspace && workspace.autoNotify;
  const base = emptyAutoNotify();
  if (!isRecord(raw)) return base;
  if (isRecord(raw.rules)) for (const kind of KINDS) if (isRecord(raw.rules[kind])) base.rules[kind] = { ...raw.rules[kind] };
  if (isRecord(raw.notified) && Array.isArray(raw.notified.confirmed)) base.notified.confirmed = raw.notified.confirmed.filter((id) => typeof id === 'string');
  if (Array.isArray(raw.reminderSlots)) base.reminderSlots = raw.reminderSlots.filter((slot) => typeof slot === 'string');
  return base;
}

// 안내 대상: 참가 확정이고 연락처가 있는 사람.
function eligibleRecipient(person) {
  return isRecord(person) && String(person.status || '').toUpperCase() === 'APPROVED' &&
    typeof person.id === 'string' && person.id.length > 0 && person.id.length <= 120 &&
    String(person.phone || '').replace(/\D/g, '').length >= 9;
}

function eligibleRecipients(workspace) {
  return (Array.isArray(workspace && workspace.participants) ? workspace.participants : []).filter(eligibleRecipient);
}

// 규칙 저장 명령 (autoNotify.save). 한 번에 규칙 하나를 바꾼다.
function saveAutoNotify(ctx, input) {
  const { validateTemplateVariables } = require('./commands/content-results');
  const kind = ctx.clean(input.rule, 16);
  if (!KINDS.includes(kind)) throw ctx.fail(400, '자동 안내 종류를 확인하세요', 'rule');
  if (typeof input.enabled !== 'boolean') throw ctx.fail(400, '사용 여부를 선택하세요', 'enabled');
  const state = stored(ctx.workspace);
  const previous = state.rules[kind] || null;
  const body = ctx.clean(input.body === undefined ? (previous && previous.body) || '' : input.body, 2000);
  if (input.enabled && !body.trim()) throw ctx.fail(400, '자동으로 보낼 내용을 입력하세요', 'body');
  validateTemplateVariables(ctx, body);
  const rule = { enabled: input.enabled, body, enabledAt: previous && previous.enabledAt ? previous.enabledAt : null, updatedAt: ctx.now };
  if (kind === 'reminder') {
    const anchor = normalizeScheduleAnchor({ kind: 'EVENT_DATE', days: input.days === undefined && previous ? previous.days : input.days,
      time: input.time === undefined && previous ? previous.time : input.time });
    if (!anchor || anchor.days < -1 || anchor.days > 7) throw ctx.fail(400, '리마인드 시점을 확인하세요', 'days');
    rule.days = anchor.days;
    rule.time = anchor.time;
  }
  const turningOn = rule.enabled && !(previous && previous.enabled === true);
  if (turningOn) {
    rule.enabledAt = ctx.now;
    // 켜는 순간 이미 확정된 사람에게 소급 발송하지 않는다.
    if (kind === 'confirmed') state.notified.confirmed = [...new Set([...state.notified.confirmed, ...eligibleRecipients(ctx.workspace).map((person) => person.id)])].slice(-NOTIFIED_LIMIT);
  }
  if (!rule.enabled) rule.enabledAt = previous ? previous.enabledAt : null;
  state.rules[kind] = rule;
  ctx.workspace.autoNotify = state;
  return { body: { autoNotify: state } };
}

function buildCampaign({ kind, workspace, recipients, now, slot }) {
  const { recipientRoutingVersion, recipientRoutingParts } = require('./commands/content-results');
  const rule = stored(workspace).rules[kind];
  const day = /^\d{4}-(\d{2})-(\d{2})/.exec(now);
  const id = `auto-${kind}-${Date.parse(now) || Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return {
    id,
    title: `${TITLES[kind]}${day ? ` · ${Number(day[1])}/${Number(day[2])}` : ''}`,
    body: rule.body,
    channel: 'SMS',
    recipientIds: recipients.map((person) => person.id),
    recipientRoutingReviewVersion: 1,
    recipientSnapshot: recipients.map((person) => ({
      id: person.id, name: String(person.name || ''), phone: String(person.phone || ''),
      routingVersion: recipientRoutingVersion(person),
      routingStatus: recipientRoutingParts(person)[0], routingGroup: recipientRoutingParts(person)[1],
    })),
    scheduled: now,
    scheduleMode: 'AUTO',
    autoScheduleIntent: 'confirmed-v1',
    autoNotice: { kind, ...(slot ? { slot } : {}) },
    status: 'SCHEDULED',
    simulate: false,
    templateId: null,
    solapiTemplateId: null,
    at: now,
    cost: null,
    attempts: 0,
    deliveries: recipients.map((person) => ({ participantId: person.id, name: String(person.name || ''), status: 'WAITING', at: now })),
  };
}

// 락을 잡은 행사 하나에서 만들 캠페인을 정한다. workspace를 직접 바꾸므로 호출자가 트랜잭션 안에서 저장한다.
function materializeForEvent(workspace, event, { now, providerKind } = {}) {
  const { smsCharacterGuard, ticketLinkGuard } = require('./commands/content-results');
  const result = { created: [], issues: [], changed: false };
  if (!isRecord(workspace) || !isRecord(event) || String(event.stage || '').toUpperCase() === 'ARCHIVED') return result;
  if (!Array.isArray(workspace.messages)) return result;
  if (Object.hasOwn(workspace, 'audit') && !Array.isArray(workspace.audit)) return result;
  const state = stored(workspace);
  const nowMs = Date.parse(now);
  let changed = false;

  for (const kind of KINDS) {
    const rule = state.rules[kind];
    if (!rule || rule.enabled !== true || !rule.body) continue;
    let recipients = [];
    let slot = '';
    if (kind === 'confirmed') {
      const seen = new Set(state.notified.confirmed);
      recipients = eligibleRecipients(workspace).filter((person) => !seen.has(person.id)).slice(0, PASS_RECIPIENT_LIMIT);
    } else {
      slot = anchorInstant(event.date, { kind: 'EVENT_DATE', days: rule.days, time: rule.time });
      const slotMs = Date.parse(slot);
      if (!slot || nowMs < slotMs || nowMs >= slotMs + REMINDER_WINDOW_MS) continue;
      if (state.reminderSlots.includes(slot)) continue;
      // 켜기 전에 이미 지난 시각은 만들지 않는다.
      if (rule.enabledAt && slotMs < Date.parse(rule.enabledAt)) continue;
      recipients = eligibleRecipients(workspace).slice(0, PASS_RECIPIENT_LIMIT);
    }
    if (kind === 'reminder') {
      state.reminderSlots = [...state.reminderSlots, slot].slice(-SLOT_HISTORY_LIMIT);
      changed = true;
    }
    if (!recipients.length) continue;

    const message = buildCampaign({ kind, workspace, recipients, now, slot });
    // 작성 화면과 같은 확인: 통과하지 못하면 만들지 않고 규칙을 꺼서 운영자가 알 수 있게 한다.
    const guard = ticketLinkGuard({ body: message.body, recipientSnapshot: message.recipientSnapshot }, workspace) ||
      smsCharacterGuard(message, workspace, { event, providerKind });
    if (guard) {
      state.rules[kind] = { ...rule, enabled: false, issue: { reason: String(guard.reason || 'GUARD'), at: now } };
      result.issues.push({ kind, reason: String(guard.reason || 'GUARD') });
      changed = true;
      continue;
    }
    workspace.messages.unshift(message);
    if (kind === 'confirmed') state.notified.confirmed = [...state.notified.confirmed, ...recipients.map((person) => person.id)].slice(-NOTIFIED_LIMIT);
    if (!Array.isArray(workspace.audit)) workspace.audit = [];
    workspace.audit.unshift({ id: `auto-notify-${message.id}`, type: 'autoNotify.create', actor: 'maintenance', at: now,
      detail: `${message.title} · ${recipients.length}명`, eventId: String(event.id || ''), maintenance: true });
    result.created.push({ kind, messageId: message.id, recipients: recipients.length });
    changed = true;
  }
  if (changed) workspace.autoNotify = state;
  result.changed = changed;
  return result;
}

// 서버 루프용: 켜진 규칙이 있는 행사만 훑어 캠페인을 만든다. 발송은 하지 않는다.
async function materializeAutoNotices(database, { now, limit = 50, providerKind } = {}) {
  const tenancy = require('./tenancy');
  const candidates = await database.query(
    `SELECT e.id FROM events e JOIN event_workspaces w ON w.event_id = e.id
     WHERE e.org_id = $1 AND jsonb_typeof(w.payload->'autoNotify'->'rules') = 'object'
     ORDER BY e.id LIMIT $2`,
    [tenancy.LEGACY_ORG_ID, Math.max(1, Math.min(Number(limit) || 50, 500))]
  );
  const summary = { events: 0, created: 0, issues: 0 };
  for (const row of candidates.rows || []) {
    const outcome = await database.transaction(async (client) => {
      const locked = await client.query(
        `SELECT e.id, e.org_id, e.payload AS event_payload, w.payload AS workspace_payload
         FROM events e JOIN event_workspaces w ON w.event_id = e.id WHERE e.id = $1 FOR UPDATE OF e, w`,
        [String(row.id)]
      );
      const first = locked.rows[0];
      if (!first || String(first.org_id) !== String(tenancy.LEGACY_ORG_ID)) return null;
      const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
      const workspace = parse(first.workspace_payload);
      const event = { id: String(first.id), ...parse(first.event_payload) };
      const made = materializeForEvent(workspace, event, { now, providerKind });
      // 바뀐 것이 없으면 쓰지 않는다: 매 분 revision이 올라가면 화면 새로고침과 저장 충돌을 만든다.
      if (!made.changed) return made;
      await client.query(
        'UPDATE event_workspaces SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE event_id = $1',
        [String(row.id), JSON.stringify(workspace)]
      );
      return made;
    });
    if (!outcome) continue;
    summary.events += 1;
    summary.created += outcome.created.length;
    summary.issues += outcome.issues.length;
  }
  return summary;
}

module.exports = { KINDS, REMINDER_WINDOW_MS, eligibleRecipient, materializeAutoNotices, materializeForEvent, saveAutoNotify, stored };
