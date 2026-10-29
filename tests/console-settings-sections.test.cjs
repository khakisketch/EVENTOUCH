// Settings workspace: 4 real tabs, per-section save state, one-line scope
// note, and section-named draft-guard reasons. Source-contract test only
// (no build/server/npm test).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workspacePath = path.resolve(
  __dirname,
  "..",
  "apps",
  "web",
  "app",
  "console",
  "events",
  "[id]",
  "settings",
  "SettingsWorkspace.tsx"
);
const cssPath = path.resolve(
  __dirname,
  "..",
  "apps",
  "web",
  "app",
  "console",
  "events",
  "[id]",
  "settings",
  "settings.module.css"
);
const source = fs.readFileSync(workspacePath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

test("a one-line scope note states each tab saves only itself", () => {
  assert.match(source, /data-settings-scope-note/u);
  assert.match(source, /각 구역의 저장·게시·전환은 그 구역에만 적용됩니다/u);
  const noteLine = source
    .split("\n")
    .find((line) => line.includes("각 구역의 저장·게시·전환은 그 구역에만 적용됩니다"));
  assert.ok(noteLine, "scope note line must exist");
  assert.doesNotMatch(noteLine, /기본 정보·참가 접수·운영 기능·진행 단계/u, "the note does not repeat the visible tab labels");
  for (const label of ["기본 정보", "참가 접수", "운영 기능", "진행 단계"]) {
    assert.ok(source.includes(`label: "${label}"`), `${label} remains discoverable in the tablist`);
  }
});

test("each saving tab keeps its own success/failure line with a clock time", () => {
  for (const section of ["basics", "intake", "features"]) {
    assert.ok(
      source.includes(`data-settings-section-status={`) ||
        source.includes("data-settings-section-status"),
      `${section} status marker must exist`
    );
  }
  assert.match(source, /sectionStatusLine\(basicsStatus, "basics"\)/u);
  assert.match(source, /sectionStatusLine\(intakeStatus, "intake"\)/u);
  assert.match(source, /sectionStatusLine\(featuresStatus, "features"\)/u);
  // Status line renders message + HH:MM and announces politely.
  assert.match(source, /\{status\.message\} · \{status\.at\}/u);
  assert.match(source, /role="status"/u);
  assert.match(source, /formatClockNow/u);
  // Both outcomes land in place, not only in the page-top banner.
  assert.match(source, /kind: "success", message: successMessage/u);
  assert.match(source, /kind: "error", message/u);
  // The page-top feedback strip is retained (no silent removal).
  assert.match(source, /\{failure \? <ConsoleFeedback kind="error"/u);
  assert.match(source, /\{notice \? <ConsoleFeedback kind="success"/u);
  // Tab saves thread their section through the shared command runner.
  assert.match(source, /"기본 정보를 저장했습니다\.", "basics"/u);
  assert.match(source, /"접수를 닫았습니다\.", "intake"/u);
  assert.match(source, /"운영 기능 설정을 저장했습니다\.", "features"/u);
});

test("settings uses four real tabs; only the optional page block discloses", () => {
  // The old ConsoleSectionNav anchor list and the collapsed stage panel are
  // gone; four accessible tabs own the zones. The single remaining details
  // is the optional attendee-page disclosure after the return footer.
  assert.doesNotMatch(source, /<ConsoleSectionNav/u);
  assert.doesNotMatch(source, /data-settings-collapse/u);
  assert.match(source, /role="tablist"/u);
  assert.match(source, /role="tab"/u);
  assert.match(source, /role="tabpanel"/u);
  assert.match(source, /aria-selected/u);
  assert.match(source, /aria-controls/u);
  for (const label of ["기본 정보", "참가 접수", "운영 기능", "진행 단계"]) {
    assert.ok(source.includes(label), `tab label missing: ${label}`);
  }
  // Four tabs, not five: the attendee-page supporting block is content,
  // never a tab label in the tab definition.
  for (const entry of [
    '{ id: "basics", anchor: "settings-basics", label: "기본 정보" }',
    '{ id: "intake", anchor: "settings-intake", label: "참가 접수" }',
    '{ id: "features", anchor: "settings-features", label: "운영 기능" }',
    '{ id: "stage", anchor: "settings-stage", label: "진행 단계" }',
  ]) {
    assert.ok(source.includes(entry), `tab definition missing: ${entry}`);
  }
  assert.doesNotMatch(source, /label: "참가자 페이지"/u);
  // Deep-link anchors survive for the four tab zones.
  for (const id of ["settings-basics", "settings-intake", "settings-features", "settings-stage"]) {
    assert.ok(source.includes(id), `deep-link anchor missing: ${id}`);
  }
  // Stage keeps its existing behavior inside its tab panel, now with the
  // full five-stage timeline ahead of the transition control.
  assert.match(source, /submitStageTransition/u);
  assert.match(source, /<StageTransitionConfirmation/u);
  assert.match(source, /stageTimeline/u);
  assert.match(source, /aria-label="전체 진행 단계"/u);
  assert.match(source, /aria-current=\{isCurrent \? "step" : undefined\}/u);
  assert.match(source, /STAGE_ORDER\.map\(\(stage\)/u);
  // Tab order follows the preparation flow.
  const tabOrder = ["기본 정보", "참가 접수", "운영 기능", "진행 단계"].map((label) =>
    source.indexOf(label)
  );
  assert.ok(tabOrder.every((position) => position >= 0));
  assert.deepEqual(tabOrder, [...tabOrder].sort((a, b) => a - b));
});

test("the optional page disclosure sits after the return footer, not as a section", () => {
  // Optional and independent: a small details with its own anchor id, never
  // a ConsoleSection heading, placed after the return footer.
  assert.match(source, /<details className=\{styles\.pageDisclosure\} id="settings-page"/u);
  assert.doesNotMatch(source, /headingId="settings-page"/u);
  assert.match(source, /참가자 페이지 · 선택 사항/u);
  assert.match(source, /현황으로 돌아가기/u);
  assert.ok(
    source.indexOf("현황으로 돌아가기") < source.indexOf('id="settings-page"'),
    "return footer precedes the optional disclosure"
  );
  assert.match(source, /참가자 페이지 편집으로 이동/u);
  assert.match(source, /\/console\/events\/\$\{encodeURIComponent\(eventId\)\}\/page/);
  assert.match(source, /pagePublishedAt/u);
  assert.match(source, /최근 게시/u);
  assert.match(source, /게시하지 않아도 공개·접수·진행에 영향이 없습니다/u);
});

test("the existing draft-guard passage names the dirty sections and confirms tab switches", () => {
  assert.match(source, /useConsoleDraftGuard\(/u);
  assert.match(source, /SETTINGS_SECTION_LABEL/u);
  assert.match(source, /dirtySectionNames/u);
  assert.match(source, /기본 정보/u);
  assert.match(source, /참가 접수/u);
  assert.match(source, /운영 기능/u);
  assert.equal(
    (source.match(/useConsoleDraftGuard\(/g) || []).length,
    1,
    "draft guard stays on its single existing passage"
  );
  assert.match(source, /페이지를 떠나면 사라집니다/u);
  // Tab switches never unmount a panel: every panel stays mounted and is
  // only hidden, so a dirty form survives switching tabs. Dirty tabs carry
  // a visible dot plus a screen-reader note, and each dirty form names
  // itself in place next to its own save action.
  assert.match(source, /hidden=\{activeTab !==/u);
  assert.match(source, /tabDirty/u);
  assert.match(source, /tabDirtyDot/u);
  assert.match(source, /저장 안 됨/u);
  for (const flag of ["basicsDirty", "intakeDirty", "featuresDirty"]) {
    assert.ok(source.includes(`${flag} ? (`), `${flag} shows its own in-form unsaved label`);
  }
  assert.equal(
    (source.match(/styles\.unsavedTag/g) || []).length,
    3,
    "each of the three saving forms labels its own dirty state"
  );
});

test("tab and status styles reuse existing tokens and keep 44px targets", () => {
  assert.match(css, /\.scopeNote/u);
  assert.match(css, /\.sectionStatus/u);
  assert.match(css, /\.tabs? \{/u);
  assert.match(css, /tabDirtyDot|tabPanel/u);
  assert.match(css, /\.unsavedTag \{/u);
  assert.match(css, /\.stageTimeline \{/u);
  assert.match(css, /\.pageDisclosure \{/u);
  assert.match(css, /\.settingsFooter \{/u);
  assert.match(css, /min-height: 44px/u);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}/u);
  assert.doesNotMatch(css, /rgb\(/u);
});

test("no server contract, permission, or API surface changes", () => {
  // Reads go through the shared transport (consoleFetch, any quote style);
  // the event read is the scoped bootstrap and the client list comes from
  // the directory. Writes keep the same command endpoint.
  const fetched = [...source.matchAll(/(?:consoleFetch|fetch)\(\s*[`"']([^`"']+)["`']/ug)].map((match) =>
    match[1].replace(/\$\{[^}]*\}/g, ":param")
  );
  assert.ok(fetched.length > 0, "expected fetch calls to audit");
  const allowed = new Set([
    "/api/auth/me",
    "/api/events/:param/bootstrap",
    "/api/console/directory",
    "/api/events/:param/commands",
  ]);
  for (const url of fetched) {
    assert.ok(allowed.has(url), `unexpected API surface: ${url}`);
  }
  assert.ok(fetched.includes("/api/events/:param/bootstrap"), "scoped event read is present");
  assert.ok(fetched.includes("/api/console/directory"), "client list comes from the directory");
  assert.doesNotMatch(source, /(?:consoleFetch|fetch)\("\/api\/bootstrap"/u, "no full bootstrap read remains");
  for (const url of fetched) {
    assert.ok(allowed.has(url), `unexpected API surface: ${url}`);
  }
  // The commands are the same three; they may travel positionally or as a
  // payload field, so the contract pins the names, not the call shape.
  assert.match(source, /"event\.update"/u);
  assert.match(source, /"event\.features"/u);
  assert.match(source, /"event\.stage"/u);
  assert.match(source, /payload: \{ stage: nextStage \}/u);
});
