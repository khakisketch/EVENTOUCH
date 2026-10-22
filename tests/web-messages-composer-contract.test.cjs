'use strict';

// Messages composer UX contracts: safe repeat requests, explicit recipient
// selection state, quiet template management, and honest manual scheduling.
// Source-only assertions; rendering and browser exercise belong to main.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx'),
  'utf8'
);
const CSS = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/messages/MessagingWorkspace.module.css'),
  'utf8'
);

test('message commands reuse one id per command+payload fingerprint', () => {
  assert.match(SOURCE, /fingerprintFor\(/u);
  assert.match(SOURCE, /campaignCreateRef/u);
  assert.match(SOURCE, /templateSaveRef/u);
  assert.match(SOURCE, /retryRefs/u);
  assert.match(SOURCE, /syncRefs/u);
  assert.match(SOURCE, /fingerprint: string; commandId: string/u);
  assert.match(SOURCE, /inFlightRef/u);
  assert.match(SOURCE, /beginAction\(/u);
  assert.match(SOURCE, /endAction\(\)/u);
  assert.match(SOURCE, /isAmbiguousStatus/u);
  assert.match(SOURCE, /status >= 500 \|\| status === 408/u);
  assert.match(SOURCE, /내용을 바꾸지 않고 같은 요청으로 다시 시도하세요/u);
  assert.doesNotMatch(SOURCE, /중복 발송되지 않습니다/u);
  assert.doesNotMatch(SOURCE, /중복 저장되지 않습니다/u);
  assert.match(SOURCE, /created\.id !== pending\.id/u);
  assert.match(SOURCE, /message\.id !== campaign\.id/u);
  assert.match(SOURCE, /if \(inFlightRef\.current\) return/u);
});

test('recipient picker filters by status, searches contact fields, and reports selection', () => {
  assert.match(SOURCE, /id="recipient-status-filter"/u);
  assert.match(SOURCE, /useState\("APPROVED"\)/u);
  assert.match(SOURCE, /person\.phone/u);
  assert.match(SOURCE, /이름·소속·연락처 검색/u);
  assert.match(SOURCE, /id="recipient-summary"/u);
  assert.match(SOURCE, /화면 밖 선택/u);
  assert.match(SOURCE, /id="recipient-clear-all"[\s\S]*?전체 선택 해제/u);
  assert.match(SOURCE, /표시 추가/u);
  assert.match(SOURCE, /표시 해제/u);
  assert.match(SOURCE, /id="recipient-selected-only"/u);
  assert.match(SOURCE, /선택 대상만 보기/u);
  assert.match(SOURCE, /id="recipient-risk-warning"/u);
  assert.match(SOURCE, /승인 대기·대기 명단/u);
});

test('template management is disclosed on demand while compose keeps template choice', () => {
  assert.match(SOURCE, /<details className=\{styles\.templateDetails\}/u);
  assert.match(SOURCE, /템플릿 관리 열기/u);
  assert.doesNotMatch(SOURCE, /<details className=\{styles\.templateDetails\}[^>]*open/u);
  assert.match(SOURCE, /id="campaign-template"/u);
  assert.match(SOURCE, /headingId="templates-heading"/u);
  assert.match(CSS, /\.templateDetails/u);
});

test('scheduling promises manual execution only, with an honest due action', () => {
  assert.match(SOURCE, /예약 등록\(수동 실행\)/u);
  assert.match(SOURCE, /예약 시각 이후 이 화면에서 발송 실행을 눌러야 합니다\. 자동 발송은 지원하지 않습니다\./u);
  assert.match(SOURCE, /발송 실행/u);
  assert.doesNotMatch(SOURCE, /예약 시각에 발송을 시도합니다/u);
  assert.match(SOURCE, /id="campaign-submit-warning"/u);
  assert.match(SOURCE, /발송은 되돌릴 수 없습니다/u);
  assert.match(SOURCE, /모의 발송/u);
  assert.match(SOURCE, /모의 예약/u);
  assert.match(SOURCE, /실행해도 수신자에게 전달되지 않습니다/u);
  assert.match(SOURCE, /createdStatus/u);
  assert.match(SOURCE, /연결되지 않았으면/u);
  assert.match(SOURCE, /Solapi 승인/u);
});

test('scheduled and blocked sends can be cancelled, accepted sends cannot', () => {
  assert.match(SOURCE, /message\.cancel/u);
  assert.match(SOURCE, /cancelRefs/u);
  assert.match(SOURCE, /const canCancel = campaign\.status === "SCHEDULED" \|\| campaign\.status === "NEEDS_CONNECTION"/u);
  assert.match(SOURCE, /예약 취소/u);
  assert.match(SOURCE, /발송 취소/u);
  assert.match(SOURCE, /이미 공급사가 접수한 발송은 취소할 수 없습니다/u);
  assert.match(SOURCE, /!message \|\| message\.id !== campaign\.id \|\| text\(message\?\.status\) !== "CANCELLED"/u);
  assert.match(SOURCE, /hasFutureScheduled/u);
  assert.match(SOURCE, /setInterval/u);
  assert.match(SOURCE, /30_000/u);
});

test('stored simulate mode drives history and retry copy', () => {
  assert.match(SOURCE, /simulate: item\.simulate === true/u);
  assert.match(SOURCE, /모의 예약·전달 없음/u);
  assert.match(SOURCE, /storedSimulate/u);
  assert.match(SOURCE, /모의 예약을 실행할까요/u);
  assert.match(SOURCE, /모의 실행 결과/u);
  assert.match(SOURCE, /MMS 사진 문자로 발송되며 별도 요금이 발생합니다/u);
});

test('user-facing copy reads 발송 while command and anchor names stay internal', () => {
  assert.match(SOURCE, /title="발송 기록"/u);
  assert.match(SOURCE, /전체 발송 기록 보기/u);
  assert.match(SOURCE, /message\.create/u);
  assert.match(SOURCE, /message\.retry/u);
  assert.match(SOURCE, /message\.sync/u);
  assert.match(SOURCE, /template\.save/u);
  assert.match(SOURCE, /`campaign-\$\{pending\.id\}/u);
  assert.match(SOURCE, /attentionParam === "1"/u);
  assert.match(SOURCE, /id=\{`campaign-\$\{campaign\.id\}`\}/u);
});
