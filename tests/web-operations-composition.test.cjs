"use strict";

// Field operations (현장 운영) composition, approved 2026-11-14 (design-review
// operations-options.html, scene A3). Reopened 2026-11-19 by the owner: rows carry
// a kind tile and the gap list is amber. Reopened 2026-11-20 (owner approved
// proposal C, design-review/onsite-ux-proposal.html): the screen is renamed
// 입장·스태프 and reads as three steps (desks, staff on duty, scanning on the staff
// phone) with booths optional; the 전광판 출력 block and the two-card KPI strip are
// gone (the display moved to 현장 모드, big-number strips stay off work screens).
// Source-only: rendering rides the real browser check.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "console", "events", "[id]", "operations");
const read = (name) => fs.readFileSync(path.join(DIR, name), "utf8");

test("approved operations design stays locked", () => {
  const ops = read("OperationsWorkspace.tsx");
  const parts = read("LocationParts.tsx");
  const css = read("operations.module.css");

  // One page, no sidebar nav; anchors survive for deep links and handoffs.
  assert.doesNotMatch(ops, /ConsoleSectionNav|sectionLayout="sidebar"/u);
  for (const id of ["ops-desks", "ops-staff", "ops-scan", "ops-booths", "ops-booth-mode", "ops-booth-map"]) {
    assert.match(ops, new RegExp(`headingId="${id}"`), `${id} keeps its anchor`);
  }
  // Reopened 2026-11-20: the three steps, each with a status pill in the description slot.
  for (const [n, title] of [[1, "입장 데스크 만들기"], [2, "스태프 배정"], [3, "스태프 폰에서 스캔"]]) {
    assert.match(ops, new RegExp(`title="${title}"[\\s\\S]*?<StepPill n=\\{${n}\\}`, "u"), `step ${n} is ${title}`);
  }
  assert.match(ops, /<DeviceFrame variant="phone"/u, "step 3 previews the staff scan screen on a phone");
  assert.match(ops, /\/staff`/u, "step 3 names the staff login address");
  assert.doesNotMatch(ops, /ops-display|ops-participation|전광판 출력|ScreenIcon/u, "display and participation work left for 현장 모드");
  assert.match(ops, /\{stampEnabled \? \(\s*<ConsoleSection\s+headingId="ops-booths"/u, "booths are an optional section, only with the feature on");
  assert.doesNotMatch(ops, /styles\.kpiStrip|styles\.kpiCard/u, "no big-number strip on a work screen");
  assert.equal(ops.match(/surface="panel"/g)?.length ?? 0, 0, "no panel around a list");
  // Reopened 2026-11-20 (디자인 시스템 적용): steps are white hairline cards; the step state is a StatusPill (amber = waiting on a person).
  assert.match(css, /\.stepSection\s*\{[^}]*border:\s*1px solid var\(--line\)[^}]*border-radius:\s*var\(--r-card\)/su, "each step is a white hairline card");
  assert.match(css, /\.stepAmber\s*\{[^}]*border-color:\s*var\(--warning-line\)/su, "a step with a gap turns its border amber");
  assert.match(ops, /tone === "warn" \|\| tone === "todo" \? "wait"/u, "a waiting step is an amber pill");
  assert.match(ops, /<StatusPill tone=\{pillTone\}/u);
  assert.match(ops, /ConsoleEmptyState/u, "empty desk and booth lists use the shared empty state");
  assert.doesNotMatch(ops, /className="empty-state"/u, "no global empty-state class");
  assert.equal(ops.match(/heading="rule"/g)?.length ?? 0, 4, "the three steps and the booth card share the hairline heading");

  // A row is a name, one quiet line, faces and one control; it opens its detail.
  assert.match(parts, /export function LocationRow/u);
  assert.match(parts, /styles\.locationOpen/u);
  assert.match(ops, /<LocationRow/u);
  assert.match(ops, /onOpen=\{\(\) => setDetail\(/u);
  assert.match(parts, /<Switch/u, "desks run through a switch");
  // Reopened 2026-11-20 (디자인 시스템 적용): faces are the shared ConsoleAvatar (decorative, aria-hidden, no focus).
  assert.match(parts, /<ConsoleAvatar/u, "who is on duty reads as faces");
  assert.match(parts, /styles\.locationTile/u, "a row opens on a tile for the kind of place");
  // axe: faces inside the row button must not be focusable (an avatar tooltip adds tabindex),
  // and the button's name comes from its visible text instead of an aria-label that omits it.
  assert.doesNotMatch(parts, /<ConsoleAvatar[^>]*label=/u, "decorative faces take no focus");
  assert.doesNotMatch(parts, /<button[^>]*styles\.locationOpen[^>]*aria-label/u, "row name is its visible text");
  assert.match(ops, /<StatusDot tone=/u, "booths follow their schedule and show a state, never a switch");

  // Row actions are not a wall of buttons: nothing secondary lives in a row.
  const rows = [...ops.matchAll(/<ul className=\{styles\.locations\}>[\s\S]*?<\/ul>/gu)].map((match) => match[0]).join("\n");
  assert.equal([...ops.matchAll(/<ul className=\{styles\.locations\}>/gu)].length, 2, "desks and booths are the two location lists");
  assert.doesNotMatch(rows, /button-secondary|variant="secondary"/u, "desk and booth rows carry no secondary buttons");

  // Stopping a desk is confirmed; starting is not.
  assert.match(ops, /deskStopPending/u);
  assert.match(ops, /confirmLabel="가동 중지"/u);

  // Assignment: one page-level entry that is primary only while a place has no one on duty.
  assert.match(ops, /variant=\{gapTargets\.length && !archived \? "primary" : "ghost"\}/u);
  assert.match(css, /\.gapSurface\s*\{[^}]*background:\s*var\(--warning-soft\)/su, "the gap list is amber work waiting on a person, not a card");

  // Release lives in the detail dialog, with the same command.
  assert.match(ops, /function LocationDialog/u);
  assert.match(ops, /runCommand\("staff\.unassign"/u);

  // Dim rows stay readable: muted text, never reduced opacity.
  assert.match(css, /\.locationDim \.locationText strong\s*\{[^}]*color:\s*var\(--muted\)/su);
  assert.doesNotMatch(css, /\.location[A-Za-z]*\s*\{[^}]*opacity/su);
});
