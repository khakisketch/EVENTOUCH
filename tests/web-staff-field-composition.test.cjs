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
  // Reopened 2026-11-26: an exit scan for someone already out is information too.
  assert.match(work, /const infoFailure = result\.kind === "failed" && !result\.uncertain && \(result\.alreadyIn === true \|\| result\.alreadyOut === true \|\| boothLimitReached\)/);
  assert.match(work, /\{!infoAuto \? <div className=\{prizeStyles\.overlayPanel\}>\{resultActions\}<\/div> : null\}/, 'no button while information hands itself back; the buttons live inside the result region');
  assert.match(work, /onClick=\{retryFailedScan\}>\s*확인\s*</);
  assert.doesNotMatch(work, /onClick=\{retryFailedScan\}>\s*다시 시도\s*</);
});

test('already-entered adds who and when as one quiet line, never a new control', () => {
  // The server supplies details (owner decision 2026-11-18); the notice only reads them.
  assert.match(operations, /'이미 입장한 참가자입니다\. 중복 처리하지 않았습니다\.', undefined, 'ALREADY_CHECKED_IN', alreadyCheckedInDetails\(workspace, person\)/);
  assert.match(work, /\.\.\.\(isDesk && res\.status === 409 && data\?\.code === "ALREADY_CHECKED_IN" \? alreadyInDetails\(data\?\.details\) : \{\}\)/);
  // Reopened 2026-11-26: "already out" shares the quiet line and says 퇴장.
  assert.match(work, /const alreadyDone = result\.kind === "failed" && Boolean\(result\.alreadyIn \|\| result\.alreadyOut\)/);
  assert.match(work, /\{alreadyDone && \(result\.alreadyName \|\| result\.alreadyAt\) \? \(\s*<p className=\{prizeStyles\.subLine\}>/, 'the line reuses the existing subLine style');
  assert.match(work, /`\$\{formatCheckTime\(result\.alreadyAt\)\} 퇴장`/);
  assert.match(work, /`\$\{formatCheckTime\(result\.alreadyAt\)\} 입장`/, 'the time reads like the 최근 처리 list');
  // Nothing about the screen's structure changes: still information, still auto-advances, still no button.
  // Reopened 2026-11-26: an exit scan for someone already out is information too.
  assert.match(work, /const infoFailure = result\.kind === "failed" && !result\.uncertain && \(result\.alreadyIn === true \|\| result\.alreadyOut === true \|\| boothLimitReached\)/);
  assert.match(work, /\{!infoAuto \? <div className=\{prizeStyles\.overlayPanel\}>\{resultActions\}<\/div> : null\}/);
});

test('alreadyInDetails keeps only a usable name and time and never throws on odd details', () => {
  const ts = require('../apps/web/node_modules/typescript');
  const vm = require('node:vm');
  const start = work.indexOf('function alreadyInDetails(');
  const end = work.indexOf('function identityKey(');
  assert.ok(start > 0 && end > start);
  const js = ts.transpileModule(`${work.slice(start, end)}\nthis.result = alreadyInDetails;`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const sandbox = {};
  vm.runInNewContext(js, sandbox);
  const details = (value) => JSON.parse(JSON.stringify(sandbox.result(value)));
  assert.deepEqual(details({ name: ' 홍길동 ', firstCheckedInAt: '2026-11-18T05:13:00.000Z' }), { alreadyName: '홍길동', alreadyAt: '2026-11-18T05:13:00.000Z' });
  assert.deepEqual(details({ name: '홍길동', firstCheckedInAt: null }), { alreadyName: '홍길동' }, 'no entry time on record: name only');
  assert.deepEqual(details({ name: '', firstCheckedInAt: 'not-a-time' }), {}, 'blank name and an unreadable time are dropped');
  for (const odd of [undefined, null, 'text', 7, [], [{ name: 'x' }], { name: 5, firstCheckedInAt: {} }]) {
    assert.deepEqual(details(odd), {}, `ignored: ${JSON.stringify(odd)}`);
  }
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
  assert.match(css, /\.bar3 button\s*\{[^}]*min-height:\s*72px/s);
  assert.match(css, /\.scanPrimary\s*\{[^}]*min-height:\s*60px/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.timer i \{ animation: none; \} \}/);
});

// Reopened 2026-11-19: the dark column gets presence without changing the flow.
test('field column: segmented desk/booth switch, pill station title, lit viewfinder, icon tiles', () => {
  // Reopened 2026-11-20: 999px became var(--r-pill).
  assert.match(css, /\.fieldContext \.taskSwitch\s*\{[^}]*border-radius:\s*var\(--r-pill\)/s, 'the desk/booth switch is one segmented pill');
  assert.match(css, /\.fieldContext :global\(\.staff-select-field\) select\s*\{[^}]*border-radius:\s*var\(--r-pill\)/s, 'the station select is a pill title');
  assert.match(css, /\.idleFrame::after\s*\{[^}]*linear-gradient/s, 'the idle viewfinder carries a scan line');
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.idleFrame::after \{ animation/s, 'the scan line moves only for motion-tolerant users');
  assert.match(work, /icon=\{<CameraIcon \/>\}/, 'the one orange action carries a camera glyph');
});

// Reopened 2026-11-26 (door-day audit): an ended login, refusals that wait for the event lead,
// "already out", and a card request id that survives a lost response.
test('already-out details reuse the already-in reading with the exit time', () => {
  const ts = require('../apps/web/node_modules/typescript');
  const vm = require('node:vm');
  const source = work.slice(work.indexOf('function alreadyInDetails('), work.indexOf('function identityKey('));
  const js = ts.transpileModule(`${source}\nthis.result = alreadyOutDetails;`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const sandbox = {};
  vm.runInNewContext(js, sandbox);
  const details = (value) => JSON.parse(JSON.stringify(sandbox.result(value)));
  assert.deepEqual(details({ name: '홍길동', lastCheckedOutAt: '2026-11-26T05:13:00.000Z' }), { alreadyName: '홍길동', alreadyAt: '2026-11-26T05:13:00.000Z' });
  assert.deepEqual(details({ name: '홍길동', lastCheckedOutAt: null }), { alreadyName: '홍길동' });
  for (const odd of [undefined, null, 'text', 7]) assert.deepEqual(details(odd), {});
  assert.match(operations, /'ALREADY_CHECKED_OUT', alreadyCheckedOutDetails\(workspace, person\)/);
  assert.match(work, /const alreadyOut = isDesk && res\.status === 409 && data\?\.code === "ALREADY_CHECKED_OUT"/);
});

test('pending, waitlist and payment refusals wait for a decision, like a status conflict', () => {
  for (const code of ['TICKET_APPROVAL_PENDING', 'TICKET_WAITLISTED', 'TICKET_PAYMENT_REQUIRED']) {
    assert.ok(operations.includes(`'${code}'`), code);
    assert.ok(work.includes(`"${code}"`), code);
  }
  assert.match(work, /\["TICKET_STATUS_CONFLICT", "CHECK_OUT_REVIEW_REQUIRED"\]\.includes\(data\.code\) \|\| admissionHold\)/);
  assert.match(work, /‘기다리는 사람’ 목록에서 이 참가자를 선택해 확인하세요\./);
});

test('an ended login offers signing in again in a new tab and never redirects loaded work', () => {
  assert.match(work, /href=\{loginHrefForLocation\(window\.location\.pathname, window\.location\.search\)\} target="_blank" rel="noreferrer"/);
  const load = work.slice(work.indexOf('async function load('), work.indexOf('const lastCheck') > 0 ? work.indexOf('const lastCheck') : work.indexOf('// A reload keeps only a scoped pointer'));
  assert.match(load, /if \(silent\) \{ setSessionExpired\(true\);[^}]*return false; \}\s*router\.push/);
  assert.equal((work.match(/router\.push\(/g) || []).length, 1, 'only the first load, with nothing typed yet, redirects');
  for (const start of ['async function submitTicket', 'async function postRewardCommand', 'async function correctLatest']) {
    assert.match(work.slice(work.indexOf(start)).slice(0, 9000), /status === 401\) setSessionExpired\(true\)/, start);
  }
  // The warning, the failed result and the open sheets all carry the same action.
  assert.match(work, /\{signedOut \? <StaffNote tone="warn" role="alert">/);
  assert.match(work, /<div className=\{prizeStyles\.nextActions\}>\s*\{relogin\}/);
  assert.equal((work.match(/\{signedOutLine\}/g) || []).length, 3, 'correction, rewards and name search');
});

test('a desk card keeps one request id until the server answers definitely; printing does not', async () => {
  const ts = require('../apps/web/node_modules/typescript');
  const vm = require('node:vm');
  const arrivals = fs.readFileSync(path.join(app, 'staff/DeskArrivals.tsx'), 'utf8');
  const source = arrivals.slice(arrivals.indexOf('const REPLAYABLE'), arrivals.indexOf('export function useDeskArrivals'));
  const js = ts.transpileModule(source.replace('export async function', 'async function') + '\nthis.send = sendDeskCommand;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sent = [];
  let next;
  let ids = 0;
  const sandbox = {
    AbortController, window: { setTimeout: () => 1, clearTimeout: () => {} },
    randomCommandId: () => `id-${++ids}`, abandonOperatorAttempt: () => {}, forgetOperatorReceipt: () => {},
    operatorFetch: async (url, init) => {
      sent.push(JSON.parse(init.body));
      if (next === 'lost') throw new Error('response lost after possible commit');
      return { ok: next[0] < 300, status: next[0], json: async () => next[1] };
    },
  };
  vm.runInNewContext(js, sandbox);
  const send = async (answer, command = 'arrival.handover', payload = { deskId: 'd', arrivalId: 'a' }) => {
    next = answer;
    const result = await sandbox.send('event', command, 'assignment', payload);
    return [sent.at(-1).commandId, result];
  };
  const [first] = await send('lost');
  for (const answer of [[500, {}], [408, {}], [401, {}], [403, {}], [200, null], [409, { code: 'ORGANIZATION_CONTEXT_CHANGED' }]]) {
    assert.equal((await send(answer))[0], first, `still unknown after ${JSON.stringify(answer)}`);
  }
  assert.equal((await send('lost', 'arrival.handover', { deskId: 'd', arrivalId: 'other' }))[0] === first, false, 'another arrival has its own id');
  const [replayed, result] = await send([200, { checkId: first }]);
  assert.deepEqual([replayed, result.ok], [first, true]);
  const [afterSuccess] = await send([409, { code: 'ARRIVAL_CLOSED' }]);
  assert.notEqual(afterSuccess, first);
  assert.notEqual((await send('lost'))[0], afterSuccess, 'a definite refusal releases the id');
  for (const command of ['arrival.claim-print', 'arrival.print-result', 'arrival.record']) {
    const [one] = await send('lost', command);
    assert.notEqual((await send('lost', command))[0], one, `${command} is judged afresh`);
  }
  const [, signedOut] = await send([401, { error: '로그인이 필요합니다' }]);
  assert.equal(signedOut.status, 401);
});

test('a re-entry card offers one admission with a reason, or names who can', () => {
  const arrivals = fs.readFileSync(path.join(app, 'staff/DeskArrivals.tsx'), 'utf8');
  assert.match(arrivals, /const REENTRY_REASONS = \["식사·외출", "기타"\] as const/);
  assert.match(arrivals, /const readmittable = review === "REENTRY" && view\.canReadmit === true/);
  assert.match(arrivals, /disabled=\{busy \|\| !reason\} onClick=\{\(\) => onReadmit\(reason\)\}>재입장 확정/);
  assert.match(arrivals, /재입장은 행사 책임자에게 요청하세요\./);
  assert.match(arrivals, /maxLength=\{200\}/);
  assert.match(work, /onReadmit=\{\(reason\) => void runArrival\(\(\) => handOver\(waiting, reason\)\)\}/);
});
