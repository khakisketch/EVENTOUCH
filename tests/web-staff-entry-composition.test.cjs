'use strict';

// Locks the approved staff hub and login (DESIGN.md "스태프 목록과 로그인 확정
// 구성", mockup staff-entry-a3.html + staff-entry-a2.html): the hub is the same
// dark column as the field screen with one live card; the login is a dark band
// over a white sheet. Routing, copy and recovery behavior do not change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = path.join(__dirname, '../apps/web/app');
const hub = fs.readFileSync(path.join(app, 'staff/StaffHub.tsx'), 'utf8');
const scope = fs.readFileSync(path.join(app, 'staff/staff-scope.ts'), 'utf8');
const css = fs.readFileSync(path.join(app, 'staff/staff-event-work.module.css'), 'utf8');
const menuCss = fs.readFileSync(path.join(app, 'staff/staff-account-menu.module.css'), 'utf8');
const page = fs.readFileSync(path.join(app, 'staff/page.tsx'), 'utf8');
const loginPage = fs.readFileSync(path.join(app, 'login/page.tsx'), 'utf8');
const loginCss = fs.readFileSync(path.join(app, 'login/login-entry.module.css'), 'utf8');
const ts = require(path.join(__dirname, '../apps/web/node_modules/typescript'));

function helpers() {
  const start = scope.indexOf('// List line under an event');
  const code = ts.transpileModule(`type StaffScope = any;\n${scope.slice(start).replace(/export function/g, 'function')}\nglobalThis.out = { staffScopeLine, staffHubGroups, staffStartLabel };`, { compilerOptions: { target: 'ES2020' } }).outputText;
  const sandbox = { Date, Math, Number, RegExp };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.out;
}

test('the hub is the field screen\'s dark column with the live event as one card', () => {
  assert.match(page, /workStyles\.hubPage/u);
  assert.match(css, /\.hubPage\s*\{[^}]*background:\s*var\(--ink\)/su);
  assert.match(hub, /staffHubGroups\(state\.scopes\)/u);
  assert.match(hub, /className=\{workStyles\.hubGo\}/u, 'the live card holds the one orange action');
  assert.match(css, /\.hubGo\s*\{[^}]*background:\s*var\(--brand\)/su);
  assert.match(css, /\.hubPage :global\(\.staff-workspace\)\s*\{[^}]*background:\s*transparent/su, 'the shared white workspace must not cover the ink');
  assert.match(page, /<h1>내 업무<\/h1>/u, 'the page heading stays for assistive technology');
});

test('the list shows kind and count, never desk or booth names', () => {
  assert.match(hub, /staffScopeLine\(/u);
  assert.doesNotMatch(hub, /staffScopeSummary/u);
  const { staffScopeLine } = helpers();
  assert.equal(staffScopeLine({ desks: [{}, {}], booths: [] }), '데스크 2곳');
  assert.equal(staffScopeLine({ desks: [], booths: [{}, {}, {}] }), '부스 3곳');
  assert.equal(staffScopeLine({ desks: [{}], booths: [{}] }), '데스크 1곳 · 부스 1곳');
  assert.equal(staffScopeLine({ desks: [], booths: [] }), '배정 업무');
});

test('only a LIVE event becomes the card, and the rest keep their order', () => {
  const { staffHubGroups } = helpers();
  const a = { stage: 'READY', id: 'a' }, b = { stage: 'LIVE', id: 'b' }, c = { stage: 'LIVE', id: 'c' };
  const grouped = staffHubGroups([a, b, c]);
  assert.equal(grouped.live.id, 'b');
  assert.deepEqual(grouped.rest.map((item) => item.id), ['a', 'c']);
  assert.equal(staffHubGroups([a]).live, null);
});

test('start labels are day-level: today, tomorrow, then the date', () => {
  const { staffStartLabel } = helpers();
  const now = new Date(2027, 0, 16, 8, 0);
  assert.equal(staffStartLabel({ date: '2027-01-16', start: '09:00' }, now), '09:00 시작');
  assert.equal(staffStartLabel({ date: '2027-01-17', start: '10:00' }, now), '내일 10:00 시작');
  assert.equal(staffStartLabel({ date: '2027-12-20', start: '09:30' }, now), '12.20 09:30 시작');
  assert.equal(staffStartLabel({ date: '', start: '09:30' }, now), '09:30 시작');
  assert.equal(staffStartLabel({ date: '2027-01-16', start: '' }, now), '');
});

test('routing, empty and failure copy, and the organization notice are unchanged', () => {
  for (const text of ['shouldAutoRouteStaffHub', '배정된 업무가 없습니다. 운영자에게 문의하세요.', '다시 불러오기', 'OrganizationContextNotice', 'orgLineText()', '다른 탭에서 조직이 전환됐습니다']) {
    assert.ok(hub.includes(text), `${text} stays`);
  }
  assert.match(menuCss, /\.accountMenu\[data-tone="dark"\]/u);
});

test('the login is a dark band over a white sheet, on the existing markup', () => {
  assert.match(loginPage, /styles\.stage/u);
  assert.match(loginPage, /className="auth-brand"/u);
  assert.match(loginPage, /aria-label="운영 로그인"/u);
  assert.match(loginCss, /\.auth-brand\) \{[^}]*background:\s*var\(--ink\)/su);
  assert.match(loginCss, /\.auth-card\) \{[^}]*border-radius:\s*28px 28px 0 0/su);
  assert.match(loginCss, /input \{[^}]*min-height:\s*56px/su);
  assert.match(loginCss, /p\[role="alert"\] \+ :global\(button\)/u, 'the error sits right above the submit');
});
