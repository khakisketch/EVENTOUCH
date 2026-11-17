"use strict";

// 새 행사 만들기, approved 2026-11-16 (design-review create-event-a3.html).
// Source-only; rendering rides the real browser check. Change it only on a new
// owner decision. The write path (receipts, retry, duplicate, client
// registration) is pinned by web-create-event-dialog-chrome and
// console-event-card-a2; this file pins the presentation and the shortcuts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "console");
const dialog = fs.readFileSync(path.join(DIR, "CreateEventDialog.tsx"), "utf8");
const css = fs.readFileSync(path.join(DIR, "console-home.module.css"), "utf8");

test("name, date, time and customer are all up front; the rest folds into extra settings", () => {
  const form = dialog.slice(dialog.indexOf('<ValidatedForm id={eventFormId}'));
  const order = ['id="create-name"', 'id="create-date"', 'name="create-quick-time"', 'id="create-client"', "data-create-settings"]
    .map((token) => form.indexOf(token));
  assert.ok(order.every((index) => index > -1), "every up-front control exists");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "name, date, time, customer, then the fold");
  const fold = form.slice(form.indexOf("data-create-settings"));
  for (const id of ["create-start", "create-end", "create-capacity", "create-slug"]) {
    assert.ok(fold.includes(`id="${id}"`), `${id} lives in the fold`);
  }
  assert.ok(!fold.includes('id="create-client"'), "the customer is not hidden in the fold");
});

test("the name is a title input with an address line; the removed progress format is gone", () => {
  assert.match(dialog, /className=\{styles\.createTitle\}/u);
  assert.match(dialog, /placeholder="행사 이름"/u);
  assert.match(dialog, /참가자 주소 <strong>\/event\/\{addressSlug\}<\/strong>/u);
  // The address line shows while typing (not on blur) so it never shifts the
  // form under a click on the fold's summary; the shown code is the sent one.
  assert.match(dialog, /const addressSlug = slug \|\| \(name\.trim\(\) \? suggestedSlug\(name, fallbackSlugRef\.current\) : ""\)/u);
  assert.match(dialog, /slug \|\| generatedSlugRef\.current \|\| suggestedSlug\(name, fallbackSlugRef\.current\)/u);
  assert.match(dialog, /같은 이름의 행사가 있어요/u);
  assert.doesNotMatch(dialog, /create-format|EVENT_FORMAT_CHOICES|진행 형태|setFormat/u, "the dead setting is not offered or sent");
});

test("chips only shortcut values the form already holds", () => {
  assert.match(dialog, /DATE_PRESETS = \[[\s\S]*?내일[\s\S]*?1주 뒤[\s\S]*?1개월 뒤/u);
  assert.match(dialog, /TIME_PRESETS = \[[\s\S]*?종일 9–18[\s\S]*?오전 9–12[\s\S]*?오후 13–18[\s\S]*?저녁 18–21/u);
  assert.match(dialog, /CAPACITY_PRESETS = \["50", "100", "300", "500"\]/u);
  assert.match(dialog, /onPick=\{\(value\) => \{\s*const preset = DATE_PRESETS[\s\S]*?setDate\(/u);
  assert.match(dialog, /setStart\(preset\.start\);\s*setEnd\(preset\.end\);/u);
  assert.match(dialog, /onPick=\{setCapacity\}/u);
  // The payload still carries the same fields; no chip field is submitted on its own.
  assert.match(dialog, /const payload = \{\s*name,\s*slug: effectiveSlug,[\s\S]*?date,\s*start,\s*end,\s*capacity: capacity \? Number\(capacity\) : 0,\s*\};/u);
  assert.match(dialog, /<input type="radio" name=\{name\}/u, "native radios own selection and keyboard");
});

test("guidance appears while typing and never blocks the write", () => {
  assert.match(dialog, /const timeOrderWrong = Boolean\(start && end && start >= end\)/u);
  assert.match(dialog, /종료 시간은 시작 시간보다 늦어야 합니다\./u, "same wording as the server rule");
  assert.match(dialog, /날짜가 원본과 같고 이미 지났어요\. 새 행사 날짜로 바꾸세요\./u);
  assert.match(dialog, /이미 지난 날짜예요\./u);
  assert.match(dialog, /durationLabel\(start, end\)/u);
  assert.match(dialog, /아직 등록된 고객사가 없어요/u, "an empty customer list offers registration instead of an empty select");
  assert.doesNotMatch(dialog, /disabled=\{[^}]*timeOrderWrong/u, "the wrong-order notice does not disable submit; the server decides");
});

test("the mode choice is a segmented bar over native radios and the dialog keeps one orange action", () => {
  assert.match(css, /\.modeGroup\s*\{[^}]*grid-template-columns:\s*1fr 1fr/su);
  assert.match(css, /\.modeGroup input\[type="radio"\]\s*\{[^}]*opacity:\s*0/su, "radios stay real inputs, stretched over the tile");
  assert.match(css, /\.quickPick label:has\(:checked\)\s*\{[^}]*background:\s*var\(--ink\)/su, "selected chips are ink, not orange");
  assert.doesNotMatch(css.slice(css.indexOf(".quickPick {"), css.indexOf(".createFlag {")), /var\(--brand\)/u);
  assert.match(css, /\.createForm \.createTitle\s*\{[^}]*border-bottom:\s*2px solid/su, "the title input has no box");
});
