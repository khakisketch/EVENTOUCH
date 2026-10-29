'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '../apps/web/app', file), 'utf8');

test('answer-save-preserves-publication-while-unpublish-is-explicit', () => {
  const source = read('console/events/[id]/programs/ProgramsWorkspace.tsx');
  assert.match(source, /onClick=\{\(\) => props\.onManage\(question, question\.approved\)\}/);
  assert.match(source, /onClick=\{\(\) => props\.onManage\(question, false\)\}/);
  assert.match(source, /답변 저장·공개 유지/);
  assert.match(source, /공개 취소/);
  assert.match(source, /"question\.manage", \{ id: question\.id, answer, approved \}/);
});

test('report-sharing-record-does-not-imply-customer-delivery-and-errors-stay-in-dialog', () => {
  const source = read('console/events/[id]/reports/ReportsWorkspace.tsx');
  assert.match(source, /공유 완료로 표시/);
  assert.match(source, /고객사에 자동 전송되지는 않습니다/);
  assert.doesNotMatch(source, />\s*고객사 공유\s*</);
  assert.match(source, /failure=\{failure\}/);
  assert.match(source, /id="report-dialog-error" role="alert"/);
  // The dialog mounts the shared shell with caller-owned focus and
  // dismissal gates; Tab trapping and focus return live centrally.
  assert.match(source, /<ConsoleDialog/);
  assert.match(source, /initialFocusRef=\{titleRef\}/);
  assert.match(source, /canClose=\{confirmDialogClose\}/);
  const dialog = read('console/console-ui/ConsoleDialog.tsx');
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(dialog, /previouslyFocused/);
  assert.match(source, /pendingCommandsRef\.current\.get\(attempt\)/);
});

test('staff-ready-gate-is-explained-and-copy-feedback-is-local-to-booth-qr', () => {
  const source = read('staff/StaffEventWork.tsx');
  assert.match(source, /데스크를 먼저 선택하세요/);
  assert.match(source, /운영 중인 부스를 먼저 선택하세요/);
  assert.match(source, /aria-describedby="staff-scan-hint"/);
  assert.match(source, /isExitDesk \? "퇴장 처리" : "입장 처리"/);
  assert.match(source, /setBoothCopyNotice\("부스 코드를 복사했습니다/);
  assert.doesNotMatch(source, /setCorrectNotice\("부스 코드를 복사/);
  assert.match(source, /<details className=\{prizeStyles\.codeFallback\}>/);
});

test('public-event-error-recovery-never-renders-raw-framework-errors', () => {
  const source = read('event/[slug]/error.tsx');
  assert.doesNotMatch(source, /error\?\.message|\{error\.message\}/);
  assert.match(source, /연결 상태를 확인한 뒤 다시 시도하세요/);
  assert.match(source, /<RuntimeRecovery error=\{error\} retry=\{retry\}/);
  assert.doesNotMatch(source, /reset\(\)/);
  assert.match(source, /행사 안내로/);
  const recovery = read('RuntimeRecovery.tsx');
  assert.match(recovery, /<main id="main-content"/);
  assert.match(recovery, /onClick=\{retrySegment\}/);
  assert.doesNotMatch(recovery, /\{error\.message\}/);
});

test('primary-hover-uses-the-existing-high-contrast-foreground-token', () => {
  const source = read('globals.css');
  assert.match(source, /\.button-primary:hover,[\s\S]*?background: var\(--brand-hover\);\s*color: var\(--on-brand-hover\);/);
});

test('anonymous-landing-header-links-keep-touch-size-on-small-and-tablet-screens', () => {
  const source = read('landing.module.css');
  assert.match(source, /\.brand\s*\{[^}]*min-height:\s*44px/s);
  assert.match(source, /\.siteNav a\s*\{[^}]*min-height:\s*44px/s);
});
