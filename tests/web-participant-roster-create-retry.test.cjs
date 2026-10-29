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

test('web-participant-row-reuse-prefills-name-company-only-and-guards-dirty-forms', () => {
  const list = read('app/console/events/[id]/participants/ParticipantList.tsx');
  // One explicit per-row action, gated by the existing roster write gate.
  assert.match(list, /이 정보로 새 참가자 등록/);
  // The inspector owns the action now; the same selected participant is
  // passed and the function's copy/guard contract is unchanged.
  assert.match(list, /reuseForNewRegistration\(selectedPerson\)/);
  assert.match(list, /if \(!canMutateStatus\) return;/);
  // Only name + company travel; contact/consent/ticket/attendance/reward
  // history/results/files are never copied from the row.
  const reuseStart = list.indexOf('function reuseForNewRegistration');
  const reuseEnd = list.indexOf('const [addBusy, setAddBusy]', reuseStart);
  const reuse = list.slice(reuseStart, reuseEnd === -1 ? undefined : reuseEnd);
  assert.match(reuse, /name: person\.name, phone: "", company: person\.company, email: "", registrationType: "ONSITE"/);
  assert.doesNotMatch(reuse, /person\.phone|person\.email|consent|ticket|everIn|reward/i);
  // Dirty or outcome-unknown forms are never overwritten: the guard reopens
  // the pending work with its receipt intact instead of replacing it.
  assert.match(reuse, /addBusy \|\| pendingAddRef\.current !== null/);
  assert.match(reuse, /if \(addDirty\) \{/);
  assert.match(reuse, /결과 미확인인 등록이 있습니다/);
  assert.match(reuse, /작성 중인 새 등록 내용이 있습니다/);
  // New-registration marking and exact focus on the first empty input.
  assert.match(reuse, /setReuseFrom\(person\.name\)/);
  assert.match(list, /이름·소속을 가져왔습니다\. 연락처를 입력하세요/);
  assert.match(reuse, /getElementById\("participant-add-phone"\)\?\.focus/);
  // The bulk select-all rides the toolbar action scroll-row on every width
  // (paired inline group), never a tall full-width block ahead of the list.
  // Copy is short ("전체 N명 선택") so the 390px row scrolls in one line;
  // the filter-wide scope stays announced via aria-describedby.
  assert.match(list, /data-toolbar-inline/);
  assert.match(list, /전체 \{visiblePeople\.length\}명 선택/);
  assert.match(list, /검색·필터에 맞는 전체를 선택합니다/);
  const toolbarActions = list.slice(list.indexOf('actions={'));
  assert.ok(toolbarActions.indexOf('전체 {visiblePeople.length}명 선택') !== -1 && toolbarActions.indexOf('명단 가져오기') !== -1,
    'select-all sits with the other roster bulk actions');
  // Scoped bootstrap denials name the permission problem (an unassigned
  // identity sees this, not a blind retry promise): 403/404 read as
  // missing-or-forbidden while other failures keep the retryable copy.
  assert.match(list, /bootRes\.status === 404 \|\| bootRes\.status === 403/);
  assert.match(list, /행사를 찾을 수 없거나 접근 권한이 없습니다/);
  // The frozen create command, receipt, duplicate validation and selection
  // scope travel untouched through the same createParticipant path.
  assert.match(list, /"participant\.create"/);
  assert.match(list, /pendingAddRef\.current\?\.fingerprint === fingerprint/);
  // Ambiguous outcomes keep the frozen id with retry guidance; definitive
  // rejections surface the server reason and clear the id.
  assert.match(list, /const ambiguous = res\.status >= 500 \|\| res\.status === 408/);
  assert.match(list, /응답을 확인하지 못했습니다\. 같은 내용으로 다시 시도하세요\./);
  assert.match(list, /if \(!ambiguous\) pendingAddRef\.current = null/);
});

test('web-participant-roster-is-compact-with-coherent-columns', () => {
  const list = read('app/console/events/[id]/participants/ParticipantList.tsx');
  const css = read('app/console/events/[id]/participants/participants.module.css');
  // Approved B composition replaces independently aligned grid labels with
  // a native table; mobile retains a compact list over the same page slice.
  assert.match(list, /rosterHead/);
  assert.match(list, /styles\.participantStatus/);
  assert.match(css, /\.rosterHead th\s*\{/);
  assert.match(css, /\.participantStatus\s*\{/);
  assert.match(list, /<table className=\{styles\.rosterTable\}>/);
  assert.match(list, /<thead className=\{styles\.rosterHead\}>/);
  for (const label of ['연락처', '그룹', '신청 상태', '출입']) assert.ok(list.includes(`<th scope="col">${label}</th>`), label);
  assert.match(list, /aria-sort=\{nameSort/);
  assert.match(css, /\.rosterTable\s*\{[^}]*width:\s*100%/s);
  assert.doesNotMatch(list, /목록 요약|inspectorSummary/, 'closed details do not reserve a summary column');
  assert.match(css, /\.detailActions select\s*\{[^}]*flex:\s*1 1 220px/s);
  // Rows stay compact but never below the 44px touch target.
  assert.match(css, /\.participantRow\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.participantActions :global\(\.button\)\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.detailActions select\s*\{[^}]*min-height:\s*44px/s);
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

test('web-participant-scope-selects-keep-visible-labels-as-accessible-names', () => {
  const list = read('app/console/events/[id]/participants/ParticipantList.tsx');
  // Voice control and the browser audits locate these buttons by visible
  // text: the accessible name must equal the visible label (label-in-name),
  // with each scope riding aria-describedby instead of a diverging label.
  assert.doesNotMatch(list, /aria-label=\{`[^`]*명 선택`\}/u, 'no select button renames itself apart from its visible label');
  assert.match(list, /전체 \{visiblePeople\.length\}명 선택/u, 'filter scope keeps its short visible label');
  assert.match(list, /이 페이지 \{pagePeople\.length\}명 선택/u, 'page scope keeps its short visible label');
  assert.match(list, /aria-describedby="roster-select-all-help"/u, 'filter scope stays described');
  assert.match(list, /aria-describedby="roster-page-position"/u, 'page scope stays described');
  // Caption and filter-wide select travel as one wrapping unit so narrow
  // rows never strand the label apart from its button.
  assert.match(list, /<span className=\{styles\.scopeGroup\}>\s*<span className=\{styles\.scopeLabel\}>선택 범위<\/span>/u, 'caption and select stay grouped');
  const css = read('app/console/events/[id]/participants/participants.module.css');
  assert.match(css, /\.scopeGroup\s*\{[^}]*display:\s*inline-flex/su, 'scope pair wraps as one unit without overlay');
  // Narrow rows stack deterministically (count + refresh, then the scope
  // pair) instead of squeezing the count beside nowrap controls.
  const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
  assert.match(mobile, /\.rosterMeta\s*\{[^}]*display:\s*grid/su, 'narrow meta rows stack instead of squeezing');
  assert.match(mobile, /\.scopeGroup\s*\{[^}]*grid-column:\s*1 \/ -1/su, 'scope pair owns the second narrow row');
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
