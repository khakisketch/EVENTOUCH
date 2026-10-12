'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const owner = { id: 'owner', name: 'Owner', email: 'owner@example.test', role: 'AGENCY', active: true, orgOwner: true };

function loadAgencyViews() {
  const E = {
    views: {}, actions: {}, forms: {}, handlers: {}, route: { scope: 'agency', page: 'clients' },
    ui: { filters: {} },
    state: { clients: [], events: [], workspaces: {}, memberships: [], accounts: [owner], invitations: [] },
    session: owner, seed: () => ({}), load: () => ({}), readiness: () => [], run: async () => {},
    event: () => null,
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    button: (label, action, attrs = '', cls = '') => `<button class="btn ${cls}" data-action="${action}" ${attrs}>${label}</button>`,
    link: (label, url, cls = '') => `<a class="btn ${cls}" href="${url}">${label}</a>`,
    field: () => '', select: () => '', check: () => '', submit: () => '',
    badge: text => `<span class="badge">${text}</span>`,
    head: (title, desc = '', actions = '', eyebrow = '', className = '') => `<header class="page-head${className ? ' ' + className : ''}"><div>${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ''}<h1>${title}</h1>${desc}</div><div class="actions">${actions}</div></header>`,
    panel: (title, body) => `<section class="panel"><h2>${title}</h2>${body}</section>`,
    empty: (title, desc, action = '') => `<div class="empty"><h3>${title}</h3><p>${desc}</p>${action}</div>`,
    notice: text => `<div class="notice">${text}</div>`,
    table: (heads, rows) => `<table><thead><tr>${heads.map(head => `<th>${head}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`,
    detail: () => '', register(name, group, fn, options = {}) { this.handlers[name] = { group, fn, options }; },
    metrics: () => ({ total: 1 }), stages: { DRAFT: '기획', LIVE: '진행 중' }, icon: () => '',
    consoleURL: () => '#/console/events/event-1/overview', image: () => '',
    toast: () => {}, dialog: () => {}, confirm: () => {}, close: () => {}, id: () => 'id',
    require: value => value, copy: value => value, activeAssignments: () => [], assignment: () => null,
    work: () => ({}), person: () => null, storageWarning: '',
  };
  const context = {
    window: { ET: E, addEventListener() {} },
    document: { addEventListener() {}, body: { classList: { contains: () => false } }, querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    URLSearchParams, location: { href: 'http://localhost/' }, console,
  };
  vm.createContext(context);
  for (const file of ['assets/js/role-model.js', 'assets/js/operator-experience.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return E;
}

test('empty clients use the shared empty state without repeating the agency workspace label', () => {
  const E = loadAgencyViews();
  const html = E.views['agency-clients']();
  assert.doesNotMatch(html, /운영 워크스페이스/);
  assert.match(html, /<section class="panel"><h2>고객사 목록<\/h2><div class="empty">/);
});

test('one-event agency home adapts its grid without removing the event card', () => {
  const E = loadAgencyViews();
  const event = { id: 'event-1', name: '한 개 행사', slug: 'one-event', date: '2026-10-08', start: '09:00', end: '17:00', stage: 'DRAFT', features: [] };
  E.state.events = [event];
  E.state.workspaces[event.id] = { branding: {} };
  E.route.page = 'events';
  const html = E.views['agency-events']();
  assert.match(html, /event-card-grid event-card-grid-single/);
  assert.match(html, /<header class="page-head agency-events-head">/);
  assert.match(html, /한 개 행사/);
  assert.doesNotMatch(html, /운영 워크스페이스/);
});

test('event-list no-results state is distinct and offers a direct filter reset', () => {
  const E = loadAgencyViews();
  const event = { id: 'event-1', name: '한 개 행사', slug: 'one-event', date: '2026-10-08', start: '09:00', end: '17:00', stage: 'DRAFT', features: [] };
  E.state.events = [event];
  E.state.workspaces[event.id] = { branding: {} };
  E.route.page = 'events';
  E.ui.filters.events = '없는 행사';
  E.ui.filters.eventStatus = 'LIVE';

  const html = E.views['agency-events']();

  assert.match(html, /검색 결과|조건에 맞는 행사/);
  assert.match(html, /data-action="clear-event-filters"/);
  assert.doesNotMatch(html, /담당 행사가 없습니다|조직 구성원에게 행사 접근 권한을 요청하세요/);
});

test('event cards label schedule separately from the persisted operational stage', () => {
  const E = loadAgencyViews();
  const event = { id: 'event-1', name: '행사명', slug: 'one-event', date: '2026-11-15', start: '09:00', end: '17:00', stage: 'LIVE', features: [] };
  E.state.events = [event];
  E.state.workspaces[event.id] = { branding: {} };
  E.route.page = 'events';

  const html = E.views['agency-events']();
  const card = html.slice(html.indexOf('<article'), html.indexOf('</article>') + '</article>'.length);

  assert.match(card, /일정/);
  assert.match(card, /운영 상태/);
  assert.match(card, /2026-11-15[\s\S]*09:00[\s\S]*17:00/);
  assert.match(card, /class="event-schedule-date">2026-11-15<\/span>\s+<span class="event-schedule-time">09:00–17:00/);
  assert.match(card, /진행 중/);
  assert.equal(event.stage, 'LIVE');
});

test('event-list heading omits persistent helper copy and image-free cards have no image placeholder', () => {
  const E = loadAgencyViews();
  const event = { id: 'event-1', name: '이미지 없는 행사', slug: 'no-image', date: '2026-10-08', start: '09:00', end: '17:00', stage: 'DRAFT', features: [] };
  E.state.events = [event];
  E.state.workspaces[event.id] = { branding: {} };
  E.route.page = 'events';

  const html = E.views['agency-events']();

  assert.doesNotMatch(html, /담당 범위의 행사에서 준비와 운영을 이어갑니다|팀과 행사 권한은/);
  assert.doesNotMatch(html, /event-card-keyvisual/);
  assert.match(html, /이미지 없는 행사/);
});

test('team management column follows available permission-checked actions and notice stays in section', () => {
  const E = loadAgencyViews();
  E.route.page = 'team';
  let html = E.views['agency-team']();
  assert.doesNotMatch(html, /<th>관리<\/th>/);
  assert.match(html, /<section class="panel"><h2>팀원<\/h2>[\s\S]*class="notice"[\s\S]*<\/section>/);
  E.state.accounts.push({ id: 'member', name: 'Member', email: 'member@example.test', role: 'OPERATOR', active: true, orgOwner: false, orgPermissions: [] });
  html = E.views['agency-team']();
  assert.match(html, /<th>관리<\/th>/);
  assert.match(html, /data-action="edit-org-permissions"/);
  assert.doesNotMatch(html, /운영 워크스페이스/);
});

test('integrations describe the browser preview when not connected to the server', () => {
  const E = loadAgencyViews();
  E.route.page = 'integrations';
  // storageMode/previewMode are unset, so this is the browser-experience view.
  const html = E.views['agency-integrations']();
  assert.equal((html.match(/class="badge[ "]/g) || []).length, 5);
  assert.match(html, /브라우저 체험/);
  assert.doesNotMatch(html, /연결됨/);
  assert.equal((html.match(/class="list-item agency-integration-row"/g) || []).length, 5);
  assert.doesNotMatch(html, /운영 워크스페이스/);
});

test('integrations report real server connections in server mode', () => {
  const E = loadAgencyViews();
  E.route.page = 'integrations';
  E.previewMode = false;
  E.storageMode = 'server';
  const html = E.views['agency-integrations']();
  // Login and file/photo storage are genuinely live on the server; messaging
  // and payments genuinely are not. The screen must say which is which.
  assert.equal((html.match(/class="badge[ "]/g) || []).length, 6);
  assert.equal((html.match(/연결됨/g) || []).length, 2);
  assert.match(html, /계정과 세션은 행사 서버가 관리합니다/);
  // The stubbed badge helper ignores the kind argument, so the good-tone class
  // is asserted against the real helper separately below.
  assert.doesNotMatch(html, /프로토타입|브라우저 체험|체험 계정/);
});

test('mobile console shell keeps agency or event context beside the menu in a sticky topbar', () => {
  const E = loadAgencyViews();
  E.route.scope = 'agency';
  let html = E.adminShell('');
  assert.match(html, /class="btn square menu-button" data-action="toggle-menu"/);
  assert.match(html, /breadcrumb agency-context"><span class="workspace-context">운영 워크스페이스/);
  E.route.scope = 'console';
  E.route.eventId = 'event-1';
  E.event = () => ({ id: 'event-1', name: '한 개 행사', slug: 'one-event', stage: 'DRAFT', features: [] });
  html = E.adminShell('');
  assert.match(html, /breadcrumb event-context"><span class="workspace-context">운영 워크스페이스<\/span><span class="context-separator">\/<\/span><strong class="event-context">한 개 행사/);
  const css = fs.readFileSync(path.join(root, 'assets/css/console.css'), 'utf8');
  assert.match(css, /@media\(max-width:768px\)\{[^}]*\.admin-main>\.topbar\{position:sticky;top:0;z-index:50\}/s);
  assert.match(css, /\.topbar \.breadcrumb\.agency-context \.workspace-context\{display:inline\}/);
});
