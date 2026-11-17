"use strict";

// Staff field screen, stage 1 (2026-11-14, mockup staff-viewfinder.html):
// one header line, the station as the title line, underline tabs, a plain
// recent list. Stage 2 (viewfinder stage, result stage, sheet) builds on it.
// Source-only; rendering rides the real browser check.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "staff");
const work = fs.readFileSync(path.join(DIR, "StaffEventWork.tsx"), "utf8");
const css = fs.readFileSync(path.join(DIR, "staff-event-work.module.css"), "utf8");

test("staff header is one line: back, event, one menu", () => {
  assert.match(work, /<details className=\{prizeStyles\.moreMenu\}>/u);
  const menu = work.slice(work.indexOf("<details className={prizeStyles.moreMenu}>"), work.indexOf("</details>", work.indexOf("moreMenu")));
  assert.match(menu, /orgLineText\(\)/u, "the org line lives in the menu");
  assert.match(menu, /role="switch"/u, "the kiosk switch lives in the menu");
  assert.match(menu, /<StaffAccountMenu/u, "the account menu lives in the menu");
  assert.doesNotMatch(work, /prizeStyles\.accountContext/u, "no separate account line above the work");
});

test("the station reads as the title line and nothing is fixed or sticky", () => {
  assert.match(css, /\.staff-select-field\) > select\s*\{[^}]*font-size:\s*22px/su);
  assert.match(css, /\.staff-select-field\) > select\s*\{[^}]*appearance:\s*none/su);
  assert.match(css, /\.eventWorkPage \.taskSwitch :global\(\.astryx-button\)\[aria-pressed="true"\][^{]*\{[^}]*border-bottom-color:\s*var\(--ink\)/su, "task tabs mark the current one with an ink underline");
  assert.doesNotMatch(css, /\.(?:moreBody|scanInput|scanPrimary|resultBlock)\s*\{[^}]*position:\s*(?:sticky|fixed)/su);
});

test("recent rows are plain: name, detail and time, no per-row button", () => {
  assert.doesNotMatch(work, /기록 확인 · 다음 참가자 입력 준비/u);
  assert.match(work, /className=\{prizeStyles\.recentName\}/u);
});

test("field result: a colored face over the camera, a plain success hands itself back", () => {
  assert.match(work, /data-tone=\{stageTone\}/u, "the overlay carries its tone");
  assert.match(work, /const infoFailure = result\.kind === "failed" && !result\.uncertain && \(result\.alreadyIn === true \|\| boothLimitReached\)/u, "an already-entered ticket is information, not an error");
  assert.match(work, /\(infoFailure \? "info" : result\.uncertain \|\| result\.attendanceReviewRequired[^)]*\? "warn" : "bad"\)/u, "needs-a-look is amber, a plain failure red");
  assert.match(css, /\.overlay\s*\{[^}]*var\(--success-soft\)/su);
  assert.match(css, /\.overlay\[data-tone="info"\]\s*\{[^}]*var\(--info-soft\)/su);
  assert.match(css, /\.overlay\[data-tone="warn"\]\s*\{[^}]*var\(--warning-soft\)/su);
  assert.match(css, /\.overlay\[data-tone="bad"\]\s*\{[^}]*var\(--danger-soft\)/su);
  assert.match(css, /\.bigName\s*\{[^}]*font-size:\s*2\.5rem/su, "the name reads large");
  assert.match(work, /const autoMs = autoNext \? \(plainSuccess \? 1500 : infoAuto \? 3000 : 0\) : 0/u);
  assert.match(work, /variant="ghost" disabled=\{writeLocked\} aria-expanded=\{nametagOpen\}/u, "the nametag is a quiet action, not a second button");
});

test("stage 2: the staff viewfinder is scoped and never touches the attendee camera", () => {
  assert.match(css, /\.eventWorkPage :global\(\.camera-panel\):has\(video\)::before/u, "corner marks only over a live video");
  assert.match(css, /\.eventWorkPage :global\(\.camera-panel\) > button\[data-variant="secondary"\]/u, "buttons stay readable on the dark panel");
  assert.doesNotMatch(css, /(^|\n)\.camera-panel\b/u, "no unscoped camera rule in the staff module");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(/u, "tokens only");
});
