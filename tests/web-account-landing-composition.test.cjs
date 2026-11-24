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
  // Reopened 2026-11-20 (shared gaps): the entry frame no longer repaints PRIMARY submits (one primary-action colour rule), but the
  // secondary submit keeps DESIGN.md's white bordered look (Astryx's own secondary is a translucent grey).
  assert.match(entry, /button\[data-product-variant="secondary"\]\[type="submit"\]\) \{[^}]*background:\s*var\(--paper\)/su, 'the retry stays secondary beside the one primary check');
  assert.doesNotMatch(entry, /button\[type="submit"\]\)[^{]*\{[^}]*(?:background|color):\s*var\(--(?:brand|on-brand)/su, 'no --brand repaint of submits');
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
  // Refreshed 2026-11-24: the header link is plain "로그인" (one shared /login), and the
  // contact address lives in lib/support-contact.ts (shown only after mount, see fce5422).
  for (const text of ['이메일로 도입 문의', '>로그인</Link>', 'href="/login"', '참가자 앱 설치 없음', '문자 발송 연결 확인', '고객사 포털 없음']) assert.ok(home.includes(text), `${text} stays`);
  assert.match(fs.readFileSync(path.join(app, '..', 'lib', 'support-contact.ts'), 'utf8'), /contact@eventouch\.co\.kr/u, 'the default contact address stays');
  assert.match(pages.invite, /팀 초대 수락/u);
  assert.match(pages.recover, /비밀번호 재설정/u);
});

test('the landing below the hero is interactive, honest and keeps the hero\'s ink identity', () => {
  const home = fs.readFileSync(path.join(app, 'page.tsx'), 'utf8');
  const sections = fs.readFileSync(path.join(app, 'landing-sections.module.css'), 'utf8');
  const flow = fs.readFileSync(path.join(app, 'LandingFlow.tsx'), 'utf8');
  // The persuasion path: one event in three moments, the attendee page you can try,
  // the old way against the new, who it fits, the result, the steps, the answers.
  for (const part of ['<LandingFlow', '<LandingPageDemo', '<LandingCompare', 'id="report"', 'id="faq"', 'id="contact"']) assert.ok(home.includes(part), `${part} stays`);
  // Totals nobody measured are not shown as a track record.
  assert.doesNotMatch(home, /320\+|86,000\+|누적 운영 행사/u);
  // Interactive parts are real controls with names and states, not pictures.
  assert.match(flow, /role="tablist"[\s\S]*?role="tab"[\s\S]*?aria-selected/u);
  assert.match(flow, /role="tabpanel"/u);
  assert.match(flow, /prefers-reduced-motion/u, 'the flow never advances for people who asked for less motion');
  const demo = fs.readFileSync(path.join(app, 'LandingPageDemo.tsx'), 'utf8');
  assert.match(demo, /role="radiogroup"[\s\S]*?role="radio"[\s\S]*?aria-checked/u);
  assert.match(demo, /실제 행사 데이터가 아닙니다/u, 'the attendee page sample says it is a sample');
  const compare = fs.readFileSync(path.join(app, 'LandingCompare.tsx'), 'utf8');
  assert.match(compare, /aria-pressed/u);
  // Reveal never hides content before script runs, and motion respects the preference.
  assert.match(sections, /\[data-reveal="pending"\]/u);
  assert.match(sections, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(sections, /@media print[\s\S]*?\[data-reveal\][\s\S]*?opacity: 1 !important/u);
  // The closing band is the hero's ink reversed, so the page starts and ends dark.
  assert.match(landing, /\.contactSection \{[^}]*background:\s*var\(--ink\)/su);
  // A phone does not keep a 160px sticky header over every screen.
  assert.match(landing, /@media \(max-width: 768px\) \{\s*\.header \{ position: static; \}/u);
});

test('phone landing previews stay readable: tall hero stage, no clipped offset shadow, one legible phone in the flow stage', () => {
  // Reopened 2026-11-25 (owner: 랜딩 가독성·모바일 제품 프리뷰). The dark hero identity and the three-tab preview are unchanged.
  const sections = fs.readFileSync(path.join(app, 'landing-sections.module.css'), 'utf8');
  assert.match(landing, /@media \(max-width: 768px\)[\s\S]*?\.consoleEvidence \{\s*box-shadow: 0 10px 30px var\(--shadow-color\);\s*\}[\s\S]*?\.heroMedia \{ --hero-stage-h: 600px; \}/u);
  assert.match(sections, /@media \(max-width: 560px\) \{\s*\.flow \{ --flow-stage-h: 520px; --k-duo: 0\.82; --k-pair: 0\.82; \}/u);
  assert.match(sections, /\.stageDuo \.window \{ display: none; \}/u);
  assert.match(sections, /\.stagePair \.phoneCrop:last-child \{ display: none; \}/u);
});
