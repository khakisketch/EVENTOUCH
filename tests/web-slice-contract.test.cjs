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
  // An unusable ticket never reads as confirmed; a transient lookup failure
  // retries with the stored bearer instead of dead-ending.
  assert.match(view, /결제 확인 필요/);
  assert.match(view, /setReloadTick/);
  // Entry tone follows usability, and the failure is announced.
  assert.match(view, /data-tone/);
  assert.match(view, /<p role="alert">/);
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

test('web-console-home-reads-bootstrap-before-any-write-paths', () => {
  const login = read('app/staff/login/StaffLoginForm.tsx');
  assert.match(login, /\/staff/);
  assert.match(login, /\/console/);
  // No public signup by design: accounts are invitation-only, and a
  // forgotten password goes through the organization owner.
  assert.match(login, /조직 관리자에게 재설정을 요청/);
  const home = read('app/console/ConsoleHome.tsx');
  assert.match(home, /\/api\/bootstrap/);
  assert.doesNotMatch(home, /localStorage/);
  assert.doesNotMatch(home, /sessionStorage/);
  // Event creation is the only write on the home and goes through the
  // idempotent organisation endpoint via the dialog.
  const dialog = read('app/console/CreateEventDialog.tsx');
  assert.match(dialog, /\/api\/events/);
  assert.match(dialog, /commandId/);
  assert.doesNotMatch(dialog, /localStorage/);
  assert.doesNotMatch(dialog, /sessionStorage/);
  const overview = read('app/console/events/[id]/EventOverview.tsx');
  assert.doesNotMatch(overview, /localStorage/);
  assert.doesNotMatch(overview, /sessionStorage/);
});

test('web-console-home-is-a-card-grid-with-a-calendar-date-filter', () => {
  const home = read('app/console/ConsoleHome.tsx');
  assert.doesNotMatch(home, /먼저 확인/);
  // The header is one heading plus the create trigger; the schedule order
  // needs no visible explainer above the filters.
  assert.doesNotMatch(home, /오늘과 가까운 일정부터/);
  assert.match(home, /<h1>행사<\/h1>/);
  // One visible heading only; the result count is a screen-reader live
  // region instead of a second visible total next to the filter counts.
  assert.doesNotMatch(home, /aria-live/);
  assert.match(home, /className="sr-only" role="status"/);
  assert.match(home, /date: typeof event\.date/);
  assert.match(home, /start: typeof event\.start/);
  assert.match(home, /event\.date > todayKey/);
  assert.match(home, /eventRecency/);
  // No full-width rows: events render as cards in a capped grid, and the
  // calendar only filters those same cards by date.
  assert.doesNotMatch(home, /eventRow/);
  assert.match(home, /className=\{styles\.eventGrid\}/);
  assert.match(home, /className=\{styles\.eventCard/);
  assert.match(home, /styles\.dayCell/);
  assert.match(home, /selectedDate/);
  assert.match(home, /nextAction/);
  // Empty stage filters stay out of the way; archived events remain
  // reachable through the always-visible total.
  assert.match(home, /counts\[item\.id\] > 0/);
  assert.match(home, /승인 처리하기/);
  assert.match(home, /일정 미정/);
  // A recoverable connection failure restores shell navigation with the list.
  assert.match(home, /eventouch:shell-reload/);
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /eventouch:shell-reload/);
  assert.doesNotMatch(shell, /aria-disabled/);
  // One wordmark, one heading, one name: no breadcrumb bar, tagline,
  // footer line, or two-line operator identity competing above the work.
  assert.doesNotMatch(shell, /topbarLabel/);
  assert.doesNotMatch(shell, /console-topbar/);
  assert.doesNotMatch(shell, /console-footer/);
  assert.doesNotMatch(shell, /console-tagline/);
  assert.doesNotMatch(shell, /<small>\{roleLabel\}<\/small>/);
  assert.match(home, /aria-pressed=\{filter === item\.id\}/);
  for (const label of ['전체', '준비 중', '진행 중', '종료·보관']) {
    assert.match(home, new RegExp(label));
  }
  assert.match(home, /className=\{styles\.eventDate\}/);
  assert.match(home, /className=\{styles\.eventStatus\}/);
  assert.match(home, /pending: counts\.pending/);
  assert.match(home, /inside: counts\.inside/);
  assert.doesNotMatch(home, /localStorage/);
  assert.doesNotMatch(home, /sessionStorage/);
  // The create dialog is a real modal again: styled, focus-trapped,
  // Escape-dismissed, with focus returned to the trigger.
  const dialog = read('app/console/CreateEventDialog.tsx');
  assert.match(dialog, /nameRef\.current\?\.focus/);
  assert.match(dialog, /Escape/);
  assert.match(dialog, /previouslyFocused/);
  // Escape/backdrop never fake-cancel an in-flight write.
  assert.match(dialog, /submittingRef/);
  const css = read('app/console/console-home.module.css');
  assert.match(css, /\.dialogBackdrop/);
  assert.match(css, /\.dialogActions/);
  assert.match(css, /\.eventRecency/);
  assert.match(css, /\.eventGrid/);
  assert.match(css, /\.dayCell/);
  assert.doesNotMatch(css, /\.eventRow/);
  assert.doesNotMatch(css, /min-height: 40px/);
});

test('web-invite-accept-and-team-reset-cover-invitation-only-accounts', () => {
  // Invitation links are single-use bearers: the page reads public metadata
  // and never persists the token.
  const invite = read('app/invite/[token]/InviteAccept.tsx');
  assert.match(invite, /\/api\/auth\/invitations\/\$\{encodeURIComponent\(token\)\}\/accept/);
  assert.match(invite, /new-password/);
  assert.doesNotMatch(invite, /localStorage/);
  assert.doesNotMatch(invite, /sessionStorage/);
  const invitePage = read('app/invite/[token]/page.tsx');
  assert.match(invitePage, /\/api\/auth\/invitations\//);
  assert.doesNotMatch(invitePage, /localStorage/);
  // Password resets are owner-only, idempotent by command id, and revoke
  // other sessions; the UI gates on the same permission the server enforces.
  const team = read('app/console/team/TeamWorkspace.tsx');
  assert.match(team, /\/api\/auth\/accounts\/\$\{encodeURIComponent\(account\.id\)\}\/password/);
  assert.match(team, /commandId/);
  assert.match(team, /team\.manage/);
  assert.match(team, /previouslyFocused/);
  assert.match(team, /Escape/);
  assert.doesNotMatch(team, /localStorage/);
  assert.doesNotMatch(team, /sessionStorage/);
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /\/console\/team/);
});

test('web-participant-status-goes-through-the-operator-command-path', () => {
  const list = read('app/console/events/[id]/participants/ParticipantList.tsx');
  assert.match(list, /participant\.status/);
  assert.match(list, /\/commands/);
  assert.match(list, /assignmentId|membership|canManage/);
  assert.doesNotMatch(list, /localStorage/);
  assert.doesNotMatch(list, /sessionStorage/);
  // Long lists stay findable; unknown server statuses never read as pending.
  assert.match(list, /이름 검색/);
  assert.match(list, /전체 상태/);
  assert.match(list, /상태 확인 필요/);
  assert.match(list, /다시 불러오기/);
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
  // Recipient subsets stay selectable without scanning the full list; a
  // failed load recovers in place.
  assert.match(messaging, /이름·소속 검색/);
  assert.match(messaging, /visibleRecipients/);
  assert.match(messaging, /다시 불러오기/);
  // Bulk selection is scoped to the visible view: adding never drops other
  // views, clearing never touches them.
  assert.match(messaging, /표시된 대상 추가 선택/);
  assert.match(messaging, /\[\.\.\.new Set\(\[\.\.\.current, \.\.\.ids\]\)\]/);
  assert.match(messaging, /eventouch:shell-reload/);
  // Unknown values never read as a concrete channel or status.
  assert.match(messaging, /채널 확인 필요/);
  assert.match(messaging, /상태 확인 필요/);
});

test('web-console-shell-keeps-decided-navigation-and-clients-read-only', () => {
  const shell = read('app/console/ConsoleShell.tsx');
  const globalStyles = read('app/globals.css');
  assert.match(shell, /행사/);
  assert.match(shell, /고객사/);
  assert.match(shell, /nav/i);
  assert.match(shell, /mobile-primary-nav/);
  assert.match(shell, /mobile-event-nav/);
  assert.match(shell, /mobileEventBranchRef/);
  assert.match(shell, /revealCurrentDestination/);
  assert.match(shell, /aria-current=\{isHome \? "page" : isEventPath \? "location"/);
  assert.match(shell, /mobileOperatorTriggerRef\.current\?\.contains\(target\)/);
  assert.match(globalStyles, /\.mobile-primary-nav\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*auto 0 0;/s);
  assert.match(globalStyles, /safe-area-inset-bottom/);
  assert.match(globalStyles, /container-type:\s*inline-size/);
  assert.match(globalStyles, /@container\s*\(max-width:\s*340px\)/);
  assert.match(globalStyles, /\.nav-event-branch \.console-subnav-item\.active::before/);
  assert.match(globalStyles, /scroll-snap-type:\s*x proximity/);
  const clients = read('app/console/clients/ClientsList.tsx');
  assert.match(clients, /\/api\/bootstrap/);
  assert.doesNotMatch(clients, /method:\s*"POST"/i);
  assert.doesNotMatch(clients, /\/commands/);
  assert.match(clients, /다시 불러오기/);
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

test('web-event-stage-moves-forward-through-the-command-path-only', () => {
  const overview = read('app/console/events/[id]/EventOverview.tsx');
  assert.match(overview, /event\.stage/);
  assert.match(overview, /\/commands/);
  assert.doesNotMatch(overview, /window\.confirm/);
  assert.match(overview, /setStageConfirm\(true\)/);
  assert.match(overview, /정말 전환합니다/);
  assert.match(overview, /취소/);
  assert.match(overview, /commandId:\s*stageCommandIdRef\.current/);
  assert.match(overview, /payload:\s*\{\s*stage:\s*nextStage\s*\}/);
  assert.equal((overview.match(/className=\{styles\.metricCard\}/g) ?? []).length, 4);
  assert.match(overview, /<time[^>]+dateTime/);
  assert.match(overview, /formatCheckTime\(check\.at\)/);
  assert.match(overview, /overview\.registrationOpen \? "접수 중" : "접수 마감"/);
  assert.doesNotMatch(overview, /className="notice"/);
  assert.match(overview, /overview\.canManageEvent && !archived/);
  assert.match(overview, /currentStage === "ARCHIVED"/);
  assert.doesNotMatch(read('app/console/events/[id]/page.tsx'), /eyebrow/);
  // The UI may hint at prerequisites but never decides them.
  assert.doesNotMatch(overview, /stage:\s*"(LIVE|ARCHIVED)"\s*\}/);
  // A failed load recovers in place; unknown stages read as undecided.
  assert.match(overview, /다시 불러오기/);
  assert.match(overview, /단계 미정/);
  // Every screen retry also wakes the shell navigation.
  for (const file of [
    'app/console/events/[id]/EventOverview.tsx',
    'app/console/events/[id]/participants/ParticipantList.tsx',
    'app/console/clients/ClientsList.tsx',
    'app/console/events/[id]/operations/OperationsWorkspace.tsx',
    'app/console/events/[id]/settings/SettingsWorkspace.tsx',
  ]) {
    assert.match(read(file), /eventouch:shell-reload/);
  }
});

test('web-operations-uses-desk-booth-and-assignment-commands-only', () => {
  const ops = read('app/console/events/[id]/operations/OperationsWorkspace.tsx');
  for (const command of ['desk.save', 'desk.set-open', 'booth.save', 'staff.assign', 'staff.unassign']) {
    assert.match(ops, new RegExp(command.replace('.', '\\.')));
  }
  assert.match(ops, /\/commands/);
  assert.doesNotMatch(ops, /localStorage/);
  assert.doesNotMatch(ops, /sessionStorage/);
  // The screen may surface prerequisites but never computes authorization.
  assert.doesNotMatch(ops, /access\.|authorize\(/);
  // Every dialog follows the modal contract; field rejections surface inside
  // the open dialog, and unknown values never render as raw codes.
  assert.match(ops, /previouslyFocused/);
  assert.match(ops, /Escape/);
  assert.match(ops, /DialogError/);
  assert.match(ops, /assign-dialog-error/);
  assert.doesNotMatch(ops, /\?\? desk\.action/);
  assert.doesNotMatch(ops, /\?\? booth\.status/);
  assert.doesNotMatch(ops, /\?\? assignment\.accountId/);
  assert.doesNotMatch(ops, /\?\? target\.action/);
});

test('web-display-honors-the-operator-selection-from-the-public-projection', () => {
  const board = read('app/screen/[slug]/DisplayBoard.tsx');
  assert.match(board, /display\.type/);
  for (const type of ['notice', 'poll', 'quiz', 'draw', 'qa', 'photo']) {
    assert.match(board, new RegExp(`"${type}"`));
  }
  // Counts arrive aggregate-only from the server; the board never renders
  // voter identity.
  assert.match(board, /counts/);
  assert.doesNotMatch(board, /participantId/);
  // A dropped poll keeps the last frame but says so; long content is capped
  // so projection never pushes the footer off-screen.
  assert.match(board, /stale/);
  assert.match(board, /연결 확인 중/);
  assert.match(board, /display-idle/);
});

test('web-staff-booth-work-uses-the-booth-visit-command-and-stamp-mode', () => {
  const staff = read('app/staff/StaffConsole.tsx');
  assert.match(staff, /booth\.visit/);
  assert.match(staff, /stampMode/);
  assert.match(staff, /boothAssignments/);
  // The self-scan mode is a notice, never a staff-side certification.
  assert.match(staff, /참가자가 부스 QR을 스캔하는 방식/);
  // …so the camera action stays out of SELF mode, and a stale refresh says so.
  assert.match(staff, /stampMode === "SELF" \? null/);
  assert.match(staff, /오래되었을 수 있습니다/);
  // A silent refresh never strands an operator on an empty screen.
  assert.match(staff, /scopesRef/);
  assert.doesNotMatch(staff, /localStorage/);
});

test('web-settings-uses-the-preparation-command-set', () => {
  const settings = read('app/console/events/[id]/settings/SettingsWorkspace.tsx');
  for (const command of ['event.update', 'event.features', 'form.publish', 'form.close', 'attendee.page.save', 'attendee.page.publish']) {
    assert.match(settings, new RegExp(command.replace('.', '\\.')));
  }
  assert.match(settings, /\/commands/);
  assert.doesNotMatch(settings, /localStorage/);
  // Publishing never ships a stale draft silently; field errors name their
  // control; the twelve feature toggles read as three grouped decisions.
  assert.match(settings, /draftDirty/);
  assert.match(settings, /describedBy/);
  assert.match(settings, /FEATURE_GROUPS/);
  assert.match(settings, /참여 프로그램/);
  // The shell links every live event destination.
  const shell = read('app/console/ConsoleShell.tsx');
  for (const href of ['/participants', '/messages', '/operations', '/settings']) {
    assert.match(shell, new RegExp(href.replace('/', '\\/')));
  }
});
