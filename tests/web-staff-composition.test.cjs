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
