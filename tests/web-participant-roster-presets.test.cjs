'use strict';

// Roster quick presets are shortcuts, not a second filter system: they must
// call the same setters as the advanced selects (same URL sync, selection
// scope and reset contract), and stay keyboard/touch reachable.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const list = fs.readFileSync(path.join(ROOT, 'apps/web/app/console/events/[id]/participants/ParticipantList.tsx'), 'utf8');

test('roster presets reuse the select setters and stay discoverable', () => {
  assert.match(list, /ariaLabel="빠른 상태 보기"/u, 'presets are a labelled group (CountTabs renders aria-pressed buttons)');
  // Reopened 2026-11-24: an extra 출입 filter on top of a status keeps that status tab lit (the old find alone lit nothing).
  assert.match(list, /value=\{ticketFilter \? null : \(rosterPresets\.find\(\(preset\) => statusFilter === preset\.status && attendanceFilter === preset\.attendance\)[\s\S]{0,160}\?\? rosterPresets\.find\(\(preset\) => statusFilter === preset\.status && preset\.attendance === ""\)\)\?\.key \?\? null\}/u, 'active tracking includes both original filters; a ticket filter presses no tab, never 전체');
  assert.match(list, /function applyRosterPreset\(preset: RosterPreset\) \{\s*setStatusFilter\(preset\.status\);\s*setAttendanceFilter\(preset\.attendance\);\s*setTicketFilter\(""\);\s*\}/u, 'presets write through the same setters and clear the ticket-only filter');
  for (const [key, status, attendance] of [['pending', 'PENDING', ''], ['approved', 'APPROVED', ''], ['not-entered', 'APPROVED', 'NOT_ENTERED'], ['all', '', '']]) {
    assert.match(list, new RegExp(`key: "${key}", label: "[^"]+", status: "${status}", attendance: "${attendance}"`, 'u'), `${key} preset keeps its filter pair`);
  }
  // 미입장 follows the established drill-down (확정 + NOT_ENTERED), not a new rule.
  assert.match(list, /matchesAttendance\(person, "NOT_ENTERED"\)/u, 'not-entered uses the shared attendance predicate');
  // Counts ignore status/attendance so chips show distribution, not their own filter.
  assert.match(list, /presetBase\.filter\(\(person\) => person\.status === "PENDING"\)/u, 'pending count is scope-based');
});

// Approved roster design (2026-11-13). See DESIGN.md "참가자 명단 확정 구성"; change only with a new user decision.
test('approved roster design stays locked', () => {
  const list = fs.readFileSync(path.join(ROOT, 'apps/web/app/console/events/[id]/participants/ParticipantList.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'apps/web/app/console/events/[id]/participants/participants.module.css'), 'utf8');
  // One flat ledger: no card box around controls or list.
  assert.match(css, /\.workbenchControls \{[^}]*background: transparent/su, 'controls are not a card');
  assert.match(css, /\.rosterSection \{[^}]*border: 0;[^}]*box-shadow: none/su, 'list is not a card');
  // Reopened 2026-11-20 (owner: 카드 띠도 개수 탭으로): the funnel cards are one row of count
  // tabs that are still the filter. Amber badge only for 승인 대기, never orange.
  assert.match(list, /<CountTabs\s+className=\{styles\.quickPresets\}/u, 'view filters are one row of count tabs');
  assert.doesNotMatch(css, /\.funnel/u, 'the funnel cards are gone');
  assert.match(list, /srLabel: `\$\{preset\.label\} · \$\{preset\.count\}명`/u, 'the tab keeps its full accessible name');
  assert.match(list, /tone: preset\.key === "pending" \? "wait" : "default"/u, 'waiting approvals are flagged amber');
  // Search, filter and tools carry icons; rows carry an initial avatar; the bulk bar actions carry icons.
  assert.match(list, /<span className=\{styles\.searchGlyph\} aria-hidden="true"><SearchIcon \/><\/span>/u, 'search has a magnifier');
  assert.match(list, /<FilterIcon \/>\s*<span>필터/u, 'filter control has a filter icon');
  // Reopened 2026-11-20 (디자인 시스템 적용): the initial avatar is the shared ConsoleAvatar, tinted by status.
  assert.match(list, /<ConsoleAvatar name=\{person\.name\} tone=\{avatarTone\(person\.status\)\} \/>/u, 'rows carry an initial avatar');
  assert.match(list, /icon=\{<UsersIcon \/>\}/u);
  assert.match(list, /<MessageIcon \/> 메시지 작성/u);
  assert.match(list, /data-bulk="danger"/u, 'bulk cancel is marked destructive');
  // Whole row opens the detail dialog; a chevron replaces the 상세 text.
  assert.ok(list.includes('onClick={(event) => openDetailsFromRow(event, person.id)}'), 'row click opens details');
  assert.match(list, /<ChevronRightIcon \/>/u);
  assert.match(css, /\.rosterRow \{ cursor: pointer; \}/u);
  // Reopened 2026-11-20 (owner: the docked column squeezed the table): details are an
  // overlay sheet over the full-width table, never a grid column. It steps through the
  // filtered, sorted roster with 이전/다음 and Up/Down, and keeps one primary approval.
  assert.match(list, /<ConsoleDialog presentation="drawer" title=\{selectedPerson\.name\} titleId=\{`participant-details-\$\{selectedPerson\.id\}`\}/u, 'details use the modal drawer');
  assert.doesNotMatch(list, /presentation="inspector"/u, 'no docked inspector');
  assert.doesNotMatch(css, /rosterWorkbench:has\(/u, 'the table never reflows when details open');
  assert.match(list, /aria-label="이전 참가자"/u);
  assert.match(list, /aria-label="다음 참가자"/u);
  assert.match(list, /event\.key !== "ArrowUp" && event\.key !== "ArrowDown"/u, 'arrow keys step through people');
  assert.match(list, /variant="primary" className=\{styles\.sheetPrimary\}/u, 'the sheet carries the one approve action');
  assert.match(css, /prefers-reduced-motion: reduce\) \{ :global\(\.dialog\)\[role="dialog"\]:has\(> \.rosterSheet\) \{ animation: none/u, 'the slide respects reduced motion');
  // Mobile rows are two lines: no phone line.
  assert.doesNotMatch(list, /styles\.mobileContact/u, 'phone stays in the detail dialog');
  // Utilities and pagination are ghost; the scope action sits in the selection bar.
  assert.match(list, /<ProductButton type="button" variant="ghost" onClick=\{\(\) => setImportOpen\(true\)\}/u);
  assert.match(list, /id="roster-previous-page"\s*variant="ghost"/u);
  assert.match(list, /id="roster-next-page"\s*variant="ghost"/u);
  assert.match(list, /variant="ghost" className=\{styles\.selectionScopeAction\}/u);
});
