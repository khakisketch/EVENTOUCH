'use strict';
// The display idle stage must not render separators for lines the operator
// has not filled in (date kept, empty venue dropped, and the reverse).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load({ venue = '', date = '2026-11-15', name = '테스트 행사', display, notices = [] } = {}) {
  const event = { id: 'event-1', name, date, features: ['screen'] };
  const workspace = {
    venue: { name: venue },
    display: display || { type: 'idle', moduleId: null, noticeId: null, at: null },
    modules: [], notices, questions: [], photos: [], branding: {},
  };
  const E = {
    esc: value => String(value ?? ''),
    button: (label, action) => `<button data-action="${action}">${label}</button>`,
    link: (label, href) => `<a href="${href}">${label}</a>`,
    select: () => '',
    register() {},
    views: {}, forms: {}, actions: {},
    copy: value => JSON.parse(JSON.stringify(value)),
    image: (image, alt) => `<img alt="${alt}">`,
    event: () => event,
    work: () => workspace,
    route: { eventId: event.id },
    state: { workspaces: { [event.id]: workspace } },
  };
  const window = { ET: E, addEventListener() {}, location: { hash: '' } };
  const document = { addEventListener() {}, querySelector: () => null };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/display.js'), 'utf8'), { window, document });
  return E;
}

test('idle display drops the separator when the venue is empty', () => {
  const html = load({ venue: '' }).views.display();
  assert.match(html, /테스트 행사/);
  assert.match(html, /2026-11-15/);
  assert.doesNotMatch(html, /2026-11-15\s*·/);
  assert.doesNotMatch(html, /·\s*<\/p>/);
});

test('idle display keeps the venue when the operator has set one', () => {
  const html = load({ venue: '테스트홀' }).views.display();
  assert.match(html, /2026-11-15 · 테스트홀/);
});

test('idle display omits the meta line entirely when nothing is set', () => {
  const html = load({ date: '', venue: '' }).views.display();
  assert.match(html, /잠시 후 시작합니다/);
  assert.doesNotMatch(html, /<p>\s*·?\s*<\/p>/);
});
