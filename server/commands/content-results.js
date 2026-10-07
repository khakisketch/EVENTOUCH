'use strict';

const crypto = require('node:crypto');

const COMMANDS = new Set([
  'template.save',
  'message.create',
  'message.cancel',
  'message.retry',
  'payment.simulate',
  'payment.refund-request',
  'payment.refund',
  'reward.create',
  'reward.fulfill',
  'reward.cancel',
  'report.create',
  'report.update',
  'report.publish',
  'report.successor',
]);

const MESSAGE_CHANNELS = new Set(['SMS', 'ALIMTALK']);
const TEMPLATE_VARIABLES = new Set(['이름', '행사명', '행사일', '티켓링크']);
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

function randomId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function saveTemplate(ctx, input) {
  if (!Array.isArray(ctx.workspace.templates)) ctx.workspace.templates = [];
  const id = ctx.clean(input.id || ctx.makeId('template'), 120);
  const old = ctx.workspace.templates.find((item) => item.id === id);
  const channel = ctx.clean(input.channel, 16).toUpperCase();
  if (!MESSAGE_CHANNELS.has(channel)) throw ctx.fail(400, '메시지 채널을 선택하세요', 'channel');
  const template = {
    id,
    name: requireText(ctx, input.name, '템플릿 이름', 80, 'name'),
    channel,
    body: requireText(ctx, input.body, '메시지 내용', 2000, 'body'),
  };
  if (old) Object.assign(old, template);
  else ctx.workspace.templates.push(template);
  return { body: { template } };
}

function validateTemplateVariables(ctx, body) {
  const tokens = String(body).match(/\{\{[^{}]*\}\}/g) || [];
  if (tokens.some((token) => !TEMPLATE_VARIABLES.has(token.slice(2, -2)))) {
    throw ctx.fail(400, '지원하지 않는 메시지 변수가 있습니다', 'body');
  }
}

function createMessage(ctx, input) {
  const ids = Array.isArray(input.ids) ? input.ids.map((id) => ctx.clean(id, 120)) : [];
  if (!ids.length || ids.length > 5000 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw ctx.fail(400, '발송 대상을 선택하세요', 'ids');
  }
  const recipients = ids.map((id) => ctx.workspace.participants.find((person) => person.id === id));
  if (recipients.some((person) => !person || person.status === 'CANCELLED')) {
    throw ctx.fail(409, '검토 후 대상이 변경되었습니다. 대상을 다시 확인하세요');
  }
  const channel = ctx.clean(input.channel, 16).toUpperCase();
  if (!MESSAGE_CHANNELS.has(channel)) throw ctx.fail(400, '발송 채널을 선택하세요', 'channel');
  const title = requireText(ctx, input.title, '캠페인 제목', 100, 'title');
  const body = requireText(ctx, input.body, '내용', 2000, 'body');
  validateTemplateVariables(ctx, body);

  const scheduled = input.scheduled ? ctx.clean(input.scheduled, 64) : '';
  const scheduledAt = scheduled ? Date.parse(scheduled) : NaN;
  if (scheduled && (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now())) {
    throw ctx.fail(400, '예약 시각은 현재 이후로 설정하세요', 'scheduled');
  }
  const simulated = input.simulate === true;
  const status = scheduled ? 'SCHEDULED' : simulated ? 'SIMULATED' : 'NEEDS_CONNECTION';
  const message = {
    id: ctx.commandId,
    title,
    body,
    channel,
    recipientIds: recipients.map((person) => person.id),
    // Never duplicate attendee ticket bearers into campaign history.
    recipientSnapshot: recipients.map((person) => ({
      id: person.id,
      name: String(person.name || ''),
      phone: String(person.phone || ''),
    })),
    scheduled,
    status,
    simulate: simulated,
    at: ctx.now,
    cost: null,
    attempts: status === 'SCHEDULED' ? 0 : 1,
    deliveries: recipients.map((person) => ({
      participantId: person.id,
      name: String(person.name || ''),
      status: status === 'SIMULATED' ? 'SIMULATED' : status === 'NEEDS_CONNECTION' ? 'UNCONNECTED' : 'WAITING',
      at: ctx.now,
    })),
  };
  ctx.workspace.messages.unshift(message);
  return { status: 201, body: { message } };
}

function cancelMessage(ctx, input) {
  const message = list(ctx.workspace.messages).find((item) => item.id === ctx.clean(input.id, 120));
  if (!message || !['SCHEDULED', 'DRAFT', 'NEEDS_CONNECTION'].includes(message.status)) {
    throw ctx.fail(409, '취소할 수 없는 상태입니다');
  }
  message.status = 'CANCELLED';
  list(message.deliveries).forEach((delivery) => { delivery.status = 'CANCELLED'; });
  return { body: { message } };
}

function retryMessage(ctx, input) {
  const message = list(ctx.workspace.messages).find((item) => item.id === ctx.clean(input.id, 120));
  if (!message || !['SCHEDULED', 'NEEDS_CONNECTION'].includes(message.status)) {
    throw ctx.fail(409, '실행할 수 없는 상태입니다');
  }
  if (message.scheduled && Date.parse(message.scheduled) > Date.now()) throw ctx.fail(409, '예약 시각 전입니다');
  message.attempts = (Number(message.attempts) || 0) + 1;
  message.status = message.simulate === true ? 'SIMULATED' : 'NEEDS_CONNECTION';
  list(message.deliveries).forEach((delivery) => {
    delivery.status = message.simulate === true ? 'SIMULATED' : 'UNCONNECTED';
    delivery.at = ctx.now;
  });
  return { body: { message } };
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
  const person = list(ctx.workspace.participants).find((item) =>
    item.id === ctx.clean(input.participantId, 120) && item.status === 'APPROVED'
  );
  if (!person) throw ctx.fail(404, '참가 확정자를 선택하세요');
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

function fulfillReward(ctx, input) {
  requireFeature(ctx, 'reward');
  const reward = list(ctx.workspace.rewards).find((item) => item.id === ctx.clean(input.id, 120));
  if (!reward || !['READY', 'FAILED'].includes(reward.status)) throw ctx.fail(409, '지급 대기 경품을 선택하세요');
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

async function reportSnapshot(ctx) {
  const participants = list(ctx.workspace.participants).filter((person) => person.status !== 'CANCELLED');
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

async function createReport(ctx, input) {
  const report = {
    id: ctx.commandId,
    title: requireText(ctx, input.title, '보고서 제목', 100, 'title'),
    summary: ctx.clean(input.summary, 2000),
    sections: reportSections(ctx, input.sections),
    snapshot: await reportSnapshot(ctx),
    color: /^#[0-9a-f]{6}$/i.test(String(input.color || '')) ? String(input.color).toUpperCase() : '#E76D26',
    status: 'DRAFT',
    version: 1,
    createdAt: ctx.now,
    publishedAt: null,
  };
  ctx.workspace.reports.unshift(report);
  return { status: 201, body: { report: { ...report } } };
}

function findReport(ctx, id) {
  const report = list(ctx.workspace.reports).find((item) => item.id === ctx.clean(id, 120));
  if (!report) throw ctx.fail(404, '보고서를 찾을 수 없습니다');
  return report;
}

function updateReport(ctx, input) {
  const report = findReport(ctx, input.id);
  if (report.status === 'PUBLISHED') throw ctx.fail(409, '공유한 버전은 수정할 수 없습니다. 새 보고서 버전을 만드세요');
  report.title = requireText(ctx, input.title, '제목', 100, 'title');
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
  if (input.source === 'current') snapshot = await reportSnapshot(ctx);
  else if (input.source === undefined || input.source === 'snapshot') snapshot = structuredClone(source.snapshot);
  else throw ctx.fail(400, '보고서 버전 기준을 확인하세요', 'source');
  const report = {
    id: ctx.commandId,
    familyId,
    parentId: source.id,
    version,
    title: String(source.title || ''),
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
    case 'message.create': return createMessage(ctx, ctx.input);
    case 'message.cancel': return cancelMessage(ctx, ctx.input);
    case 'message.retry': return retryMessage(ctx, ctx.input);
    case 'payment.simulate': return simulatePayment(ctx, ctx.input);
    case 'payment.refund-request': return requestRefund(ctx, ctx.input);
    case 'payment.refund': return refundPayment(ctx, ctx.input);
    case 'reward.create': return createReward(ctx, ctx.input);
    case 'reward.fulfill': return fulfillReward(ctx, ctx.input);
    case 'reward.cancel': return cancelReward(ctx, ctx.input);
    case 'report.create': return createReport(ctx, ctx.input);
    case 'report.update': return updateReport(ctx, ctx.input);
    case 'report.publish': return publishReport(ctx, ctx.input);
    case 'report.successor': return createSuccessor(ctx, ctx.input);
    default: throw ctx.fail(400, '지원하지 않는 결과 작업입니다', 'command');
  }
}

module.exports = { COMMANDS, apply };
