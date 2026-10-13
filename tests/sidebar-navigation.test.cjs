const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const routerSource = fs.readFileSync(path.join(__dirname, '../assets/js/router.js'), 'utf8');
const experienceSource = fs.readFileSync(path.join(__dirname, '../assets/js/experience.js'), 'utf8');
const operatorExperienceSource = fs.readFileSync(path.join(__dirname, '../assets/js/operator-experience.js'), 'utf8');

function loadNavigation({ page = 'overview', scope = 'console', can = () => true, elements = {}, orgOwner = true, features = ['stamp', 'screen', 'poll'] } = {}) {
  const handlers = new Proxy({}, { get: (target, key) => target[key] || (target[key] = { fn() {} }) });
  const document = {
    addEventListener() {},
    getElementById(id) { return elements[id] || null; },
  };
  const event = { id: 'event-1', name: '테스트 행사', slug: 'test-event', clientId: 'client-1', stage: 'LIVE', features };
  const E = {
    views: {}, actions: {}, forms: {}, handlers, ui: { externalChange: false }, route: { scope, page },
    session: { id: 'manager-1', active: true, role: 'MANAGER', name: '운영자', orgOwner },
    state: { clients: [{ id: 'client-1', name: '고객사' }], memberships: [{ accountId: 'manager-1', eventId: 'event-1', write: [] }], workspaces: {} },
    roleNames: { MANAGER: '매니저' }, stages: { LIVE: '진행 중' },
    esc: value => String(value ?? ''),
    event: () => event,
    can,
    groupForPage: pageName => ({ overview: 'overview', participants: 'participants', onsite: 'onsite', booths: 'booth', page: 'page', programs: 'programs', messages: 'messages', screen: 'screen', results: 'results', settings: 'settings' })[pageName] || null,
    consoleURL: pageName => '#/console/events/event-1/' + pageName,
    url: hash => hash,
    icon: name => '<svg data-icon="' + name + '"></svg>',
    badge: label => '<span class="badge">' + label + '</span>',
    button: (label, action, attrs = '', cls = '') => '<button class="btn ' + cls + '" type="button" data-action="' + action + '" ' + attrs + '>' + label + '</button>',
    link: (label, href, cls = '') => '<a class="btn ' + cls + '" href="' + href + '">' + label + '</a>',
    register() {},
  };
  const window = { ET: E, addEventListener() {} };
  vm.runInNewContext(routerSource, { window, document, location: { hash: '' }, URLSearchParams });
  vm.runInNewContext(experienceSource, { window, document });
  vm.runInNewContext(operatorExperienceSource, { window, document });
  E.can = can;
  return { E, html: E.adminShell('<p>content</p>') };
}

test('event sidebar keeps workspace landmarks and nests the event tree directly under Events', () => {
  const { html } = loadNavigation();
  assert.equal([routerSource, experienceSource, operatorExperienceSource].flatMap(source => [...source.matchAll(/E\.adminShell\s*=/g)]).length, 1, 'exactly one shell implementation should remain');
  const labels = ['운영 현황', '결과·보고서', '참가자', '참가자 페이지', '메시지', '현장 운영', '부스 운영', '참여 프로그램', '행사장 출력', '설정'];
  const itemLabels = [...html.matchAll(/<a class="nav-item[^\"]*"[^>]*>[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<\/a>/g)].map(match => match[1]);
  assert.deepEqual(itemLabels, ['행사', ...labels, '고객사', '팀·권한', '서비스 연동']);
  assert.ok(html.indexOf('id="workspace-events-link"') < html.indexOf('class="nav-event-branch"'));
  assert.ok(html.indexOf('class="nav-event-branch"') < html.indexOf('href="#/console/agency/clients"'));
  assert.match(html, /class="nav-section-label">현황과 결과<\/p>/);
  assert.match(html, /class="nav-section-label">참가자 관리<\/p>/);
  assert.match(html, /class="nav-section-label">현장·프로그램 운영<\/p>/);
  assert.match(html, /class="nav-section-label">행사 설정<\/p>/);
  assert.doesNotMatch(html, /nav-group-toggle|toggle-sidebar-group|class="nav-group-items"| hidden/);
  assert.match(html, /class="nav-current-event"[\s\S]*?<strong>테스트 행사<\/strong>/);
  assert.match(html, /class="nav-event-switch" href="#\/console\/agency\/events" aria-label="전환: 다른 행사 선택"/);
  for (const route of ['participants', 'page', 'programs', 'messages', 'overview', 'onsite', 'booths', 'screen', 'results', 'settings']) {
    assert.ok(html.includes('href="#/console/events/event-1/' + route + '"'), 'missing existing route ' + route);
  }
});

test('event sidebar applies active state to the current destination and preserves permission gates', () => {
  const { html } = loadNavigation({ page: 'programs', can: group => group !== 'page' && group !== 'booth' });
  assert.match(html, /<a class="nav-item active" aria-current="page" href="#\/console\/events\/event-1\/programs">/);
  assert.match(html, /<a class="nav-item active-path" id="workspace-events-link" href="#\/console\/agency\/events">/);
  assert.doesNotMatch(html, /href="#\/console\/events\/event-1\/(page|booths)"/);
  assert.match(html, /href="#\/console\/events\/event-1\/programs"/);
});

test('feature-off destinations are omitted without blank placeholder rows or links', () => {
  const { html } = loadNavigation({ features: [] });
  assert.equal((html.match(/class="nav-item-placeholder"/g) || []).length, 0);
  assert.doesNotMatch(html, /href="#\/console\/events\/event-1\/(booths|programs|screen)"/);
  assert.ok(html.indexOf('href="#/console/events/event-1/onsite"') < html.indexOf('href="#/console/events/event-1/settings"'));
});

test('agency scope retains the same four top-level landmarks without an event subtree', () => {
  const { html } = loadNavigation({ scope: 'agency', page: 'events' });
  const labels = [...html.matchAll(/<a class="nav-item[^\"]*"[^>]*>[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<\/a>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['행사', '고객사', '팀·권한', '서비스 연동']);
  assert.match(html, /<a class="nav-item active" id="workspace-events-link" aria-current="page" href="#\/console\/agency\/events">/);
  assert.doesNotMatch(html, /nav-event-branch|nav-current-event|nav-section-label/);
});
