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

// Reopened 2026-11-21 (owner: 행사 바꾸기를 메뉴로): the switcher left the event name row;
// the current-event card of the rail and of the phone drawer is the control.
const shell = read("ConsoleShell.tsx");

test("the event name row has no switcher; the rail card and the drawer card are the control", () => {
  assert.doesNotMatch(page, /EventSwitcher/);
  assert.match(page, /page\.scope === "event" && eventId\?\.trim\(\)/);
  assert.match(shell, /import EventSwitcher from "\.\/console-ui\/EventSwitcher";/);
  assert.match(shell, /<EventSwitcher eventId=\{eventId\} pageId=\{currentPageId \?\? "overview"\} variant="rail">/);
  assert.match(shell, /<EventSwitcher eventId=\{eventId\} pageId=\{currentPageId \?\? "overview"\} variant="drawer">/);
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

test("the panel groups events by stage, searches only past six events, and opens inline in the drawer", () => {
  assert.match(switcher, /SEARCH_THRESHOLD = 6/);
  assert.match(switcher, /events\.length > SEARCH_THRESHOLD/);
  assert.match(switcher, /\["live", "진행 중"\], \["wait", "준비 중"\], \["end", "종료"\]/);
  assert.match(switcherCss, /\.panel\[data-variant="rail"\] \{[^}]*position: fixed;/);
  assert.match(switcherCss, /\.panel\[data-variant="drawer"\] \{[^}]*position: static;/);
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
