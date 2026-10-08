'use strict';
// Console-facing records must not render rows for values the organizer has
// not filled in: the participant detail uses an explicit placeholder, and the
// report cover drops empty lines entirely.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRegistration(person) {
  const captured = {};
  const E = {
    esc: value => String(value ?? ''),
    button: (label, action, attrs = '', cls = '') => `<button data-action="${action}" class="${cls}">${label}</button>`,
    link: (label, href, cls = '') => `<a class="${cls}" href="${href}">${label}</a>`,
    field: () => '',
    select: () => '',
    register() {},
    views: {}, actions: {}, forms: {}, ui: { filters: {} },
    detail: rows => '<dl>' + rows.map(([label, value]) => '<dt>' + label + '</dt><dd>' + value + '</dd>').join('') + '</dl>',
    notice: text => '<div class="notice">' + text + '</div>',
    dialog: (title, body) => { captured.dialog = { title, body }; },
    work: () => ({ participants: [person], checks: [], fields: [] }),
    can: () => true,
    event: () => ({ id: 'event-1' }),
    date: value => String(value).slice(0, 10),
    registrationStates: { APPROVED: '참가 확정' },
    ticketURL: () => '#/ticket',
    copyLink: () => {},
  };
  const window = { ET: E, addEventListener() {}, location: { hash: '' } };
  const document = { addEventListener() {}, querySelector: () => null };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/registration.js'), 'utf8'), { window, document });
  return { E, captured };
}

function person(overrides = {}) {
  return Object.assign({
    id: 'person-1', name: '검증 참가자', company: '', phone: '01000000000', email: '',
    group: '일반', status: 'APPROVED', inside: false, everIn: false,
    createdAt: '2026-10-08T00:00:00.000Z', consent: null, paymentStatus: 'FREE', answers: {},
  }, overrides);
}

test('participant detail shows a placeholder instead of blank optional rows', () => {
  const { E, captured } = loadRegistration(person());
  E.actions['person-detail']({ id: 'person-1' });
  assert.match(captured.dialog.body, /<dt>소속<\/dt><dd>—<\/dd>/);
  assert.match(captured.dialog.body, /<dt>이메일<\/dt><dd>—<\/dd>/);
  assert.doesNotMatch(captured.dialog.body, /<dd><\/dd>/);
});

test('participant detail keeps provided optional values', () => {
  const { E, captured } = loadRegistration(person({ company: '검증 조직', email: 'person@example.test' }));
  E.actions['person-detail']({ id: 'person-1' });
  assert.match(captured.dialog.body, /<dt>소속<\/dt><dd>검증 조직<\/dd>/);
  assert.match(captured.dialog.body, /<dt>이메일<\/dt><dd>person@example\.test<\/dd>/);
});

function loadResults({ client = '', venue = '' } = {}) {
  const E = {
    esc: value => String(value ?? ''),
    button: () => '', link: () => '', field: () => '', select: () => '',
    register() {},
    views: {}, actions: {}, forms: {},
    detail: rows => '<dl>' + rows.map(([label, value]) => '<dt>' + label + '</dt><dd>' + value + '</dd>').join('') + '</dl>',
    stats: () => '', notice: text => '<div class="notice">' + text + '</div>',
    table: () => '', image: () => '',
    date: value => String(value).slice(0, 10),
    event: () => ({ id: 'event-1', name: '테스트 행사', date: '2026-11-15', start: '09:00', end: '17:00', clientId: 'client-1' }),
    state: { clients: [{ id: 'client-1', name: client }] },
    work: () => ({ venue: { name: venue }, participants: [], groups: [] }),
    metrics: () => ({}),
  };
  const window = { ET: E, addEventListener() {}, location: { hash: '' } };
  const document = { addEventListener() {}, querySelector: () => null };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/results.js'), 'utf8'), { window, document });
  return E;
}

function report({ client = '', venue = '' } = {}) {
  return {
    title: '테스트 보고서', color: '#123456', sections: [], summary: '',
    snapshot: {
      event: { name: '테스트 행사', date: '2026-11-15', start: '09:00', end: '17:00', venue, client },
      capturedAt: '2026-10-08T00:00:00.000Z', revision: 1,
      metrics: { total: 0, checked: 0, inside: 0, rate: 0 },
      groups: [], programs: [], booths: [], survey: [], photos: [],
    },
  };
}

test('report cover drops empty client and venue lines', () => {
  const html = loadResults().reportMarkup(report());
  assert.doesNotMatch(html, /<dt>고객사<\/dt>/);
  assert.doesNotMatch(html, /<dt>장소<\/dt>/);
  assert.match(html, /<dt>행사<\/dt><dd>테스트 행사<\/dd>/);
});

test('report cover keeps client and venue lines when provided', () => {
  const html = loadResults().reportMarkup(report({ client: '검증 고객사', venue: '테스트홀' }));
  assert.match(html, /<dt>고객사<\/dt><dd>검증 고객사<\/dd>/);
  assert.match(html, /<dt>장소<\/dt><dd>테스트홀<\/dd>/);
});
