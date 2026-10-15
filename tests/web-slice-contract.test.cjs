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

test('web-service-entry-sends-everyone-through-the-shared-login', () => {
  // Attendees arrive by event link, never here; operators get one door.
  const home = read('app/page.tsx');
  assert.match(home, /\/login/);
  assert.match(home, /\/staff/);
  assert.match(home, /\/console/);
  assert.match(home, /초대 메시지/);
  assert.doesNotMatch(home, /\/commands/);
  assert.doesNotMatch(home, /localStorage/);
  assert.doesNotMatch(home, /sessionStorage/);
  // SaaS landing (B): email-only inquiry, no form storage, policy notice.
  assert.match(home, /mailto:/);
  assert.match(home, /도입 문의/);
  assert.doesNotMatch(home, /<form/);
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

test('web-attendee-verification-precedes-signup-and-recovery-without-accounts', () => {
  // Verified-only events prove phone possession before signup; the grant is
  // bound to the exact digits and dies when the number is edited.
  const form = read('app/event/[slug]/register/RegisterForm.tsx');
  assert.match(form, /verificationRequired/);
  assert.match(form, /verification\/request/);
  assert.match(form, /verification\/confirm/);
  assert.match(form, /verificationGrant/);
  assert.match(form, /연락처 인증을 먼저 완료하세요/);
  assert.match(form, /setGrantPhone/);
  assert.doesNotMatch(form, /localStorage/);
  assert.doesNotMatch(form, /sessionStorage/);
  const page = read('app/event/[slug]/register/page.tsx');
  assert.match(page, /verificationRequired/);
  // Recovery reconnects by verified number; the session cookie set by the
  // server does the rest. No account, no stored secret on the device.
  const recover = read('app/event/[slug]/ticket/recover/RecoverForm.tsx');
  assert.match(recover, /verification\/request/);
  assert.match(recover, /verification\/confirm/);
  assert.match(recover, /RECOVER/);
  assert.match(recover, /\/ticket/);
  assert.doesNotMatch(recover, /localStorage/);
  assert.doesNotMatch(recover, /sessionStorage/);
  const recoverPage = read('app/event/[slug]/ticket/recover/page.tsx');
  assert.match(recoverPage, /RecoverForm/);
  // The ticket screen falls back to the session when the tab holds no
  // bearer, and points home instead of dead-ending.
  const view = read('app/event/[slug]/ticket/TicketView.tsx');
  assert.match(view, /ticket\/recover/);
  assert.match(view, /내 참가 정보 다시 연결/);
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
  const login = read('app/login/LoginForm.tsx');
  assert.match(login, /\/api\/auth\/login/);
  assert.doesNotMatch(login, /localStorage/);
  assert.doesNotMatch(login, /sessionStorage/);
  // The shared login honors a validated return destination and keeps
  // STAFF on the assignment hub instead of the operator console.
  assert.match(login, /safeNextPath/);
  assert.match(login, /\/staff/);
  assert.match(login, /\/console/);
  const guard = read('app/auth-redirect.ts');
  assert.match(guard, /safeNextPath/);
  assert.match(guard, /\/login\?next=/);
  const hub = read('app/staff/StaffHub.tsx');
  assert.match(hub, /\/api\/bootstrap/);
  assert.match(hub, /\/staff\/events\//);
  assert.doesNotMatch(hub, /\/commands/);
  assert.doesNotMatch(hub, /localStorage/);
  assert.doesNotMatch(hub, /sessionStorage/);
  const work = read('app/staff/StaffEventWork.tsx');
  assert.match(work, /\/api\/bootstrap/);
  assert.match(work, /\/commands/);
  assert.match(work, /check\.scan/);
  assert.match(work, /assignmentId/);
  // No ticket bearer may be persisted on the device.
  assert.doesNotMatch(work, /localStorage/);
  assert.doesNotMatch(work, /sessionStorage/);
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
  const console_ = read('app/staff/StaffEventWork.tsx');
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
  const login = read('app/login/LoginForm.tsx');
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
  // Keep one page heading, a visible result count near the list, and a
  // screen-reader status announcement without adding a second live region.
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
  assert.match(home, /className=\{styles\.eventCard\}>/);
  assert.match(home, /styles\.dayCell/);
  assert.match(home, /selectedDate/);
  // One native stage selector keeps the four stable filters discoverable
  // without turning every status into a separate card-like control.
  assert.match(home, /className=\{styles\.stageFilter\}>\s*<span>진행 단계<\/span>\s*<select/);
  assert.match(home, /value=\{filter\}/);
  assert.match(home, /FILTERS\.map\(\(item\) =>/);
  assert.match(home, /counts\[item\.id\]/);
  // Triage: the pending queue outranks the calendar when asked.
  assert.match(home, /승인 대기 있는 행사만/);
  assert.match(home, /needsWork/);
  assert.match(home, /event\.pending > 0/);
  assert.match(home, /b\.pending - a\.pending/);
  assert.match(home, /workFilter/);
  assert.doesNotMatch(home, /nextAction|승인 처리하기|현장 보기|이어서 만들기/);
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
  assert.match(home, /aria-pressed=\{view === "cards"\}/);
  for (const label of ['전체', '준비 중', '진행 중', '종료·보관']) {
    assert.match(home, new RegExp(label));
  }
  assert.match(home, /className=\{styles\.eventDate\}/);
  assert.match(home, /className=\{styles\.eventStatus\}/);
  assert.match(home, /className=\{styles\.eventMetrics\}/);
  assert.match(home, /등록 인원/);
  assert.match(home, /승인 대기/);
  assert.match(home, /현재 입장/);
  assert.match(home, /pending: counts\.pending/);
  assert.match(home, /inside: counts\.inside/);
  const eventCard = home.slice(home.indexOf('function EventCard('), home.indexOf('export default function ConsoleHome()'));
  assert.match(eventCard, /<Link[\s\S]*className=\{styles\.eventCardLink\}/);
  assert.match(eventCard, /href=\{`\/console\/events\/\$\{encodeURIComponent\(event\.id\)\}`\}/);
  assert.doesNotMatch(eventCard, /aria-label=/);
  assert.equal((eventCard.match(/<Link\b/g) ?? []).length, 1);
  assert.doesNotMatch(eventCard, /<button|<select|<input|<a\b/);
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
  assert.match(css, /\.eventCardTop/);
  assert.match(css, /\.eventCardLink:focus-visible/);
  assert.match(css, /\.metricUnit/);
  assert.match(css, /\.eventGrid/);
  assert.match(css, /\.dayCell/);
  // Korean titles wrap at word boundaries, never mid-syllable; unbreakable
  // strings still break so narrow cards never overflow.
  assert.match(css, /\.eventName\s*\{[^}]*word-break:\s*keep-all/s);
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
  // Invitation issuing moved in from the legacy app: agency-only create with
  // a once-shown link, pending list, and idempotent revoke.
  assert.match(team, /\/api\/auth\/invitations/);
  assert.match(team, /\/invite\/\$\{encodeURIComponent\(data\.token\)\}/);
  assert.match(team, /초대 링크는 발급 시 한 번만 표시됩니다/);
  assert.match(team, /대기 중인 초대/);
  assert.match(team, /초대 철회/);
  assert.match(team, /\/revoke/);
  assert.doesNotMatch(team, /localStorage/);
  assert.doesNotMatch(team, /sessionStorage/);
  // Operations visibility is read-only: integration status from the health
  // probe, recent activity from scoped workspaces, login protection from the
  // agency-only security endpoint. Credentials are never entered on screen.
  const ops = read('app/console/team/OperationsPanels.tsx');
  assert.match(ops, /\/api\/health/);
  assert.match(ops, /\/api\/auth\/security/);
  assert.match(ops, /연동 상태/);
  assert.match(ops, /최근 활동/);
  assert.match(ops, /로그인 보호 상태/);
  assert.match(ops, /성공한 로그인은 기록하지 않으므로/);
  assert.match(ops, /화면에 입력하지 않습니다/);
  assert.doesNotMatch(ops, /localStorage/);
  assert.doesNotMatch(ops, /sessionStorage/);
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
  assert.match(list, /이름·소속·연락처 검색/);
  assert.match(list, /전체 상태/);
  assert.match(list, /상태 확인 필요/);
  assert.match(list, /다시 불러오기/);
  // Approval is explicit on pending rows, with identity on the row; only
  // cancellation asks twice. The full digits stay in exports, not on screen.
  assert.match(list, /participant-identity/);
  assert.match(list, /maskPhone/);
  assert.match(list, /"승인"/);
  assert.match(list, /승인 중/);
  assert.match(list, /발급된 티켓은 무효화/);
  assert.match(list, /\*\*\*\*/);
  // Export stays client-side; import lives behind the management gate.
  assert.match(list, /EVENTOUCH_participants\.csv/);
  assert.match(list, /participants\/import/);
});

test('web-participant-import-maps-and-reviews-before-the-command-path', () => {
  const wizard = read('app/console/events/[id]/participants/import/ImportWizard.tsx');
  assert.match(wizard, /participant\.import/);
  assert.match(wizard, /\/commands/);
  assert.match(wizard, /commandId/);
  assert.match(wizard, /submittingRef/);
  assert.match(wizard, /1048576/);
  assert.match(wizard, /1,000/);
  assert.match(wizard, /양식 CSV/);
  assert.match(wizard, /EVENTOUCH_import_template\.csv/);
  assert.match(wizard, /동의 기록은 가져오기만으로 생성하지 않습니다/);
  assert.match(wizard, /canManage/);
  assert.doesNotMatch(wizard, /localStorage/);
  assert.doesNotMatch(wizard, /sessionStorage/);
  assert.doesNotMatch(wizard, /sheetjs/i);
  assert.doesNotMatch(wizard, /require\(.xlsx|from .xlsx/);
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
  // MMS carries a photo: channel option, JPEG upload under 200KB, file id on
  // the create payload, and the honest surcharge note. Bytes never travel
  // through the command path.
  assert.match(messaging, /MMS · 사진/);
  assert.match(messaging, /campaign-image/);
  assert.match(messaging, /imageFileId/);
  assert.match(messaging, /200KB/);
  assert.match(messaging, /별도 요금/);
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
  // Exactly one account trigger per viewport: the two-class hide rule must
  // beat .operator-block's later display:flex on desktop, and the mobile
  // rule must win it back inside the media query.
  assert.match(globalStyles, /\.operator-block\.operator-mobile-trigger\s*\{[^}]*display:\s*none/s);
  assert.match(globalStyles, /\.operator-block\.operator-mobile-trigger\s*\{[^}]*grid-area:\s*profile/s);
  const clients = read('app/console/clients/ClientsList.tsx');
  assert.match(clients, /\/api\/bootstrap/);
  // Client records live on the organization REST path (agency-only on the
  // server), never the event command path; files travel the file routes.
  assert.match(clients, /\/api\/clients/);
  assert.match(clients, /method:\s*"POST"/i);
  assert.doesNotMatch(clients, /\/commands/);
  assert.match(clients, /\/files\?name=/);
  assert.match(clients, /logoFileId/);
  assert.match(clients, /docFileId/);
  assert.match(clients, /사업자등록증/);
  assert.match(clients, /600KB/);
  assert.match(clients, /canManage/);
  assert.match(clients, /다시 불러오기/);
  assert.doesNotMatch(clients, /localStorage/);
  assert.doesNotMatch(clients, /sessionStorage/);
});

test('web-retry-keeps-one-command-id-per-attempt-on-signup-and-scan', () => {
  // A lost response must replay the same request id, or the retry becomes a
  // second registration / a confusing duplicate scan.
  const register = read('app/event/[slug]/register/RegisterForm.tsx');
  assert.match(register, /commandIdRef\.current/);
  assert.match(register, /useRef<string \| null>/);
  const staff = read('app/staff/StaffEventWork.tsx');
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
  const staff = read('app/staff/StaffEventWork.tsx');
  assert.match(staff, /booth\.visit/);
  assert.match(staff, /stampMode/);
  assert.match(staff, /boothAssignments/);
  // The self-scan mode is a notice, never a staff-side certification.
  assert.match(staff, /참가자가 부스 QR을 스캔하는 방식/);
  // …so the camera action stays out of SELF mode, and a stale refresh says so.
  assert.match(staff, /stampMode === "SELF" \? null/);
  assert.match(staff, /오래되었을 수 있습니다/);
  // A silent refresh never strands an operator on an empty screen.
  assert.match(staff, /scopeRef/);
  assert.doesNotMatch(staff, /localStorage/);
});

test('web-staff-desk-shows-direction-and-prints-nametags-in-kiosk-mode', () => {
  const staff = read('app/staff/StaffEventWork.tsx');
  // The scan action comes from the desk; the operator must see it.
  assert.match(staff, /퇴장/);
  assert.match(staff, /이 데스크는/);
  // Kiosk is a display mode on the same assignment and login, never an
  // unattended self check-in.
  assert.match(staff, /키오스크 모드/);
  assert.match(staff, /kiosk-mode/);
  assert.match(staff, /무인 셀프 체크인은 지원하지 않습니다/);
  // Nametags print from the scan result with the company on file.
  assert.match(staff, /네임택 인쇄/);
  assert.match(staff, /nametag-sheet/);
  assert.match(staff, /nametag-printing/);
  const css = read('app/globals.css');
  assert.match(css, /\.nametag-sheet/);
  assert.match(css, /\.kiosk-mode/);
});

test('web-shared-login-keeps-safe-return-destinations-only', () => {
  const guard = read('app/auth-redirect.ts');
  assert.match(guard, /safeNextPath/);
  assert.match(guard, /startsWith\("\/console/);
  assert.doesNotMatch(guard, /http/);
  const legacyLogin = read('app/staff/login/page.tsx');
  assert.match(legacyLogin, /\/login\?next=/);
  assert.match(legacyLogin, /safeNextPath/);
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /loginHrefForLocation/);
  assert.match(shell, /\/login/);
  assert.doesNotMatch(shell, /router\.replace\("\/staff\/login"\)/);
  const invite = read('app/invite/[token]/InviteAccept.tsx');
  assert.match(invite, /href="\/login"/);
  // Protected screens preserve the requested destination on 401 instead of
  // dropping it at a bare login path.
  for (const file of [
    'app/console/ConsoleHome.tsx',
    'app/console/clients/ClientsList.tsx',
    'app/console/events/[id]/EventOverview.tsx',
    'app/staff/StaffHub.tsx',
    'app/staff/StaffEventWork.tsx',
  ]) {
    assert.match(read(file), /loginHrefForLocation/);
  }
});

test('web-staff-hub-links-event-work-without-downloading-all-desks-upfront', () => {
  const hubPage = read('app/staff/page.tsx');
  assert.match(hubPage, /StaffHub/);
  assert.doesNotMatch(hubPage, /StaffConsole/);
  const eventPage = read('app/staff/events/[eventId]/page.tsx');
  assert.match(eventPage, /StaffEventWork/);
  assert.match(eventPage, /params/);
  const scope = read('app/staff/staff-scope.ts');
  assert.match(scope, /buildStaffScopes/);
  assert.match(scope, /DESK/);
  assert.match(scope, /BOOTH/);
});

test('web-reports-combine-live-analysis-with-snapshot-reports', () => {
  const reports = read('app/console/events/[id]/reports/ReportsWorkspace.tsx');
  // Analysis mirrors the server snapshot formulas; reports go through the
  // existing idempotent domain command path.
  for (const command of ['report.create', 'report.update', 'report.publish', 'report.successor']) {
    assert.match(reports, new RegExp(command.replace('.', '\\.')));
  }
  assert.match(reports, /\/commands/);
  assert.match(reports, /누적 입장/);
  assert.match(reports, /누적 입장률/);
  assert.match(reports, /재입장을 중복 집계하지 않습니다/);
  for (const label of ['운영 요약', '참가·입장', '프로그램·부스', '만족도', '승인 사진']) {
    assert.match(reports, new RegExp(label));
  }
  // Published versions lock; the next version branches explicitly.
  assert.match(reports, /공유하면 이 버전은 잠깁니다/);
  assert.match(reports, /현재 집계로 새 버전/);
  assert.match(reports, /데이터 JSON 저장/);
  // Cover: subtitle and note survive create/edit/versioning.
  assert.match(reports, /subtitle/);
  assert.match(reports, /coverNote/);
  assert.match(reports, /표지 부제목/);
  assert.match(reports, /표지 문구/);
  assert.match(reports, /reportCover/);
  // No customer portal: publish records shared state, never a share link.
  assert.doesNotMatch(reports, /shareToken/);
  assert.doesNotMatch(reports, /공유 링크/);
  // The create/edit dialog is modal: initial focus, Escape, focus return.
  assert.match(reports, /titleRef\.current\?\.focus/);
  assert.match(reports, /Escape/);
  assert.match(reports, /previouslyFocused/);
  assert.match(reports, /보고서 항목을 하나 이상 선택하세요/);
  assert.doesNotMatch(reports, /localStorage/);
  assert.doesNotMatch(reports, /sessionStorage/);
  const page = read('app/console/events/[id]/reports/page.tsx');
  assert.match(page, /ReportsWorkspace/);
  // Every screen retry also wakes the shell navigation.
  assert.match(reports, /eventouch:shell-reload/);
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
  // Phone-verification opt-in rides the basics form into event.update.
  assert.match(settings, /verificationRequired/);
  assert.match(settings, /참가 신청 전 연락처 인증 필요/);
  // The shell links every live event destination.
  const shell = read('app/console/ConsoleShell.tsx');
  for (const href of ['/participants', '/messages', '/operations', '/settings', '/reports']) {
    assert.match(shell, new RegExp(href.replace('/', '\\/')));
  }
});
