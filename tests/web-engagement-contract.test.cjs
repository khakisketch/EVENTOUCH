'use strict';

// Engagement slice contract (console programs + attendee engage): pins the
// guest command path, the ticket-bearer handling, the response-locked edit
// rule, and the dialog modal behavior as static source assertions. Live
// rendering is verified against the demo servers outside the suite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

test('web-console-programs-uses-the-engagement-operator-commands', () => {
  const workspace = read('app/console/events/[id]/programs/ProgramsWorkspace.tsx');
  for (const command of [
    'module.save',
    'module.status',
    'module.reveal',
    'question.manage',
    'photo.moderate',
    'post.moderate',
    'draw.run',
    'draw.publish',
  ]) {
    assert.match(workspace, new RegExp(command.replace('.', '\\.')));
  }
  assert.match(workspace, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/);
  assert.match(workspace, /\/api\/bootstrap/);
  assert.match(workspace, /commandId/);
  assert.match(workspace, /eventouch:shell-reload/);
  assert.match(workspace, /다시 불러오기/);
  assert.doesNotMatch(workspace, /localStorage/);
  assert.doesNotMatch(workspace, /sessionStorage/);
  // No ticket bearer on the operator path.
  assert.doesNotMatch(workspace, /Bearer /);
});

test('web-console-programs-gates-on-the-same-management-membership', () => {
  const workspace = read('app/console/events/[id]/programs/ProgramsWorkspace.tsx');
  assert.match(workspace, /canManage/);
  assert.match(workspace, /memberships\.some/);
  assert.match(workspace, /참여 프로그램을 관리할 운영 권한이 없습니다/);
  const page = read('app/console/events/[id]/programs/page.tsx');
  assert.match(page, /ProgramsWorkspace/);
});

test('web-console-programs-locks-edits-once-attendees-respond', () => {
  const workspace = read('app/console/events/[id]/programs/ProgramsWorkspace.tsx');
  assert.match(workspace, /응답이 있어 문제를 수정할 수 없습니다\. 새 프로그램을 만드세요/);
  assert.match(workspace, /editLockReason/);
  assert.match(workspace, /lockReason !== null/);
  assert.match(workspace, /DRAFT/);
  assert.match(workspace, /OPEN/);
  assert.match(workspace, /CLOSED/);
});

test('web-console-programs-covers-status-reveal-draw-and-moderation', () => {
  const workspace = read('app/console/events/[id]/programs/ProgramsWorkspace.tsx');
  // Status moves both ways through module.status only.
  assert.match(workspace, /시작/);
  assert.match(workspace, /종료/);
  assert.match(workspace, /다시 열기/);
  // Quiz reveal, draw count limits, latest-result publish.
  assert.match(workspace, /퀴즈 정답 공개/);
  assert.match(workspace, /당첨 인원은 1~20명으로 입력하세요/);
  assert.match(workspace, /최신 결과 공개/);
  // Moderation approves or rejects; Q&A shows the like count.
  assert.match(workspace, /승인/);
  assert.match(workspace, /반려/);
  assert.match(workspace, /좋아요/);
  // Type counts: votes/quizzes/surveys by response, Q&A by question.
  assert.match(workspace, /응답 \$/);
  assert.match(workspace, /질문 \$/);
  // Feature-flagged-off types point at settings instead of failing silently.
  assert.match(workspace, /기능을 먼저 켜세요/);
  assert.match(workspace, /행사 설정/);
});

test('web-console-programs-dialog-is-modal-and-wires-field-errors', () => {
  const workspace = read('app/console/events/[id]/programs/ProgramsWorkspace.tsx');
  assert.match(workspace, /role="dialog"/);
  assert.match(workspace, /aria-modal/);
  assert.match(workspace, /previouslyFocused/);
  assert.match(workspace, /Escape/);
  assert.match(workspace, /투표 선택지/);
  assert.match(workspace, /퀴즈 정답/);
  assert.match(workspace, /만족도 질문/);
  assert.match(workspace, /data\?\.field/);
  assert.match(workspace, /aria-describedby/);
});

test('web-console-shell-links-programs-between-operations-and-settings', () => {
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /참여 프로그램/);
  assert.match(shell, /\$\{eventBasePath\}\/programs/);
  assert.match(shell, /isPrograms/);
  const operationsAt = shell.indexOf('현장 운영');
  const programsAt = shell.indexOf('참여 프로그램');
  const settingsAt = shell.indexOf('행사 설정');
  assert.ok(operationsAt >= 0 && programsAt >= 0 && settingsAt >= 0);
  assert.ok(operationsAt < programsAt && programsAt < settingsAt);
});

test('web-engage-reads-the-public-projection-and-reuses-the-ticket-key', () => {
  const client = read('app/event/[slug]/engage/EngageClient.tsx');
  assert.match(client, /\/api\/public\/events\/\$\{encodeURIComponent\(slug\)\}/);
  assert.match(client, /\/ticket/);
  assert.match(client, /published/);
  assert.match(client, /DRAFT/);
  // The tab-kept ticket key is the one TicketView owns; no new keys.
  assert.match(client, /eventouch\.ticket\./);
  assert.match(client, /sessionStorage/);
  assert.doesNotMatch(client, /localStorage/);
  assert.equal((client.match(/sessionStorage/g) ?? []).length, 3);
  const page = read('app/event/[slug]/engage/page.tsx');
  assert.match(page, /EngageClient/);
});

test('web-engage-submits-through-the-guest-command-path-only', () => {
  const client = read('app/event/[slug]/engage/EngageClient.tsx');
  for (const command of [
    'response.submit',
    'question.submit',
    'question.like',
    'photo.submit',
    'post.submit',
  ]) {
    assert.match(client, new RegExp(command.replace('.', '\\.')));
  }
  assert.match(client, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/);
  assert.match(client, /authorization:\s*`Bearer /);
  // Photo bytes ride the guest upload route, never the command path.
  assert.match(client, /\/api\/public\/events\/\$\{encodeURIComponent\(slug\)\}\/files/);
  assert.match(client, /600000/);
  // One in-flight submission and one command id per form: retries replay.
  assert.match(client, /submitting/);
  assert.match(client, /commandIdsRef/);
  // Server field rejections land on their inputs.
  assert.match(client, /aria-describedby/);
  assert.match(client, /모든 만족도 항목을 1~5점으로 선택하세요|ratings/);
});

test('web-engage-keeps-the-bearer-off-the-screen-and-explains-without-a-ticket', () => {
  const client = read('app/event/[slug]/engage/EngageClient.tsx');
  assert.match(client, /티켓 링크가 필요합니다/);
  assert.match(client, /내 티켓으로 이동/);
  assert.match(client, /이미 제출했습니다/);
  assert.match(client, /참가 확정 후/);
  assert.doesNotMatch(client, /localStorage/);
  assert.doesNotMatch(client, /console\.log/);
  assert.doesNotMatch(client, /TicketView/);
});
