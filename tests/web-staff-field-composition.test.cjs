'use strict';

// Locks the approved staff field screen (DESIGN.md "스태프 현장 화면 확정 구성",
// mockup staff-field2.html): the camera is the stage and stays open between
// people; a plain success hands itself back; information is not an error;
// only decisions hold the screen; lists and forms open as sheets on demand.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '../apps/web/app');
const work = fs.readFileSync(path.join(app, 'staff/StaffEventWork.tsx'), 'utf8');
const css = fs.readFileSync(path.join(app, 'staff/staff-event-work.module.css'), 'utf8');
const camera = fs.readFileSync(path.join(app, 'CameraScan.tsx'), 'utf8');
const cameraCss = fs.readFileSync(path.join(app, 'camera-scan.module.css'), 'utf8');
const operations = fs.readFileSync(path.join(__dirname, '../server/commands/operations.js'), 'utf8');

test('the camera stays open between people and never reads one code twice', () => {
  const detected = work.slice(work.indexOf('onDetected={(code) => {'), work.indexOf('onClose={() => setCameraOpen(false)}'));
  assert.doesNotMatch(detected, /setCameraOpen\(false\)/, 'a detection no longer closes the camera');
  const submit = work.slice(work.indexOf('async function submitTicket'), work.indexOf('async function onScan'));
  assert.doesNotMatch(submit, /setCameraOpen\(false\)/);
  assert.match(work, /suspended=\{scanSuspended\}/);
  assert.match(work, /const scanSuspended = submitting \|\| result\.kind !== "idle" \|\| writeLocked \|\| sheet !== null/);
  // Field variant: continuous decode, hold-in-view and 3s repeat guards, wake lock, torch.
  assert.match(camera, /variant\?: "panel" \| "field"/);
  assert.match(camera, /const stillInView = same && at - lastSeenRef\.current < 1500/);
  assert.match(camera, /same && at - lastFiredRef\.current < 3000/);
  assert.match(camera, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(camera, /advanced: \[\{ torch: next \}/);
  // The attendee booth camera keeps its one-shot behavior.
  assert.match(camera, /doneRef\.current = true;\s*window\.clearTimeout\(hintTimer\);/);
});

test('a plain success hands itself back; anything that needs a decision holds', () => {
  assert.match(work, /const autoMs = autoNext \? \(plainSuccess \? 1500 : infoAuto \? 3000 : 0\) : 0/);
  for (const hold of ['!correctionLocked', '!rewardCollectUncertain', '!directionReview', '!nametagOpen', '!writeLocked', '!correctUnknown', '!rewardHold']) {
    assert.ok(work.includes(`&& ${hold}`) || work.includes(`${hold} &&`), `a success holds while ${hold}`);
  }
  assert.match(work, /<AutoAdvance key=\{`advance-\$\{resultSeq\}`\}/);
  assert.match(work, /aria-label="다음 참가자" onClick=\{prepareNextParticipant\}/, 'a tap hands back at once');
  assert.match(work, /결과 자동 넘김|autoNext/);
});

test('already-entered is information; a definitive failure is acknowledged, not retried', () => {
  assert.match(work, /alreadyIn: isDesk && res\.status === 409 && data\?\.code === "ALREADY_CHECKED_IN"/);
  assert.match(operations, /'이미 입장한 참가자입니다\. 중복 처리하지 않았습니다\.', undefined, 'ALREADY_CHECKED_IN'/);
  assert.match(work, /const infoFailure = result\.kind === "failed" && !result\.uncertain && \(result\.alreadyIn === true \|\| boothLimitReached\)/);
  assert.match(work, /\{!infoAuto \? <div className=\{prizeStyles\.overlayPanel\}>\{resultActions\}<\/div> : null\}/, 'no button while information hands itself back; the buttons live inside the result region');
  assert.match(work, /onClick=\{retryFailedScan\}>\s*확인\s*</);
  assert.doesNotMatch(work, /onClick=\{retryFailedScan\}>\s*다시 시도\s*</);
});

test('lists and forms open only on demand, as sheets with a visible close', () => {
  for (const title of ['티켓 코드 입력', '명단에서 찾기', '최근 처리', '입장·퇴장 기록 정정', '경품 확인·수령']) {
    assert.match(work, new RegExp(`<ConsoleDialog title="${title}" presentation="drawer" stickyChrome`), `${title} is a sheet`);
  }
  assert.match(work, /className=\{prizeStyles\.bar3\}/, 'three quiet buttons under the camera');
  assert.doesNotMatch(work, /activity-heading">/, 'no standing recent list under the scan');
  assert.match(work, /const \[lastScan, setLastScan\]/, 'the last scan stays correctable after it hands back');
});

test('field screen is token-only, in normal flow and thumb sized', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(/);
  assert.doesNotMatch(cameraCss, /#[0-9a-fA-F]{3,8}\b|rgb\(/);
  assert.match(css, /\.fieldStage\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(css, /\.overlay\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.bar3 button\s*\{[^}]*min-height:\s*64px/s);
  assert.match(css, /\.scanPrimary\s*\{[^}]*min-height:\s*60px/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.timer i \{ animation: none; \} \}/);
});
