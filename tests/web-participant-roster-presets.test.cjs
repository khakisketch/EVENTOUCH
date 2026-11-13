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
  assert.match(list, /role="group" aria-label="빠른 상태 보기"/u, 'presets are a labelled group');
  assert.match(list, /aria-pressed=\{presetActive\}/u, 'active preset is announced');
  assert.match(list, /const presetActive = !ticketFilter && statusFilter === preset\.status && attendanceFilter === preset\.attendance/u, 'active tracking includes both original filters and ticket review');
  assert.match(list, /value=\{ticketFilter \? "custom" : rosterPresets\.find/u, 'mobile preset distinguishes a ticket filter from 전체');
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
  // Ink-underline tabs, not orange.
  assert.match(css, /\.quickPresets :global\(\.pill\[aria-pressed="true"\]\) \{[^}]*border-bottom-color: var\(--ink\)/su, 'active tab is ink');
  assert.doesNotMatch(css, /\.quickPresets[^{]*\{[^}]*var\(--brand/su, 'tabs carry no orange');
  // Whole row opens the detail dialog; a chevron replaces the 상세 text.
  assert.ok(list.includes('onClick={(event) => openDetailsFromRow(event, person.id)}'), 'row click opens details');
  assert.match(list, /<ChevronRightIcon \/>/u);
  assert.match(css, /\.rosterRow \{ cursor: pointer; \}/u);
  // Mobile rows are two lines: no phone line.
  assert.doesNotMatch(list, /styles\.mobileContact/u, 'phone stays in the detail dialog');
  // Utilities and pagination are ghost; the scope action sits in the selection bar.
  assert.match(list, /<ProductButton type="button" variant="ghost" onClick=\{\(\) => setImportOpen\(true\)\}/u);
  assert.match(list, /id="roster-previous-page"\s*variant="ghost"/u);
  assert.match(list, /id="roster-next-page"\s*variant="ghost"/u);
  assert.match(list, /variant="ghost" className=\{styles\.selectionScopeAction\}/u);
});
