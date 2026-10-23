// Settings workspace: per-section save state, save-scope note, folded
// stage/page summaries with live status, and section-named draft-guard
// reasons. Source-contract test only (no build/server/npm test).
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

test("a one-line scope note states each section saves only itself", () => {
  assert.match(source, /data-settings-scope-note/u);
  assert.match(source, /각 구역의 저장·게시·전환은 그 구역에만 적용됩니다/u);
  const noteLine = source
    .split("\n")
    .find((line) => line.includes("각 구역의 저장·게시·전환은 그 구역에만 적용됩니다"));
  assert.ok(noteLine, "scope note line must exist");
  assert.match(noteLine, /기본 정보·참가 접수·기능·진행 단계/u);
});

test("each saving section keeps its own success/failure line with a clock time", () => {
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
  // Section saves thread their section through the shared command runner.
  assert.match(source, /"기본 정보를 저장했습니다\.", "basics"/u);
  assert.match(source, /"접수를 닫았습니다\.", "intake"/u);
  assert.match(source, /"기능 설정을 저장했습니다\.", "features"/u);
});

test("stage and attendee-page sections fold with live status in the summary", () => {
  assert.match(source, /data-settings-collapse="stage"/u);
  assert.match(source, /data-settings-collapse="page"/u);
  assert.match(source, /data-settings-collapse-summary="stage"/u);
  assert.match(source, /data-settings-collapse-summary="page"/u);
  // Folded summaries carry the current state.
  assert.match(source, /진행 단계 · 현재 \$\{stageText\}/u);
  assert.match(source, /pageSummary/u);
  assert.match(source, /미게시/u);
  assert.match(source, /게시 버전/u);
  // Native details/summary keeps keyboard access; headings stay mounted so
  // anchors and the section nav never lose their targets.
  assert.ok(source.includes("<details"), "folding must use native <details>");
  assert.ok(source.includes("<summary"), "folding must use native <summary>");
  assert.match(source, /headingId="settings-stage"/u);
  assert.match(source, /headingId="settings-page"/u);
  // Expanded content keeps its existing behavior.
  assert.match(source, /submitStageTransition/u);
  assert.match(source, /참가자 페이지 편집으로 이동/u);
  // Ready/intake/features sections stay unfolded (no details wrapper).
  const basicsIndex = source.indexOf('headingId="settings-basics"');
  const intakeIndex = source.indexOf('headingId="settings-intake"');
  const featuresIndex = source.indexOf('headingId="settings-features"');
  const stageIndex = source.indexOf('headingId="settings-stage"');
  const firstDetails = source.indexOf("<details");
  assert.ok(basicsIndex >= 0 && intakeIndex >= 0 && featuresIndex >= 0);
  assert.ok(firstDetails > featuresIndex, "only stage/page fold");
  assert.ok(stageIndex < firstDetails, "stage folding starts at the stage section");
});

test("the existing draft-guard passage names the dirty sections", () => {
  assert.match(source, /useConsoleDraftGuard\(/u);
  assert.match(source, /SETTINGS_SECTION_LABEL/u);
  assert.match(source, /dirtySectionNames/u);
  assert.match(source, /기본 정보/u);
  assert.match(source, /참가 접수/u);
  assert.match(source, /기능/u);
  // No new confirmation plumbing: the same hook carries the improved reason.
  assert.equal(
    (source.match(/useConsoleDraftGuard\(/g) || []).length,
    1,
    "draft guard stays on its single existing passage"
  );
  assert.match(source, /페이지를 떠나면 사라집니다/u);
  assert.doesNotMatch(source, /window\.confirm/u);
});

test("folding and status styles reuse existing tokens and keep 44px targets", () => {
  assert.match(css, /\.scopeNote/u);
  assert.match(css, /\.sectionStatus/u);
  assert.match(css, /\.collapseSummary/u);
  assert.match(css, /min-height: 44px/u);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}/u);
  assert.doesNotMatch(css, /rgb\(/u);
});

test("no server contract, permission, or API surface changes", () => {
  const fetched = [...source.matchAll(/fetch\("([^"]+)"/ug)].map((match) =>
    match[1].replace(/\$\{[^}]*\}/g, ":param")
  );
  assert.ok(fetched.length > 0, "expected fetch calls to audit");
  const allowed = new Set([
    "/api/auth/me",
    "/api/bootstrap",
    "/api/events/:param/commands",
  ]);
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
