'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadOverview({ canChecks = true, stage = 'LIVE', readiness = [] } = {}) {
  const checks = [
    { id: 'check-new', name: '최근 참가자', action: 'OUT', at: '2026-10-11T09:42:00', corrected: true },
    { id: 'check-older', name: '이전 참가자', action: 'IN', at: '2026-10-11T09:31:00', corrected: false },
    { id: 'check-oldest', name: '오래된 참가자', action: 'IN', at: '2026-10-11T09:15:00', corrected: false },
  ];
  const E = {
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    button: () => '', link: () => '', field: () => '', select: () => '',
    register() {}, views: {}, actions: {}, forms: { 'import-map': () => {} }, ui: { filters: {} },
    handlers: { 'participant.update': { fn: () => {} }, 'participant.self-update': { fn: () => {} } },
    route: { scope: 'console' }, personFields: () => '', validateInput: input => input,
    features: {}, resolveCode: value => value,
    state: { migration: { available: false } },
    work: () => ({ checks, participants: [], questions: [], photos: [], posts: [], messages: [], reports: [], registrationOpen: true, venue: { name: '운영홀' } }),
    event: () => ({ id: 'event-1', name: '운영 행사', stage, date: '2026-10-11', start: '09:00', end: '17:00', slug: 'event', features: [] }),
    metrics: () => ({ total: 3, inside: 1, checked: 2, pending: 0 }),
    readiness: () => readiness,
    can: (page) => page === 'checks' ? canChecks : true,
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

test('LIVE overview shows the first two check-ins and gates identities and history together', () => {
  const html = loadOverview();
  assert.ok(html.indexOf('최근 참가자') < html.indexOf('이전 참가자'));
  assert.match(html, /OUT/);
  assert.match(html, /IN/);
  assert.match(html, /09:42/);
  assert.match(html, /정정/);
  assert.doesNotMatch(html, /오래된 참가자/);
  assert.match(html, /href="#\/console\/events\/event-1\/checks">전체 기록 보기/);
  assert.doesNotMatch(html, /overview-menu-link[^]*운영 기록/);

  const restricted = loadOverview({ canChecks: false });
  assert.doesNotMatch(restricted, /최근 참가자|이전 참가자|오래된 참가자|정정|전체 기록 보기/);

  const draft = loadOverview({ stage: 'DRAFT' });
  assert.doesNotMatch(draft, /overview-check-activity/);
  assert.match(draft, /href="#\/console\/events\/event-1\/checks"[^]*운영 기록/);
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
