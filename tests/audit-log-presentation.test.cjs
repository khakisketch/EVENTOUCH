'use strict';

// The activity log is an operator-facing record, not a developer console. A
// previous version printed the raw command key (desk.set-open, reward.fulfill)
// as the visible cell text, which design system section 4 forbids. These tests
// pin the Korean label, the fallback for an unknown command, and the fact that
// the raw key stays available to support without being the visible text.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAudit(entries) {
  const E = {
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    register() {}, views: {}, actions: {}, forms: {}, ui: { filters: {} },
    work: () => ({ audit: entries }),
    state: { accounts: [{ id: 'acc-1', name: '운영 담당자' }] },
    event: () => ({ id: 'event-1', features: [], slug: 'demo' }),
    features: {},
    route: { page: 'audit', scope: 'console' },
    consoleURL: (page) => `#/console/events/event-1/${page}`,
    tabs: () => '',
    head: (title, desc) => `<header>${title}|${desc}</header>`,
    eventTabs: () => '',
    panel: (title, body) => `<section class="panel"><h2>${title}</h2>${body}</section>`,
    empty: (title, desc) => `<div class="empty">${title}|${desc}</div>`,
    table: (heads, rows) => `<table><thead>${heads.join(',')}</thead><tbody>${rows.join('')}</tbody></table>`,
    date: (value) => String(value).slice(0, 16),
  };
  const window = { ET: E, addEventListener() {} };
  const document = { addEventListener() {}, querySelector: () => null, body: { classList: { toggle() {} } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets/js/console.js'), 'utf8'), { window, document });
  return E.views.audit();
}

test('the-activity-log-shows-a-korean-label-and-keeps-the-command-in-the-title', () => {
  const html = loadAudit([
    { id: 'cmd-1', type: 'desk.set-open', actor: 'acc-1', at: '2026-10-13T05:10:00.000Z', detail: '등록 데스크 · 열기' },
    { id: 'cmd-2', type: 'reward.fulfill', actor: 'acc-1', at: '2026-10-13T05:08:00.000Z', detail: '' },
  ]);
  assert.match(html, /데스크 열기·닫기/);
  assert.match(html, /경품 지급 처리/);
  assert.match(html, /title="desk\.set-open"/);
  assert.match(html, /title="reward\.fulfill"/);
  // The raw key must not be the visible cell text.
  assert.doesNotMatch(html, />desk\.set-open</);
  assert.doesNotMatch(html, />reward\.fulfill</);
  assert.match(html, /운영 담당자/);
  assert.match(html, /—/, 'empty detail still renders the placeholder');
});

test('an-unknown-command-falls-back-to-its-raw-key-instead-of-disappearing', () => {
  const html = loadAudit([{ id: 'cmd-3', type: 'future.command', actor: 'acc-1', at: '2026-10-13T05:00:00.000Z', detail: 'x' }]);
  assert.match(html, /future\.command/);
});

test('an-empty-log-explains-itself-instead-of-rendering-an-empty-table', () => {
  const html = loadAudit([]);
  assert.match(html, /활동 기록이 없습니다/);
  assert.doesNotMatch(html, /<table>/);
});
