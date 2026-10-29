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
  assert.match(list, /const presetActive = statusFilter === preset\.status && attendanceFilter === preset\.attendance/u, 'active tracking reads both filters');
  assert.match(list, /function applyRosterPreset\(preset: RosterPreset\) \{\s*setStatusFilter\(preset\.status\);\s*setAttendanceFilter\(preset\.attendance\);\s*\}/u, 'presets write through the same setters');
  for (const [key, status, attendance] of [['pending', 'PENDING', ''], ['approved', 'APPROVED', ''], ['not-entered', 'APPROVED', 'NOT_ENTERED'], ['all', '', '']]) {
    assert.match(list, new RegExp(`key: "${key}", label: "[^"]+", status: "${status}", attendance: "${attendance}"`, 'u'), `${key} preset keeps its filter pair`);
  }
  // 미입장 follows the established drill-down (확정 + NOT_ENTERED), not a new rule.
  assert.match(list, /matchesAttendance\(person, "NOT_ENTERED"\)/u, 'not-entered uses the shared attendance predicate');
  // Counts ignore status/attendance so chips show distribution, not their own filter.
  assert.match(list, /presetBase\.filter\(\(person\) => person\.status === "PENDING"\)/u, 'pending count is scope-based');
});
