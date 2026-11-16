'use strict';

// Locks the approved attendee entry composition (DESIGN.md "참가 신청과 입장
// 티켓 확정 구성", mockup attendee-ticket-b2.html, "입장 패스 B"): the ticket
// is a pass whose band carries the state and the name, the QR is the largest
// thing on it, and the form is a short sheet with its submit in reach.
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
const registerCss = read('register/register.module.css');
const eventPage = read('page.tsx');
const eventCss = read('public-event.module.css');
const recover = read('ticket/recover/RecoverForm.tsx');
const wakeLock = fs.readFileSync(path.join(__dirname, '../apps/web/lib/use-screen-wake-lock.ts'), 'utf8');

test('the ticket is a pass: a band with state and name, then the QR, then the event', () => {
  const band = ticket.indexOf('className={styles.ticketBand}');
  const qr = ticket.indexOf('className={styles.ticketQr}');
  const event = ticket.indexOf('className={styles.ticketEvent}');
  const actions = ticket.indexOf('className={styles.ticketActions}');
  assert.ok(band > 0 && qr > band && event > qr && actions > event, 'band, QR, event, actions in that order');
  assert.match(ticket, /<h1>내 티켓<\/h1>/u, 'the heading stays for screen readers and audits');
  assert.match(ticket, /state\.inside \? "in" : "good"/u, 'an entered attendee reads blue');
  for (const tone of ['wait', 'bad', 'in']) {
    assert.match(ticketCss, new RegExp(`\\.ticketBand\\[data-tone="${tone}"\\]`), `${tone} band tone`);
  }
  assert.match(ticketCss, /\.ticketBand\s*\{[^}]*var\(--success-soft\)/su, 'confirmed is the default band');
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

test('the way back is quiet and the secondary actions under the QR are utilities', () => {
  assert.match(ticketPage, /styles\.returnLink/u);
  assert.match(ticketCss, /\.ticketActions \.buttonSecondary\s*\{[^}]*background:\s*transparent/su);
});

test('the form is short: one lead line, quiet labels, large fields, a sticky submit', () => {
  assert.match(register, /<h2 className="sr-only">신청하면 어떻게 되나요<\/h2>/u, 'the outcome heading is read, not shown');
  assert.match(register, /<span className=\{styles\.req\}>/u);
  assert.match(registerCss, /\.stepSection :global\(\.form-field\) input:not\(\[type="checkbox"\]\)[\s\S]*?min-height:\s*52px/u);
  assert.match(registerCss, /\[aria-invalid="true"\]\s*\{[^}]*var\(--danger\)/su, 'only the field to fix turns red');
  assert.match(registerCss, /\.submitBlock\s*\{[^}]*position:\s*sticky/su);
  assert.doesNotMatch(registerCss, /\.submitBlock\s*\{[^}]*margin-inline:\s*calc\(/su, 'the bar must not bleed past the page and scroll sideways');
  assert.match(registerCss, /scroll-margin-block-end:\s*220px/u, 'a focused field keeps its error clear of the bar');
});

test('closed intake has one way forward: find my ticket becomes the primary', () => {
  assert.match(eventPage, /\{acceptingSignup \? \(/u);
  assert.match(eventPage, /acceptingSignup \? "button-secondary" : "button-primary"/u);
  assert.match(eventCss, /\.registrationClosed\s*\{[^}]*background:\s*var\(--surface-muted\)/su);
});

test('finding a ticket again is one large field and one primary action', () => {
  assert.match(recover, /ticketStyles\.recover/u);
  assert.match(ticketCss, /\.recover input\s*\{[^}]*min-height:\s*56px/su);
  assert.match(ticketCss, /\.recover :global\(\.button-secondary\)\s*\{[^}]*background:\s*transparent/su);
});
