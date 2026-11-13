"use strict";

// Field operations (현장 운영) composition, approved 2026-11-14 (design-review
// operations-options.html, scene A3). Source-only: rendering rides the real
// browser check. Change it only on a new owner decision.
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
  for (const id of ["ops-desks", "ops-booths", "ops-staff", "ops-display", "ops-participation", "ops-booth-mode", "ops-booth-map"]) {
    assert.match(ops, new RegExp(`headingId="${id}"`), `${id} keeps its anchor`);
  }

  // Desks are the only bordered card; everything else stays plain.
  assert.equal(ops.match(/surface="panel"/g)?.length ?? 0, 1, "one card on the page");
  assert.match(ops, /headingId="ops-desks"\s+title="데스크"\s+surface="panel"/u);

  // A row is a name, one quiet line, faces and one control; it opens its detail.
  assert.match(parts, /export function LocationRow/u);
  assert.match(parts, /styles\.locationOpen/u);
  assert.match(ops, /<LocationRow/u);
  assert.match(ops, /onOpen=\{\(\) => setDetail\(/u);
  assert.match(parts, /<Switch/u, "desks run through a switch");
  assert.match(parts, /<Avatar/u, "who is on duty reads as faces");
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
  assert.match(css, /\.gapSurface\s*\{[^}]*background:\s*var\(--surface-muted\)/su, "the gap list is a soft surface, not a card");

  // Release lives in the detail dialog, with the same command.
  assert.match(ops, /function LocationDialog/u);
  assert.match(ops, /runCommand\("staff\.unassign"/u);

  // Dim rows stay readable: muted text, never reduced opacity.
  assert.match(css, /\.locationDim \.locationText strong\s*\{[^}]*color:\s*var\(--muted\)/su);
  assert.doesNotMatch(css, /\.location[A-Za-z]*\s*\{[^}]*opacity/su);
});
