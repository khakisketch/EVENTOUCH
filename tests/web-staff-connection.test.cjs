'use strict';

// Reopened 2026-11-24 (audit S3): the staff scan screen had no connection state.
// The strip informs only; scan confirmation and lost-response recovery are untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'apps', 'web', 'app', 'staff');
const hook = fs.readFileSync(path.join(root, 'use-staff-connection.ts'), 'utf8');
const work = fs.readFileSync(path.join(root, 'StaffEventWork.tsx'), 'utf8');

test('the staff connection hook listens to online and offline and waits five seconds before calling a request slow', () => {
  assert.match(hook, /addEventListener\("online"/u);
  assert.match(hook, /addEventListener\("offline"/u);
  assert.match(hook, /removeEventListener\("offline"/u);
  assert.match(hook, /STAFF_SLOW_AFTER_MS = 5000/u);
  assert.match(hook, /useState\(true\)/u, 'starts online so hydration matches');
});

test('the staff screen shows an offline alert and a slow notice without touching scan handling', () => {
  assert.match(work, /useStaffConnection\(submitting \|\| rewardCollectingId !== null\)/u);
  assert.match(work, /!connection\.online \? <StaffNote id="staff-connection-offline" tone="danger" role="alert">\{STAFF_OFFLINE_MESSAGE\}/u);
  assert.match(work, /connection\.slow \? <StaffNote id="staff-connection-slow" tone="warn" role="status">\{STAFF_SLOW_MESSAGE\}/u);
  assert.match(hook, /연결이 끊겼습니다\. 연결을 확인하기 전에는 스캔하지 마세요/u);
  assert.match(hook, /연결이 느립니다/u);
  // The strip must not feed any scan gate.
  assert.doesNotMatch(work, /connection\.online[^\n]*(scanBusyRef|writeLocked|pendingScanRef)/u);
  assert.doesNotMatch(work.slice(work.indexOf('async function submitTicket'), work.indexOf('async function onScan')), /connection\./u);
});
