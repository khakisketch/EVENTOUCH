const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const routerSource = fs.readFileSync(path.join(__dirname, '../assets/js/router.js'), 'utf8');
const experienceSource = fs.readFileSync(path.join(__dirname, '../assets/js/experience.js'), 'utf8');
const operatorExperienceSource = fs.readFileSync(path.join(__dirname, '../assets/js/operator-experience.js'), 'utf8');

function loadNavigation({ page = 'overview', can = () => true, elements = {} } = {}) {
  const handlers = new Proxy({}, { get: (target, key) => target[key] || (target[key] = { fn() {} }) });
  const document = {
    addEventListener() {},
    getElementById(id) { return elements[id] || null; },
  };
  const event = { id: 'event-1', name: '테스트 행사', slug: 'test-event', clientId: 'client-1', stage: 'LIVE', features: ['stamp', 'screen', 'poll'] };
  const E = {
    views: {}, actions: {}, forms: {}, handlers, ui: { externalChange: false }, route: { scope: 'console', page },
    session: { id: 'manager-1', active: true, role: 'MANAGER', name: '운영자' },
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

test('event sidebar groups existing destinations into preparation, live operation, and wrap-up', () => {
  const { html } = loadNavigation();
  assert.equal([routerSource, experienceSource, operatorExperienceSource].flatMap(source => [...source.matchAll(/E\.adminShell\s*=/g)]).length, 1, 'exactly one shell implementation should remain');
  const labels = ['참가자', '참가자 페이지', '참여 프로그램', '메시지', '운영 현황', '현장 운영', '부스 운영', '행사장 출력', '결과·보고서', '설정'];
  assert.deepEqual([...html.matchAll(/class="nav-item[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(match => match[1]), labels);
  for (const group of ['preparation', 'live-operation', 'wrap-up']) {
    assert.match(html, new RegExp('data-group="' + group + '"'));
    assert.match(html, new RegExp('aria-controls="sidebar-nav-' + group + '"'));
  }
  for (const route of ['participants', 'page', 'programs', 'messages', 'overview', 'onsite', 'booths', 'screen', 'results', 'settings']) {
    assert.ok(html.includes('href="#/console/events/event-1/' + route + '"'), 'missing existing route ' + route);
  }
});

test('event sidebar expands the section containing the current route and preserves permission gates', () => {
  const { html } = loadNavigation({ page: 'programs', can: group => group !== 'page' && group !== 'booth' });
  assert.match(html, /data-group="preparation"[^>]*aria-expanded="true"/);
  assert.match(html, /data-group="live-operation"[^>]*aria-expanded="false"/);
  assert.match(html, /data-group="wrap-up"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /href="#\/console\/events\/event-1\/(page|booths)"/);
  assert.match(html, /href="#\/console\/events\/event-1\/programs"/);
});

test('sidebar group control keeps aria-expanded synchronized with the collapsed list', () => {
  const list = { hidden: false };
  const button = {
    expanded: 'true',
    getAttribute(name) { return name === 'aria-expanded' ? this.expanded : null; },
    setAttribute(name, value) { if (name === 'aria-expanded') this.expanded = value; },
  };
  const { E } = loadNavigation({ elements: { 'sidebar-nav-preparation': list } });
  E.actions['toggle-sidebar-group']({ group: 'preparation' }, button);
  assert.equal(button.expanded, 'false');
  assert.equal(list.hidden, true);
  E.actions['toggle-sidebar-group']({ group: 'preparation' }, button);
  assert.equal(button.expanded, 'true');
  assert.equal(list.hidden, false);
});
