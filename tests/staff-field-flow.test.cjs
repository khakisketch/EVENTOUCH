'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');

const work = fs.readFileSync(
  path.join(__dirname, '../apps/web/app/staff/StaffEventWork.tsx'),
  'utf8'
);
const styles = fs.readFileSync(
  path.join(__dirname, '../apps/web/app/staff/staff-event-work.module.css'),
  'utf8'
);
const hub = fs.readFileSync(
  path.join(__dirname, '../apps/web/app/staff/StaffHub.tsx'),
  'utf8'
);

test('scan-success-groups-summary-and-next-action-before-auxiliary-acts', () => {
  assert.match(work, /aria-label="스캔 결과"/);
  assert.match(work, /다음 참가자를 스캔하세요/);
  assert.match(work, /className="button button-primary" disabled=\{writeLocked\} onClick=\{prepareNextParticipant\}>\s*다음 참가자/);
  assert.match(work, /const writeLocked = correctionLocked \|\| orgChanged/);
  // Auxiliary nametag stays available but secondary and after the next action.
  const nextIndex = work.indexOf('다음 참가자');
  const nametagIndex = work.indexOf('네임택 인쇄');
  assert.ok(nextIndex !== -1 && nametagIndex !== -1 && nextIndex < nametagIndex);
  assert.match(work, /button-secondary \$\{prizeStyles\.auxAction\}/);
  // No existing copy is dropped: identity, verdict, booth, and reentry stay.
  assert.match(work, /result\.name\}/);
  assert.match(work, /부스 인증/);
  assert.match(work, /재입장/);
});

test('scan-failure-guides-retry-and-manual-entry-without-repeating-itself', () => {
  assert.match(work, /aria-label=\{result\.uncertain \? "스캔 결과 미확인" : "스캔 실패"\}/);
  assert.match(work, /result\.uncertain \? "처리 결과를 확인하지 못했습니다" : result\.attendanceReviewRequired \? "출입 기록 확인이 필요합니다" : result\.eligibilityReviewRequired \? "참가 상태 확인이 필요합니다" : "처리에 실패했습니다"/);
  assert.match(work, /retryFailedRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(work, /scanFailureRef\.current\?\.scrollIntoView\(\{ block: "center", behavior: "instant" \}\)/);
  assert.match(work, /role=\{boothLimitReached \? "status" : "alert"\}>\{result\.message\}/);
  assert.match(work, /카메라가 안 되면 티켓 코드를 직접 입력하세요/);
  assert.match(work, /result\.message\.includes\("다시 시도"\)/);
  assert.match(work, />\s*다시 시도\s*</);
});

test('recent-checks-read-as-one-line-and-offer-next-scan-flow', () => {
  assert.match(work, /같은 티켓을 다시 스캔하면 같은 결과가 나옵니다/);
  assert.match(work, /actionLabel/);
  assert.match(work, /부스 인증/);
  assert.match(work, /정정됨/);
  assert.match(work, /slice\(0, 10\)/);
  // 2026-11-14: 최근 처리 행의 행별 "다음 참가자" 버튼은 결과 면의 주 버튼과 같은
  // 일을 해서 없앴다. 행은 이름·내용·시각만 읽히는 평면 목록이다.
  assert.doesNotMatch(work, /기록 확인 · 다음 참가자 입력 준비/);
  assert.match(work, /prizeStyles\.recentName/);
  assert.match(work, /<time dateTime=\{check\.at\}>\{formatCheckTime\(check\.at\)\}<\/time>/);
  assert.match(work, /onClick=\{prepareNextParticipant\}>\s*다음 참가자\s*</);
});

test('failure-retry-keeps-the-typed-ticket-and-refocuses', () => {
  // 현장 마감 사유: 실패의 "다시 시도"는 같은 티켓 재시도이므로 입력값을
  // 지우면 대기열 앞에서 긴 코드를 다시 치게 된다. 성공 때만 비운다.
  const retry = work.slice(work.indexOf('function retryFailedScan'), work.indexOf('async function copyTicketCode'));
  assert.match(retry, /setResult\(\{ kind: "idle" \}\)/);
  assert.doesNotMatch(retry, /setTicket/);
  assert.match(work, /onClick=\{retryFailedScan\}>\s*다시 시도\s*</);
});

test('pending-scan-temporarily-protects-context-with-a-bounded-uncertain-outcome', () => {
  const scan = work.slice(work.indexOf('async function submitTicket'), work.indexOf('async function onScan'));
  assert.match(scan, /pendingScanIdRef\.current\.get\(attempt\) \?\? randomCommandId\(\)/);
  assert.match(scan, /new AbortController\(\)/);
  assert.match(scan, /window\.setTimeout\(\(\) => controller\.abort\(\), 15000\)/);
  assert.match(scan, /signal: controller\.signal/);
  assert.match(scan, /await load\(true, controller\.signal\)/);
  assert.match(scan, /kind: "failed", uncertain: true/);
  assert.match(scan, /window\.clearTimeout\(timeout\)/);
  assert.match(work, /readOnly=\{submitting\}/);
  assert.match(work, /disabled=\{!ready \|\| writeLocked \|\| submitting\}/);
  const detected = work.slice(work.indexOf('onDetected={(code) => {'), work.indexOf('onClose={() => setCameraOpen(false)}'));
  const guard = detected.indexOf('if (scanBusyRef.current || submitting || writeLocked) return;');
  const replace = detected.indexOf('setTicket(code)');
  assert.ok(guard >= 0 && replace > guard, 'a late camera callback must not replace the in-flight ticket');
});

test('unconfirmed scan offers the original ticket as a direct receipt retry', () => {
  const scan = work.slice(work.indexOf('async function submitTicket'), work.indexOf('async function onScan'));
  assert.match(scan, /JSON\.stringify\(\[activeScope\.eventId, activeAssignment!\.id, activeTask, payload\]\)/);
  assert.match(scan, /pendingScanIdRef\.current\.get\(attempt\) \?\? randomCommandId\(\)/);
  assert.match(scan, /const requestTicket = "ticket" in pending\.payload \? pending\.payload\.ticket : ""/);
  assert.equal((scan.match(/requestTarget: pending\.targetLabel/g) || []).length, 3);
  assert.match(work, /submitTicket\(result\.requestTicket, true\)/);
  assert.match(work, /같은 요청 재확인/);
  assert.match(work, /pendingScanRef\.current !== null \|\| pendingRewardCommandsRef\.current\.size > 0/);
  assert.match(work, /떠나면 같은 요청으로 다시 확인할 수 없습니다/);
  assert.match(work, /const scanControlsLocked = writeLocked \|\| scanUnknown/);
  assert.match(work, /scanInputHasWork && result\.kind !== "ok" && !scanUnknown/);
  assert.match(work, /if \(pendingScanRef\.current\) return;\s*setResult\(\{ kind: "idle" \}\)/);
  assert.match(work, /!correctUnknown && !submitting && !\(result\.kind === "failed" && result\.uncertain\)/);
  assert.match(work, /처리됐을 수 있는 요청의 결과를 아직 확인하지 못했습니다/);
});

test('lost response blocks another ticket and replays the exact frozen desk and booth requests', async () => {
  const source = work.slice(work.indexOf('async function submitTicket'), work.indexOf('async function onScan'));
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  for (const task of ['desk', 'booth']) {
    const calls = [];
    const outcomes = [];
    const abandoned = [], forgotten = [];
    let ids = 0;
    const sandbox = {
      assignment: { id: 'assignment-original' }, activeScope: { eventId: 'event-original' }, activeTask: task,
      deskId: 'desk-original', boothId: 'booth-original', selectedDesk: { name: '원래 데스크', action: 'IN' }, selectedBooth: { name: '원래 부스' },
      scanBusyRef: { current: false }, pendingScanRef: { current: null }, pendingScanIdRef: { current: new Map() },
      receiptRefreshRef: { current: false }, rewardRequestRef: { current: null },
      scanFocusAtSubmitRef: {}, scanEditAtSubmitRef: {}, scanEditRevisionRef: { current: 0 },
      ready: true, submitting: false, writeLocked: false, rewardLookupLoading: false, rewardCollectingId: null,
      manualIdentityConfirmed: false, manualTargetCurrent: null, manualTargetDistinct: false,
      document: { activeElement: null }, window: { setTimeout: () => 1, clearTimeout: () => {} }, AbortController,
      randomCommandId: () => `command-${++ids}`, setSubmitting: () => {}, setCameraOpen: () => {},
      setResult: result => outcomes.push(result), setTicketCopyNotice: () => {}, clearRewardPanel: () => {},
      setLastScannedTicket: () => {}, setRewardTarget: () => {}, setTargetRewards: () => {}, setRewardDataLoaded: () => {},
      setTicket: () => {}, load: async () => {}, rewardEnabled: false, directory: {},
      setManualTarget: () => {}, setManualIdentityConfirmed: () => {}, setManualQuery: () => {},
      abandonOperatorAttempt: id => abandoned.push(id), forgetOperatorReceipt: id => forgotten.push(id),
      operatorFetch: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (calls.length === 1 || calls.length === 3) throw new Error('response lost after possible commit');
        return { ok: true, json: async () => task === 'desk'
          ? { id: 'p', name: '참가자', action: 'IN', checkId: calls.at(-1).body.commandId }
          : { name: '참가자', booth: '원래 부스', visitId: calls.at(-1).body.commandId,
            boothId: 'booth-original', participantId: 'p' } };
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox);
    sandbox.receiptRefreshRef.current = true;
    await sandbox.submitTicket('ticket-original');
    assert.equal(calls.length, 0, 'a status refresh blocks a new scan');
    sandbox.receiptRefreshRef.current = false;
    sandbox.rewardRequestRef.current = Symbol('reward-lookup');
    await sandbox.submitTicket('ticket-original');
    assert.equal(calls.length, 0, 'a reward lookup blocks a new scan before the UI renders');
    sandbox.rewardRequestRef.current = null;
    await sandbox.submitTicket('ticket-original');
    assert.equal(outcomes.at(-1).uncertain, true);
    if (task === 'desk') assert.equal(calls[0].body.payload.expectedAction, 'IN');
    await sandbox.submitTicket('another-ticket');
    assert.equal(calls.length, 1, 'another ticket cannot overwrite the pending request');
    sandbox.assignment = { id: 'different-assignment' };
    sandbox.activeScope = { eventId: 'different-event' };
    sandbox.activeTask = task === 'desk' ? 'booth' : 'desk';
    sandbox.selectedDesk = { name: '방향이 바뀐 데스크', action: 'OUT' };
    sandbox.deskId = 'different-desk'; sandbox.boothId = 'different-booth';
    await sandbox.submitTicket('another-ticket', true);
    assert.deepEqual(calls[1], calls[0], 'retry uses exactly the original URL, command ID, assignment and payload');
    assert.equal(ids, 1);
    assert.equal(outcomes.at(-1).kind, 'ok');
    assert.equal(sandbox.pendingScanRef.current, null);
    // A second uncertain operation is intentionally abandoned; only then is
    // another scan of the same ticket a new operation, not a receipt replay.
    sandbox.assignment = { id: 'assignment-original' }; sandbox.activeScope = { eventId: 'event-original' };
    sandbox.activeTask = task; sandbox.deskId = 'desk-original'; sandbox.boothId = 'booth-original';
    sandbox.selectedDesk = { name: '원래 데스크', action: 'IN' };
    await sandbox.submitTicket('ticket-original');
    assert.equal(outcomes.at(-1).uncertain, true);
    const start = work.indexOf('if (!window.confirm("처리됐을 수 있는 요청');
    const end = work.indexOf('}}>확인 중단하고 다른 업무', start);
    assert.ok(start !== -1 && end !== -1);
    const abandon = ts.transpileModule(`function abandon() { ${work.slice(start, end)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInContext(abandon, sandbox);
    sandbox.window.confirm = () => false;
    sandbox.abandon();
    assert.ok(sandbox.pendingScanRef.current, 'cancel keeps the uncertain request');
    sandbox.window.confirm = () => true;
    sandbox.abandon();
    assert.equal(sandbox.pendingScanRef.current, null);
    assert.deepEqual(abandoned, [calls[2].body.commandId]);
    assert.deepEqual(forgotten, [calls[2].body.commandId]);
    await sandbox.submitTicket('ticket-original');
    assert.notEqual(calls[3].body.commandId, calls[2].body.commandId, 'new scan after deliberate abandonment must not replay the old receipt');
  }
});

test('self-booth-qr-names-its-booth-above-the-code', () => {
  // 현장 마감 사유: 여러 부스가 한 화면에 있을 때 보이는 캡션 없이 QR만
  // 두면 잘못된 부스 코드를 보여주는 실수를 카메라가 걸러내지 못한다.
  // 크기는 햇빛 아래 가독을 위해 220으로 올리고 좁은 화면 넘침만 막는다.
  assert.match(work, /boothQrCaption.*인증 QR/);
  assert.match(work, /size=\{220\}/);
  assert.match(work, /selectedBooth\?\.name/);
  assert.match(styles, /\.boothQrCaption\s*\{/);
  assert.match(styles, /\.boothQr svg\s*\{[^}]*max-width:\s*100%/s);
});

test('field-flow-keeps-touch-size-unobscured-scan-and-kiosk-distinction', () => {
  assert.match(work, /prizeStyles\.scanInput/);
  assert.match(work, /kiosk-mode/);
  // 2026-11-10: 토글이 버튼 문구 전환식이 아닌 role=switch 트랙형으로 바뀌었다. 라벨은 고정 '키오스크'.
  assert.match(work, /role="switch"/);
  assert.match(work, /키오스크/);
  assert.match(styles, /\.nextActions button\s*\{[^}]*min-height:\s*44px/s);
  assert.doesNotMatch(styles, /\.recentRow button/, 'recent rows carry no buttons');
  assert.match(styles, /\.scanPrimary\s*\{[^}]*min-height:\s*56px/s);
  // The former sticky dock covered the desk on a 320×568 screen. Keep the
  // scan area in normal flow and retain the rendered hit-test regression.
  assert.doesNotMatch(styles, /\.scanInput\s*\{[^}]*position:\s*(?:sticky|fixed|absolute)/s);
  assert.doesNotMatch(styles, /\.fallbackBlock\s*\{[^}]*position:\s*(?:sticky|fixed|absolute)/s);
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-crossrole-journey-audit.cjs'), 'utf8');
  assert.match(audit, /\['assigned desk', work320\.locator\('#staff-desk'\)\]/);
  assert.match(audit, /\['camera action', work320\.getByRole\('button'/);
  assert.match(audit, /document\.elementFromPoint/);
  assert.match(audit, /actual\.inViewport && actual\.unobscured/);
  assert.match(styles, /\.nextActions button,[\s\S]*?width:\s*100%/);
});

test('scan-320-fallback-peeks-without-a-fixed-overlay', () => {
  // 320 첫 화면 목적: 고정 오버레이 없이 수동 입력 안내가 보이게 한다.
  // 간격만 조이고 터치 바닥·글자·order·position은 그대로 둔다.
  assert.match(styles, /\.fallbackBlock\s*\{[^}]*scroll-margin-top/s);
  assert.match(styles, /@media\s*\(max-width:\s*360px\)/);
  const small = styles.slice(styles.indexOf('@media (max-width: 360px)'));
  assert.match(small, /\.fallbackBlock/);
  assert.match(small, /scroll-margin-top/);
  const globals = fs.readFileSync(path.join(__dirname, '../apps/web/app/globals.css'), 'utf8');
  assert.match(globals, /\.staff-workspace\s+\.scan-form/);
  assert.match(globals, /@media\s*\(max-width:\s*360px\)[\s\S]*?\.staff-workspace\s+\.scan-form[\s\S]*?border-top:\s*0/);
  // Scan-first order stays: context + camera first, typed code below the hairline.
  // 2026-11-10: 접힌 details 대신 스캔/명단 전환 버튼을 쓴다. 명단 경로는 숨기지 않는다.
  // 순서는 모드 선택 → 안내 → 카메라 → 코드 입력이다.
  const modeOrder = work.indexOf('entryModeSwitch');
  const scanOrder = work.indexOf('prizeStyles.scanContext');
  const cameraOrder = work.indexOf('카메라로 스캔');
  const codeOrder = work.indexOf('코드로 직접 처리');
  assert.ok(modeOrder !== -1 && scanOrder !== -1 && cameraOrder !== -1 && codeOrder !== -1 && modeOrder < scanOrder && scanOrder < cameraOrder && cameraOrder < codeOrder);
});

test('scan-result-binds-request-location-not-current-selection', () => {
  // 결과 위치는 요청 스냅샷에 결부한다. 현재 선택값 재계산 금지.
  assert.match(work, /type ScanPlace/);
  assert.match(work, /place:\s*ScanPlace/);
  assert.match(work, /const requestPlace/);
  assert.match(work, /selectedDesk\?\.name/);
  assert.match(work, /selectedBooth\?\.name/);
  const scan = work.slice(work.indexOf('async function submitTicket'), work.indexOf('async function onScan'));
  const snapshotAt = scan.indexOf('const requestPlace');
  const attemptAt = scan.indexOf('JSON.stringify([activeScope.eventId');
  assert.ok(snapshotAt !== -1 && attemptAt !== -1 && snapshotAt < attemptAt, 'location snapshot must precede the idempotent attempt key');
  assert.match(scan, /place:\s*requestPlace/);
  // Late/uncertain responses keep the original place: every failed/ok verdict carries it.
  const okVerdicts = scan.match(/place:\s*requestPlace/g) || [];
  assert.ok(okVerdicts.length >= 4, `expected request-bound place on ok + all failed paths, saw ${okVerdicts.length}`);
  // Rendered location never re-reads the live selector.
  assert.match(work, /처리 위치:.*result\.place\.placeName/s);
  assert.match(work, /result\.place\.actionLabel/);
  assert.doesNotMatch(work, /처리 위치:[^}]*selectedDesk\?\.name/s);
  assert.doesNotMatch(work, /처리 위치:[^}]*deskId\)\?\.name/s);
  // Nametag also binds the request desk, not the live selection.
  assert.match(work, /context:\s*`\$\{result\.place\.placeName\} · 입장`/);
});

test('scan-result-clears-when-context-changes-so-stale-place-never-sticks', () => {
  // 미확인 뒤 다른 데스크/티켓을 고르면 결과가 바뀌며 제거된다.
  // 늦은 응답이 와도 이전 결과에 잘못 붙지 않는다.
  const deskChange = work.slice(work.indexOf("id=\"staff-desk\""), work.indexOf("id=\"staff-desk\"") + 1200);
  assert.match(deskChange, /setResult\(\{ kind: "idle" \}\)/);
  const boothChange = work.slice(work.indexOf("id=\"staff-booth\""), work.indexOf("id=\"staff-booth\"") + 1200);
  assert.match(boothChange, /setResult\(\{ kind: "idle" \}\)/);
  assert.match(work, /setTask\("desk"\)[\s\S]*?setResult\(\{ kind: "idle" \}\)/);
  assert.match(work, /setTask\("booth"\)[\s\S]*?setResult\(\{ kind: "idle" \}\)/);
  // Uncertain keeps the id for same-request retry; definitive clears it.
  const scan = work.slice(work.indexOf('async function submitTicket'), work.indexOf('async function onScan'));
  assert.match(scan, /if \(!uncertain\) \{\s*pendingScanIdRef\.current\.delete\(attempt\);\s*pendingScanRef\.current = null;/);
  assert.match(scan, /const deskChanged = isDesk && res\.status === 409 &&\s*\(data\?\.code === "DESK_ACTION_CHANGED" \|\| data\?\.code === "DESK_CLOSED"\)/);
  assert.match(scan, /const manualChanged = isDesk && "participantId" in pending\.payload && res\.status === 409 && data\?\.code === "MANUAL_IDENTITY_CHANGED"/);
  assert.match(scan, /const attendanceReviewRequired = isDesk && res\.status === 409 && data\?\.code === "CHECK_ATTENDANCE_REVIEW_REQUIRED"/);
  assert.match(scan, /const sourceUnavailable = isDesk && res\.status === 409 && data\?\.code === "CHECK_SOURCE_UNAVAILABLE"/);
  assert.match(scan, /\["TICKET_STATUS_CONFLICT", "CHECK_OUT_REVIEW_REQUIRED"\]\.includes\(data\.code\)/);
  assert.match(scan, /const uncertain = !deskChanged && !manualChanged && !attendanceReviewRequired && !eligibilityReviewRequired && !sourceUnavailable && \(pending\.uncertain \|\| res\.status >= 500 \|\| \[408, 425, 429\]\.includes\(res\.status\)\)/);
  assert.match(scan, /if \(deskChanged \|\| manualChanged \|\| attendanceReviewRequired \|\| eligibilityReviewRequired \|\| sourceUnavailable\) \{ abandonOperatorAttempt\(pending\.commandId\); forgetOperatorReceipt\(pending\.commandId\); \}/);
  assert.match(scan, /pendingScanIdRef\.current\.delete\(attempt\)/);
  // Late-edit and focus-steal guards stay with the bound result.
  assert.match(scan, /scanEditRevisionRef\.current/);
  assert.match(work, /scanEditRevisionRef\.current !== scanEditAtSubmitRef\.current/);
  assert.match(work, /scanFocusAtSubmitRef\.current/);
});

test('hub-empty-and-error-wrap-by-word-and-keep-next-action-findable', () => {
  // 320px 배정 없음 안내: 음절 중간 끊김(문/의, 스태/프) 없이 어절 단위.
  // 기존 데이터/조직/리다이렉트/상태/포커스 계약은 그대로 둔다.
  assert.match(styles, /\.hubNote\s*\{[^}]*word-break:\s*keep-all/s);
  assert.match(styles, /\.hubNote\s*\{[^}]*overflow-wrap:\s*break-word/s);
  assert.match(hub, /className=\{workStyles\.hubNote\}/);
  // Existing copy stays verbatim (source of truth for invite honesty test).
  assert.match(hub, /배정된 업무가 없습니다\. 운영자에게 문의하세요\./);
  assert.match(hub, /운영 콘솔.*현장 운영.*스태프 배정/);
  assert.match(hub, /초대 메일·행사 안내의 문의처/);
  assert.match(hub, /다시 불러오기/);
  // No inputs are introduced; hub still holds no drafts and issues no writes.
  assert.doesNotMatch(hub, /<input/);
  assert.doesNotMatch(hub, /localStorage/);
  assert.doesNotMatch(hub, /sessionStorage/);
  assert.doesNotMatch(hub, /\/commands/);
  // Redirect/state/focus contract stays: single-assignment replace, reload tick retry.
  assert.match(hub, /shouldAutoRouteStaffHub\(\{/);
  assert.match(hub, /router\.replace\(`\/staff\/events\//);
  assert.match(hub, /setReloadTick\(\(tick\) => tick \+ 1\)/);
});

test('staff-warnings-wrap-by-word-without-mid-syllable-split', () => {
  // 390 미확인 티/켓 + 320 실패 끊김 회귀 방지. 스태프 한정, 임의 데이터는
  // 넘치지 않게. 문구·상태·스냅샷·가드·포커스 불변.
  assert.match(styles, /\.resultBlock\s+\.scan-result\s*\{[^}]*word-break:\s*keep-all/s);
  assert.match(styles, /\.resultBlock\s+\.scan-result\s*\{[^}]*overflow-wrap:\s*break-word/s);
  assert.match(styles, /\.nextStep\s*\{[^}]*word-break:\s*keep-all/s);
  assert.match(styles, /\.nextStep\s*\{[^}]*overflow-wrap:\s*break-word/s);
  assert.match(styles, /\.sectionTitle\s*\{[^}]*word-break:\s*keep-all/s);
  assert.match(styles, /\.scanContext\s*\{[^}]*word-break:\s*keep-all/s);
  const globals = fs.readFileSync(path.join(__dirname, '../apps/web/app/globals.css'), 'utf8');
  assert.match(globals, /\.staff-workspace\s+\.scan-result\s*\{[^}]*word-break:\s*keep-all/s);
  assert.match(globals, /\.staff-workspace\s+\.scan-result\s*\{[^}]*overflow-wrap:\s*break-word/s);
  assert.match(globals, /\.staff-direction-hint\s*\{[^}]*word-break:\s*keep-all/s);
  // Long arbitrary data still breaks anywhere instead of overflowing.
  assert.match(styles, /\.ticketFullCode\s+code\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  // The definitive booth limit is a status, while scan failures still announce an alert.
  assert.match(work, /처리 응답을 확인하지 못했습니다\. 같은 업무·티켓으로 다시 시도하세요\./);
  assert.match(work, /role=\{boothLimitReached \? "status" : "alert"\}>\{result\.message\}/);
  assert.match(work, /place:\s*requestPlace/);
  assert.match(work, /window\.setTimeout\(\(\) => controller\.abort\(\), 15000\)/);
});

test('crossrole-audit-pins-request-place-on-real-responses', () => {
  // 소스 핀을 넘어 기존 격리 흐름에서 실제 요청/결과 연결을 검증한다.
  // 지연응답·동일 요청ID·단일 기록 검사는 그대로 둔다.
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-crossrole-journey-audit.cjs'), 'utf8');
  assert.match(audit, /uncertain 390 binds the request desk/);
  assert.match(audit, /failed 390 binds the request desk/);
  assert.match(audit, /failed 320 binds the request desk on the narrow viewport/);
  assert.match(audit, /multi-desk failure binds its request desk/);
  assert.match(audit, /failed scan input shows and describes its current desk/);
  assert.match(audit, /editing a failed ticket preserves both input context and prior result location/);
  assert.match(audit, /task switch clears the bound place with the result/);
  assert.match(audit, /처리 위치:/);
  assert.match(audit, /감사 입장 데스크/);
  assert.match(audit, /hub empty wraps by word at 320 \(keep-all\)/);
  // Ordering guard: the multi-desk place must be read while the verdict is
  // open — never after retry clears it into idle. No false pass allowed.
  assert.match(audit, /const multiPlace = await multiFailure\.getByText\(\/처리 위치:\/\)/);
  const bindAt = audit.indexOf('multi-desk failure binds its request desk');
  const retryAt = audit.indexOf("multiFailureRetry.getByRole('button', { name: '다시 시도'");
  const switchAt = audit.indexOf('task switch clears the bound place with the result');
  assert.ok(bindAt !== -1 && retryAt !== -1 && switchAt !== -1 && bindAt < switchAt && switchAt < retryAt,
    'place read (open) -> actual work switch clears -> separate 404 retry reproduction');
  // Separate keyboard-retry reproduction keeps the retry value/focus guard.
  assert.match(audit, /const multiFailureRetry = multiWork\.locator\('section\[aria-label="스캔 실패"\]'\)/);
  assert.match(audit, /keyboard retry preserves the submitted ticket and returns focus/);
  // Existing guards stay pinned.
  assert.match(audit, /retry replays the identical request \(body and command id\)/);
  assert.match(audit, /exactly one IN check for A \(no duplicate from retry\)/);
  assert.match(audit, /a pending scan prevents desk and camera changes/);
  // Wrap proof stays pinned: computed keep-all plus a Range boundary probe
  // on the rendered warning (티켓으로 @390, 티켓을 @320). No weakening.
  assert.match(audit, /uncertain 390 warning wraps by word without mid-syllable split/);
  assert.match(audit, /failed 320 warning wraps by word without mid-syllable split/);
  assert.match(audit, /getClientRects\(\)/);
});
