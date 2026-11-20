"use strict";

// 현장 전환 "다른 행사" (approved in design-review/event-switcher-options.html,
// proposal A) and the new-event summary column (design-review/create-event-improve.html,
// proposal C1). Source-only; the real switch and summary are exercised in the
// browser (see scripts/web-event-switcher-audit notes in the commit). Reopened 2026-11-20.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "console");
const read = (...parts) => fs.readFileSync(path.join(DIR, ...parts), "utf8");
const page = read("console-ui", "ConsolePage.tsx");
const switcher = read("console-ui", "EventSwitcher.tsx");
const switcherCss = read("console-ui", "event-switcher.module.css");
const dialog = read("CreateEventDialog.tsx");
const homeCss = read("console-home.module.css");

test("the event name row gets the switcher only on event-scoped pages", () => {
  assert.match(page, /import EventSwitcher from "\.\/EventSwitcher";/);
  const branch = page.slice(page.indexOf("const context = overviewHref"), page.indexOf("const classNames"));
  assert.match(branch, /<EventSwitcher eventId=\{eventId!\} pageId=\{pageId\} \/>/);
  assert.match(page, /page\.scope === "event" && eventId\?\.trim\(\)/);
});

test("the switcher loads the directory only when opened, never from an effect keyed to load state", () => {
  assert.match(switcher, /consoleFetch\("\/api\/console\/directory"/);
  assert.match(switcher, /const toggle = \(\) => \{[\s\S]*void loadEvents\(\);/);
  const effects = switcher.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g) || [];
  assert.equal(effects.some((effect) => effect.includes("consoleFetch")), false, "no fetch inside an effect");
});

test("the switcher keeps the current menu page, marks the current event, and closes with Escape", () => {
  assert.match(switcher, /consolePageHref\(pageId, event\.id\)/);
  assert.match(switcher, /aria-current=\{current \? "true" : undefined\}/);
  assert.match(switcher, /event\.key === "Escape"/);
  assert.match(switcher, /trigger\.current\?\.focus\(\)/);
  assert.match(switcher, /aria-label="행사 바꾸기"/);
});

test("on phones the switcher panel is a bottom sheet, not anchored to the trigger", () => {
  const mobile = switcherCss.slice(switcherCss.indexOf("@media (max-width: 640px)"));
  assert.match(mobile, /position: fixed;/);
  assert.match(mobile, /inset: auto var\(--s2\) var\(--s2\) var\(--s2\)/);
});

test("new event dialog shows a summary column only on wide screens and keeps the form first", () => {
  assert.match(dialog, /wide=\{!isClientCreate\}/);
  assert.match(dialog, /<aside className=\{styles\.createSummary\} aria-label="만들어질 행사">/);
  const form = dialog.slice(dialog.indexOf('<ValidatedForm id={eventFormId}'));
  assert.ok(form.indexOf("styles.createMain") < form.indexOf("styles.createSummary"), "fields come before the summary");
  assert.match(dialog, /저장하면 기획 상태의 행사가 생깁니다\./);
});

test("summary CSS is hidden by default and only shown from 900px", () => {
  const base = homeCss.slice(homeCss.indexOf(".createSummary {"));
  assert.match(base.slice(0, 60), /display: none;/);
  const wide = homeCss.slice(homeCss.indexOf("@media (min-width: 900px)"));
  assert.match(wide, /\.createForm:has\(> \.createSummary\)/);
  assert.match(wide, /grid-template-columns: minmax\(0, 1fr\) 260px;/);
});
