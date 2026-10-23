'use strict';

// Settings no longer edits the attendee page: the ThemeWorkspace at
// /console/events/:id/page is the single editor (guarded by
// expectedDraftVersion), and settings keeps a status link so the two can
// never silently overwrite each other. Settings also keeps section order,
// anchor navigation, blocked stage preconditions, idempotent retries and
// independent dirty forms.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

const SETTINGS = 'app/console/events/[id]/settings/SettingsWorkspace.tsx';
const THEME = 'app/console/events/[id]/page/ThemeWorkspace.tsx';

test('settings-attendee-single-entry: page editing lives only in the theme editor', () => {
  const settings = read(SETTINGS);
  const theme = read(THEME);
  assert.doesNotMatch(settings, /attendee\.page\.save/);
  assert.doesNotMatch(settings, /attendee\.page\.publish/);
  assert.doesNotMatch(settings, /PageDraft/);
  assert.match(theme, /attendee\.page\.save/);
  assert.match(theme, /attendee\.page\.publish/);
  assert.doesNotMatch(settings, /label: "참가자 페이지"/u);
  assert.match(settings, /참가자 페이지 편집으로 이동/);
  assert.match(settings, /\/console\/events\/\$\{encodeURIComponent\(eventId\)\}\/page/);
  assert.match(settings, /pagePublishedAt/);
  assert.match(settings, /최근 게시/);
});

test('settings-attendee-single-entry: theme edits intro, accent and visibility with guarded saves', () => {
  const theme = read(THEME);
  for (const id of ['home-intro', 'home-accent']) {
    assert.match(theme, new RegExp(`id="${id}"`), `theme edits ${id}`);
  }
  for (const field of ['showAnnouncements', 'showSchedule', 'showVenue', 'showPrograms']) {
    assert.match(theme, new RegExp(`pageFields\\.${field}`), `theme edits ${field}`);
  }
  assert.match(theme, /savedPageFields/);
  assert.match(theme, /pageFieldsAreDirty/);
  assert.match(theme, /updatePageField/);
  assert.match(theme, /\.\.\.state\.pageFields,/);
  assert.match(theme, /homeStyle: \{\s*\.\.\.state\.form\.homeStyle/);
  assert.match(theme, /expectedDraftVersion: state\.draftVersion/);
  assert.match(theme, /아래 소개 입력란을 확인하세요/);
});

test('settings-attendee-single-entry: tabs stay in preparation order with deep-link anchors', () => {
  const settings = read(SETTINGS);
  // Four real tabs own the zones; deep-link anchors survive for each tab.
  assert.doesNotMatch(settings, /<ConsoleSectionNav/);
  assert.match(settings, /role="tablist"/u);
  assert.match(settings, /role="tab"/u);
  assert.match(settings, /role="tabpanel"/u);
  const order = ['기본 정보', '참가 접수', '운영 기능', '진행 단계']
    .map((label) => settings.indexOf(label));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  for (const id of ['settings-basics', 'settings-intake', 'settings-features', 'settings-stage']) {
    assert.ok(settings.includes(id), `deep-link anchor survives: ${id}`);
  }
  // The attendee-page supporting block is content, never a fifth tab label.
  assert.match(settings, /참가자 페이지 편집으로 이동/);
  assert.doesNotMatch(settings, /label: "참가자 페이지"/u);
});

test('settings-attendee-single-entry: stage preconditions block instead of failing remotely', () => {
  const settings = read(SETTINGS);
  assert.match(settings, /stagePrecondition/);
  assert.match(settings, /stageBlocked/);
  assert.match(settings, /disabled=\{stageBusy \|\| busy \|\| stageBlocked\}/);
  assert.match(settings, /!stageConfirm \|\| stageBlocked/);
  assert.match(settings, /\/operations/);
  assert.match(settings, /\/programs/);
  assert.match(settings, /href="#settings-intake"/);
  assert.match(settings, /retry=\{Boolean\(stageCommandIdRef\.current && stageError\)\}/);
  assert.match(read('app/console/console-ui/StageTransitionConfirmation.tsx'), /같은 요청 다시 시도/);
  assert.match(settings, /Preserve the id so a retry can replay the server receipt after a lost response/);
});

test('settings-attendee-single-entry: closed registration shows status, not a dead button', () => {
  const settings = read(SETTINGS);
  assert.doesNotMatch(settings, /disabled=\{busy \|\| !state\.registrationOpen\}/);
  assert.match(settings, /접수가 닫혀 있습니다/);
});

test('settings-attendee-single-entry: in-flight commands share a synchronous guard', () => {
  const settings = read(SETTINGS);
  assert.match(settings, /operationsBusyRef/);
  assert.match(settings, /operationsBusyRef\.current = true/);
  assert.match(settings, /if \(busy \|\| operationsBusyRef\.current\) return false/);
  assert.match(settings, /stageBusy \|\| operationsBusyRef\.current/);
});

test('settings-attendee-single-entry: empty or misshapen 2xx bodies stay ambiguous', () => {
  const settings = read(SETTINGS);
  assert.match(settings, /isProvenResponse/);
  assert.match(settings, /text\(event\.id\) === eventId/);
  assert.match(settings, /data\.registrationOpen === false/);
  assert.match(settings, /text\(event\.stage\)\.toUpperCase\(\) === expectedStage/);
  assert.match(settings, /if \(!isProvenResponse\(command, data\)\)/);
  assert.match(settings, /if \(!isProvenResponse\("event\.stage", data, nextStage\)\)/);
});

test('settings-attendee-single-entry: blocked stage buttons reference the visible reason', () => {
  const settings = read(SETTINGS);
  assert.match(settings, /id="settings-stage-precondition"/);
  assert.match(settings, /aria-describedby=\{stageBlocked \? "settings-stage-precondition" : undefined\}/);
  assert.doesNotMatch(settings, /title=\{stageBlocked/);
});

test('settings-attendee-single-entry: publish summary covers intro and visibility changes', () => {
  const theme = read(THEME);
  assert.match(theme, /publishedPageFields/);
  assert.match(theme, /describeChangedPageFields/);
  assert.match(theme, /노출 항목\(\$/);
  assert.match(theme, /내 변경을 최신 초안에 적용/);
  assert.match(theme, /게시본과 다른 저장된 변경/);
});

test('settings-attendee-single-entry: retries reuse one id per command fingerprint', () => {
  const settings = read(SETTINGS);
  assert.match(settings, /commandIdCache/);
  assert.match(settings, /stableStringify/);
  assert.match(settings, /isAmbiguousFailure/);
  assert.match(settings, /408/);
  assert.match(settings, />= 500/);
  assert.match(settings, /commandIdCache\.current\.delete\(fingerprint\)/);
  assert.match(settings, /같은 요청으로 다시 시도하세요/);
  assert.match(settings, /liveRef/);
  assert.match(settings, /JSON\.stringify\(live\.basics\)/);
  assert.match(settings, /describedBy/);
  assert.match(settings, /FEATURE_GROUPS/);
  assert.match(settings, /verificationRequired/);
  // The actor comes from the concurrent session/bootstrap read, not from an
  // account directory: AGENCY everywhere, MANAGER on their own events. The
  // server still authorizes every settings command.
  assert.match(settings, /fetch\("\/api\/auth\/me", \{ cache: "no-store" \}\)/);
  assert.match(settings, /fetch\("\/api\/bootstrap", \{ cache: "no-store" \}\)/);
  assert.match(settings, /const user = record\(record\(meData\)\?\.user\)/);
  assert.match(settings, /const canManageEvent = role === "AGENCY" \|\| \(role === "MANAGER" && memberships\.some\(/);
  assert.match(settings, /Display gate only: AGENCY everywhere, MANAGER on their own events/);
});
