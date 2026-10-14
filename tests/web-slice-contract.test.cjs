'use strict';

// Slice-1 contract for apps/web: the browser talks to the new app's own
// origin under /api/* only, and the public event page reads the existing
// public projection. These are static source assertions on purpose: they pin
// the migration seam without booting Next.js inside the suite. Live rendering
// of the slice is verified against the demo servers outside the suite
// (evidence under /tmp/opencode/eventouch-captures/web-slice1-*.png).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

test('web-proxy-keeps-the-same-origin-api-contract', () => {
  const config = read('next.config.ts');
  assert.match(config, /source:\s*"\/api\/:path\*"/);
  assert.match(config, /destination:.*\/api\/:path\*/);
  assert.match(config, /EVENTOUCH_API_URL/);
  assert.doesNotMatch(config, /http:\/\/127\.0\.0\.1:8776\/[^a]/);
});

test('web-event-page-reads-the-public-projection-and-handles-unknown-slugs', () => {
  const page = read('app/event/[slug]/page.tsx');
  assert.match(page, /\/api\/public\/events\//);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /cache:\s*"no-store"/);
  assert.doesNotMatch(page, /\/api\/events\/\$\{/);
});

test('web-slice-does-not-take-over-writes', () => {
  const sources = ['app/page.tsx', 'app/event/[slug]/page.tsx', 'app/event/[slug]/not-found.tsx']
    .map(read)
    .join('\n');
  assert.doesNotMatch(sources, /method:\s*"POST"/i);
  assert.doesNotMatch(sources, /\/commands/);
});

test('web-registration-posts-to-the-public-signup-contract', () => {
  const form = read('app/event/[slug]/register/RegisterForm.tsx');
  assert.match(form, /\/api\/events\/.*\/signup/);
  assert.match(form, /formVersion/);
  assert.match(form, /commandId/);
  assert.match(form, /consent/);
  const page = read('app/event/[slug]/register/page.tsx');
  assert.match(page, /registrationOpen/);
  assert.match(page, /publishedVersion/);
});

test('web-ticket-keeps-the-bearer-out-of-history-and-persistent-storage', () => {
  const view = read('app/event/[slug]/ticket/TicketView.tsx');
  assert.match(view, /authorization:\s*`Bearer /);
  assert.match(view, /history\.replaceState/);
  // The bearer survives a venue refresh in the tab session only; it must
  // never land in persistent storage or outlive the tab.
  assert.match(view, /sessionStorage/);
  assert.doesNotMatch(view, /localStorage/);
  // The QR encodes the same raw token the staff scanners accept.
  assert.match(view, /<QRCode value=\{[^}]*ticket[^}]*\}/);
});

test('web-staff-uses-session-bootstrap-and-server-checked-commands', () => {
  const login = read('app/staff/login/StaffLoginForm.tsx');
  assert.match(login, /\/api\/auth\/login/);
  assert.doesNotMatch(login, /localStorage/);
  assert.doesNotMatch(login, /sessionStorage/);
  const console_ = read('app/staff/StaffConsole.tsx');
  assert.match(console_, /\/api\/bootstrap/);
  assert.match(console_, /\/commands/);
  assert.match(console_, /check\.scan/);
  assert.match(console_, /assignmentId/);
  // No ticket bearer may be persisted on the device.
  assert.doesNotMatch(console_, /localStorage/);
  assert.doesNotMatch(console_, /sessionStorage/);
});

test('web-camera-scan-degrades-to-manual-entry-without-a-camera', () => {
  const scanner = read('app/staff/CameraScan.tsx');
  // Guarded access: never crash where getUserMedia is missing or denied.
  assert.match(scanner, /navigator\.mediaDevices/);
  assert.match(scanner, /getUserMedia/);
  assert.match(scanner, /직접 입력/);
  // Decoded strings go through the same server-checked submit, never a
  // local decision.
  assert.match(scanner, /onDetected/);
  assert.doesNotMatch(scanner, /fetch\(/);
  const console_ = read('app/staff/StaffConsole.tsx');
  assert.match(console_, /CameraScan/);
  assert.match(console_, /submitTicket\(code\)/);
});

test('web-display-polls-public-content-and-never-blanks-on-a-drop', () => {
  const board = read('app/screen/[slug]/DisplayBoard.tsx');
  assert.match(board, /\/api\/public\/events\//);
  assert.match(board, /setInterval/);
  assert.match(board, /5000/);
  // A failed poll keeps the last good frame; only the first load may fail.
  assert.match(board, /prev\.kind === "ready"/);
  assert.doesNotMatch(board, /localStorage/);
  assert.doesNotMatch(board, /sessionStorage/);
});

test('web-console-reads-operator-bootstrap-and-writes-nothing-yet', () => {
  const login = read('app/staff/login/StaffLoginForm.tsx');
  assert.match(login, /\/staff/);
  assert.match(login, /\/console/);
  for (const file of ['app/console/ConsoleHome.tsx', 'app/console/events/[id]/EventOverview.tsx']) {
    const source = read(file);
    assert.match(source, /\/api\/bootstrap/);
    assert.doesNotMatch(source, /method:\s*"POST"/i);
    assert.doesNotMatch(source, /\/commands/);
    assert.doesNotMatch(source, /localStorage/);
    assert.doesNotMatch(source, /sessionStorage/);
  }
});

test('web-participant-status-goes-through-the-operator-command-path', () => {
  const list = read('app/console/events/[id]/participants/ParticipantList.tsx');
  assert.match(list, /participant\.status/);
  assert.match(list, /\/commands/);
  assert.match(list, /assignmentId|membership|canManage/);
  assert.doesNotMatch(list, /localStorage/);
  assert.doesNotMatch(list, /sessionStorage/);
});

test('web-messaging-uses-operator-commands-and-keeps-ticket-bearers-out-of-history', () => {
  const messaging = read('app/console/events/[id]/messages/MessagingWorkspace.tsx');
  assert.match(messaging, /template\.save/);
  assert.match(messaging, /message\.create/);
  assert.match(messaging, /message\.retry/);
  assert.match(messaging, /message\.sync/);
  assert.match(messaging, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/);
  assert.match(messaging, /workspaces/);
  assert.match(messaging, /deliveries/);
  assert.match(messaging, /messageStatusLabel/);
  assert.match(messaging, /deliveryStatusLabel/);
  assert.match(messaging, /data\?\.field/);
  assert.match(messaging, /window\.confirm/);
  assert.doesNotMatch(messaging, /localStorage/);
  assert.doesNotMatch(messaging, /sessionStorage/);
  assert.doesNotMatch(messaging, /recipientSnapshot|ticketToken|Bearer /);
});

test('web-console-shell-keeps-decided-navigation-and-clients-read-only', () => {
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /행사/);
  assert.match(shell, /고객사/);
  assert.match(shell, /nav/i);
  const clients = read('app/console/clients/ClientsList.tsx');
  assert.match(clients, /\/api\/bootstrap/);
  assert.doesNotMatch(clients, /method:\s*"POST"/i);
  assert.doesNotMatch(clients, /\/commands/);
});

test('web-retry-keeps-one-command-id-per-attempt-on-signup-and-scan', () => {
  // A lost response must replay the same request id, or the retry becomes a
  // second registration / a confusing duplicate scan.
  const register = read('app/event/[slug]/register/RegisterForm.tsx');
  assert.match(register, /commandIdRef\.current/);
  assert.match(register, /useRef<string \| null>/);
  const staff = read('app/staff/StaffConsole.tsx');
  assert.match(staff, /pendingScanIdRef\.current/);
  assert.match(staff, /useRef<string \| null>/);
});
