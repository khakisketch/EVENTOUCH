'use strict';

// Locks the approved account screens and the landing hero (DESIGN.md "계정·첫
// 화면 확정 구성", mockup account-landing-options.html): the login's dark band
// over a white sheet is the shared frame of the account screens, and the
// landing's header and hero share one ink band. Flows and copy do not change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '../apps/web/app');
const entry = fs.readFileSync(path.join(app, 'auth-entry.module.css'), 'utf8');
const landing = fs.readFileSync(path.join(app, 'landing.module.css'), 'utf8');
const pages = {
  recover: fs.readFileSync(path.join(app, 'recover/page.tsx'), 'utf8'),
  email: fs.readFileSync(path.join(app, 'account/email/page.tsx'), 'utf8'),
  invite: fs.readFileSync(path.join(app, 'invite/[token]/page.tsx'), 'utf8'),
};

test('the account screens share the login\'s band and sheet through the one entry frame', () => {
  for (const [name, source] of Object.entries(pages)) assert.match(source, /styles\.entry/u, `${name} opts into the shared frame`);
  assert.match(entry, /\.auth-brand\) \{[^}]*background:\s*var\(--ink\)/su);
  assert.match(entry, /\.auth-card\) \{[^}]*border-radius:\s*28px 28px 0 0/su);
  assert.match(entry, /\.wordmark\)::first-letter \{ color: var\(--brand\)/u, 'the orange E');
  assert.match(entry, /input,\s*\n?\.entry[^{]*registration-form\) input \{ min-height: 56px/su, 'fields are 56px');
});

test('a secondary submit in an uncertain flow reads the button variant, not a class ProductButton strips', () => {
  const button = fs.readFileSync(path.join(app, 'ui/ProductButton.tsx'), 'utf8');
  assert.match(button, /"data-product-variant": resolvedVariant/u, 'the resolved variant reaches the DOM');
  assert.doesNotMatch(entry, /button\.button-secondary/u, 'the legacy class never reaches the DOM, so a rule on it never matches');
  assert.match(entry, /a:not\(\.button, \[data-action-variant\]\)/u, 'an action-styled link (ProductLink) keeps its own rank beside the boxed text links');
  assert.doesNotMatch(entry, /a:not\(\.button\)/u);
  assert.match(entry, /button\[data-product-variant="secondary"\]\[type="submit"\]\) \{[^}]*background:\s*var\(--paper\)/su, 'the retry stays secondary beside the one orange check');
});

test('only an error that leads into a submit is docked with it', () => {
  assert.match(entry, /p\[role="alert"\]:has\(\+ :global\(button\)\)[^{]*\{ margin-top: auto; \}/u);
  assert.doesNotMatch(entry, /p\[role="alert"\] \{[^}]*margin: auto 0 0/su, 'a lone notice must not be pushed to the bottom');
});

test('the landing header and hero are one full-width ink band', () => {
  assert.match(landing, /\.header,\s*\n\.hero \{[^}]*background:\s*var\(--ink\)[^}]*box-shadow:\s*0 0 0 100vmax var\(--ink\)[^}]*clip-path:\s*inset\(0 -100vmax\)/su);
  assert.match(landing, /\.brandName::first-letter \{ color: var\(--brand\)/u);
  assert.match(landing, /\.heroTabs button\[aria-selected="true"\] \{[^}]*background:\s*var\(--paper\)/su);
  assert.match(landing, /@media \(min-width: 1025px\) \{ \.hero \{ overflow: visible; \} \}/u, 'the glow bleeds only where it cannot cause a sideways scroll');
  assert.match(landing, /@media print \{ \.header, \.hero \{ background: transparent/u, 'print keeps its plain frame');
});

test('flows, tokens and the contact rules are unchanged', () => {
  const home = fs.readFileSync(path.join(app, 'page.tsx'), 'utf8');
  for (const text of ['이메일로 도입 문의', '운영자·스태프 로그인', 'contact@eventouch.co.kr', '참가자 앱 설치 없음', '문자 발송 연결 확인', '고객사 포털 없음']) assert.ok(home.includes(text), `${text} stays`);
  assert.match(pages.invite, /팀 초대 수락/u);
  assert.match(pages.recover, /비밀번호 재설정/u);
});
