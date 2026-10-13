'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadOverview({ canChecks = true, canParticipants = true, canCheckin = true, canOnsite = true, canPrograms = true, canMessages = true, stage = 'LIVE', readiness = [], capacity = 200, pending = 0, photos = [], emptyChecks = false } = {}) {
  const checks = emptyChecks ? [] : [
    { id: 'check-new', name: '최근 참가자', action: 'OUT', at: '2026-10-11T09:42:00', corrected: true },
    { id: 'check-older', name: '이전 참가자', action: 'IN', at: '2026-10-11T09:31:00', corrected: false },
    { id: 'check-oldest', name: '오래된 참가자', action: 'IN', at: '2026-10-11T09:15:00', corrected: false },
    { id: 'check-newest', name: '가장 최근 참가자', action: 'OUT', at: '2026-10-11T09:50:00', corrected: false },
    { id: 'check-middle', name: '중간 참가자', action: 'OUT', at: '2026-10-11T09:35:00', corrected: false },
    { id: 'check-outside', name: '화면 밖 참가자', action: 'IN', at: '2026-10-11T09:00:00', corrected: false },
  ];
  const E = {
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    button: () => '', link: () => '', field: () => '', select: () => '',
    register() {}, views: {}, actions: {}, forms: { 'import-map': () => {} }, ui: { filters: {} },
    handlers: { 'participant.update': { fn: () => {} }, 'participant.self-update': { fn: () => {} } },
    route: { scope: 'console' }, personFields: () => '', validateInput: input => input,
    features: {}, resolveCode: value => value,
    state: { migration: { available: false } },
     work: () => ({ checks, participants: [], questions: [], photos, posts: [], messages: [], reports: [], modules: [], registrationOpen: true, venue: { name: '운영홀' } }),
     event: () => ({ id: 'event-1', name: '운영 행사', stage, date: '2026-10-11', start: '09:00', end: '17:00', capacity, slug: 'event', features: [] }),
     metrics: () => ({ total: 3, inside: 1, checked: 2, pending, approved: 2, rate: 67 }),
    readiness: () => readiness,
     can: (page) => page === 'checks' ? canChecks : page === 'participants' ? canParticipants : page === 'checkin' ? canCheckin : page === 'onsite' ? canOnsite : page === 'programs' ? canPrograms : page === 'messages' ? canMessages : true,
    groupForPage: page => page,
    consoleURL: page => `#/console/events/event-1/${page}`,
    stages: { LIVE: '진행 중', DRAFT: '준비 중' },
    badge: (label, tone = '') => `<span class="badge ${tone}">${label}</span>`,
    icon: name => `<span class="icon icon-${name}"></span>`,
  };
  const window = { ET: E, addEventListener() {}, requestAnimationFrame() {} };
  const document = { addEventListener() {}, querySelector: () => null, body: { classList: { toggle() {} } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/js/experience.js'), 'utf8'), { window, document });
  return E.views.overview();
}

test('LIVE overview leads with KPIs and actions, sorts recent check-ins, and gates activity', () => {
  const html = loadOverview();
  assert.match(html, /<h1 class="overview-page-title">운영 현황<\/h1>/);
  assert.match(html, /id="overview-status-title">등록·입장 현황<\/h2>/);
  assert.match(html, /id="overview-action-title">지금 할 일<\/h2>/);
  assert.match(html, /체크인 시작/);
  assert.match(html, /대기 중인 업무가 없습니다/);
  assert.match(html, /overview-hourly-list/);
  assert.ok(html.indexOf('가장 최근 참가자') < html.indexOf('최근 참가자'));
  assert.ok(html.indexOf('최근 참가자') < html.indexOf('중간 참가자'));
  assert.ok(html.indexOf('중간 참가자') < html.indexOf('이전 참가자'));
  assert.match(html, /퇴장/);
  assert.match(html, /입장/);
  assert.match(html, /09:42/);
  assert.match(html, /정정/);
  assert.doesNotMatch(html, /화면 밖 참가자/);
  assert.equal((html.match(/overview-check-activity-list">[\s\S]*?<\/ol>/)?.[0].match(/<li>/g) || []).length, 5);
  assert.match(html, /href="#\/console\/events\/event-1\/checks">전체 기록 보기/);
  assert.doesNotMatch(html, /관리 메뉴|overview-menu-link/);

  const restricted = loadOverview({ canChecks: false });
  assert.doesNotMatch(restricted, /가장 최근 참가자|최근 참가자|이전 참가자|오래된 참가자|정정|전체 기록 보기|overview-hourly-list|class="overview-kpi-label">입장률/);

  const draft = loadOverview({ stage: 'DRAFT' });
  assert.doesNotMatch(draft, /overview-check-activity/);
  assert.doesNotMatch(draft, /overview-hourly-list/);
  assert.match(draft, /id="overview-status-title">접수 현황<\/h2>/);
  assert.match(draft, /접수·준비 현황/);
  assert.doesNotMatch(draft, /관리 메뉴|\/checks/);

  const noAccess = loadOverview({ canChecks: false, canParticipants: false, canCheckin: false, canOnsite: false, canPrograms: false, canMessages: false });
  assert.doesNotMatch(noAccess, /overview-kpi-section|overview-progress-panel|overview-primary-row|overview-check-activity|overview-hourly-list/);
  assert.match(noAccess, /현재 계정에서 접근할 수 있는 업무가 없습니다/);

  const ended = loadOverview({ stage: 'ENDED' });
  assert.match(ended, /id="overview-status-title">행사 집계<\/h2>/);
  assert.match(ended, /정원 대비 행사 집계/);
  assert.match(ended, /overview-check-activity/);
  assert.match(ended, /결과 분석 보기/);
  const archived = loadOverview({ stage: 'ARCHIVED' });
  assert.match(archived, /id="overview-status-title">행사 집계<\/h2>/);
  assert.doesNotMatch(archived, /overview-hourly-list/);

  const hasTasks = loadOverview({ pending: 2, photos: [{ status: 'PENDING' }] });
  assert.match(hasTasks, /승인 대기/);
  assert.match(hasTasks, /검토 대기 콘텐츠/);
  assert.match(hasTasks, /<span class="overview-task-count"><strong>2<\/strong>/);

  const noCheckins = loadOverview({ emptyChecks: true });
  assert.doesNotMatch(noCheckins, /overview-hourly-list/);
  assert.match(noCheckins, /id="overview-progress-title">현장 진행률<\/h2>/);
  assert.match(noCheckins, /overview-capacity-meter/);

  const noCapacity = loadOverview({ stage: 'READY', capacity: 0 });
  assert.match(noCapacity, /overview-kpi-value"><span>—<\/span>/);
  assert.match(noCapacity, /정원 미설정/);
  assert.doesNotMatch(noCapacity, /NaN/);
});

test('overview task rows let the visible text be the accessible name', () => {
  // A previous version composed aria-label="제목, N건. 설명". The count sat
  // between the two visible strings, so the accessible name no longer
  // contained the visible text and axe reported label-content-name-mismatch
  // (serious) whenever a task row was present.
  const html = loadOverview({
    stage: 'DRAFT',
    readiness: [
      ['확인할 행사장 안내', false, 'venue', '장소 이름과 주소 확인'],
      ['배정할 스태프 배정', false, 'desks', '현장 담당자 배정'],
    ],
  });
  assert.match(html, /overview-task-row/);
  assert.match(html, /확인할 행사장 안내/);
  assert.match(html, /장소 이름과 주소 확인/);
  assert.doesNotMatch(html, /overview-task-row[^>]*aria-label/);
});
