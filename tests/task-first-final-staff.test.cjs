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
  const mobile = css.slice(css.indexOf('@media (max-width: 560px)'));
  assert.match(mobile, /\.recentRow\s*\{[^}]*flex-direction: column/s);
  assert.match(mobile, /\.recentRow span\s*\{[^}]*flex: none/s);
});
