'use strict';

// Console content authoring (notices, schedule programs, venue guidance):
// pins the preparation command path, the server field contracts, the
// publish-to-public flow, the management gate, and the dialog modal
// behavior as static source assertions. Live rendering is verified against
// the demo servers outside the suite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

test('web-console-content-uses-the-preparation-content-commands', () => {
  const workspace = read('app/console/events/[id]/content/ContentWorkspace.tsx');
  for (const command of [
    'notice.save',
    'notice.delete',
    'program.save',
    'program.delete',
    'venue.save',
  ]) {
    assert.match(workspace, new RegExp(command.replace('.', '\\.')));
  }
  assert.match(workspace, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/);
  // Reads go through the shared transport; the event read is the scoped
  // event bootstrap, never the full directory.
  assert.match(workspace, /consoleFetch\(`\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/bootstrap`/);
  assert.doesNotMatch(workspace, /consoleFetch\("\/api\/bootstrap"/);
  assert.match(workspace, /commandId/);
  assert.match(workspace, /eventouch:shell-reload/);
  assert.match(workspace, /다시 불러오기/);
  assert.doesNotMatch(workspace, /localStorage/);
  assert.doesNotMatch(workspace, /sessionStorage/);
  // No ticket bearer on the operator path.
  assert.doesNotMatch(workspace, /Bearer /);
  const page = read('app/console/events/[id]/content/page.tsx');
  assert.match(page, /ContentWorkspace/);
});

test('web-console-content-follows-the-server-field-contracts', () => {
  const workspace = read('app/console/events/[id]/content/ContentWorkspace.tsx');
  // notice.save: title 100 / body 3000 with server field errors on inputs.
  assert.match(workspace, /NOTICE_TITLE_MAX = 100/);
  assert.match(workspace, /NOTICE_BODY_MAX = 3000/);
  // program.save: title / place 160 / description 4000; attachment rides as
  // a stored fileId reference (PDF, 600KB), never raw bytes.
  assert.match(workspace, /PROGRAM_TITLE_MAX = 100/);
  assert.match(workspace, /PROGRAM_PLACE_MAX = 160/);
  assert.match(workspace, /PROGRAM_DESCRIPTION_MAX = 4000/);
  assert.match(workspace, /application\/pdf/);
  assert.match(workspace, /600000/);
  assert.match(workspace, /attachmentDirty/);
  assert.match(workspace, /\{ fileId/);
  // venue.save: name / address / directions / contact / description.
  assert.match(workspace, /name: 100, address: 200, directions: 400, contact: 120, description: 400/);
  assert.match(workspace, /venue\.save/);
  // Server field rejections land on their inputs.
  assert.match(workspace, /data\?\.field/);
  assert.match(workspace, /aria-describedby/);
});

test('web-console-content-keeps-the-publish-flow-visible', () => {
  const workspace = read('app/console/events/[id]/content/ContentWorkspace.tsx');
  // Only published notices and programs reach the public event page.
  assert.match(workspace, /게시한 항목만 참가자에게 보입니다/);
  assert.match(workspace, /게시 중/);
  assert.match(workspace, /비공개/);
  assert.match(workspace, /비게시/);
  assert.match(workspace, /참가자 화면에 보입니다/);
  // Notices pin; programs read in date+start order like attendees see.
  assert.match(workspace, /고정/);
  assert.match(workspace, /localeCompare\(right\.date \+ right\.start\)/);
  assert.match(workspace, /날짜·시작 시간 순으로 정렬/);
  // Venue needs its feature flag first; the guidance points at settings.
  assert.match(workspace, /장소 안내 기능이 꺼져 있습니다/);
  assert.match(workspace, /기능을 먼저 켜세요/);
  assert.match(workspace, /행사 설정/);
  // Deletes confirm before posting.
  assert.match(workspace, /공지를 삭제할까요/);
  assert.match(workspace, /일정을 삭제할까요/);
});

test('web-console-content-gates-on-the-same-management-membership', () => {
  const workspace = read('app/console/events/[id]/content/ContentWorkspace.tsx');
  // Membership plus per-command scopes: notices/venue are page scope,
  // programs are programs scope. The denial copy stays for the fully
  // ungranted operator; partial grants get their own cross-scope notes.
  assert.match(workspace, /memberships/);
  assert.match(workspace, /canWriteEvent\(capabilities, "notice\.save"\)/);
  assert.match(workspace, /canWriteEvent\(capabilities, "program\.save"\)/);
  assert.match(workspace, /콘텐츠를 관리할 운영 권한이 없습니다/);
  assert.match(workspace, /공지·장소 쓰기 권한이 없습니다/);
  assert.match(workspace, /프로그램 일정 변경은 참여 프로그램 쓰기 권한이 필요합니다/);
});

test('web-console-content-dialogs-are-modal-and-wire-field-errors', () => {
  const workspace = read('app/console/events/[id]/content/ContentWorkspace.tsx');
  // Dialogs mount the shared shell: workspace owns usage, title ids and
  // dismissal gates; the shell owns role/focus/Escape mechanics centrally.
  assert.match(workspace, /<ConsoleDialog/);
  assert.match(workspace, /titleId="content-notice-dialog-title"/);
  assert.match(workspace, /titleId="content-program-dialog-title"/);
  assert.match(workspace, /canClose=\{canCloseNoticeDialog\}/);
  assert.match(workspace, /canClose=\{canCloseProgramDialog\}/);
  assert.match(workspace, /if \(canCloseNoticeDialog\(\)\) setNoticeDialogOpen\(false\)/);
  assert.match(workspace, /if \(canCloseProgramDialog\(\)\) setProgramDialogOpen\(false\)/);
  const dialog = read('app/console/console-ui/ConsoleDialog.tsx');
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /previouslyFocused/);
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(dialog, /initialFocusRef/);
  assert.match(workspace, /공지 작성/);
  assert.match(workspace, /일정 추가/);
  assert.match(workspace, /상단 고정/);
  assert.match(workspace, /게시함/);
  assert.match(workspace, /content-notice-title-error/);
  assert.match(workspace, /content-program-title-error/);
  assert.match(workspace, /role="alert"/);
  assert.match(workspace, /aria-describedby/);
});

test('web-console-shell-groups-content-before-field-programs-and-settings', () => {
  const shell = read('app/console/ConsoleShell.tsx');
  // The rail renders the hub order with registry labels and hrefs, not
  // literal duplicate routes: badges, permissions and feature gates stay in
  // the shell while the registry owns destinations.
  assert.match(shell, /EVENT_HUBS\.map\(\(hub\)/);
  assert.match(shell, /CONSOLE_PAGES\[pageId\]\.label/);
  assert.match(shell, /consolePageHref\(pageId, eventId/);
  assert.match(shell, /nav-badge/);
  assert.match(shell, /showOperatorNavBadges/);
  assert.match(shell, /canManageEvidencePhotos/);
  const navigation = read('app/console/console-navigation.ts');
  assert.match(navigation, /content: \{ label: "콘텐츠"/);
  assert.match(navigation, /return `\$\{base\}\/content`/);
  // Preparation hub order: settings opens the setup sequence, content feeds
  // programs, so content sits before programs inside one hub.
  assert.match(navigation, /pageIds: \["settings", "attendeePage", "content", "programs"\]/);
});
