'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.match(work, /result\.uncertain \? "처리 결과를 확인하지 못했습니다" : "처리에 실패했습니다"/);
  assert.match(work, /retryFailedRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(work, /role="alert">\{result\.message\}/);
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
  assert.match(work, /aria-label=\{\`\$\{check\.name\} 다시 스캔 준비\`\}/);
  assert.match(work, />\s*다시 스캔\s*</);
  assert.match(work, /onClick=\{prepareNextParticipant\}/);
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
  assert.match(work, /키오스크 모드/);
  assert.match(styles, /\.nextActions button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.recentRow button\s*\{[^}]*min-height:\s*44px/s);
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
  const scanOrder = work.indexOf('prizeStyles.scanContext');
  const cameraOrder = work.indexOf('카메라로 스캔');
  const fallbackOrder = work.indexOf('카메라가 안 될 때');
  assert.ok(scanOrder !== -1 && cameraOrder !== -1 && fallbackOrder !== -1 && scanOrder < cameraOrder && cameraOrder < fallbackOrder);
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
  assert.match(work, /deskName:\s*result\.place\.task === "desk" \? result\.place\.placeName/);
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
  assert.match(scan, /if \(!uncertain\) pendingScanIdRef\.current\.delete\(attempt\)/);
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
  // No copy/state/snapshot/guard/focus changes ride along.
  assert.match(work, /처리 응답을 확인하지 못했습니다\. 같은 업무·티켓으로 다시 시도하세요\./);
  assert.match(work, /role="alert">\{result\.message\}/);
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
