'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const event = {
  id: 'event-1', slug: 'browser-event', name: '가을 포럼', date: '2026-10-12',
  start: '09:30', end: '12:00', stage: 'LIVE', features: [],
};
const workspace = {
  venue: { name: '시민회관', address: '서울 중구 세종대로 1' },
  branding: { tagline: '함께 나누는 지역의 이야기', logo: null, keyvisual: null },
  notices: [], program: [], modules: [], publishedFields: [
    { id: 'name', label: '이름', required: true, type: 'text' },
    { id: 'phone', label: '연락처', required: true, type: 'tel' },
    { id: 'company', label: '소속', required: false, type: 'text' },
  ],
  registrationOpen: true, publishedVersion: 'version-7',
  consentText: '이름과 연락처를 참가 신청 및 입장 확인에 사용합니다.',
  approvalRequired: false, price: 0, payments: [], desks: [],
};

function loadAttendee(page = 'home', person = null, options = {}) {
  const classes = new Set();
  const testEvent = { ...event, features: options.features || event.features };
  const testWorkspace = { ...workspace, ...options.workspace };
  const E = {
    route: { scope: 'attendee', eventId: testEvent.id, slug: testEvent.slug, page, params: new URLSearchParams() },
    state: { events: [event] }, views: {}, forms: {}, actions: {}, ui: {},
    features: {}, registrationStates: { APPROVED: '참가 확정', PENDING: '확인 중' },
    event: () => testEvent, work: () => testWorkspace, person: () => person, date: value => String(value ?? ''),
    can: () => false, ticketValid: () => true,
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    button: (label, action, attrs = '', cls = '') => `<button class="btn ${cls}" data-action="${action}" ${attrs}>${label}</button>`,
    link: (label, href, cls = '', icon = '') => `<a class="btn ${cls}" href="${href}">${icon}${label}</a>`,
    field: (label, name, value = '', type = 'text', attrs = '') => `<label>${label}<input name="${name}" type="${type}" ${attrs}></label>`,
    select: (label, name, options, value = '', attrs = '') => `<label>${label}<select name="${name}" ${attrs}>${options.map(o => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select></label>`,
    panel: (title, body) => `<section class="panel"><h2>${title}</h2>${body}</section>`,
    notice: (text, kind = '') => `<div class="notice ${kind}">${text}</div>`,
    submit: label => `<button class="btn primary" type="submit">${label}</button>`,
    badge: text => `<span class="badge">${text}</span>`,
    detail: items => `<dl>${items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`,
    empty: (title, desc) => `<section><h3>${title}</h3><p>${desc}</p></section>`,
    icon: () => '', image: () => '', number: String,
    id: prefix => `${prefix}-fixed`,
    mobileEngagement: () => '<p>module</p>',
  };
  E.button = E.button.bind(E);
  const document = { body: { classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: name => classes.has(name) } } };
  const window = { ET: E, ETQR: { encode: code => `<svg data-ticket="${code}"></svg>` } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/js/attendee.js'), 'utf8'), { window, document, URLSearchParams });
  return { E, classes };
}

function loadCoreAndConsole() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/js/core.js'), 'utf8'), { window, URLSearchParams });
  const E = window.ET;
  const testEvent = { ...event, features: ['payment'] };
  const testWorkspace = { ...workspace, price: 2500 };
  Object.assign(E, {
    event: () => testEvent,
    work: () => testWorkspace,
    can: () => true,
    head: () => '',
    tabs: items => items.map(([label]) => label).join('|'),
    panel: (title, body) => `<section>${title}${body}</section>`,
    field: (label, name, value = '', type = 'text') => `<label>${label}<input name="${name}" type="${type}" value="${value}"></label>`,
    select: (label, name) => `<label>${label}<select name="${name}"></select></label>`,
    check: () => '', notice: () => '', submit: () => '<button>저장</button>',
    state: { clients: [] }, stages: { LIVE: '진행 중' },
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/js/console.js'), 'utf8'), { window: { ET: E } });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/js/router.js'), 'utf8'), {
    window: { ET: E, addEventListener() {} }, document: { addEventListener() {} },
    URLSearchParams, location: { hash: '' }, requestAnimationFrame() {},
  });
  E.route = { page: 'participants' };
  return E;
}

function loadPrograms(features = [], allowed = true) {
  const E = {
    esc: value => String(value ?? ''),
    button: (label, action, attrs = '', cls = '') => `<button class="btn ${cls}" data-action="${action}" ${attrs}>${label}</button>`,
    link: (label, href, cls = '') => `<a class="btn ${cls}" href="${href}">${label}</a>`,
    field: () => '', select: () => '', register() {},
    features: { poll: '투표', quiz: '퀴즈', qa: 'Q&A', draw: '추첨', survey: '만족도' },
    event: () => ({ id: 'event-1', features }),
    work: () => ({ modules: [] }),
    head: (title, desc, action = '') => `<header><h1>${title}</h1><p>${desc}</p>${action}</header>`, eventTabs: () => '', can: () => allowed,
    moduleCard: () => '', empty: (title, desc, action = '') => `<div class="empty"><h3>${title}</h3><p>${desc}</p>${action}</div>`,
    consoleURL: page => `#/console/events/event-1/${page}`,
  };
  const source = fs.readFileSync(path.join(root, 'assets/js/programs.js'), 'utf8');
  const start = source.indexOf('E.programPage=');
  const end = source.indexOf('\nE.views.programs=', start);
  vm.runInNewContext(source.slice(start, end), {
    E,
    e: E.esc,
    B: E.button,
    L: E.link,
  });
  return E;
}

test('attendee home identifies event date, time, venue, and a registration action', () => {
  const { E } = loadAttendee();
  const html = E.mobileHome();
  assert.match(html, /가을 포럼/);
  assert.match(html, /2026-10-12/);
  assert.match(html, /09:30/);
  assert.match(html, /12:00/);
  assert.match(html, /시민회관/);
  assert.match(html, /서울 중구 세종대로 1/);
  assert.match(html, /참가 신청/);
});

test('attendee home uses shared empty states for unpublished notice and schedule content', () => {
  const source = fs.readFileSync(path.join(root, 'assets/js/operator-experience.js'), 'utf8');
  const home = source.match(/E\.mobileHome\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\};/)?.[1] || '';
  assert.ok(home, 'the configured attendee home override remains active');
  assert.match(home, /E\.empty\('새 안내가 없습니다'/);
  assert.match(home, /E\.empty\('일정 준비 중입니다'/);
  assert.doesNotMatch(home, /E\.notice\('(새 안내가 게시되면|시간표가 게시되면)/);
});

test('server attendee home binds the existing capped desktop hero while preserving mobile content order', () => {
  const source = fs.readFileSync(path.join(root, 'assets/js/operator-experience.js'), 'utf8');
  const home = source.match(/E\.mobileHome\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\};/)?.[1] || '';
  assert.ok(home, 'the server-mode attendee home override remains active');
  assert.match(home, /class="attendee-home-hero"/);
  assert.match(home, /class="attendee-home-copy"/);
  assert.match(home, /class="attendee-home-image"/);
  assert.ok(home.indexOf('attendee-home-copy') < home.indexOf('attendee-home-image'));
  assert.ok(home.indexOf('attendee-home-image') < home.indexOf('hero-actions'));

  const css = fs.readFileSync(path.join(root, 'assets/css/server-presentation.css'), 'utf8');
  assert.match(css, /\.attendee-home-image img\s*\{[^}]*max-height:\s*420px/s);
});

test('direct registration shows event context before the unchanged form and consent', () => {
  const { E } = loadAttendee('register');
  const html = E.mobileRegister();
  assert.ok(html.indexOf('가을 포럼') >= 0 && html.indexOf('가을 포럼') < html.indexOf('<form data-form="attendee-register"'));
  assert.ok(html.indexOf('서울 중구 세종대로 1') >= 0 && html.indexOf('서울 중구 세종대로 1') < html.indexOf('<form data-form="attendee-register"'));
  assert.match(html, /name="name"/);
  assert.match(html, /name="phone"/);
  assert.match(html, /name="company"/);
  assert.match(html, /이름과 연락처를 참가 신청 및 입장 확인에 사용합니다\./);
  assert.match(html, /name="consent" required/);
  assert.match(html, /type="submit"/);
});

test('attendee info omits blank optional details while retaining populated identity rows', () => {
  const person = { name: '김가람', phone: '010-1234-5678', company: '', email: '  ', status: 'APPROVED', createdAt: '' };
  const { E } = loadAttendee('info', person);
  const html = E.mobileInfo();
  assert.match(html, /<dt>이름<\/dt><dd>김가람<\/dd>/);
  assert.match(html, /<dt>연락처<\/dt><dd>010-1234-5678<\/dd>/);
  assert.doesNotMatch(html, /<dt>(소속|이메일|등록 시각)<\/dt>/);
  person.email = 'garam@example.test';
  assert.match(E.mobileInfo(), /<dt>이메일<\/dt><dd>garam@example\.test<\/dd>/);
});

test('program empty state links to feature settings only when no program feature is enabled', () => {
  const disabled = loadPrograms([], true).programPage();
  assert.match(disabled, /사용할 기능을 켜고 프로그램을 시작하면 참가자에게 노출됩니다\./);
  assert.match(disabled, /href="#\/console\/events\/event-1\/features">기능 설정<\/a>/);
  assert.match(disabled, /data-action="edit-module"/);
  const enabled = loadPrograms(['poll'], true).programPage();
  assert.doesNotMatch(enabled, /기능 설정/);
  const readOnly = loadPrograms([], false).programPage();
  assert.doesNotMatch(readOnly, /data-action="edit-module"/);
  assert.match(readOnly, /기능 설정/);
});

test('handheld modal action footer remains sticky and reachable while modal content scrolls', () => {
  const css = fs.readFileSync(path.join(root, 'assets/css/tokens.css'), 'utf8');
  assert.match(css, /\.phone-screen \.modal footer\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0[^}]*background:\s*var\(--paper\)/s);
});

test('payment is absent from selectable features and settings preserve price in a hidden input', () => {
  const E = loadCoreAndConsole();
  assert.equal(Object.hasOwn(E.features, 'payment'), false);
  assert.doesNotMatch(E.eventTabs('participants'), /결제/);
  assert.equal(E.groupForPage('payments'), null);
  const html = E.views.settings();
  assert.match(html, /<input type="hidden" name="price" value="2500">/);
  assert.doesNotMatch(html, /참가비/);
});

test('legacy paid registration and payment deep links render no payment UI', () => {
  const { E } = loadAttendee('register', null, { features: ['payment'], workspace: { price: 2500 } });
  const registration = E.mobileRegister();
  assert.doesNotMatch(registration, /참가비|결제 흐름|simulate-payment|request-refund/);

  E.route.page = 'payment';
  const deepLink = E.views.attendee();
  assert.match(deepLink, /없는 페이지입니다/);
  assert.match(deepLink, /행사 홈/);
  assert.doesNotMatch(deepLink, /결제|환불|payment\.simulate|simulate-payment|request-refund/);
});

test('ticket payment-status gate remains while presenting neutral next steps', () => {
  const person = { id: 'person-paid-pending', ticket: 'bearer-code', name: '김가람', status: 'APPROVED', paymentStatus: 'PENDING' };
  const { E } = loadAttendee('ticket', person);
  const ticket = E.mobileTicket();
  assert.match(ticket, /티켓을 사용할 수 없습니다/);
  assert.match(ticket, /신청 정보 확인/);
  assert.doesNotMatch(ticket, /data-ticket=|결제|환불|payment/);
});

test('approved ticket puts event context before a functional QR and QR enlargement link', () => {
  const person = { id: 'person-1', ticket: 'bearer-code', name: '김가람', company: '지역모임', status: 'APPROVED', paymentStatus: 'FREE', inside: false, everIn: false };
  const { E } = loadAttendee('ticket', person);
  const html = E.mobileTicket();
  assert.ok(html.indexOf('2026-10-12') < html.indexOf('data-ticket="bearer-code"'));
  assert.ok(html.indexOf('서울 중구 세종대로 1') < html.indexOf('data-ticket="bearer-code"'));
  assert.match(html, /참가 확정/);
  assert.match(html, /QR 크게 보기/);
});

test('waitlisted attendee sees the event and pending state without a ticket QR', () => {
  const person = { id: 'person-2', ticket: 'bearer-code', name: '김가람', status: 'WAITLIST', paymentStatus: 'FREE' };
  const { E } = loadAttendee('ticket', person);
  const html = E.mobileTicket();
  assert.match(html, /가을 포럼/);
  assert.match(html, /대기 등록이 완료되었습니다/);
  assert.doesNotMatch(html, /data-ticket=/);
});

test('attendee view renders outside the simulated handheld shell and bottom app navigation', () => {
  const { E, classes } = loadAttendee('home');
  const html = E.views.attendee();
  assert.match(html, /class="mobile-app attendee-site/);
  assert.doesNotMatch(html, /class="app-nav"/);
  assert.equal(classes.has('handheld'), false);
});

test('scoped attendee presentation contains responsive browser-page layout rules', () => {
  const css = fs.readFileSync(path.join(root, 'assets/css/server-presentation.css'), 'utf8');
  assert.match(css, /body:has\(#app > \.attendee-site\)/);
  assert.match(css, /\.attendee-register-layout/);
  assert.match(css, /\.attendee-ticket-page \.ticket-card/);
  assert.match(css, /@media\s*\(max-width:\s*700px\)/);
});

test('five attendee header routes form balanced narrow rows and expose the current route', () => {
  const person = { id: 'person-1', ticket: 'bearer-code', name: '김가람', status: 'APPROVED' };
  const { E } = loadAttendee('home', person);
  const html = E.views.attendee();
  const nav = html.match(/<nav aria-label="행사 메뉴">([\s\S]*?)<\/nav>/)?.[1] || '';
  for (const route of ['home', 'schedule', 'notices', 'more', 'ticket']) {
    assert.match(nav, new RegExp(`href="#/event/browser-event/${route}"`));
  }
  assert.match(nav, /class="[^\"]*active[^\"]*"[^>]*aria-current="page"[^>]*>행사 홈<\/a>/);

  E.route.page = 'schedule';
  const scheduleNav = E.views.attendee().match(/<nav aria-label="행사 메뉴">([\s\S]*?)<\/nav>/)?.[1] || '';
  assert.match(scheduleNav, /class="[^\"]*active[^\"]*"[^>]*href="#\/event\/browser-event\/schedule" aria-current="page">일정<\/a>/);
  E.route.page = 'register';
  const focusedNav = E.views.attendee().match(/<nav aria-label="페이지 이동">([\s\S]*?)<\/nav>/)?.[1] || '';
  assert.match(focusedNav, /href="#\/event\/browser-event\/home" aria-current="page">행사 홈<\/a>/);
  assert.doesNotMatch(focusedNav, /내 티켓/);
  E.route.page = 'fullticket';
  const fullTicketNav = E.views.attendee().match(/<nav aria-label="페이지 이동">([\s\S]*?)<\/nav>/)?.[1] || '';
  assert.match(fullTicketNav, /href="#\/event\/browser-event\/home" aria-current="page">행사 홈<\/a>/);
  assert.doesNotMatch(fullTicketNav, /내 티켓/);

  const css = fs.readFileSync(path.join(root, 'assets/css/server-presentation.css'), 'utf8');
  assert.match(css, /\.attendee-site-header nav:has\(> a:nth-child\(5\)\)/);
  assert.match(css, /\.attendee-site-header nav:has\(> a:nth-child\(5\)\)[\s\S]*?grid-template-columns:\s*repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(css, /\.attendee-site-header nav:has\(> a:nth-child\(5\)\) a:nth-child\(4\)\s*\{[^}]*grid-column:\s*2\s*\/\s*span\s*2/s);
  assert.match(css, /\.attendee-site-header nav:has\(> a:nth-child\(5\)\) a:nth-child\(5\)\s*\{[^}]*grid-column:\s*4\s*\/\s*span\s*2/s);
  const activeRule = css.indexOf('.attendee-site-header nav a.active{');
  assert.ok(activeRule >= 0 && activeRule < css.indexOf('@media(max-width:700px)'), 'the visible active treatment applies at desktop widths too');
});

test('attendee child routes mark their parent destination while unknown routes stay unselected', () => {
  const { E } = loadAttendee('home', { id: 'person-1', ticket: 'bearer-code', name: '김가람', status: 'APPROVED' });
  const parentRoutes = {
    'program-detail': 'schedule', 'notice-detail': 'notices', info: 'more', venue: 'more', help: 'more',
    stamp: 'more', poll: 'more', quiz: 'more', qa: 'more', draw: 'more', survey: 'more', photo: 'more', board: 'more', rewards: 'more',
  };
  for (const [page, parent] of Object.entries(parentRoutes)) {
    E.route.page = page;
    const nav = E.views.attendee().match(/<nav aria-label="행사 메뉴">([\s\S]*?)<\/nav>/)?.[1] || '';
    const currentLinks = nav.match(/<a\b[^>]*aria-current="page"[^>]*>/g) || [];
    assert.equal(currentLinks.length, 1, `${page} should expose exactly one current destination`);
    assert.match(currentLinks[0], new RegExp(`href="#/event/browser-event/${parent}"`));
    assert.match(currentLinks[0], /class="[^"]*active[^"]*"/);
  }

  E.route.page = 'unknown';
  const unknownNav = E.views.attendee().match(/<nav aria-label="행사 메뉴">([\s\S]*?)<\/nav>/)?.[1] || '';
  assert.doesNotMatch(unknownNav, /aria-current="page"|class="[^"]*\bactive\b/);
});

test('organizer overview uses the shared panel, list-row, badge, empty-state and action-row treatments', () => {
  const source = fs.readFileSync(path.join(root, 'assets/js/experience.js'), 'utf8');
  const overview = source.match(/E\.views\.overview\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\};/)?.[1] || '';
  assert.ok(overview, 'the experience override remains the active overview implementation');
  assert.match(overview, /E\.head\(/);
  assert.match(overview, /E\.stats\(/);
  assert.match(overview, /E\.panel\(/);
  assert.match(overview, /class="list-item"/);
  assert.match(overview, /class="actions"/);
  assert.match(overview, /E\.badge\(/);
  assert.match(overview, /E\.empty\(/);
  assert.doesNotMatch(overview, /class="(?:task-row|quick-link|timeline-item)|class="context-summary|current-stage/);
});

const PHOTO_TICKET = `ET:browser-event:T-${'t'.repeat(40)}`;
test('attendee photo submission uploads through the public route in server mode', async () => {
  const uploaded = []; const submitted = [];
  const { E } = loadAttendee('photo', { id: 'p1', status: 'APPROVED', ticket: PHOTO_TICKET });
  E.previewMode = false; E.storageMode = 'server';
  E.remote = { uploadPublicFile: async (file, options) => { uploaded.push({ file, options }); return { fileId: 'file-1', name: file.name, type: file.type, size: file.size, width: 10, height: 10 }; } };
  E.run = async (name, payload) => { submitted.push({ name, payload }); return {}; };
  E.toast = () => {};
  const file = { name: 'photo.png', type: 'image/png', size: 10 };
  await E.forms['attendee-photo']({ caption: '사진 설명' }, { elements: { image: { files: [file] } } });
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].options.slug, 'browser-event');
  assert.equal(uploaded[0].options.commandId, 'photo-upload-fixed');
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{
    name: 'photo.submit',
    payload: { image: { fileId: 'file-1', name: 'photo.png', type: 'image/png', size: 10, width: 10, height: 10 }, caption: '사진 설명' },
  }]);
  assert.equal(E.dirty, true);
});
test('attendee photo submission keeps inline preview data in preview mode', async () => {
  const submitted = [];
  const { E } = loadAttendee('photo', { id: 'p1', status: 'APPROVED', ticket: PHOTO_TICKET });
  E.previewMode = true; E.storageMode = 'local';
  E.readImage = async () => ({ data: 'data:image/png;base64,AAAA', width: 4, height: 4 });
  E.run = async (name, payload) => { submitted.push({ name, payload }); return {}; };
  E.toast = () => {};
  await E.forms['attendee-photo']({ caption: '사진' }, { elements: { image: { files: [{ name: 'p.png', type: 'image/png', size: 10 }] } } });
  assert.equal(submitted[0].payload.image.data, 'data:image/png;base64,AAAA');
  assert.equal(E.dirty, true);
  await assert.rejects(E.forms['attendee-photo']({ caption: '사진' }, { elements: { image: { files: [] } } }), /사진을 선택/);
});
