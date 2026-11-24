'use strict';
// Reopened 2026-11-24 (전수 점검 M1~M12): MMS photos shrink in the browser instead of being refused,
// manual reservations say "직접 실행 필요" everywhere, scheduled details show the body, 알림톡 without an
// approved template says so, the auto-notify card separates unsaved changes from saved state, and a
// hand-made 전날 리마인드 warns when the automatic reminder is already on. No confirmed screen layout changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const WORKSPACE = read('apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx');
const PANEL = read('apps/web/app/console/events/[id]/messages/AutoNotifyPanel.tsx');
const IMAGE_FIT = read('apps/web/lib/image-fit.ts');

test('M1: formatImageBytes names the limit and the file size the way people read them', () => {
  const start = IMAGE_FIT.indexOf('export function formatImageBytes');
  const end = IMAGE_FIT.indexOf('\n}\n', start);
  const code = stripTypeScriptTypes(`${IMAGE_FIT.slice(start, end + 3).replace(/^export /u, '')}\nmodule.exports = { formatImageBytes };`);
  const module_ = { exports: {} };
  new Function('module', code)(module_);
  const { formatImageBytes } = module_.exports;
  assert.equal(formatImageBytes(200000), '200KB');
  assert.equal(formatImageBytes(600000), '600KB');
  assert.equal(formatImageBytes(3_500_000), '3.5MB');
});

test('M1: fitImage keeps its signature and defaults, adds a JPEG-only option and a limit-aware message', () => {
  assert.match(IMAGE_FIT, /fitImage\(file: File, maxBytes = NOTICE_IMAGE_MAX_BYTES, options: FitOptions = \{\}\)/u);
  assert.match(IMAGE_FIT, /requireJpeg/u);
  assert.doesNotMatch(IMAGE_FIT, /600KB 이하로 줄/u, 'the limit comes from maxBytes, not a fixed string');
  assert.match(IMAGE_FIT, /\$\{limit\} 이하로 줄이지 못했습니다/u);
});

test('M1: MMS photo upload shrinks to JPEG 200,000 bytes before upload and uses the fitted file', () => {
  assert.match(WORKSPACE, /const MMS_IMAGE_MAX_BYTES = 200000;/u);
  assert.match(WORKSPACE, /fitImage\(file, MMS_IMAGE_MAX_BYTES, \{ requireJpeg: true \}\)/u);
  assert.match(WORKSPACE, /내 파일 \$\{formatImageBytes\(file\.size\)\} · \$\{formatImageBytes\(MMS_IMAGE_MAX_BYTES\)\} 이하로 줄이지 못했습니다\. 더 작은 사진을 선택해 주세요\./u);
  assert.match(WORKSPACE, /file: target, commandId: commandId\(\), uncertain: false/u, 'the upload attempt carries the fitted file so a retry reuses it');
  assert.match(WORKSPACE, /사진은 자동으로 줄여서 첨부합니다/u);
  assert.match(WORKSPACE, /accept="image\/jpeg,image\/png,image\/webp"/u);
  assert.doesNotMatch(WORKSPACE, /JPG 200KB 이하/u);
});

test('M2: manual reservations say 예약됨 · 직접 실행 필요 in the sentence, the confirm and the history', () => {
  assert.match(WORKSPACE, /id="campaign-manual-run"[^>]*>.*예약됨 · 직접 실행 필요/su);
  assert.match(WORKSPACE, /예약됨 · 직접 실행 필요\\n/u, 'the review confirm leads with it');
  assert.match(WORKSPACE, /<StatusPill tone="neutral">예약됨 · 직접 실행 필요<\/StatusPill>/u);
  assert.match(WORKSPACE, /id="message-overdue-alert"/u);
  assert.match(WORKSPACE, /scheduleMode: "MANUAL",\n/u, 'the default stays MANUAL');
});

test('M3: a scheduled record shows its body and the reservation time on the recipient line', () => {
  assert.match(WORKSPACE, /campaign\.status === "SCHEDULED" && campaign\.body \? <div className=\{styles\.scheduledBody\}>/u);
  assert.match(WORKSPACE, /예약 \{formatDate\(campaign\.scheduled\)\}/u);
});

test('M4: 알림톡 without an approved template explains it and keeps the SMS body out of the preview', () => {
  assert.match(WORKSPACE, /승인된 알림톡 템플릿이 없습니다\./u);
  assert.match(WORKSPACE, /알림톡을 쓰려면 승인된 템플릿을 선택해야 합니다\./u);
  assert.match(WORKSPACE, /alimtalkNeedsTemplate \? <span className=\{styles\.bubbleEmpty\}>/u);
  assert.doesNotMatch(WORKSPACE, /Solapi 승인 ID가 있는 템플릿을 선택해야 합니다/u);
  assert.doesNotMatch(read('apps/web/lib/message-composition.ts'), /Solapi 승인 ID가 있는/u);
});

test('M5: the auto-notify card marks unsaved changes, saves with one label and fixes the particle', () => {
  assert.match(PANEL, /저장하지 않은 변경/u);
  assert.match(PANEL, /\{busy \? "저장 중" : "저장"\}/u);
  assert.match(PANEL, /confirmLabel="켜기"/u);
  assert.match(PANEL, /‘\{info\.title\}’\{objectParticle\(info\.title\)\} 켭니다/u);
  assert.doesNotMatch(PANEL, /서버가 알아서/u);
  assert.match(PANEL, /조건이 맞으면 문자를 자동으로 보냅니다/u);
  assert.match(PANEL, /\{"\{\{티켓링크\}\}"\}도 넣을 수 있지만/u);
  const start = PANEL.indexOf('function objectParticle');
  const end = PANEL.indexOf('\n}\n', start);
  const code = stripTypeScriptTypes(`${PANEL.slice(start, end + 3)}\nmodule.exports = { objectParticle };`);
  const module_ = { exports: {} };
  new Function('module', code)(module_);
  assert.equal(module_.exports.objectParticle('행사 리마인드'), '를');
  assert.equal(module_.exports.objectParticle('참가 확정 안내'), '를');
  assert.equal(module_.exports.objectParticle('입장 확인'), '을');
});

test('M6: the two reminder paths warn about each other', () => {
  assert.match(WORKSPACE, /loadedPurpose\?\.key === "reminder" && autoReminderOn/u);
  assert.match(WORKSPACE, /자동 리마인드가 이미 켜져 있습니다\. 같은 문자가 두 번 갈 수 있어요/u);
  assert.match(PANEL, /직접 예약한 리마인드가 \{scheduledReminders\}건 있습니다/u);
  assert.match(WORKSPACE, /scheduledReminders=\{scheduledManualReminders\}/u);
});

test('M7/M8: banner summary with 자세히, tab change clears the notice, plain confirm labels', () => {
  assert.match(WORKSPACE, /<summary data-disclosure-indicator="">자세히<\/summary>/u);
  assert.match(WORKSPACE, /onNavigate=\{onTabChange\}/u);
  assert.match(WORKSPACE, /onTabChange=\{\(\) => setCampaignFeedback\(null\)\}/u);
  for (const label of ['예약 등록한다', '예약을 취소한다', '실행한다', '재시도한다', '발송 요청한다', '모의 발송을 기록한다']) {
    assert.ok(!WORKSPACE.includes(`"${label}"`), `${label} is gone`);
  }
  assert.match(WORKSPACE, /"예약 취소하기"/u);
  assert.match(WORKSPACE, /cancelLabel=\{historyPending\.kind === "cancel" \? "유지" : undefined\}/u);
  assert.match(WORKSPACE, /받는 사람 \$\{args\.count\}명 · /u);
});

test('M9/M10/M11/M12: wording, template dirty check, variable chips, calmer history, one date style', () => {
  assert.match(WORKSPACE, /작성 중인 내용은 그대로 남아 있습니다/u);
  assert.doesNotMatch(WORKSPACE, /원문 \$\{bodyMeasure\.bytes/u);
  assert.match(WORKSPACE, /id="campaign-submit-reason"/u);
  assert.match(WORKSPACE, /templateDraft\.name !== EMPTY_TEMPLATE\.name \|\| templateDraft\.body !== EMPTY_TEMPLATE\.body/u);
  assert.match(WORKSPACE, /insertTemplateVariable\(name\)/u);
  assert.match(WORKSPACE, /공급사 승인 ID \(Solapi\)/u);
  const css = read('apps/web/app/console/events/[id]/messages/MessagingWorkspace.module.css');
  assert.match(css, /\.campaignActions \[data-product-variant="destructive"\] \{ margin-inline: var\(--s3\); \}/u);
  assert.match(css, /\.historyDetails > summary \{[^}]*color: var\(--ink\)/u);
  assert.match(WORKSPACE, /function formatHumanInstant\(at: Date\)/u);
  assert.doesNotMatch(WORKSPACE, /dateStyle: "medium"/u);
});
