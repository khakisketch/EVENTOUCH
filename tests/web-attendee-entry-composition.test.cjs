'use strict';

// Locks the attendee entry composition (DESIGN.md "참가 신청과 입장 티켓 확정
// 구성", mockup attendee-ticket-b2.html, "입장 패스 B"), reopened 2026-11-19:
// the ticket is a pass on the event's own ground that opens with the event's
// banner, its band carries the state and the name, the QR is the largest thing
// on it, and the application is a numbered sheet with its submit in reach.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '../apps/web/app/event/[slug]');
const read = (rel) => fs.readFileSync(path.join(app, rel), 'utf8');
const ticket = read('ticket/TicketView.tsx');
const ticketCss = read('ticket/ticket.module.css');
const ticketPage = read('ticket/page.tsx');
const register = read('register/RegisterForm.tsx');
const registerPage = read('register/page.tsx');
const eventTheme = read('event-theme.ts');
const bannerSource = read('EventBanner.tsx');
const bannerCss = read('event-banner.module.css');
const registerCss = read('register/register.module.css');
const eventPage = read('page.tsx');
const eventCss = read('public-event.module.css');
const recover = read('ticket/recover/RecoverForm.tsx');
const wakeLock = fs.readFileSync(path.join(__dirname, '../apps/web/lib/use-screen-wake-lock.ts'), 'utf8');

test('the ticket is a pass: banner, a band with state and name, then the QR, then the facts', () => {
  // Reopened 2026-11-19: the pass opens with the event's own banner.
  const banner = ticket.indexOf('<EventBanner theme={theme}');
  const band = ticket.indexOf('className={styles.ticketBand}');
  const qr = ticket.indexOf('className={styles.ticketQr}');
  // Reopened 2026-11-20: the next step is the BottomAction fixed to the bottom of the phone column.
  const actions = ticket.indexOf('primary={{ label: "참여 콘텐츠 보기"');
  assert.ok(banner > 0 && band > banner && qr > band && actions > qr, 'banner, band, QR, actions in that order');
  assert.ok(ticket.indexOf('{facts}', qr) > qr && ticket.indexOf('{facts}', qr) < actions, 'the facts sit between the QR and the actions');
  assert.match(ticket, /kicker=\{<h1>내 티켓<\/h1>\}/u, 'the heading stays for screen readers and audits');
  assert.match(ticket, /<EventFacts slug=\{slug\} context=\{state\.eventContext\} fallbackDate=\{state\.eventDate\} \/>/u);
  assert.match(ticket, /state\.inside \? "in" : "good"/u, 'an entered attendee reads blue');
  for (const tone of ['wait', 'bad', 'in']) {
    assert.match(ticketCss, new RegExp(`\\.ticketBand\\[data-tone="${tone}"\\]`), `${tone} band tone`);
    assert.match(ticketCss, new RegExp(`\\.ticketBand \\.ticketEntryState\\[data-tone="${tone}"\\]`), `${tone} state pill`);
  }
  assert.match(ticketCss, /\.ticketBand\s*\{[^}]*var\(--success-soft\)/su, 'confirmed is the default band');
  assert.match(ticketCss, /\.ticketBand \.ticketEntryState\s*\{[^}]*background:\s*var\(--success\)/su, 'the state is a solid pill');
});

test('the ticket page sits on the event ground and wears its published banner', () => {
  assert.match(ticketPage, /loadAttendeeTheme\(slug\)/u);
  assert.match(ticketPage, /style=\{attendeeGroundStyle\(theme\)\}/u);
  // Reopened 2026-11-20: the ground is the attendee surface's --ev-ground (the chosen color still rides --home-background-color).
  assert.match(ticketCss, /\.ticketPage:global\(\.site-page\)\s*\{[^}]*background:\s*var\(--ev-ground, var\(--home-background-color\)/su);
  assert.match(ticketPage, /<AttendeeSurface as="main"/u);
  assert.match(ticketCss, /\.tear i\s*\{[^}]*var\(--ev-ground, var\(--home-background-color\)/su, 'the stub notches are cut in the ground color');
  assert.match(eventTheme, /normalizeHomeStyle/u);
  assert.match(bannerSource, /bannerFillCss\(homeStyle\)/u);
  assert.match(bannerSource, /\/attendee-home-banner\.png/u);
  assert.match(bannerCss, /data-fill="image"\]::after/u, 'a picture gets a scrim under its text');
  assert.match(ticketCss, /@media print[\s\S]*\.ticketCard\.pass/u, 'a printed ticket stays the QR and the name on white');
});

test('the QR stays large and keeps its four-module quiet zone', () => {
  assert.match(ticketCss, /\.ticketQr\s*\{[^}]*width:\s*min\(100%,\s*340px\)/su);
  assert.match(ticketCss, /\.ticketQr\s*\{[^}]*padding:\s*var\(--s5\)/su);
  assert.match(ticketCss, /\.ticketQr\s*\{[^}]*background:\s*var\(--paper\)/su);
  assert.match(ticketCss, /\.ticketQr svg\s*\{[^}]*width:\s*100% !important/su);
});

test('the screen stays awake while the QR is shown and says to brighten it', () => {
  assert.match(ticket, /useScreenWakeLock\(showingQr\)/u);
  assert.match(wakeLock, /navigator\.wakeLock\.request\("screen"\)/u);
  assert.match(wakeLock, /visibilitychange/u, 'the lock is taken again after the tab returns');
  assert.match(ticket, /화면을 밝게 하면 더 잘 읽혀요/u);
});

test('the registration receipt is a one-time dark line, not a pass panel', () => {
  assert.match(ticketCss, /\.ticketSuccess\s*\{[^}]*background:\s*var\(--ink\)/su);
  assert.match(ticket, /\{state\.fresh \? \(/u, 'it still shows only for a fresh signup');
});

test('the way back is quiet; the next step is the one primary and the recheck is a utility', () => {
  assert.match(ticketPage, /styles\.returnLink/u);
  // Reopened 2026-11-19: with the QR in hand the content link is the primary;
  // the recheck is ghost. Without a QR the recheck is the primary.
  // Reopened 2026-11-20: the content link is alone in the BottomAction bar (a second button would make the bar taller
  // than the room under the QR on a 390x844 phone and cover its lower edge); the recheck is a ghost button in the page.
  assert.match(ticket, /<BottomAction label="다음 행동" primary=\{\{ label: "참여 콘텐츠 보기", href: `\/event\/\$\{encodeURIComponent\(slug\)\}\/engage` \}\} \/>/u);
  assert.doesNotMatch(ticket, /secondary=\{recheckAction\}/u, 'no second button in the bar over the QR');
  assert.match(ticket, /<EventBanner theme=\{theme\} title=\{state\.eventName\} kicker=\{<h1>내 티켓<\/h1>\} compact \/>/u, 'the short strip keeps the whole QR above the bar');
});

test('the application is a numbered sheet: banner, facts, sections, a sticky submit', () => {
  // Reopened 2026-11-19: step titles are visible and numbered; the outcome
  // heading is still read, not shown.
  assert.match(register, /<h2 className="sr-only">신청하면 어떻게 되나요<\/h2>/u, 'the outcome heading is read, not shown');
  assert.match(register, /<h2 className=\{styles\.stepTitle\}>참가자 정보<\/h2>/u);
  assert.match(registerCss, /\.stepTitle::before[\s\S]*?content:\s*counter\(step\)/u, 'each section title carries its step number');
  assert.match(registerPage, /<EventBanner theme=\{theme\} title=\{data\.name\} titleAs="h1"/u);
  assert.match(registerPage, /<EventFacts slug=\{slug\} context=\{data\.eventContext\} \/>/u);
  // Reopened 2026-11-20: a1 (white ground) or a2 (the event's color) from AttendeeSurface; a step bar and a BottomAction submit.
  assert.match(registerCss, /\.page:global\(\.registration-page\)\s*\{[^}]*background:\s*var\(--ev-ground, var\(--home-background-color\)/su);
  assert.match(registerPage, /<AttendeeSurface as="main"/u);
  assert.match(register, /<AttendeeStep className=\{styles\.step\} current=\{currentStep\} total=\{totalSteps\}/u, 'the sections are the steps, with a progress bar');
  assert.match(register, /<span className=\{styles\.req\}>/u);
  assert.match(registerCss, /\.stepSection :global\(\.form-field\) input:not\(\[type="checkbox"\]\)[\s\S]*?min-height:\s*calc\(var\(--s7\) \+ var\(--s2\)\)/u, 'large input fields (56px)');
  assert.match(registerCss, /\[aria-invalid="true"\]\s*\{[^}]*var\(--danger\)/su, 'only the field to fix turns red');
  // The submit is the BottomAction primary (fixed to the bottom of the column), still inside the form.
  assert.match(register, /<BottomAction[\s\S]*?label: submitting \? \(retryPending \? "신청 결과 확인 중입니다" : "신청 중입니다"\) : \(retryPending \? "신청 결과 다시 확인" : "신청하기"\),\s*type: "submit"/u, 'one strong submit');
  assert.doesNotMatch(registerCss, /\.submitBlock/u, 'the old sticky submit block is gone');
  assert.doesNotMatch(registerCss, /\.sheet\s*\{[^}]*overflow:\s*(?:hidden|clip)/su, 'no overflow clip on the sheet, or the submit bar stops sticking');
  assert.match(registerCss, /scroll-margin-block-end:\s*220px/u, 'a focused field keeps its error clear of the bar');
});

test('closed intake has one way forward: find my ticket becomes the primary', () => {
  // The registration card is the home's ticket-card slot: open intake offers
  // "참가 신청"; closed intake turns the same slot into "내 티켓 찾기" (or a quiet
  // closed note where recovery is unavailable), so there is still one way forward.
  assert.match(eventPage, /\{acceptingSignup \? \(\s*<GuideCard slot=\{!simple\} href=\{`\$\{guideHref\}\/register`\}/u);
  assert.match(eventPage, /: !recoveryBlocked \? \(\s*<GuideCard slot=\{!simple\} href=\{`\$\{guideHref\}\/ticket\/recover`\}/u);
  // Reopened 2026-11-20: the closed note is an AttendeeStateMessage; the stylesheet only places it.
  assert.match(eventPage, /<AttendeeStateMessage kind="info" title="현재 신청을 받지 않습니다\." className=\{styles\.closedCard\} \/>/u);
  assert.match(eventCss, /\.closedCard\s*\{[^}]*margin:/su);
});

test('finding a ticket again is one large field and one primary action', () => {
  assert.match(recover, /ticketStyles\.recover/u);
  assert.match(ticketCss, /\.recover input\s*\{[^}]*min-height:\s*56px/su);
  assert.match(ticketCss, /\.recover :global\(\.button-secondary\)\s*\{[^}]*background:\s*transparent/su);
});
