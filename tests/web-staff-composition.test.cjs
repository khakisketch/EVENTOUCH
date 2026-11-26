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
  // Reopened 2026-11-20 (design-system application): the title select reads at --text-lg (it was 22px before the
  // 2026-11-19 pill title already shrank it to 18px) and the desk/booth switch is the segmented pill, not tabs.
  assert.match(css, /\.staff-select-field\) select\s*\{[^}]*font-size:\s*var\(--text-lg\)/su);
  assert.match(css, /\.staff-select-field\) select\s*\{[^}]*appearance:\s*none/su);
  assert.match(css, /\.taskSwitch \[data-product-action\]\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--paper\)/su, "the current task is the lit segment");
  assert.doesNotMatch(css, /\.(?:moreBody|scanInput|scanPrimary|resultBlock)\s*\{[^}]*position:\s*(?:sticky|fixed)/su);
});

test("recent rows are plain: name, detail and time, no per-row button", () => {
  assert.doesNotMatch(work, /기록 확인 · 다음 참가자 입력 준비/u);
  assert.match(work, /className=\{prizeStyles\.recentName\}/u);
});

test("field result: a colored face over the camera, a plain success hands itself back", () => {
  assert.match(work, /data-tone=\{stageTone\}/u, "the overlay carries its tone");
  // Reopened 2026-11-26: an exit scan for someone already out is information too.
  assert.match(work, /const infoFailure = result\.kind === "failed" && !result\.uncertain && \(result\.alreadyIn === true \|\| result\.alreadyOut === true \|\| boothLimitReached\)/u, "an already-entered ticket is information, not an error");
  assert.match(work, /\(infoFailure \? "info" : result\.uncertain \|\| result\.attendanceReviewRequired[^)]*\? "warn" : "bad"\)/u, "needs-a-look is amber, a plain failure red");
  assert.match(css, /\.overlay\s*\{[^}]*var\(--success-soft\)/su);
  assert.match(css, /\.overlay\[data-tone="info"\]\s*\{[^}]*var\(--info-soft\)/su);
  assert.match(css, /\.overlay\[data-tone="warn"\]\s*\{[^}]*var\(--warning-soft\)/su);
  assert.match(css, /\.overlay\[data-tone="bad"\]\s*\{[^}]*var\(--danger-soft\)/su);
  assert.match(css, /--fld-name:\s*2\.5rem/u, "the name reads large: the one stage size above --text-num, named once");
  assert.match(css, /\.bigName\s*\{[^}]*font-size:\s*var\(--fld-name\)/su, "the name reads large");
  assert.match(work, /const autoMs = autoNext \? \(plainSuccess \? 1500 : infoAuto \? 3000 : 0\) : 0/u);
  assert.match(work, /variant="ghost" disabled=\{writeLocked\} aria-expanded=\{nametagOpen\}/u, "the nametag is a quiet action, not a second button");
});

// Reopened 2026-11-20 (design-system application): the old .camera-panel viewfinder rules styled markup that no
// component renders any more (the field camera lives in camera-scan.module.css), so they were removed.
test("the staff module is scoped, token-only and carries no dead camera-panel rules", () => {
  assert.doesNotMatch(css, /camera-panel/u, "no rule for markup nobody renders");
  assert.doesNotMatch(css, /(^|\n)\.camera-panel\b/u, "no unscoped camera rule in the staff module");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(/u, "tokens only");
  assert.doesNotMatch(css, /font-size:\s*[0-9.]+px/u, "type comes from --text-* or the named stage sizes");
  assert.doesNotMatch(css, /border-radius:\s*[0-9.]+px/u, "radii come from --r-* or the named sheet corner");
  assert.doesNotMatch(css, /font-weight:\s*(?:[0-9]{3})\b/u, "weights are the three tokens");
});

test("states on the field screen share one vocabulary: icon, words and tone", () => {
  const status = fs.readFileSync(path.join(DIR, "StaffStatus.tsx"), "utf8");
  assert.match(status, /export function StaffNote/u);
  assert.match(status, /export function StaffPill/u);
  assert.match(status, /import StatusPill/u, "the pill is the shared console StatusPill");
  assert.doesNotMatch(work, /className="notice"/u, "no bare global .notice paragraph on the field screen");
  assert.match(work, /<StaffNote tone="warn" role="alert">/u, "a needs-a-look message is warn + alert");
  assert.match(work, /<StaffPill tone=/u, "row states are pills with icons");
  assert.match(work, /prizeStyles\.hubState/u, "loading/missing states stay on ink");
});
