'use strict';

// Preparation/operations/communications unification: the four workspaces
// below render inside the shared ConsolePage frame with shared sections,
// feedback, actions, nav and dialogs. Per-page header/back rows, outer
// widths, card chrome and modal focus traps are gone; domain logic,
// safeguards and pinned operational copy stay. Source-only assertions;
// rendering is verified against live builds outside the suite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

const PAGES = {
  messages: read('app/console/events/[id]/messages/MessagingWorkspace.tsx'),
  settings: read('app/console/events/[id]/settings/SettingsWorkspace.tsx'),
  content: read('app/console/events/[id]/content/ContentWorkspace.tsx'),
  operations: read('app/console/events/[id]/operations/OperationsWorkspace.tsx'),
};

test('preparation pages render inside the shared ConsolePage frame', () => {
  for (const [pageId, source] of Object.entries(PAGES)) {
    assert.match(source, new RegExp(`<ConsolePage pageId="${pageId}"`), `${pageId} uses the shared frame`);
    assert.match(source, /eventId=\{eventId\}/, `${pageId} scopes the frame to the event`);
    assert.match(source, /from "\.\.\/\.\.\/\.\.\/console-ui\/console-ui\.module\.css"/, `${pageId} uses shared layout classes`);
  }
});

test('preparation pages no longer invent their own header chrome', () => {
  for (const [pageId, source] of Object.entries(PAGES)) {
    assert.doesNotMatch(source, /import ConsolePageHeader,/, `${pageId} does not render a private header`);
    assert.doesNotMatch(source, /label: "← 운영 현황"/u, `${pageId} has no per-page back row; the rail owns event navigation`);
  }
});

test('preparation pages expose tab navigation where the task flows span zones', () => {
  assert.match(PAGES.settings, /role="tablist"/u);
  assert.match(PAGES.settings, /role="tab"/u);
  assert.match(PAGES.settings, /role="tabpanel"/u);
  assert.doesNotMatch(PAGES.settings, /<ConsoleSectionNav/u);
  for (const label of ['기본 정보', '참가 접수', '운영 기능', '진행 단계']) {
    assert.ok(PAGES.settings.includes(label), `settings tab reaches ${label}`);
  }
  for (const id of ['settings-basics', 'settings-intake', 'settings-features', 'settings-stage']) {
    assert.ok(PAGES.settings.includes(id), `settings keeps deep-link anchor ${id}`);
  }
  // The attendee-page supporting block is content, never a fifth tab label.
  assert.doesNotMatch(PAGES.settings, /label: "참가자 페이지"/u);
  assert.match(PAGES.content, /<ConsoleSectionNav/u);
  for (const id of ['content-notices', 'content-program', 'content-venue']) {
    assert.match(PAGES.content, new RegExp(`\\{ id: "${id}"`), `content nav reaches ${id}`);
  }
  assert.match(PAGES.operations, /<ConsoleSectionNav/u);
  for (const id of ['ops-desks', 'ops-booths', 'ops-staff']) {
    assert.match(PAGES.operations, new RegExp(`\\{ id: "${id}"`), `operations nav reaches ${id}`);
  }
});

test('preparation tabs keep stable anchors and form reading width', () => {
  for (const id of ['campaign-heading', 'templates-heading', 'history-heading']) {
    assert.match(PAGES.messages, new RegExp(`headingId="${id}"`), `messages keeps ${id}`);
  }
  const composeStart = PAGES.messages.indexOf('headingId="campaign-heading"');
  const composeHeader = PAGES.messages.slice(composeStart, PAGES.messages.indexOf('<form', composeStart));
  assert.ok(composeStart > 0);
  assert.match(composeHeader, /surface="panel"/u, 'compose stays a panel');
  assert.doesNotMatch(composeHeader, /width="form"/u, 'two-column workbench uses the shared full workspace width');
  assert.match(PAGES.messages, /className=\{styles\.composeGrid\}/u, 'composition and recipients share one workbench');
  for (const id of ['settings-basics', 'settings-intake', 'settings-features', 'settings-stage']) {
    assert.ok(PAGES.settings.includes(id), `settings keeps deep-link anchor ${id}`);
  }
  // The attendee-page supporting block is not a fifth tab label.
  assert.doesNotMatch(PAGES.settings, /label: "참가자 페이지"/u);
  // The optional disclosure keeps its own anchor id without a section heading.
  assert.ok(PAGES.settings.includes('id="settings-page"'), 'optional disclosure keeps its deep-link id');
  assert.doesNotMatch(PAGES.settings, /headingId="settings-page"/u);
  for (const id of ['content-notices', 'content-program', 'content-venue']) {
    assert.match(PAGES.content, new RegExp(`headingId="${id}"`), `content keeps ${id}`);
  }
  for (const id of ['ops-desks', 'ops-booths', 'ops-booth-mode', 'ops-booth-map', 'ops-display', 'ops-staff']) {
    assert.match(PAGES.operations, new RegExp(`headingId="${id}"`), `operations keeps ${id}`);
  }
  assert.match(PAGES.content, /headingId="content-venue" title="장소 안내" width="form"/u);
});

test('preparation feedback and editing-unit actions use the shared components', () => {
  for (const [pageId, source] of Object.entries(PAGES)) {
    assert.match(source, /<ConsoleFeedback kind="/u, `${pageId} reports through shared feedback`);
    assert.match(source, /<ConsoleFormActions/u, `${pageId} closes editing units with shared actions`);
  }
  assert.match(PAGES.messages, /<ConsoleFormActions/u);
  assert.match(PAGES.messages, /className=\{styles\.reviewBar\}/u, 'compose keeps its target/mode safeguard beside the submit');
  assert.match(PAGES.messages, /id="campaign-submit-warning"/u);
});

test('preparation dialogs use the shared shell with dismissal gates', () => {
  assert.match(PAGES.content, /<ConsoleDialog/u);
  assert.match(PAGES.content, /titleId="content-notice-dialog-title"/u);
  assert.match(PAGES.content, /titleId="content-program-dialog-title"/u);
  assert.match(PAGES.content, /canClose=\{canCloseNoticeDialog\}/u);
  assert.match(PAGES.content, /canClose=\{canCloseProgramDialog\}/u);
  assert.doesNotMatch(PAGES.content, /function Modal\(/u, 'content drops its private focus trap');
  assert.match(PAGES.operations, /<ConsoleDialog title=\{initial \? "데스크 편집" : "데스크 추가"\}/u);
  assert.match(PAGES.operations, /<ConsoleDialog title=\{initial \? "부스 편집" : "부스 추가"\}/u);
  assert.match(PAGES.operations, /<ConsoleDialog title="스태프 배정"/u);
  assert.match(PAGES.operations, /DialogError/u, 'operations keeps dialog field errors');
  assert.doesNotMatch(PAGES.operations, /function Dialog\(\{/u, 'operations drops its private focus trap');
});

test('preparation lists use shared record layout without nested cards', () => {
  assert.match(PAGES.content, /uiStyles\.collection/u);
  assert.match(PAGES.content, /uiStyles\.recordRow/u);
  assert.match(PAGES.content, /uiStyles\.recordMain/u);
  assert.match(PAGES.content, /uiStyles\.recordMeta/u);
  assert.match(PAGES.content, /uiStyles\.recordActions/u);
  assert.match(PAGES.operations, /uiStyles\.collection/u);
  assert.match(PAGES.operations, /uiStyles\.recordRow/u);
});

test('archived events read as read-only with the reason on every write control', () => {
  for (const [pageId, source] of Object.entries(PAGES)) {
    assert.match(source, /=== "ARCHIVED"/u, `${pageId} derives the archived gate from server stage`);
    assert.match(source, /보관된 행사는 읽기 전용입니다/u, `${pageId} names the reason`);
  }
  assert.match(PAGES.settings, /disabled=\{busy \|\| archived \|\| !canWriteSettings\}/u);
  assert.match(PAGES.settings, /disabled=\{busy \|\| archived \|\| !canWriteIntake\}/u);
  assert.match(PAGES.messages, /const messagesLocked = archived \|\| !state\.canWriteMessages/u);
  assert.match(PAGES.messages, /disabled=\{selectedCount === 0 \|\| busyAction !== null \|\| uploadingImage \|\| messagesLocked\}/u);
  assert.match(PAGES.content, /disabled=\{busy !== null \|\| archived\}/u);
  for (const [section, permission] of [['onsite', 'Onsite'], ['booth', 'Booth'], ['display', 'Display']]) {
    assert.match(PAGES.operations, new RegExp(`const ${section}Blocked = archived \\|\\| !canWrite${permission}`, 'u'));
    if (section === 'display') {
      assert.match(PAGES.operations, /disabled=\{busy \|\| !displayChoice \|\| displayChoice === currentDisplayValue \|\| displayBlocked\}/u);
      assert.match(PAGES.operations, /title=\{\s*displayBlocked\s*\? displayNoWriteReason/u);
    } else {
      assert.match(PAGES.operations, new RegExp(`disabled=\\{busy \\|\\| ${section}Blocked\\}`, 'u'));
      assert.match(PAGES.operations, new RegExp(`title=\\{${section}Blocked \\? ${section}NoWriteReason : undefined\\}`, 'u'));
    }
  }
  assert.match(PAGES.operations, /function commandBlocked\(command: string\): boolean \{\s*if \(archived\) return true;\s*return !canWriteEvent\(capabilities, command\)/u);
});

test('settings gates on the signed-in actor, not the account directory', () => {
  assert.match(PAGES.settings, /\/api\/auth\/me/u);
  assert.match(PAGES.settings, /const user = record\(record\(meData\)\?\.user\)/u);
  assert.match(PAGES.settings, /const role = text\(user\.role\)/u);
  assert.match(PAGES.settings, /const myId = text\(user\.id\)/u);
  assert.match(PAGES.settings, /const capabilities = \{ role: state\.role, userId: state\.userId, memberships: state\.memberships, eventId \}/u);
  assert.match(PAGES.settings, /canWriteEvent\(capabilities, "event\.update"\)/u);
  assert.match(PAGES.settings, /canWriteEvent\(capabilities, "form\.publish"\)/u);
  const capabilities = read('lib/event-capabilities.ts');
  assert.match(capabilities, /if \(role === "AGENCY"\) return true/u);
  assert.match(capabilities, /if \(role !== "MANAGER"\) return false/u);
  assert.match(capabilities, /item\.accountId === userId && item\.eventId === eventId/u);
  assert.match(capabilities, /if \(grants === null\) return false/u);
  assert.doesNotMatch(PAGES.settings, /canManageEvent = accounts\.some/u);
});

test('render corrections: warning spacing and truthful draft guard', () => {
  assert.match(
    PAGES.messages,
    /발송 상태는 공급사 응답을 기준으로 표시합니다\.\{" "\}/u,
    'provider warning keeps a real space between lead and body'
  );
  assert.match(
    PAGES.messages,
    // Presentation change: retain the provider state and require the actual
    // delivery limit in the always-visible summary, not only inside details.
    /<summary>발송 연결 · \{state\.integrations\.connected \? "연결됨" : "미연동 · 실제 전달 안 됨"\}<\/summary>/u,
    'provider state AND the non-delivery limit stay visible before sending'
  );
  assert.match(
    PAGES.operations,
    /commandBusyRef\.current \|\|/u,
    'operations guard tracks in-flight commands'
  );
  assert.match(
    PAGES.operations,
    /commandIdCache\.current\.size > 0/u,
    'operations guard tracks receipts kept after ambiguous responses'
  );
  assert.doesNotMatch(
    PAGES.operations,
    /deskOpen \|\|\n {6}boothOpen/u,
    'operations guard no longer warns on merely open pristine dialogs'
  );
  assert.match(
    PAGES.operations,
    /res\.status !== 408 && res\.status < 500/u,
    'definitive rejections clear the receipt id; ambiguous ones keep it'
  );
});

test('ux-case fixes: booth edit, booth-only assignment, masked phones, true selected review', () => {
  const messages = read('app/console/events/[id]/messages/MessagingWorkspace.tsx');
  const ops = read('app/console/events/[id]/operations/OperationsWorkspace.tsx');
  // Booth rows edit through the same booth.save with the row id.
  assert.match(ops, /setEditingBooth\(booth\)/u);
  assert.match(ops, /initial\?: Booth \| null/u);
  assert.match(ops, /title=\{initial \? "부스 편집" : "부스 추가"\}/u);
  assert.match(ops, /\.\.\.\(initial \? \{ id: initial\.id \} : null\)/u);
  // Assignment works with booths only and defaults to booth without desks.
  assert.match(ops, /assignableTargets/u);
  // Contextual row opens may override the type; the generic entry must keep
  // the original booth-only fallback when no desk exists.
  assert.match(ops, /initialType=\{assignPreset\?\.type \?\? \(desks\.length \? "DESK" : "BOOTH"\)\}/u);
  assert.match(ops, /배정하려면 먼저 데스크나 부스를 만드세요/u);
  // Recipient rows show the same masked phone participants show.
  assert.match(messages, /function maskPhone\(phone: string\)/u);
  assert.match(messages, /\$\{digits\.slice\(0, 3\)\}-[*]{4}-\$\{digits\.slice\(-4\)\}/u);
  assert.match(messages, /maskPhone\(person\.phone\)/u);
  // Selected-only review bypasses status/search instead of intersecting them.
  assert.doesNotMatch(messages, /\? searchedRecipients\.filter\(\(person\) => selectedIds/u);
  assert.match(messages, /선택한 대상이 없습니다/u);
});
test('message safeguards survive the migration untouched', () => {
  assert.match(PAGES.messages, /fingerprintFor\(/u);
  assert.match(PAGES.messages, /inFlightRef/u);
  assert.match(PAGES.messages, /simulate: item\.simulate === true/u);
  assert.match(PAGES.messages, /storedSimulate/u);
  assert.match(PAGES.messages, /cancelRefs/u);
  assert.match(PAGES.messages, /내용을 바꾸지 않고 같은 요청으로 다시 시도하세요/u);
  assert.match(PAGES.messages, /모의 예약·전달 없음/u);
});

test('settings dirty sections and command receipts survive the migration', () => {
  assert.match(PAGES.settings, /liveRef/u);
  assert.match(PAGES.settings, /commandIdCache/u);
  assert.match(PAGES.settings, /isProvenResponse/u);
  assert.match(PAGES.settings, /operationsBusyRef/u);
  assert.match(PAGES.settings, /stageCommandIdRef/u);
});

test('content keeps venue-draft protection and idempotent writes', () => {
  assert.match(PAGES.content, /venueBaselineRef/u);
  assert.match(PAGES.content, /commandIdCache/u);
  assert.match(PAGES.content, /attachmentDirty/u);
  assert.match(PAGES.content, /게시한 항목만 참가자에게 보입니다/u);
});

test('messages applies the roster ?to= handoff once and pages long history', () => {
  const messages = read('app/console/events/[id]/messages/MessagingWorkspace.tsx');
  // Param contract: /console/events/:id/messages?to=<comma-separated ids>,
  // read once on load, stripped with history.replaceState (no navigation).
  assert.match(messages, /params\.get\("to"\)/u, 'handoff reads ?to= on load');
  assert.match(messages, /history\.replaceState/u, 'handoff removes ?to= without navigation');
  assert.match(messages, /handoffAppliedRef/u, 'handoff applies once per event');
  assert.match(messages, /handoffNotice/u);
  assert.match(messages, /인계받았습니다/u, 'handoff reports the inherited count');
  assert.match(messages, /제외.*\(취소·삭제\)/u, 'handoff reports missing/cancelled/duplicate exclusions');
  assert.match(messages, /CANCELLED/u, 'cancelled ids stay excluded from the handoff');
  assert.match(messages, /setShowSelectedOnly\(true\)/u, 'handoff opens the selected-only review mode');
  assert.match(messages, /id="handoff-notice"/u, 'handoff notice has a stable selector');
  // Long history reveals every campaign incrementally: first 10, +10 per click.
  assert.match(messages, /shownCampaigns/u);
  assert.match(messages, /slice\(0, historyLimit\)/u, 'history reveals the first page');
  assert.match(messages, /setHistoryLimit\(\(current\) => current \+ 10\)/u, 'history grows 10 per click');
  assert.match(messages, /이전 발송 더 보기/u);
  assert.match(messages, /id="campaign-history-more"/u, 'history overflow has a stable selector');
});

test('message history reveal moves focus to the first new row', () => {
  const messages = read('app/console/events/[id]/messages/MessagingWorkspace.tsx');
  // Rows insert before the focused 더 보기, so focus must follow the new
  // rows — including the final reveal where the button unmounts. Counts and
  // the attention anchor semantics stay untouched.
  assert.match(messages, /pendingHistoryFocusRef/u, 'reveal records the first new row index');
  assert.match(messages, /pendingHistoryFocusRef\.current = shownCampaigns\.length/u, 'pending index is the pre-reveal window end');
  assert.match(messages, /historyListRef\.current\?\.querySelectorAll<HTMLElement>\("\[data-history-row\]"\)\[target\]/u, 'focus lands on the first newly revealed record, not its optional detail row');
  assert.match(messages, /data-history-row/u, 'revealed rows carry a stable marker');
  assert.match(messages, /attentionParam === "1"/u, 'attention anchor semantics stay');
});
