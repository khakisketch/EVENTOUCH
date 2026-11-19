'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('apps/web/app/staff/StaffEventWork.tsx', 'utf8');

test('single assigned desk is selected, zero/multiple desks still require a choice', () => {
  const expression = source.match(/setDeskId\((next\.desks\.length === 1 \? next\.desks\[0\]\.id : "")\);/);
  assert.ok(expression);
  const select = new Function('next', `return ${expression[1]}`);
  assert.equal(select({ desks: [] }), '');
  assert.equal(select({ desks: [{ id: 'desk-one' }] }), 'desk-one');
  assert.equal(select({ desks: [{ id: 'desk-one' }, { id: 'desk-two' }] }), '');
});

test('single desk shortcut keeps explicit scan, direction, server permission and result recovery', () => {
  assert.match(source, /selectedDesk\?\.action === "OUT"/);
  assert.match(source, /id="staff-desk"/);
  assert.match(source, /id="staff-ticket"/);
  assert.match(source, /check\.scan/);
  assert.match(source, /다음 참가자/);
  assert.match(source, /다시 불러오기/);
});

test('mobile recent activity text uses its content height, not the desktop width basis', () => {
  const css = fs.readFileSync('apps/web/app/staff/staff-event-work.module.css', 'utf8');
  // Recent rows are one line: name and detail grow, the time keeps its own width.
  // Reopened 2026-11-20 (design-system application): the stacked redesign layers were merged, so the
  // rows no longer need the .eventWorkPage prefix to win; the one-line contract is unchanged.
  assert.match(css, /\.recentRow\s*\{[^}]*flex-wrap: nowrap/s);
  assert.match(css, /\.recentRow \.recentName span\s*\{[^}]*flex: none/s);
  assert.match(css, /\.recentRow time\s*\{[^}]*flex: none/s);
});
