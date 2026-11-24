'use strict';

// Reopened 2026-11-19: the stage row is a connected stepper (done = green check, current = ink
// circle, next = outline) and the feature tiles carry a switch. Layout, drawer and behaviour below
// are unchanged.
// Reopened 2026-11-20 (디자인 시스템 적용): the page gains a left table of contents (SettingsToc,
// 변경됨 pill per section), the two panels stack as full-width hairline section cards (heading="rule"),
// each save row is a sticky bar (ConsoleFormActions sticky), the dirty tag is a StatusPill, and the stage dot is ink.
// Everything else below (event card, drawer, anchors, behaviour) is unchanged.
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
  assert.match(workspace, /<h2 id="settings-basics" className=\{styles\.eventTitle\}>\{state\.basics\.name\}<\/h2>/u);
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
  // Use the published snapshot whenever there is a live form.
  assert.match(workspace, /className=\{styles\.formPreview\}/u);
  assert.match(workspace, /현재 게시된 신청서/u);
  assert.match(workspace, /신청서 초안/u);
  assert.match(workspace, /항목 편집/u);
  assert.match(workspace, /hasPublishedForm \? state\.publishedFields : state\.fields/u);
  assert.match(workspace, /formPreviewFields\.map/u);
  // The publish button stays visible because application fields change on
  // their own page: even a clean consent may need a publish (a version
  // conflict then surfaces in review). Unpublished edits rename it 변경 게시.
  // Reopened 2026-11-24 (전수 점검 P5): in 기획 the intake stays closed after a
  // publish, so the button is "양식 게시" and the band says "접수 대기"; an open
  // intake with nothing changed offers "양식 다시 게시" instead of repeating 열기.
  assert.match(workspace, /\? \(intakeWaiting && intakeDirty \? "변경 게시" : "양식 게시"\)/u);
  assert.match(workspace, /!state\.registrationOpen \? "양식 게시·접수 열기" : intakeDirty \? "변경 게시" : "양식 다시 게시"/u);
  assert.match(workspace, /양식 게시됨 · 접수 대기 \(행사 단계를 운영 준비로 바꾸면 열립니다\)/u);
  assert.match(workspace, /hint: intakeWaiting \? "양식 게시됨 · 접수 대기"/u);
  assert.match(workspace, /void runCommand\("form\.close"/u);
});

test('reopened 2026-11-19: stage is a stepper and each feature tile shows a switch', () => {
  assert.match(workspace, /data-done=\{isDone \? "true" : undefined\}/u);
  assert.match(css, /\.stageStep\[data-done="true"\]::before\s*\{[^}]*var\(--success\)/su, 'finished steps are green with a check');
  assert.match(css, /\.stageStepCurrent::before\s*\{[^}]*background:\s*var\(--ink\)/su, 'the current step is ink, orange stays for actions');
  assert.match(css, /\.featureGrid > \.check::after\s*\{[^}]*width:\s*40px/su, 'the switch track');
  assert.match(css, /\.featureGrid > \.check input\s*\{[^}]*opacity:\s*0/su, 'the real checkbox stays in the tile for keyboard and screen readers');
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
  // The dark calendar block keeps full-white small text: dimmed paper on
  // ink fails contrast (caught by the preparation audit, 2026-11-15).
  const cal = css.slice(css.indexOf('.cal {'), css.indexOf('.eventName {'));
  assert.doesNotMatch(cal, /opacity/u);
});

// Reopened 2026-11-20 (디자인 시스템 적용)
test('Reopened 2026-11-20: left contents list, hairline section cards and a sticky save bar', () => {
  const toc = read('SettingsToc.tsx');
  const tocCss = read('settings-toc.module.css');
  assert.match(workspace, /<SettingsToc items=\{\[/u);
  assert.match(toc, /aria-label="설정 목차"/u);
  assert.match(toc, /<StatusPill tone="wait" size="sm" dot>변경됨<\/StatusPill>/u, 'each dirty section is named in the list');
  assert.match(toc, /item\.href \? \(/u, 'sections are anchors, basics opens the drawer');
  for (const flag of ['basicsDirty', 'intakeDirty', 'featuresDirty']) assert.ok(workspace.includes(`dirty: Boolean(${flag})`), `${flag} reaches the list`);
  assert.match(workspace, /title="참가 접수" heading="rule" surface="panel"/u);
  assert.match(workspace, /title="운영 기능" heading="rule" surface="panel"/u);
  // Reopened 2026-11-20 (shared gaps): the sticky save row is ConsoleFormActions' own `sticky` option, not a local .saveBar.
  assert.equal((workspace.match(/<ConsoleFormActions sticky>/g) || []).length, 2, 'intake and features keep their save row in view');
  assert.doesNotMatch(css, /\.saveBar/u, 'no local save bar');
  assert.match(css, /\.layout \{[^}]*grid-template-columns: 188px/su);
  assert.match(css, /\.workPanels \{[^}]*grid-template-columns: minmax\(0, 1fr\)/su, 'panels stack beside the list');
  assert.match(workspace, /<StatusPill tone="wait" size="sm" dot>저장 안 됨<\/StatusPill>/u);
  assert.match(css, /\.stageDot \{[^}]*background: var\(--ink\)/su, 'the stage dot is ink, not a second orange');
  assert.doesNotMatch(tocCss, /#[0-9a-fA-F]{3,8}|font-size:\s*\d+px/u);
  assert.doesNotMatch(css, /:global\(\[data-variant/u, 'no Astryx variant overrides');
});
