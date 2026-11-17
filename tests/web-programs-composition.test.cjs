'use strict';

// Approved programs composition (2026-11-14): a flat ledger grouped by run
// state with type tiles, one amber doorway to a modal review drawer, and the
// merged answer card. Change it only on a new owner decision.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'apps/web/app/console/events/[id]/programs');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const workspace = read('ProgramsWorkspace.tsx');
const drawer = read('ReviewDrawer.tsx');
const icons = read('ProgramIcons.tsx');
const css = read('programs.module.css');
const dialog = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/console/console-ui/ConsoleDialog.tsx'), 'utf8');

test('approved programs design stays locked: ledger rows grouped by run state, one orange action', () => {
  assert.match(workspace, /\{ key: "OPEN", label: "진행 중" \},\s*\{ key: "DRAFT", label: "준비 중" \},\s*\{ key: "CLOSED", label: "종료" \}/u, 'rows group as 진행 중 / 준비 중 / 종료');
  assert.match(workspace, /<ProgramTypeIcon type=\{module\.type\} state=\{state\} \/>/u, 'each row opens with its type tile and state dot');
  assert.match(workspace, /className=\{styles\.moduleSummary\}/u);
  assert.ok((workspace.slice(0, workspace.indexOf('function ModuleDialog')).match(/variant="primary"/gu) || []).length === 1, 'the page has exactly one orange action: 콘텐츠 만들기 (the create dialog keeps its own submit)');
  assert.match(workspace, /콘텐츠 만들기/u);
  assert.doesNotMatch(workspace, /styles\.typeBadge|styles\.status\b|statusOpen|statusDraft|workspacePurpose/u, 'type and state pills and the purpose paragraph stay gone');
  assert.match(workspace, /className=\{styles\.rowAction\}/u, '시작 / 다시 열기 sit at the row end, 종료 inside the expanded row');
  assert.match(workspace, /onClick=\{\(\) => props\.onRequestStatus\("CLOSED"\)\}>종료</u);
  assert.doesNotMatch(css, /\.moduleCard\s*\{[^}]*border-bottom/su, 'rows are divided by space, not hairlines');
});

test('review drawer: one doorway, modal presentation, same handlers as the lists', () => {
  assert.match(workspace, /aria-haspopup="dialog"/u);
  assert.match(workspace, /<ReviewDrawer/u);
  assert.match(drawer, /presentation="drawer"/u);
  assert.match(dialog, /presentation\?: "modal" \| "inspector" \| "drawer"/u);
  assert.match(drawer, /onManage\(question, true\)/u, 'answer-and-publish reuses manageQuestion');
  assert.match(drawer, /onManage\(question, false\)/u, '답변만 저장 reuses manageQuestion');
  assert.match(drawer, /onRequestPhoto\(photo, "APPROVED"\)/u);
  assert.match(drawer, /<ConsoleConfirm/u, 'photo and post decisions keep their confirmation');
  assert.match(drawer, /onOpenEdit\(question\)/u, 'a pending question edit is decided in the content list, where conflict recovery lives');
  assert.match(workspace, /if \(recoveryActive\) setDrawerOpen\(false\)/u, 'recovery banners are never left behind the scrim');
  assert.match(drawer, /id=\{`review-(question|photo|post)-\$\{/u, 'drawer ids never duplicate the list ids');
});

test('answer card: asker, bubble, one reply field, one send, quiet save, no nested borders', () => {
  assert.match(drawer, /styles\.asker/u);
  assert.match(drawer, /styles\.bubble/u);
  assert.match(drawer, /styles\.replyField/u);
  assert.match(drawer, /aria-label=\{question\.approved \? "답변 저장" : "답변하고 공개"\}/u, 'the icon-only send is named for what it does');
  assert.match(drawer, /답변만 저장/u);
  assert.match(drawer, /document\.getElementById\(`review-answer-\$\{openId\}`\)\?\.focus\(\)/u, 'opening lands the cursor in the reply field');
  assert.match(css, /\.sendButton\.sendButton\s*\{[^}]*background:\s*var\(--ink\)/su, 'the send circle is ink, not orange');
  assert.doesNotMatch(drawer, /반려<\/ProductButton>[\s\S]{0,120}onManage/u, 'questions have no reject action; only edits do');
});

test('type tiles use tokens, a stroke family and an accessible text label elsewhere', () => {
  for (const type of ['poll', 'quiz', 'qa', 'survey', 'draw', 'photo', 'board']) {
    assert.match(icons, new RegExp(`case "${type}"`, 'u'), `${type} has its own glyph`);
    assert.match(css, new RegExp(`typeTile\\[data-type="${type}"\\]`, 'u'), `${type} has its own tint`);
  }
  assert.match(icons, /aria-hidden="true"/u, 'tiles are decorative; the row text names type and state');
  assert.doesNotMatch(css, /#[0-9A-Fa-f]{3,8}\b/u, 'programs CSS uses tokens, never hex');
  assert.match(workspace, /<span className="sr-only"> · \{statusLabel\(module\)\}<\/span>/u, 'state is also read aloud');
});

test('targets stay 44px and phone rows keep one line each', () => {
  assert.match(css, /\.moduleSummary\s*\{[^}]*min-height:\s*72px/su);
  assert.match(css, /\.drawerItem :global\(\.product-action\)\s*\{\s*min-height:\s*44px/u);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.meterSpacer\s*\{\s*display:\s*none/u, 'the empty meter cell never pushes the count to a second line');
});

test('the manual-grading fold keeps a 44px touch target like the other disclosures', () => {
  assert.match(css, /\.resultDisclosure > summary,\s*\.rejectDisclosure > summary \{[^}]*min-height:\s*44px/su);
});
