'use strict';

// Scoped roster + create-retry contract for the participant systematic pass:
// compact row-style roster with URL-synced filters and fingerprint-based
// same-request retries. Static source assertions on purpose: they pin the
// seam without booting Next.js. Rendered verification happens outside the
// suite (main owns DB/browser/servers).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

test('web-participant-roster-is-compact-with-coherent-columns', () => {
  const list = read('app/console/events/[id]/participants/ParticipantList.tsx');
  const css = read('app/console/events/[id]/participants/participants.module.css');
  // Compact row grid: identity + inline status + actions in coherent columns,
  // with a desktop column header. The status pill sizes to its label instead
  // of stretching full-width.
  assert.match(list, /rosterHead/);
  assert.match(list, /styles\.participantStatus/);
  assert.match(css, /\.rosterHead\s*\{/);
  assert.match(css, /\.participantStatus\s*\{/);
  // Header and rows share identical fixed tracks (status 112px, action
  // 160px): independent `auto` tracks let narrow/wide controls shift the
  // columns apart (header 상태/작업 vs pills/actions). Action controls fill
  // their track so every row's action starts at the same x.
  assert.match(css, /\.rosterHead\s*\{[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\) 112px 160px/s);
  assert.match(css, /\.participantRow\s*\{[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\) 112px 160px/s);
  assert.match(list, /rosterHeadStatus/);
  assert.match(list, /rosterHeadAction/);
  assert.match(css, /\.rosterHeadStatus\s*\{/);
  assert.match(css, /\.rosterHeadAction\s*\{/);
  assert.match(css, /\.participantActions \.button\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.participantActions select\s*\{[^}]*width:\s*100%/s);
  // Rows stay compact but never below the 44px touch target.
  assert.match(css, /min-height:\s*60px/);
  assert.match(css, /\.participantActions \.button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.participantActions select\s*\{[^}]*min-height:\s*44px/s);
  assert.doesNotMatch(css, /min-height:\s*40px/);
  // Identity stays on the row: name + company/masked contact, full digits
  // only in the CSV export.
  assert.match(list, /styles\.participantIdentity/);
  assert.match(list, /maskPhone/);
  assert.match(list, /\*\*\*\*/);
  assert.match(list, /EVENTOUCH_participants\.csv/);
  // Permission-specific actions are preserved, not cut.
  assert.match(list, /"승인"/);
  assert.match(list, /승인 중/);
  assert.match(list, /발급된 티켓은 무효화/);
  assert.match(list, /group\.assign/);
  assert.match(list, /reward\.create/);
  assert.match(list, /그룹 지정/);
  assert.match(list, /경품 등록/);
  assert.match(list, /effectiveSelection/);
});

test('web-participant-filters-sync-bidirectionally-without-router-refresh', () => {
  const list = read('app/console/events/[id]/participants/ParticipantList.tsx');
  // Init from URL: allowlisted status plus group/query.
  assert.match(list, /URLSearchParams\(window\.location\.search\)/);
  assert.match(list, /params\.get\("group"\)/);
  assert.match(list, /params\.get\("query"\)/);
  // Display-only attendance filter over existing check-in data: the
  // overview deep-links ?status=APPROVED&attendance=NOT_ENTERED for
  // confirmed non-entered people. Allowlisted values sync like the other
  // filters; invalid values are scrubbed; unrelated params are preserved.
  assert.match(list, /params\.get\("attendance"\)/);
  assert.match(list, /params\.set\("attendance", attendanceFilter\)/);
  assert.match(list, /NOT_ENTERED/);
  assert.match(list, /미입장/);
  assert.match(list, /matchesAttendance\(person, attendanceFilter\)/);
  assert.match(list, /person\.everIn !== true/);
  assert.match(list, /출입 상태별 보기/);
  assert.match(list, /전체 출입/);
  // Sync back uses native history so keystrokes never trigger a route
  // refresh/refetch; back/forward restores the view via popstate.
  assert.match(list, /history\.replaceState/);
  assert.match(list, /popstate/);
  assert.doesNotMatch(list, /router\.replace/);
  assert.doesNotMatch(list, /router\.refresh/);
  // Selection survives filter changes with a hidden count and an explicit
  // full deselect; back navigation never reselects.
  assert.match(list, /hiddenSelectedCount/);
  assert.match(list, /숨김/);
  assert.match(list, /선택 해제/);
});

test('web-participant-writes-reuse-one-command-id-per-request', () => {
  const list = read('app/console/events/[id]/participants/ParticipantList.tsx');
  // Fingerprint + command-id refs for all three write paths.
  assert.match(list, /pendingStatusRef/);
  assert.match(list, /pendingGroupRef/);
  assert.match(list, /pendingRewardRef/);
  assert.match(list, /fingerprint/);
  // Definitive 4xx (not 408) clears the id; 5xx/408/network/malformed
  // success keep it for a same-request replay.
  assert.match(list, /408/);
  assert.match(list, /isDefinitiveClientError/);
  assert.match(list, /participants\?: unknown/);
  assert.match(list, /participantIds\?: unknown/);
  assert.match(list, /reward\?: unknown/);
  // Failed inputs/selections are preserved with an actionable same-request
  // retry (status retry button, group/reward dialogs stay open).
  assert.match(list, /statusRetry/);
  assert.match(list, /같은 요청으로 다시 시도/);
  assert.doesNotMatch(list, /localStorage/);
  assert.doesNotMatch(list, /sessionStorage/);
});

test('web-create-dialog-retries-with-the-same-command-id', () => {
  const dialog = read('app/console/CreateEventDialog.tsx');
  assert.match(dialog, /commandId/);
  assert.match(dialog, /fingerprint/);
  assert.match(dialog, /commandIdRef\.current/);
  // Cleared on proven success and definitive 4xx (not 408); kept on
  // ambiguous 5xx/unparseable success/network. Payload edits mint a new id.
  assert.match(dialog, /408/);
  assert.match(dialog, /isDefinitiveClientError/);
  assert.match(dialog, /generatedSlugRef/);
  assert.match(dialog, /같은 요청으로 다시 시도/);
  assert.match(dialog, /retryable/);
  // The migrated dialog mounts the shared shell: creation focus rides
  // nameRef through initialFocusRef, Escape/backdrop/focus-return live
  // centrally with the busy gate, and the cancel affordance stays disabled
  // while submitting. No own listeners.
  assert.match(dialog, /<ConsoleDialog/);
  assert.match(dialog, /initialFocusRef=\{nameRef\}/);
  assert.match(dialog, /canClose=\{canClose\}/);
  assert.match(dialog, /busy=\{submitting\}/);
  assert.match(dialog, /disabled=\{submitting\}/);
  const shell = read('app/console/console-ui/ConsoleDialog.tsx');
  assert.match(shell, /role="dialog"/);
  assert.match(shell, /aria-modal="true"/);
  assert.match(shell, /event\.key === "Escape"/);
  assert.match(shell, /event\.key !== "Tab"/);
  assert.match(shell, /previouslyFocused/);
  assert.match(shell, /initialFocusRef/);
  assert.doesNotMatch(dialog, /addEventListener\("keydown"/);
  assert.doesNotMatch(dialog, /document\.body\.style\.overflow/);
  // Escape/backdrop never fake-cancel an in-flight write: a synchronous
  // same-turn gate backs the submitting state, and the shared dialog owns
  // the busy gate with the caller dismissal predicate.
  assert.match(dialog, /submitGateRef = useRef\(false\)/);
  assert.match(dialog, /if \(submitGateRef\.current\) return false/);
  assert.match(dialog, /submitGateRef\.current = true/);
  assert.match(dialog, /busy=\{submitting\}/);
  assert.match(dialog, /disabled=\{submitting\}/);
  assert.match(dialog, /duplicateOf/);
  assert.match(dialog, /\/api\/events\/\$\{encodeURIComponent\(effectiveDuplicate\.id\)\}\/duplicate/);
  assert.match(dialog, /참가자·티켓·입장·발송·당첨 기록/);
  assert.doesNotMatch(dialog, /localStorage|sessionStorage/);
});
