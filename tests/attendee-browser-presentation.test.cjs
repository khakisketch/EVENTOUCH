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
  notices: [], program: [], publishedFields: [
    { id: 'name', label: '이름', required: true, type: 'text' },
    { id: 'phone', label: '연락처', required: true, type: 'tel' },
    { id: 'company', label: '소속', required: false, type: 'text' },
  ],
  registrationOpen: true, publishedVersion: 'version-7',
  consentText: '이름과 연락처를 참가 신청 및 입장 확인에 사용합니다.',
  approvalRequired: false, price: 0, payments: [], desks: [],
};

function loadAttendee(page = 'home', person = null) {
  const classes = new Set();
  const E = {
    route: { scope: 'attendee', eventId: event.id, slug: event.slug, page, params: new URLSearchParams() },
    state: { events: [event] }, views: {}, forms: {}, actions: {}, ui: {},
    features: {}, registrationStates: { APPROVED: '참가 확정', PENDING: '확인 중' },
    event: () => event, work: () => workspace, person: () => person,
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
    mobileEngagement: () => '<p>module</p>',
  };
  E.button = E.button.bind(E);
  const document = { body: { classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: name => classes.has(name) } } };
  const window = { ET: E, ETQR: { encode: code => `<svg data-ticket="${code}"></svg>` } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/js/attendee.js'), 'utf8'), { window, document, URLSearchParams });
  return { E, classes };
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
