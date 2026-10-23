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

function readSurfaceModules(rel) {
  const directory = path.join(WEB, rel);
  return fs.readdirSync(directory, { recursive: true })
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .sort()
    .map((file) => fs.readFileSync(path.join(directory, file), 'utf8'))
    .join('\n');
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
  assert.match(home, /행사 링크/);
  assert.match(home, /앱 설치 없이/);
  assert.doesNotMatch(home, /\/commands/);
  assert.doesNotMatch(home, /localStorage/);
  assert.doesNotMatch(home, /sessionStorage/);
  // SaaS landing (B): email-only inquiry, no form storage, policy notice.
  assert.match(home, /mailto:/);
  assert.match(home, /도입 문의/);
  assert.doesNotMatch(home, /<form/);
  // Persuade hierarchy: the hero asks for inquiry, login stays a utility.
  assert.match(home, /이메일로 도입 문의/);
  assert.match(home, /styles\.loginLink/);
  assert.match(home, /INQUIRY_BODY/);
  assert.match(home, /이메일 주소 복사/);
  // Honest messaging claim plus real product evidence, not mockups. The
  // evidence set carries the operating flow: console, attendee, staff, report.
  assert.match(home, /모의 발송으로 동작합니다/);
  assert.match(home, /실제 제품 화면/);
  for (const asset of ['ev-console', 'ev-attendee-event', 'ev-staff', 'ev-report']) {
    assert.match(home, new RegExp(`/evidence/${asset}\\.png`));
  }
  // Auth lookup must not block public content; it has a deadline and fallback.
  assert.match(home, /AbortController/);
  assert.match(home, /4000/);
  // Header login and FAQ interactions remain accessible at touch size.
  const landingCss = read('app/landing.module.css');
  assert.match(landingCss, /\.loginLink\s*\{[^}]*min-height:\s*44px/s);
  assert.match(landingCss, /\.faqItem summary:focus-visible/);
  assert.match(landingCss, /prefers-reduced-motion/);
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
  // Readiness is stated before submission, not discovered through it; the
  // sent code is confirmed with its window and a resend path.
  assert.match(form, /인증을 마쳐야 신청할 수 있습니다/);
  // The verification panel now leads the form, so the notice points forward
  // to the fields instead of back at the panel above it.
  assert.match(form, /연락처 인증을 완료하면 아래에서 신청 정보를 입력할 수 있습니다/);
  assert.match(form, /인증번호 다시 받기/);
  assert.match(form, /10분 안에 입력하세요/);
  assert.doesNotMatch(form, /localStorage/);
  assert.doesNotMatch(form, /sessionStorage/);
  const page = read('app/event/[slug]/register/page.tsx');
  assert.match(page, /verificationRequired/);
  assert.match(page, /이미 신청했다면 내 티켓 찾기/);
  assert.match(page, /현재 신청을 받지 않습니다/);
  assert.match(page, /loadVerificationMode/);
  assert.match(page, /VerificationUnavailable/);
  const unavailable = read('app/event/[slug]/VerificationUnavailable.tsx');
  assert.match(unavailable, /실제 문자로 전송되지 않습니다/);
  // Recovery reconnects by verified number; the session cookie set by the
  // server does the rest. No account, no stored secret on the device.
  const recover = read('app/event/[slug]/ticket/recover/RecoverForm.tsx');
  assert.match(recover, /verification\/request/);
  assert.match(recover, /verification\/confirm/);
  assert.match(recover, /RECOVER/);
  assert.match(recover, /\/ticket/);
  assert.match(recover, /인증번호 다시 받기/);
  assert.match(recover, /setSent\(false\)/);
  assert.doesNotMatch(recover, /setPhone\(""\)/);
  assert.doesNotMatch(recover, /localStorage/);
  assert.doesNotMatch(recover, /sessionStorage/);
  const recoverPage = read('app/event/[slug]/ticket/recover/page.tsx');
  assert.match(recoverPage, /RecoverForm/);
  // The ticket screen falls back to the session when the tab holds no
  // bearer, and points home instead of dead-ending. Recovery entries stay
  // but step aside with device + operator guidance where no SMS code can
  // arrive (mock/none transports).
  const view = read('app/event/[slug]/ticket/TicketView.tsx');
  assert.match(view, /ticket\/recover/);
  assert.match(view, /연락처 인증으로 티켓 다시 찾기/);
  assert.match(view, /신청 연락처 인증으로 다시 연결/);
  assert.match(view, /신청한 기기에서만 열 수 있습니다/);
  // The recovery note stays a quiet footnote; the wording changed with it.
  assert.match(view, /이 티켓은 현재 탭에만 보관됩니다/);
  const event = read('app/event/[slug]/page.tsx');
  assert.match(event, /이미 신청했다면 · 내 티켓 찾기/);
  assert.match(event, /참가자 홈/);
  const home = read('app/event/[slug]/home/page.tsx');
  assert.match(home, /HomeShell/);
  // Detail components may be extracted without changing this surface's
  // API/bearer contracts. Rendering and navigation have separate live audits.
  const shell = readSurfaceModules('app/event/[slug]/home');
  assert.match(shell, /lucky\.assign/);
  assert.match(shell, /roulette\.spin/);
  assert.match(shell, /vote\.ranked/);
  // Same tab-scoped bearer contract as the ticket screen: sessionStorage is
  // allowed, localStorage is not, and the bearer travels in the header.
  assert.match(shell, /authorization:\s*`Bearer /);
  assert.match(shell, /sessionStorage/);
  assert.doesNotMatch(shell, /localStorage/);
  assert.match(shell, /history\.replaceState/);
  assert.match(shell, /\/ticket\/recover/);
  assert.match(shell, /\/commands/);
  // The phone screenshot, not the slide's explanatory bars, is the visual
  // reference. Keep every destination; rendered layout and home/detail
  // separation are verified in the browser rather than pinning slide labels.
  assert.match(shell, /참가자 개인 QR|모바일 티켓/);
  assert.match(shell, /럭키드로우 번호/);
  assert.match(shell, /룰렛 이벤트/);
  assert.match(shell, /순위 투표/);
  assert.match(shell, /부스 인증/);
  // Detail behavior consumes real independent operator settings, not a
  // hardcoded wheel or stage-program gate. Visual fidelity is rendered QA,
  // not a pin on an English title or implementation-specific CSS class.
  assert.match(shell, /rouletteView/);
  assert.match(shell, /voteConfig/);
  assert.match(shell, /pickCount/);
  assert.match(shell, /prizes/);
});

test('web-attendee-home-command-contracts', () => {
  const repoRead = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const commands = repoRead('server/commands/attendee-experience.js');
  assert.match(commands, /lucky\.assign/);
  assert.match(commands, /roulette\.spin/);
  assert.match(commands, /vote\.ranked/);
  assert.match(commands, /team\.save/);
  assert.match(commands, /draw\.program\.save/);
  assert.match(commands, /draw\.program\.run/);
  assert.match(commands, /luckyNumbers/);
  assert.match(commands, /rouletteResults/);
  assert.match(commands, /drawPrograms/);
  // Program runs mirror into the linked draw module's published history so
  // the venue display shows the same result without a second publish step.
  assert.match(commands, /drawHistory/);
  assert.match(commands, /published: true/);
  // Mobile roulette is configured independently of stage draw programs.
  assert.match(commands, /roulette\.config\.save/);
  assert.match(commands, /vote\.config\.save/);
  assert.match(commands, /특정 시간에 운영됩니다/);
  const results = repoRead('server/commands/content-results.js');
  assert.match(results, /럭키번호/);
  assert.match(results, /\/home\?ticket=/);
  const domain = repoRead('server/commands/domain.js');
  assert.match(domain, /attendee-experience/);
  assert.match(domain, /attendeeExperience\.COMMANDS/);
  assert.match(domain, /attendeeExperience\.GUEST_COMMANDS/);
  const projection = repoRead('server/public-events.js');
  assert.match(projection, /teams/);
  assert.match(projection, /voteCounts/);
  assert.match(projection, /drawPrograms/);
  assert.match(projection, /roulette/);
  assert.match(projection, /rouletteView/);
  assert.match(projection, /voteConfig/);
  assert.match(projection, /lucky/);
  const draws = readSurfaceModules('app/console/events/[id]/draws');
  assert.match(draws, /team\.save/);
  assert.match(draws, /draw\.program\.save/);
  assert.match(draws, /draw\.program\.run/);
  // MC touch now selects the screen in the draw's own transaction/receipt,
  // rather than committing a prize before a separate display request.
  assert.match(draws, /showOnScreen:\s*true/);
  assert.match(draws, /vote\.config\.save/);
  assert.match(draws, /roulette\.config\.save/);
  assert.match(draws, /lucky\.preassign/);
  assert.match(draws, /reward\.assign/);
  assert.match(draws, /\/commands/);
  const board = readSurfaceModules('app/screen/[slug]');
  assert.match(board, /drawHistory/);
  assert.match(board, /luckyNumber/);
  assert.match(board, /COMPANY/);
  const messaging = read('app/console/events/[id]/messages/MessagingWorkspace.tsx');
  assert.match(messaging, /럭키번호/);
  // The rail renders registry destinations, not literal duplicate routes.
  const shellNav = read('app/console/ConsoleShell.tsx');
  assert.match(shellNav, /EVENT_PAGE_IDS\.map\(\(pageId\)/);
  assert.match(shellNav, /CONSOLE_PAGES\[pageId\]\.label/);
  assert.match(shellNav, /consolePageHref\(pageId, eventId/);
  const navigation = read('app/console/console-navigation.ts');
  assert.match(navigation, /draws: \{ label: "추첨·투표"/);
  assert.match(navigation, /return `\$\{base\}\/draws`/);
  const staff = readSurfaceModules('app/staff');
  assert.match(staff, /reward\.lookup/);
  assert.match(staff, /reward\.collect/);
  assert.doesNotMatch(staff, /workspaceRewards\.filter/);
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
  // A submitted application reads as a receipt with next steps, never as a
  // broken ticket; the usable ticket links onward to participation.
  assert.match(view, /신청이 접수되었습니다/);
  assert.match(view, /대기 명단에 등록되어 있습니다/);
  assert.match(view, /참여 프로그램 보기/);
  assert.match(view, /\/engage/);
  assert.match(view, /이 브라우저에 티켓이 보관되어 있지 않습니다/);
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
  // The failed-state retry actually refetches instead of idling on loading.
  assert.match(hub, /setReloadTick\(\(tick\) => tick \+ 1\)/);
  const work = read('app/staff/StaffEventWork.tsx');
  assert.match(work, /\/api\/bootstrap/);
  assert.match(work, /\/commands/);
  assert.match(work, /check\.scan/);
  assert.match(work, /assignmentId/);
  // No ticket bearer may be persisted on the device.
  assert.doesNotMatch(work, /localStorage/);
  assert.doesNotMatch(work, /sessionStorage/);
  // A valid mis-scan is corrected where it happened: the latest record of
  // this session carries a reason-backed correction; the server still owns
  // desk scope and authorship.
  assert.match(work, /check\.correct/);
  assert.match(work, /정정 사유/);
  assert.match(work, /최신 기록 정정/);
  assert.match(work, /correctableCheck/);
  // SELF booth codes are scannable QR with a copy path, not bare text.
  assert.match(work, /react-qr-code/);
  assert.match(work, /ET:BOOTH:/);
  assert.match(work, /코드 복사/);
});

test('web-camera-scan-degrades-to-manual-entry-without-a-camera', () => {
  // Shared by staff check-in and participant booth stamping.
  const scanner = read('app/CameraScan.tsx');
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
  assert.match(board, /set(?:Interval|Timeout)/);
  // MC-touch freshness is checked by the live workflow, not the retired
  // literal five-second cadence. Either timer implementation may be used.
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
  // The header is one registry heading plus the create trigger; the
  // schedule order needs no visible explainer above the filters. The H1
  // comes from the ConsolePage registry (this file owns no heading).
  assert.doesNotMatch(home, /오늘과 가까운 일정부터/);
  assert.match(home, /<ConsolePage pageId="events">/);
  assert.doesNotMatch(home, /<ConsolePageHeader\b|<h1\b/);
  // Keep one page heading, a visible result count near the list, and a
  // screen-reader status announcement without adding a second live region.
  assert.doesNotMatch(home, /aria-live/);
  assert.match(home, /className="sr-only" role="status"/);
  assert.match(home, /date: typeof event\.date/);
  assert.match(home, /start: typeof event\.start/);
  assert.match(home, /event\.date > todayKey/);
  assert.match(home, /eventRecency/);
  // Past dates use the same D arithmetic as future ones (D-70 / D+3), so a
  // past date beside an active stage never reads as a contradiction.
  assert.match(home, /return `D\+\$\{days\}`/);
  // A card with no date but a time says so instead of showing a bare clock
  // under 일정 미정.
  assert.match(home, /시간 \$\{time\}/);
  // No full-width rows: events render as cards in a capped grid, and the
  // calendar only filters those same cards by date.
  assert.doesNotMatch(home, /eventRow/);
  assert.match(home, /className=\{styles\.eventGrid\}/);
  assert.match(home, /className=\{styles\.eventCard\}>/);
  assert.match(home, /styles\.dayCell/);
  assert.match(home, /selectedDate/);
  // One native stage selector keeps the four stable filters discoverable
  // without turning every status into a separate card-like control.
  assert.match(home, /<label className=\{[^\n]*styles\.stageFilter[^\n]*\}>\s*<span>진행 단계<\/span>\s*<select/);
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
  assert.match(home, /className=\{styles\.eventCardZone\}/);
  assert.match(home, /className=\{styles\.eventDateTime\}/);
  assert.match(home, /className=\{styles\.eventCardBody\}/);
  assert.match(home, /className=\{styles\.eventCardFoot\}/);
  // The approved directory summary leaves statistics in the event home.
  // Only a nonempty approval queue earns a small follow-up link.
  assert.doesNotMatch(home, /eventMetrics|등록 인원|현재 입장/);
  assert.match(home, /pending: countPending\(event\.id\)/);
  assert.match(home, /event\.pending > 0 \? \(\s*<div className=\{styles\.eventCardActions\}>/);
  const overview = read('app/console/events/[id]/EventOverview.tsx');
  assert.match(overview, /headingId="event-metrics-heading"/);
  assert.match(overview, /overview\.registered/);
  assert.match(overview, /overview\.everIn/);
  const eventCard = home.slice(home.indexOf('function EventCard('), home.indexOf('export default function ConsoleHome()'));
  assert.match(eventCard, /<Link[\s\S]*className=\{styles\.eventCardLink\}/);
  assert.match(eventCard, /href=\{`\/console\/events\/\$\{encodeURIComponent\(event\.id\)\}`\}/);
  assert.match(eventCard, /participants\?status=PENDING/);
  // The pending queue is its own link outside the overview link; no nested
  // anchors, no per-card duplicate, and no always-empty footer on the card.
  assert.doesNotMatch(eventCard, /<a\b/);
  assert.match(eventCard, /<\/Link>[\s\S]*styles\.eventCardActions[\s\S]*?승인 대기/);
  assert.doesNotMatch(eventCard, /복제/);
  assert.doesNotMatch(home, /localStorage/);
  assert.doesNotMatch(home, /sessionStorage/);
  // The create dialog mounts the shared shell: creation focus rides nameRef
  // through initialFocusRef, Escape/backdrop/focus-return live centrally
  // with the busy gate, and in-flight writes still block fake cancels.
  const dialog = read('app/console/CreateEventDialog.tsx');
  assert.match(dialog, /<ConsoleDialog/);
  assert.match(dialog, /titleId="create-event-title"/);
  assert.match(dialog, /initialFocusRef=\{nameRef\}/);
  assert.match(dialog, /canClose=\{canClose\}/);
  assert.match(dialog, /busy=\{submitting\}/);
  assert.match(dialog, /disabled=\{submitting\}/);
  const shellDialog = read('app/console/console-ui/ConsoleDialog.tsx');
  assert.match(shellDialog, /role="dialog"/);
  assert.match(shellDialog, /aria-modal="true"/);
  assert.match(shellDialog, /event\.key === "Escape"/);
  assert.match(shellDialog, /event\.key !== "Tab"/);
  assert.match(shellDialog, /previouslyFocused/);
  assert.match(shellDialog, /initialFocusRef/);
  assert.doesNotMatch(dialog, /addEventListener\("keydown"/);
  assert.doesNotMatch(dialog, /document\.body\.style\.overflow/);
  // Escape/backdrop never fake-cancel an in-flight write.
  assert.match(dialog, /if \(submitGateRef\.current\) return false/);
  const dialogCss = read('app/globals.css');
  assert.match(dialogCss, /\.dialog-backdrop/);
  assert.match(dialogCss, /\.dialog-actions/);
  const css = read('app/console/console-home.module.css');
  assert.match(css, /\.eventRecency/);
  assert.match(css, /\.eventCardZone/);
  assert.match(css, /\.eventDateTime/);
  assert.match(css, /\.eventCardBody/);
  assert.match(css, /\.eventCardFoot/);
  assert.doesNotMatch(css, /\.eventCardTop/);
  assert.match(css, /\.eventCardLink:focus-visible/);
  assert.match(css, /\.approvalLink:focus-visible/);
  assert.match(css, /\.approvalLink\s*\{[^}]*min-height:\s*44px/s);
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
  // Reset and invite dialogs mount the shared shell with caller-owned
  // dismissal gates; focus mechanics live centrally.
  const team = read('app/console/team/TeamWorkspace.tsx');
  assert.match(team, /\/api\/auth\/accounts\/\$\{encodeURIComponent\(account\.id\)\}\/password/);
  assert.match(team, /commandId/);
  assert.match(team, /team\.manage/);
  assert.match(team, /<ConsoleDialog/);
  assert.match(team, /titleId="reset-title"/);
  assert.match(team, /titleId="invite-title"/);
  assert.match(team, /canClose=\{canCloseResetDialog\}/);
  assert.match(team, /canClose=\{canCloseInviteDialog\}/);
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
  // Team lives behind the registry href, not a literal duplicate route.
  assert.match(shell, /consolePageHref\("team"\)/);
  const navigation = read('app/console/console-navigation.ts');
  assert.match(navigation, /team: \{ label: "팀·권한"/);
  assert.match(navigation, /case "team":/);
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
  // The overview approval CTA lands pre-filtered via ?status=.
  assert.match(list, /URLSearchParams\(window\.location\.search\)/);
  assert.match(list, /styles\.participantIdentity/);
  assert.match(read('app/console/events/[id]/participants/participants.module.css'), /\.participantIdentity\s*\{/);
  assert.match(list, /maskPhone/);
  assert.match(list, /"승인"/);
  assert.match(list, /승인 중/);
  assert.match(list, /발급된 티켓은 무효화/);
  assert.match(list, /\*\*\*\*/);
  // Export stays client-side; import lives behind the management gate.
  assert.match(list, /EVENTOUCH_participants\.csv/);
  assert.match(list, /participants\/import/);
  // Group assignment and reward registration live on the rows, scoped to
  // the visible selection; both ride the command path.
  assert.match(list, /group\.assign/);
  assert.match(list, /reward\.create/);
  assert.match(list, /effectiveSelection/);
  assert.match(list, /그룹 지정/);
  assert.match(list, /경품 등록/);
  assert.doesNotMatch(list, /localStorage/);
  assert.doesNotMatch(list, /sessionStorage/);
});

test('web-booth-mode-and-map-editor-are-operations-owned', () => {
  const ops = read('app/console/events/[id]/operations/OperationsWorkspace.tsx');
  // Mode switching is explicit, acknowledges the direction, and blocks once
  // visits exist (server also refuses; the UI explains why).
  assert.match(ops, /booth\.mode/);
  assert.match(ops, /acknowledge:\s*true/);
  assert.match(ops, /방식을 바꿀 수 없습니다/);
  // Map editing normalizes placement to 0..1 and publishes through the
  // versioned commands.
  assert.match(ops, /booth\.map\.save/);
  assert.match(ops, /booth\.map\.publish/);
  assert.match(ops, /booth\.map\.unpublish/);
  assert.match(ops, /expectedDraftVersion/);
  assert.match(ops, /expectedPublishedVersion/);
  // Display output honours the same contract the public board reads, and
  // impossible choices are never offered.
  assert.match(ops, /display\.set/);
  assert.match(ops, /전광판 출력/);
  assert.match(ops, /module\.revealed/);
  assert.match(ops, /hasPublishedDraw/);
  // The public page renders only the published map with its markers.
  const publicPage = read('app/event/[slug]/page.tsx');
  assert.match(publicPage, /source\.published/);
  assert.match(publicPage, /public-booth-map/);
  assert.match(publicPage, /mapPoint/);
  assert.doesNotMatch(publicPage, /boothMap\.draft/);
});

test('web-rewards-fulfil-on-the-command-path-with-honest-gift-status', () => {
  const rewards = read('app/console/events/[id]/rewards/RewardsWorkspace.tsx');
  assert.match(rewards, /reward\.fulfill/);
  assert.match(rewards, /reward\.cancel/);
  assert.match(rewards, /\/commands/);
  // GIFT fulfilment is a mock in v1: the status says NEEDS_CONNECTION, and
  // the UI prints the placeholder code instead of a real coupon.
  assert.match(rewards, /NEEDS_CONNECTION/);
  assert.match(rewards, /기프티콘 미연동/);
  assert.match(rewards, /기프티콘 지급\(모의\)/);
  assert.match(rewards, /v1/);
  // The irreversible payout confirms in place, in the console's one grammar.
  assert.match(rewards, /ConsoleConfirm/);
  assert.doesNotMatch(rewards, /window\.confirm/);
  assert.match(rewards, /eventouch:shell-reload/);
  assert.doesNotMatch(rewards, /localStorage/);
  assert.doesNotMatch(rewards, /sessionStorage/);
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
  // Excel workbooks are read in the browser (first sheet, header row) and
  // flow into the same column mapping and validation as CSV.
  assert.match(wizard, /from "xlsx"/);
  assert.match(wizard, /parseWorkbook/);
  assert.match(wizard, /\.xlsx\?/);
});

test('web-messaging-uses-operator-commands-and-keeps-ticket-bearers-out-of-history', () => {
  const messaging = read('app/console/events/[id]/messages/MessagingWorkspace.tsx');
  assert.match(messaging, /template\.save/);
  assert.match(messaging, /message\.create/);
  assert.match(messaging, /message\.retry/);
  assert.match(messaging, /message\.sync/);
  assert.match(messaging, /message\.cancel/);
  assert.match(messaging, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/);
  assert.match(messaging, /workspaces/);
  assert.match(messaging, /deliveries/);
  assert.match(messaging, /messageStatusLabel/);
  assert.match(messaging, /deliveryStatusLabel/);
  assert.match(messaging, /data\?\.field/);
  // Sending a campaign confirms in place (one grammar for irreversible
  // commands); the dialog close gates keep the shared canClose contract.
  assert.match(messaging, /ConsoleConfirm/);
  assert.doesNotMatch(messaging, /window\.confirm/);
  assert.doesNotMatch(messaging, /localStorage/);
  assert.doesNotMatch(messaging, /sessionStorage/);
  assert.doesNotMatch(messaging, /recipientSnapshot|ticketToken|Bearer /);
  // Recipient subsets stay selectable without scanning the full list; a
  // failed load recovers in place.
  assert.match(messaging, /이름·소속·연락처 검색/);
  assert.match(messaging, /visibleRecipients/);
  assert.match(messaging, /다시 불러오기/);
  // Visible add/remove preserves other views; explicit full clear is separate.
  assert.match(messaging, />표시 추가<\/button>/);
  assert.match(messaging, />표시 해제<\/button>/);
  assert.match(messaging, /id="recipient-clear-all"/);
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
  // In-place switching: the current event reads as an event card (name with
  // stage, facts below), and the triage list carries the same signals as the
  // home cards so busy events sort themselves. Mobile keeps its compact row.
  assert.match(shell, /nav-event-card/);
  assert.match(shell, /nav-stage-dot/);
  // The dot carries the stage visually; its label stays for screen readers.
  assert.match(shell, /<span className="sr-only">\{stageLabel/);
  assert.match(shell, /손봐야 할 행사/);
  assert.match(shell, /nav-event-pick/);
  assert.match(shell, /nav-badge/);
  // The 행사 root link already lands on the list home, so no separate
  // view-all link competes with it.
  assert.doesNotMatch(shell, /전체 행사 보기/);
  // Content authoring and the reward desk are registry destinations inside
  // the event branch; the shell keeps badges, permissions and feature gates.
  const navigation = read('app/console/console-navigation.ts');
  assert.match(navigation, /content: \{ label: "콘텐츠"/);
  assert.match(navigation, /rewards: \{ label: "경품"/);
  assert.match(navigation, /return `\$\{base\}\/content`/);
  assert.match(navigation, /return `\$\{base\}\/rewards`/);
  assert.match(shell, /EVENT_PAGE_IDS\.map\(\(pageId\)/);
  assert.match(shell, /consolePageHref\(pageId, eventId/);
  assert.match(shell, /features\.includes\("reward"\)/);
  assert.match(shell, /currentEventMeta/);
  assert.match(shell, /renderEventSubnav/);
  assert.match(globalStyles, /\.nav-event-card/);
  assert.match(globalStyles, /\.nav-event-pick/);
  assert.doesNotMatch(shell, /mobile-primary-nav/, 'global destinations no longer occupy a persistent bottom bar');
  assert.match(shell, /aria-expanded=\{[^}]*\}/, 'top menu exposes its disclosure state');
  assert.match(shell, /행사 목록/, 'there is an explicit list escape beyond the logo');
  assert.match(shell, /mobile-event-nav/);
  assert.match(shell, /mobileEventBranchRef/);
  assert.match(shell, /revealCurrentDestination/);
  assert.match(shell, /aria-current=\{isHome \? "page" : isEventPath \? "location"/);
  assert.match(shell, /mobileOperatorTriggerRef\.current\?\.contains\(target\)/);
  assert.doesNotMatch(globalStyles, /\.mobile-primary-nav\s*\{[^}]*position:\s*fixed;/s, 'no replacement bottom dock');
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
  // A pending scan belongs to one ticket + assignment, never the next person
  // in line. Keep it for network/5xx uncertainty, not just thrown fetches.
  assert.match(staff, /pendingScanIdRef = useRef\(new Map<string, string>\(\)\)/);
  assert.match(staff, /JSON\.stringify\(\[activeScope\.eventId, activeAssignment\.id, activeTask, payload\]\)/);
  assert.match(staff, /res\.status >= 500 \|\| res\.status === 408/);
});

test('web-event-stage-moves-forward-through-the-command-path-only', () => {
  const overview = read('app/console/events/[id]/EventOverview.tsx');
  const settings = read('app/console/events/[id]/settings/SettingsWorkspace.tsx');
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(settings, /stage: text\(event\.stage\)\.toUpperCase\(\)/);
  assert.match(settings, /\/commands/);
  assert.match(settings, /command: "event\.stage"/);
  assert.match(overview, /승인 대기/);
  assert.doesNotMatch(overview, /승인대기/);
  assert.match(shell, /participants\?status=PENDING/);
  assert.doesNotMatch(settings, /window\.confirm/);
  assert.match(settings, /setStageConfirm\(true\)/);
  const confirmation = read('app/console/console-ui/StageTransitionConfirmation.tsx');
  assert.match(settings, /<StageTransitionConfirmation/);
  assert.match(confirmation, /정말 전환합니다/);
  assert.match(confirmation, /취소/);
  assert.match(settings, /commandId:\s*stageCommandIdRef\.current/);
  assert.match(settings, /payload:\s*\{\s*stage:\s*nextStage\s*\}/);
  // Metrics follow the event stage instead of a fixed four-card grid; the
  // dedicated event-home contract pins each stage's metric set.
  assert.match(overview, /metricsForStage\(overview, currentStage, base\)/);
  assert.match(overview, /<time[^>]+dateTime/);
  assert.match(overview, /formatCheckTime\(check\.at\)/);
  assert.match(overview, /overview\.registrationOpen \? "접수 중" : "접수 마감"/);
  assert.doesNotMatch(overview, /className="notice"/);
  assert.doesNotMatch(overview, /problemsForStage|event-operations-heading|event-stage-heading/);
  assert.doesNotMatch(read('app/console/events/[id]/page.tsx'), /eyebrow/);
  // The UI may hint at prerequisites but never replaces server authorization.
  assert.match(settings, /stagePrecondition/);
  assert.doesNotMatch(overview, /stage:\s*"(LIVE|ARCHIVED)"\s*\}/);
  // A failed load recovers in place; unknown stages read as undecided.
  assert.match(overview, /<ConsoleStatePanel/);
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
  // Every dialog mounts the shared shell with caller-owned dismissal
  // gates; field rejections surface inside the open dialog through the
  // shared DialogError row, and unknown values never render as raw codes.
  // Cancel affordances stay disabled while their dialog is busy.
  assert.match(ops, /<ConsoleDialog/);
  assert.match(ops, /canClose=\{canClose\}/);
  assert.match(ops, /busy=\{busy\}/);
  assert.match(ops, /disabled=\{busy\}/);
  assert.match(ops, /function DialogError/);
  assert.match(ops, /<DialogError failure=\{failure\} id="desk-dialog-error" \/>/);
  assert.match(ops, /<DialogError failure=\{failure\} id="assign-dialog-error" \/>/);
  const shellDialog = read('app/console/console-ui/ConsoleDialog.tsx');
  assert.match(shellDialog, /role="dialog"/);
  assert.match(shellDialog, /aria-modal="true"/);
  assert.match(shellDialog, /event\.key === "Escape"/);
  assert.match(shellDialog, /event\.key !== "Tab"/);
  assert.match(shellDialog, /previouslyFocused/);
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
  // The self-scan mode is a notice, never a staff-side certification, and it
  // names the participant path (home > 부스 인증) the QR code feeds.
  assert.match(staff, /참가자가 직접 인증하는 방식/);
  assert.match(staff, /참가자 홈 &gt; 부스 인증/);
  // …so the camera action stays out of SELF mode, and a stale refresh says so.
  assert.match(staff, /stampMode === "SELF" \? null/);
  assert.match(staff, /오래되었을 수 있습니다/);
  // Booth availability is stated truthfully: WAITING and CLOSED are distinct
  // and non-open booths cannot be selected.
  assert.match(staff, /운영 전/);
  assert.match(staff, /종료된 부스입니다/);
  assert.match(staff, /booth\.status !== "" && booth\.status !== "OPEN"/);
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
  // Focus follows the sheet in and back to the ticket field on close; the
  // recent list carries time so the last scan is verifiable in a queue.
  assert.match(staff, /nametagSheetRef\.current\?\.focus\(\)/);
  assert.match(staff, /formatCheckTime\(check\.at\)/);
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
  // The accept screen keeps the single shared login entry but carries the
  // role-aware return through the shared guard: staff to the assignment
  // hub, an event-scoped manager to that event, anyone else to the console.
  // A bare href="/login" would drop that return, so every destination is
  // pinned here instead of the bare path.
  assert.match(invite, /from "\.\.\/\.\.\/auth-redirect"/);
  assert.match(invite, /loginHref\(loginNextForRole\(invitation\.role, invitation\.eventId\)\)/);
  assert.match(invite, /if \(role === "STAFF"\) return "\/staff"/);
  assert.match(invite, /`\/console\/events\/\$\{eventId\}`/);
  assert.match(invite, /return "\/console"/);
  assert.doesNotMatch(invite, /href="\/login"/);
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
  assert.match(reports, /완료로 표시하면 이 버전은 편집할 수 없습니다/);
  assert.match(reports, /고객사에 자동 전송되지는 않습니다/);
  assert.match(reports, /현재 집계를 새로 반영/);
  assert.match(reports, /이 보고서의 집계 유지/);
  assert.match(reports, /원본 파일 저장 \(JSON\)/);
  // Cover: subtitle and note survive create/edit/versioning.
  assert.match(reports, /subtitle/);
  assert.match(reports, /coverNote/);
  assert.match(reports, /표지 부제목/);
  assert.match(reports, /표지 문구/);
  assert.match(reports, /reportCover/);
  // No customer portal: publish records shared state, never a share link.
  assert.doesNotMatch(reports, /shareToken/);
  assert.doesNotMatch(reports, /공유 링크/);
  // The create/edit dialog mounts the shared shell with caller-owned focus
  // and dismissal gates; snapshot/share/command/lock semantics below stay
  // pinned regardless of the chrome move.
  assert.match(reports, /<ConsoleDialog/);
  assert.match(reports, /initialFocusRef=\{titleRef\}/);
  assert.match(reports, /canClose=\{confirmDialogClose\}/);
  const shellDialog = read('app/console/console-ui/ConsoleDialog.tsx');
  assert.match(shellDialog, /event\.key === "Escape"/);
  assert.match(shellDialog, /previouslyFocused/);
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
  for (const command of ['event.update', 'event.features', 'form.publish', 'form.close']) {
    assert.match(settings, new RegExp(command.replace('.', '\\.')));
  }
  assert.match(settings, /\/commands/);
  assert.doesNotMatch(settings, /localStorage/);
  // The guarded preview editor is the only attendee-page writer; settings
  // links to it rather than silently overwriting a concurrently edited draft.
  assert.doesNotMatch(settings, /runCommand\("attendee\.page\.(?:save|publish)"/);
  assert.match(settings, /\/page/);
  const editor = read('app/console/events/[id]/page/ThemeWorkspace.tsx');
  assert.match(editor, /expectedDraftVersion/);
  assert.match(editor, /attendee\.page\.save/);
  assert.match(editor, /attendee\.page\.publish/);
  // Field errors name their control; toggles remain three grouped decisions.
  assert.match(settings, /describedBy/);
  assert.match(settings, /FEATURE_GROUPS/);
  assert.match(settings, /참여 프로그램/);
  // Phone-verification opt-in rides the basics form into event.update.
  assert.match(settings, /verificationRequired/);
  assert.match(settings, /참가 신청 전 연락처 인증 필요/);
  // The shell renders every live event destination from the registry, not
  // literal duplicate routes.
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /EVENT_PAGE_IDS\.map\(\(pageId\)/);
  assert.match(shell, /CONSOLE_PAGES\[pageId\]\.label/);
  assert.match(shell, /consolePageHref\(pageId, eventId/);
  const navigation = read('app/console/console-navigation.ts');
  for (const route of ['participants', 'messages', 'operations', 'settings', 'reports']) {
    assert.match(navigation, new RegExp(`return \\\`\\\${base}\\\/${route}\\\``));
  }
});

test('web-event-duplicate-copies-configuration-without-records', () => {
  const home = read('app/console/ConsoleHome.tsx');
  const dialog = read('app/console/CreateEventDialog.tsx');
  // A2: no per-card duplicate. Duplication lives in the create dialog's
  // stage-labeled source select over permission-available events, reusing the
  // same duplicate endpoint and copy contract.
  assert.doesNotMatch(home, /onDuplicate|setDuplicateSource/);
  assert.match(home, /duplicateSources=\{state\.events\.map/);
  assert.match(dialog, /duplicateSources\?: DuplicateCandidate\[\]/);
  assert.match(dialog, /\/api\/events\/\$\{encodeURIComponent\(effectiveDuplicate\.id\)\}\/duplicate/);
  assert.match(dialog, /참가자·티켓·입장·발송·당첨 기록/);
  assert.doesNotMatch(dialog, /localStorage|sessionStorage/);
  const homeCss = read('app/console/console-home.module.css');
  assert.doesNotMatch(homeCss, /\.eventCardAction[^s]/s);
});


test('web-overview-shows-calendar-period-registration-and-entry-counts', () => {
  const overview = read('app/console/events/[id]/EventOverview.tsx');
  assert.match(overview, /type PeriodCounts/);
  assert.match(overview, /applicationsIn/);
  assert.match(overview, /entriesIn/);
  assert.match(overview, /취소·정정 제외/);
  for (const label of ['오늘', '어제', '최근 7일']) {
    assert.match(overview, new RegExp(label));
  }
  const css = read('app/console/events/[id]/event-overview.module.css');
  assert.match(css, /\.periodTable\s*\{/);
});
