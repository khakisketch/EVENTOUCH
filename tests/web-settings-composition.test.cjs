'use strict';

// Approved 행사 설정 composition (2026-11-15, option A5): one workbench page
// (event card with identity plus stage on top, intake and features panels
// below, basics editing in a right-edge drawer). Behavior (per-section save,
// publish review, close confirm, stage transition, conflicts, recovery,
// permission gates, address-code confirm on published events) is pinned by the
// settings contract tests; this file locks the composition.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'apps/web/app/console/events/[id]/settings');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const workspace = read('SettingsWorkspace.tsx');
const css = read('settings.module.css');

test('one workbench page: event card on top, two panels below, no tabs', () => {
  assert.doesNotMatch(workspace, /role="tablist"/u);
  assert.doesNotMatch(workspace, /role="tabpanel"/u);
  // Event card: calendar, name, meta, saved policies, edit button, stage.
  assert.match(workspace, /className=\{styles\.eventCard\}/u);
  assert.match(workspace, /className=\{styles\.cal\}/u);
  assert.match(workspace, /<h2 id="settings-basics">\{state\.basics\.name\}<\/h2>/u);
  assert.match(workspace, /\{state\.eventMeta\}/u);
  assert.match(workspace, /savedPolicyFlags\(\)/u);
  assert.match(workspace, /onClick=\{\(\) => setBasicsOpen\(true\)\}/u);
  assert.match(workspace, /id="panel-settings-stage"/u);
  assert.match(workspace, /id="panel-settings-intake"/u);
  assert.match(workspace, /id="panel-settings-features"/u);
  // Basics editing lives in a drawer; the card mirrors its dirty state.
  assert.match(workspace, /<ConsoleDialog[\s\S]{0,300}title="기본 정보"[\s\S]{0,300}presentation="drawer"/u);
  assert.match(workspace, /titleId="settings-basics-dialog"/u);
  // A hash deep link scrolls to its section; basics opens the drawer.
  assert.match(workspace, /sectionFromHash\(window\.location\.hash\)/u);
  assert.match(workspace, /if \(section === "basics"\) \{ setBasicsOpen\(true\); return; \}/u);
});

test('the screen edits no price and no display format', () => {
  assert.doesNotMatch(workspace, /id="set-price"/u);
  assert.doesNotMatch(workspace, /id="set-format"/u);
  assert.doesNotMatch(workspace, /EVENT_FORMAT_CHOICES/u);
  assert.doesNotMatch(workspace, /참가비 \(원\)/u);
  // Stored values still travel verbatim in saves and baselines.
  assert.match(workspace, /price: Number\(basics\.price\) \|\| 0/u);
  assert.match(workspace, /format: basics\.format/u);
});

test('published address-code changes confirm with before/after', () => {
  assert.match(workspace, /currentStage !== "DRAFT" && basics\.slug !== state\.basics\.slug/u, 'draft stage saves directly');
  assert.match(workspace, /setSlugConfirm\(true\)/u);
  assert.match(workspace, /주소 코드를 바꿀까요\?/u);
  assert.match(workspace, /이전 주소\(\{state\.basics\.slug\}\)/u);
  assert.match(workspace, /새 주소\(\{basics\.slug \|\| "미입력"\}\)/u);
  assert.match(workspace, /confirmLabel="주소 바꾸고 저장"/u);
});

test('intake reads as a status band plus the participant form', () => {
  assert.match(workspace, /className=\{`\$\{styles\.intakeBand\} \$\{state\.registrationOpen \? styles\.bandOpen : styles\.bandClosed\}`\}/u);
  // The honest publicity lines stay verbatim.
  assert.match(workspace, /현재 \{state\.registrationOpen \? "접수 중" : "접수 닫힘"\} · 게시된 양식 버전 \{state\.publishedVersion\}/u);
  assert.match(workspace, /\(설정\) · 게시된 양식 버전 \{state\.publishedVersion\}/u);
  // The application reads as the form the participant sees.
  assert.match(workspace, /className=\{styles\.formPreview\}/u);
  assert.match(workspace, /참가 신청서/u);
  assert.match(workspace, /항목 편집/u);
  assert.match(workspace, /state\.fields\.map/u);
  // The publish button names the state: plain publish when clean or closed,
  // 변경 게시 when open with unpublished consent edits.
  assert.match(workspace, /!state\.registrationOpen \? "양식 게시·접수 열기" : intakeDirty \? "변경 게시" : "양식 게시·접수 열기"/u);
  assert.match(workspace, /void runCommand\("form\.close"/u);
});

test('features are always-visible tiles with revert beside save', () => {
  assert.match(workspace, /<fieldset className=\{styles\.featureGroups\}/u);
  assert.match(workspace, /legend id="settings-features-legend"/u);
  assert.match(workspace, /onClick=\{\(\) => \{ setFeatures\(state\.features\); setFeaturesStatus\(null\); \}\}/u, 'revert restores the server selection');
  assert.match(workspace, /되돌리기/u);
  assert.match(workspace, /저장 안 된 변경/u);
  assert.match(css, /\.featureGrid > \.check \{/u);
  assert.match(css, /:has\(input:checked\)/u, 'the checked tile reads selected');
  assert.match(css, /:has\(input:focus-visible\)/u, 'keyboard focus stays visible');
});

test('section and dialog chrome reuse tokens with 44px targets', () => {
  for (const cls of ['eventCard', 'workPanels', 'cardStage', 'intakeBand', 'formPreview', 'sectionFlash', 'stageName', 'stageDot']) {
    assert.match(css, new RegExp(`\\.${cls} \\{`, 'u'), `${cls} style exists`);
  }
  assert.match(css, /\.eventTop \{/u);
  assert.match(css, /\.cardEdit \{/u);
  assert.match(css, /min-height: 44px/u);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}/u);
  assert.doesNotMatch(css, /rgb\(/u);
});
