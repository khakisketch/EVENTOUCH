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
  // Reopened 2026-11-25 (hero 가안): the three tabs are gone; sign-in is a text link and the hero is one still scene.
  assert.match(landing, /\.loginLink \{ border: 0; background: transparent; color: var\(--paper\); text-decoration: underline;/u);
  assert.match(landing, /\.heroScene \{[^}]*position: relative;/su);
  assert.doesNotMatch(landing, /heroTabs/u);
  assert.match(landing, /@media \(min-width: 1025px\) \{ \.hero \{ overflow: visible; \} \}/u, 'the glow bleeds only where it cannot cause a sideways scroll');
  assert.match(landing, /@media print \{ \.header, \.hero \{ background: transparent/u, 'print keeps its plain frame');
});

test('flows, tokens and the contact rules are unchanged', () => {
  const home = fs.readFileSync(path.join(app, 'page.tsx'), 'utf8');
  // Refreshed 2026-11-24: the header link is plain "로그인" (one shared /login), and the
  // contact address lives in lib/support-contact.ts (shown only after mount, see fce5422).
  for (const text of ['이메일로 도입 문의', '>로그인</Link>', 'href="/login"', '참가자 앱 설치 없이 링크로 신청·티켓', '문자·알림톡은 발송 연결 후 실제 발송', '고객사 포털은 제공하지 않음']) assert.ok(home.includes(text), `${text} stays`);
  assert.match(fs.readFileSync(path.join(app, '..', 'lib', 'support-contact.ts'), 'utf8'), /contact@eventouch\.co\.kr/u, 'the default contact address stays');
  assert.match(pages.invite, /팀 초대 수락/u);
  assert.match(pages.recover, /비밀번호 재설정/u);
});

test('the landing below the hero is interactive, honest and keeps the hero\'s ink identity', () => {
  const home = fs.readFileSync(path.join(app, 'page.tsx'), 'utf8');
  const sections = fs.readFileSync(path.join(app, 'landing-sections.module.css'), 'utf8');
  const playSource = fs.readFileSync(path.join(app, 'LandingPlay.tsx'), 'utf8');
  // The persuasion path: the draw, the roulette and check-in you can try (2026-11-25), the attendee page you can try,
  // the old way against the new, who it fits, the result, the steps, the answers.
  for (const part of ['<LandingPlay', '<LandingPageDemo', '<LandingCompare', 'id="faq"', 'id="contact"']) assert.ok(home.includes(part), `${part} stays`);
  // Reopened 2026-11-25 (owner): the result report is not a differentiator, so its landing section is gone.
  assert.doesNotMatch(home, /id="report"|report-title|CountUp/u);
  // Totals nobody measured are not shown as a track record.
  assert.doesNotMatch(home, /320\+|86,000\+|누적 운영 행사/u);
  // Interactive parts are real controls with names and states, not pictures.
  // Reopened 2026-11-25 (owner: 직접 눌러 보는 방식): real buttons, announced results, and no motion for people who asked for less.
  assert.match(playSource, /<button type="button" className=\{styles\.drawButton\}/u);
  // The accessible name contains the visible "START" (WCAG 2.5.3, label in name).
  assert.match(playSource, /<button type="button" className=\{styles\.hub\}[^>]*"START · 룰렛 돌리기"/u);
  assert.equal((playSource.match(/role="status" aria-live="polite"/gu) || []).length, 2);
  assert.match(playSource, /prefers-reduced-motion/u);
  assert.doesNotMatch(playSource, /fetch\(|\/api\/|localStorage|sessionStorage/u, 'the demo stays in the browser');
  const demo = fs.readFileSync(path.join(app, 'LandingPageDemo.tsx'), 'utf8');
  assert.match(demo, /role="radiogroup"[\s\S]*?role="radio"[\s\S]*?aria-checked/u);
  // Reopened 2026-11-25 (owner): the visible "화면 구성 예시 · 합성 데이터" captions are gone from the landing; screen readers still get the
  // "구성 예시" in the drawings' aria-labels.
  assert.doesNotMatch(demo, /실제 행사 데이터가 아닙니다/u);
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

test('phone landing previews stay readable: hero scene fits a phone, the hands-on section stacks with one legible check-in phone', () => {
  // Reopened 2026-11-25 (owner: 랜딩 가독성·모바일 제품 프리뷰). The dark hero identity is unchanged.
  const sections = fs.readFileSync(path.join(app, 'landing-sections.module.css'), 'utf8');
  // Reopened 2026-11-25 (hero 가안): on a phone the hero is title, one line and the scene; the fixed bar is the only inquiry button.
  assert.match(landing, /@media \(max-width: 768px\)[\s\S]*?\.heroActions \{ display: none; \}[\s\S]*?\.heroScene \{ --k: 0\.6; height: 540px; \}/u);
  const play = fs.readFileSync(path.join(app, 'landing-play.module.css'), 'utf8');
  // Reopened 2026-11-25 (직접 눌러 보는 섹션): on phones one readable check-in phone, games stacked in one column.
  assert.match(play, /@media \(max-width: 1024px\) \{\s*\.games \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  assert.match(play, /\.phones \{ --k: 0\.82; \}\s*\.phone:first-child \{ display: none; \}/u);
  assert.match(play, /@media \(prefers-reduced-motion: reduce\) \{\s*\.rotor \{ transition: none; \}/u);
});
