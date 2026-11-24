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
const loginCopySource = fs.readFileSync(path.join(app, 'login/login-copy.ts'), 'utf8');
const loginForm = fs.readFileSync(path.join(app, 'login/LoginForm.tsx'), 'utf8');
const authRedirect = fs.readFileSync(path.join(app, 'auth-redirect.ts'), 'utf8');
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
  // Reopened 2026-11-20 (shared gaps): the same primary rule on a dark face, as a token (the bright --brand fill with --on-brand ink).
  assert.match(css, /\.hubGo\s*\{[^}]*background:\s*var\(--action-primary-on-dark\)/su);
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
  // Reopened 2026-11-24 (owner: 스태프 진입 시 현장 문구): the labels come from login-copy, whose operator wording is unchanged.
  assert.match(loginPage, /aria-label=\{copy\.sectionLabel\}/u);
  assert.match(loginCopySource, /sectionLabel: "운영 로그인"/u);
  assert.match(loginCss, /\.auth-brand\) \{[^}]*background:\s*var\(--ink\)/su);
  assert.match(loginCss, /\.auth-card\) \{[^}]*border-radius:\s*28px 28px 0 0/su);
  assert.match(loginCss, /input \{[^}]*min-height:\s*56px/su);
  assert.match(loginCss, /p\[role="alert"\] \+ :global\(button\)/u, 'the error sits right above the submit');
});

// Reopened 2026-11-24 (owner: 스태프 진입 시 현장 문구): only a staff return destination changes the words.
function loginCopyModule() {
  const begin = authRedirect.indexOf('// __SAFE_NEXT_PATH_BEGIN__');
  const end = authRedirect.indexOf('// __SAFE_NEXT_PATH_END__');
  const safe = authRedirect.slice(begin, end).replace('export function', 'function');
  const copy = loginCopySource.replace(/^import .*$/mu, '').replace(/export type LoginCopy = \{[^}]*\};/u, '').replace(/export function/gu, 'function');
  const code = ts.transpileModule(`${safe}\n${copy}\nglobalThis.out = { loginCopy, returnNotice, isStaffReturn };`, { compilerOptions: { target: 'ES2020' } }).outputText;
  const sandbox = { RegExp };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.out;
}

test('a staff return destination switches the login to field words', () => {
  const { loginCopy, returnNotice } = loginCopyModule();
  for (const next of ['/staff', '/staff/events/abc']) {
    assert.deepEqual({ ...loginCopy(next) }, {
      sectionLabel: '스태프 로그인',
      bandLabel: '스태프 로그인',
      promise: '오늘 배정받은 입장 업무를 열어요.',
      title: '스태프 로그인',
    });
    assert.equal(returnNotice(next), '운영자에게 받은 이메일과 비밀번호로 로그인하면 내 업무가 열립니다.');
  }
});

test('every other entry keeps the operator login copy exactly', () => {
  const { loginCopy, returnNotice, isStaffReturn } = loginCopyModule();
  const operator = {
    sectionLabel: '운영 로그인',
    bandLabel: '운영 로그인',
    promise: '모집부터 결과까지, 행사 운영을 한곳에서.',
    title: '로그인',
  };
  // No next, console, event, and unsafe or look-alike staff values (open-redirect shapes, /staffx, the login loop).
  for (const next of [undefined, null, '', '/console', '/console/events', '/event/x', '/staffx', '//evil.example/staff', 'https://evil.example/staff', '/staff/login', '/api/staff', '\\staff', ' /login']) {
    assert.deepEqual({ ...loginCopy(next) }, operator, `operator copy for ${String(next)}`);
    assert.equal(returnNotice(next), '로그인하면 요청하신 화면으로 돌아갑니다.');
    assert.equal(isStaffReturn(next), false);
  }
});

test('the login page and form read the same decision, and the reset line stays', () => {
  assert.match(loginCopySource, /import \{ safeNextPath \} from "\.\.\/auth-redirect"/u, 'staff is judged by the existing safe return validation');
  assert.match(loginPage, /loginCopy\(rawNext\)/u);
  assert.match(loginForm, /returnNotice\(safeRequested\)/u);
  // The recovery flow is account-wide (server/account-recovery.js has no role check), so staff keep the same line and flow.
  assert.match(loginForm, /비밀번호를 잊으셨나요\?/u);
  assert.match(loginForm, /재설정 요청/u);
  assert.match(loginForm, /로그인이 만료되었습니다\./u, 'the session notice is untouched');
});
