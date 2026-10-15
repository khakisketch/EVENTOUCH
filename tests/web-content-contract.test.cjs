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
  assert.match(workspace, /\/api\/bootstrap/);
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
  assert.match(workspace, /canManage/);
  assert.match(workspace, /memberships\.some/);
  assert.match(workspace, /콘텐츠를 관리할 운영 권한이 없습니다/);
});

test('web-console-content-dialogs-are-modal-and-wire-field-errors', () => {
  const workspace = read('app/console/events/[id]/content/ContentWorkspace.tsx');
  assert.match(workspace, /role="dialog"/);
  assert.match(workspace, /aria-modal/);
  assert.match(workspace, /previouslyFocused/);
  assert.match(workspace, /Escape/);
  assert.match(workspace, /content-notice-dialog-title/);
  assert.match(workspace, /content-program-dialog-title/);
  assert.match(workspace, /공지 작성/);
  assert.match(workspace, /일정 추가/);
  assert.match(workspace, /상단 고정/);
  assert.match(workspace, /게시함/);
});

test('web-console-shell-links-content-between-programs-and-settings', () => {
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /콘텐츠/);
  assert.match(shell, /\$\{eventBasePath\}\/content/);
  assert.match(shell, /isContent/);
  const programsAt = shell.indexOf('참여 프로그램');
  const contentAt = shell.indexOf('콘텐츠');
  const settingsAt = shell.indexOf('행사 설정');
  assert.ok(programsAt >= 0 && contentAt >= 0 && settingsAt >= 0);
  assert.ok(programsAt < contentAt && contentAt < settingsAt);
});
