'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const staffWork = read('apps/web/app/staff/StaffEventWork.tsx');
const staffStyles = read('apps/web/app/staff/staff-event-work.module.css');
const ticketView = read('apps/web/app/event/[slug]/ticket/TicketView.tsx');
const ticketStyles = read('apps/web/app/event/[slug]/ticket/ticket.module.css');
const homeLanding = read('apps/web/app/event/[slug]/home/AttendeeHomeLanding.tsx');
const homeStyles = read('apps/web/app/event/[slug]/home/home.module.css');

/*
 * A QR code is read by a phone camera, on a screen, in a room where nobody
 * knows a QR standard exists. The standard asks for four clear modules
 * around the symbol; without that quiet zone a camera has no clean edge to
 * lock onto and the scan simply fails. These tests pin that margin on every
 * code the product shows, and pin the one thing that can still cover it.
 */

test('every-shown-qr-carries-a-quiet-zone-margin', () => {
  // The booth QR: staff shows it, the participant scans it.
  assert.match(staffStyles, /\.boothQr\s*\{[^}]*padding:\s*var\(--s5\)/s);
  assert.match(staffStyles, /\.boothQr\s*\{[^}]*background:\s*var\(--paper\)/s);
  // The attendee ticket: the attendee shows it, staff scans it at the desk.
  assert.match(ticketStyles, /\.ticketQr\s*\{[^}]*padding:\s*var\(--s5\)/s);
  assert.match(ticketStyles, /\.ticketQr\s*\{[^}]*background:\s*var\(--paper\)/s);
  // The home prints no QR at all: the client keeps the simple entry list
  // because a QR is not handed to every participant. The code that is shown
  // at the desk lives on the ticket screen.
  assert.doesNotMatch(homeLanding, /QRCode/u);
  assert.doesNotMatch(homeStyles, /\.entryTicketQr\s*\{/u);
});

test('the-margin-covers-four-modules-of-the-densest-code', () => {
  // The densest code the product shows is a booth code: event id plus booth
  // id. At 200px and 37 modules a module is 5.41px, so the standard's four
  // modules need 21.6px. The spacing token used above is 24px.
  const qrcode = require(path.join(root, 'apps/web/node_modules/qrcode-generator'));
  const worst = `ET:BOOTH:event-${'x'.repeat(36)}:booth-${'y'.repeat(36)}`;
  const qr = qrcode(0, 'L');
  qr.addData(worst);
  qr.make();
  const modules = qr.getModuleCount();
  const needed = (4 * 200) / modules;
  assert.ok(modules >= 37, `expected a dense booth code, got ${modules} modules`);
  // --s5 is 24px in the token file.
  const tokens = read('apps/web/app/tokens.css');
  const s5 = Number(tokens.match(/--s5:\s*(\d+)px/)[1]);
  assert.ok(s5 >= needed, `quiet zone ${s5}px is below the ${needed.toFixed(1)}px four modules need`);
});

test('the-empty-scan-dock-never-floats-over-the-booth-qr', () => {
  // In the SELF booth task the staff shows a QR instead of scanning one, so
  // the dock has nothing in it. An empty sticky dock still floats over the
  // page and covers the QR the participant has to scan.
  // The dock is shown only when it holds something (the SELF booth task has no
  // scan form), and it folds away once a scan succeeded so the next action is
  // the result, not the old input.
  assert.match(staffWork, /const scanDockHasContent = activeTask === "desk" \|\| activeScope\.stampMode !== "SELF";/);
  assert.match(staffWork, /\{scanDockHasContent && result\.kind !== "ok" \? \(/);
  assert.match(staffWork, /<div className=\{prizeStyles\.scanDock\}>/);
});

test('the-booth-qr-scrolls-into-view-when-a-booth-is-picked', () => {
  // A participant scans the staff's screen: the code must be fully on
  // screen, not half under a bar or off the bottom.
  assert.match(staffWork, /const boothQrRef = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(staffWork, /node\.scrollIntoView\(\{ block: "center", behavior: "smooth" \}\);/);
  assert.match(staffWork, /ref=\{boothQrRef\}/);
});
