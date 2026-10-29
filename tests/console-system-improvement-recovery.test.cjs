'use strict';

// UI cohesive resilience unit: login session race, staff correction replay,
// attendee failure taxonomy, deferred camera, and explicit runtime recovery.
// Static source assertions on purpose: they pin the seam without booting
// Next.js. Rendered verification happens outside the suite (main owns
// DB/browser/servers).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

test('login-session-never-blocks-the-form-and-loses-no-race', () => {
  const form = read('app/login/LoginForm.tsx');
  // /auth/me carries an explicit ceiling instead of hanging the form.
  assert.match(form, /AbortController/);
  assert.match(form, /10000/);
  // A hung session read degrades to a stale flag with a same-context
  // recheck, not to an endless spinner.
  assert.match(form, /sessionStale/);
  assert.match(form, /세션 다시 확인/);
  assert.match(form, /setSessionCheck/);
  // The form renders while the session is being checked: only the
  // bounded setup-state check may take over the screen.
  assert.doesNotMatch(form, /if \(checkingSession \|\| setupState/);
  assert.match(form, /입력은 바로 시작할 수 있습니다/);
  // Race guard: the submit moves an epoch; a stale /auth/me read that
  // started earlier must not redirect over the fresh sign-in.
  assert.match(form, /loginEpochRef/);
  assert.match(form, /epochAtStart/);
  assert.match(form, /loginEpochRef\.current !== epochAtStart/);
  assert.match(form, /loginEpochRef\.current \+= 1/);
  // Synchronous double-submit guard backs the submitting state.
  assert.match(form, /submitGateRef = useRef\(false\)/);
  assert.match(form, /submitGateRef\.current = true/);
  assert.match(form, /submitGateRef\.current = false/);
  // Retry wiring keeps the established setup-state contract.
  assert.match(form, /setupState/);
  assert.match(form, /설정 상태 다시 확인/);
});

test('staff-correction-replays-the-same-request-id', () => {
  const work = read('app/staff/StaffEventWork.tsx');
  // Synchronous double-click guard backs the correcting state.
  assert.match(work, /correctingRef = useRef\(false\)/);
  assert.match(work, /if \(correctingRef\.current/);
  assert.match(work, /correctingRef\.current = true/);
  assert.match(work, /correctingRef\.current = false/);
  // Full request context is retained and replayed verbatim: the outgoing
  // URL and body use the STORED event/assignment, never the currently
  // selected desk. A desk switch mid-flight cannot turn the same id into a
  // different request.
  assert.match(work, /buildCorrectionPending\(\{/);
  assert.match(work, /eventId: activeScope\.eventId/);
  assert.match(work, /assignmentId: assignment\.id/);
  assert.match(work, /pendingCorrectRef\.current = pending;/);
  assert.match(work, /encodeURIComponent\(pending\.eventId\)/);
  assert.match(work, /assignmentId: pending\.assignmentId/);
  assert.match(work, /payload: \{ id: pending\.checkId, reason: pending\.reason \}/);
  // Minted and stored BEFORE the first await: a rapid second attempt (or a
  // render between ticks) reuses the identity instead of minting another.
  assert.match(work, /pendingCorrectRef\.current = pending;[\s\S]*?correctingRef\.current = true;[\s\S]*?await operatorFetch/);
  assert.match(work, /408/);
  assert.match(work, /res\.status >= 500/);
  // Visible unknown status with a same-request retry; the reason field
  // locks until the verdict is known so the pending payload cannot change.
  assert.match(work, /correctUnknown/);
  assert.match(work, /같은 요청으로 다시 시도/);
  // The lock predicate now covers correction-unresolved OR organization-
  // changed; the retry path itself stays on `correcting` only.
  assert.match(work, /const writeLocked = correctionLocked \|\| orgChanged;/);
  assert.match(work, /disabled=\{writeLocked\}/);
  assert.match(work, /대상·사유를 바꾸지 말고/);
  assert.match(work, /role=\{correctUnknown \? "alert" : "status"\}/);
  assert.match(work, /retrySame/);
  // Desk/task/kiosk/scan lock while the outcome is unresolved, with a clear
  // pending reason; only the retry path stays enabled.
  assert.match(work, /isCorrectionLocked\(correcting, correctUnknown\)/);
  assert.match(work, /정정 응답을 확인하는 중입니다/);
  // Leaving with an unconfirmed correction warns: in-app back link
  // confirms, real unloads get the platform dialog.
  assert.match(work, /beforeunload/);
  assert.match(work, /떠나면 같은 요청으로 다시 시도할 수 없습니다/);
  // Preserved semantics: normal scan receipt, unsaved-form behavior, and
  // no offline queue (the id stays for replay, nothing is stored).
  assert.match(work, /scanBusyRef/);
  assert.match(work, /같은 업무·티켓으로 다시 시도/);
  assert.doesNotMatch(work, /localStorage/);
  assert.doesNotMatch(work, /navigator\.onLine/);
});

test('correction-identity-retains-exact-assignment-at-runtime', async () => {
  // Runtime seam: execute the exact module the component uses. A desk
  // switch must change the key (and therefore the id) instead of replaying
  // an unrelated correction under the same identity.
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(WEB, 'app', 'staff', 'correction-retry.ts')).href);
  const { buildCorrectionPending, correctionAttemptKey, isCorrectionLocked } = mod;
  const base = { eventId: 'ev-1', assignmentId: 'as-1', checkId: 'ck-1', reason: '오스캔' };
  const first = buildCorrectionPending({ ...base, stored: null });
  assert.strictEqual(typeof first.commandId, 'string');
  assert.ok(first.commandId.length > 0);
  assert.strictEqual(first.eventId, 'ev-1');
  assert.strictEqual(first.assignmentId, 'as-1');
  assert.strictEqual(first.checkId, 'ck-1');
  assert.strictEqual(first.reason, '오스캔');
  // Same context + payload replays the identical id.
  const replay = buildCorrectionPending({ ...base, stored: first });
  assert.strictEqual(replay.key, first.key);
  assert.strictEqual(replay.commandId, first.commandId);
  assert.strictEqual(replay.eventId, first.eventId);
  assert.strictEqual(replay.assignmentId, first.assignmentId);
  // Same id, different assignment: NOT the same request — the key must
  // differ so a fresh id is minted instead of reusing the stored one.
  const switched = buildCorrectionPending({ ...base, assignmentId: 'as-2', stored: first });
  assert.notStrictEqual(switched.key, first.key);
  assert.notStrictEqual(switched.commandId, first.commandId);
  assert.strictEqual(switched.assignmentId, 'as-2');
  assert.strictEqual(switched.eventId, 'ev-1');
  // Reason or record edits likewise mint a fresh identity.
  assert.notStrictEqual(
    buildCorrectionPending({ ...base, reason: '다른 사유', stored: first }).commandId,
    first.commandId
  );
  assert.notStrictEqual(
    buildCorrectionPending({ ...base, checkId: 'ck-2', stored: first }).commandId,
    first.commandId
  );
  // The key itself binds the full context: no two differing contexts share one.
  assert.notStrictEqual(
    correctionAttemptKey('ev-1', 'as-1', 'ck-1', '오스캔'),
    correctionAttemptKey('ev-1', 'as-2', 'ck-1', '오스캔')
  );
  assert.notStrictEqual(
    correctionAttemptKey('ev-1', 'as-1', 'ck-1', '오스캔'),
    correctionAttemptKey('ev-2', 'as-1', 'ck-1', '오스캔')
  );
  // Lock predicate: anything unresolved locks the surrounding controls.
  assert.strictEqual(isCorrectionLocked(false, false), false);
  assert.strictEqual(isCorrectionLocked(true, false), true);
  assert.strictEqual(isCorrectionLocked(false, true), true);
  assert.strictEqual(isCorrectionLocked(true, true), true);
});

test('attendee-home-distinguishes-404-ticket-and-transient', () => {
  const shell = read('app/event/[slug]/home/HomeShell.tsx');
  // Three reasons, three recoveries: unknown slug, rejected ticket,
  // dropped connection.
  assert.match(shell, /reason: "event-missing" \| "ticket-invalid" \| "transient"/);
  assert.match(shell, /행사를 찾을 수 없습니다/);
  assert.match(shell, /티켓을 확인할 수 없습니다/);
  assert.match(shell, /행사를 불러올 수 없습니다/);
  // Same-tab retry: only the reload tick moves; the open ?view= tab and
  // the tab-kept bearer are untouched.
  assert.match(shell, /retrySameTab/);
  assert.match(shell, /setReloadTick\(\(tick\) => tick \+ 1\)/);
  assert.match(shell, /다시 시도/);
  // Ticket read path: a 404 verdict stops replaying the bearer (like the
  // ticket screen); a transient failure keeps it for the retry.
  assert.match(shell, /removeItem\(STORAGE_PREFIX \+ slug\)/);
  assert.match(shell, /ticketRes\.status === 404/);
  // Recovery links stay scoped: invalid tickets point at recovery (unless
  // the event blocks it), missing events point home.
  assert.match(shell, /내 티켓 찾기/);
  assert.match(shell, /처음으로/);
  // Missing ticket without any bearer is still the ready hasTicket=false
  // state, not an error panel.
  assert.match(shell, /hasTicket: false/);
});

test('camera-loads-only-on-scan-start-and-yields-when-hidden', () => {
  const scan = read('app/CameraScan.tsx');
  // No static decoder import: jsQR arrives with the first scan.
  assert.doesNotMatch(scan, /import jsQR from/);
  assert.match(scan, /await import\("jsqr"\)/);
  assert.match(scan, /스캐너를 불러오지 못했습니다/);
  // Availability guard accepts a real camera API and rejects everything
  // else (the inverted `=== "function"` check rejected every supported
  // browser, so both directions are pinned here and executed below).
  assert.match(scan, /isCameraApiAvailable\(media\)/);
  assert.doesNotMatch(scan, /typeof media\.getUserMedia === "function"\)/);
  // Constrained capture and throttled decode on a downscaled frame.
  assert.match(scan, /width: \{ ideal: MAX_DECODE_WIDTH \}/);
  assert.match(scan, /height: \{ ideal: MAX_DECODE_HEIGHT \}/);
  assert.match(scan, /shouldAttemptDecode\(now, lastDecode/);
  assert.match(scan, /decodeFrameSize\(videoNode\.videoWidth, videoNode\.videoHeight\)/);
  // Late play resolution after hide/unmount releases the tracks instead of
  // scheduling a loop on a dead surface.
  assert.match(scan, /if \(stopped \|\| hidden \|\| doneRef\.current\) \{\s*\n\s*stopStream\(\);/);
  // A decoded result releases the camera immediately instead of waiting
  // for the caller to unmount on a slow network.
  assert.match(scan, /stopLoop\(\);\s*\n\s*stopStream\(\);\s*\n\s*onDetectedRef\.current/);
  // Hidden tabs keep no camera: tracks stop, the loop stops, cleanup
  // removes the listener; reopening (not the tab) restarts it.
  assert.match(scan, /visibilitychange/);
  assert.match(scan, /document\.hidden/);
  assert.match(scan, /화면이 가려져 카메라를 멈췄습니다/);
  assert.match(scan, /removeEventListener\("visibilitychange"/);
  // Failure copy still points at the manual path.
  assert.match(scan, /manualHint/);
});

test('scan-frame-budget-executes-at-runtime', async () => {
  // Runtime seam, not source pattern-matching: import the exact module the
  // component uses and execute its decisions.
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(WEB, 'app', 'scan-frame.ts')).href);
  const { isCameraApiAvailable, decodeFrameSize, shouldAttemptDecode } = mod;
  assert.strictEqual(typeof isCameraApiAvailable, 'function');
  // The reported bug shape: a valid camera API must be accepted.
  assert.strictEqual(isCameraApiAvailable({ getUserMedia: async () => ({}) }), true);
  // Everything else falls back to the manual code path.
  assert.strictEqual(isCameraApiAvailable(undefined), false);
  assert.strictEqual(isCameraApiAvailable(null), false);
  assert.strictEqual(isCameraApiAvailable({}), false);
  assert.strictEqual(isCameraApiAvailable({ getUserMedia: 'yes' }), false);
  assert.strictEqual(isCameraApiAvailable('camera'), false);
  // Budget: caps respected, aspect preserved, never upscaled.
  assert.deepStrictEqual(decodeFrameSize(1920, 1080), { width: 640, height: 360 });
  assert.deepStrictEqual(decodeFrameSize(640, 480), { width: 640, height: 480 });
  assert.deepStrictEqual(decodeFrameSize(320, 240), { width: 320, height: 240 });
  for (const [w, h] of [[3840, 2160], [1280, 720], [640, 480], [320, 240], [480, 640]]) {
    const frame = decodeFrameSize(w, h);
    assert.ok(frame.width <= 640 && frame.height <= 480, `${w}x${h} exceeds budget`);
    assert.ok(frame.width >= 1 && frame.height >= 1, `${w}x${h} collapses`);
    const expected = w / h;
    const actual = frame.width / frame.height;
    assert.ok(Math.abs(expected - actual) < 0.01, `${w}x${h} distorts aspect`);
  }
  // Degenerate inputs collapse instead of producing NaN/zero sizes.
  for (const [w, h] of [[0, 480], [640, 0], [-1, 480], [NaN, 480], [640, Infinity]]) {
    assert.deepStrictEqual(decodeFrameSize(w, h), { width: 1, height: 1 });
  }
  // Throttle: a 1s window of 60fps ticks admits at most 6 decodes.
  let last = -1000;
  let decodes = 0;
  for (let t = 0; t <= 1000; t += 16) {
    if (shouldAttemptDecode(t, last)) {
      last = t;
      decodes += 1;
    }
  }
  assert.ok(decodes <= 6, `throttle admits ${decodes} decodes/s`);
  assert.ok(decodes >= 4, `throttle starves decode (${decodes}/s)`);
  assert.strictEqual(shouldAttemptDecode(200, 0), true);
  assert.strictEqual(shouldAttemptDecode(199, 0), false);
  assert.strictEqual(shouldAttemptDecode(100, 0, 100), true);
});

test('camera-consumers-defer-the-scanner-bundle', () => {
  for (const rel of ['app/staff/StaffEventWork.tsx', 'app/event/[slug]/home/HomeShell.tsx']) {
    const source = read(rel);
    assert.match(source, /import dynamic from "next\/dynamic"/);
    assert.match(source, /dynamic\(\(\) => import\(/);
    assert.match(source, /ssr: false/);
    assert.doesNotMatch(source, /import CameraScan from/);
  }
  const work = read('app/staff/StaffEventWork.tsx');
  assert.match(work, /카메라를 준비하고 있습니다/);
});

test('runtime-errors-recover-explicitly-without-auto-reload', () => {
  const root = read('app/error.tsx');
  assert.match(root, /retry: \(\) => void/);
  assert.match(root, /<RuntimeRecovery error=\{error\} retry=\{retry\}/);
  assert.doesNotMatch(root, /location\.reload/);
  assert.doesNotMatch(root, /window\.location/);
  const global = read('app/global-error.tsx');
  assert.match(global, /<html/);
  assert.match(global, /<body/);
  assert.match(global, /retry: \(\) => void/);
  assert.match(global, /<RuntimeRecovery error=\{error\} standalone/);
  assert.doesNotMatch(global, /location\.reload/);
  assert.doesNotMatch(global, /generateMetadata|export const metadata/);
  const recovery = read('app/RuntimeRecovery.tsx');
  assert.match(recovery, /입력 중이던 내용[\s\S]*유지되지[\s\S]*않을[\s\S]*수 있습니다/);
  assert.match(recovery, /onClick=\{retrySegment\}/);
  assert.match(recovery, /onClick=\{reloadDocument\}/);
  assert.match(recovery, /function reloadDocument\(\)[\s\S]*?if \(requestGate\.current\) return;[\s\S]*?window\.location\.reload\(\)/);
  assert.doesNotMatch(recovery, /setInterval|setTimeout/);
});
