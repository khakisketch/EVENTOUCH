// Event-card A2 contract: soft-tinted header, published-only theme,
// duplication inside the create dialog. Helper behavior executes for real
// (Node 24 type-strips the TS module); component wiring is pinned by
// source so refactors keep the contract without rendering mocks.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const WEB = path.join(__dirname, "..", "apps", "web");
const theme = require(path.join(WEB, "app", "console", "event-card-theme.ts"));

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), "utf8");
}

// --- 1. Published-only read: no draft leak, no new fetch -------------------

test("only a published style with a publish marker yields a color", () => {
  const published = (bg) => ({
    pageExperience: {
      publishedAt: "2026-10-20T09:00:00.000Z",
      published: { homeStyle: { backgroundColor: bg } },
    },
  });
  assert.equal(theme.readPublishedCardColor(published("#b9def0")), "#B9DEF0");
  // Draft-only, never-published, and missing markers all fall back.
  assert.equal(theme.readPublishedCardColor({ pageExperience: { draft: { homeStyle: { backgroundColor: "#123456" } } } }), null);
  assert.equal(theme.readPublishedCardColor({ pageExperience: { published: { homeStyle: { backgroundColor: "#123456" } } } }), null);
  assert.equal(theme.readPublishedCardColor({ pageExperience: { publishedAt: "", published: { homeStyle: { backgroundColor: "#123456" } } } }), null);
  assert.equal(theme.readPublishedCardColor({ pageExperience: { publishedAt: "2026-10-20T09:00:00.000Z", published: { homeStyle: { backgroundColor: "#123456" } } } }), "#123456");
  // STAFF projections carry no pageExperience at all.
  assert.equal(theme.readPublishedCardColor({ participants: [] }), null);
  assert.equal(theme.readPublishedCardColor(null), null);
});

test("invalid or malicious colors never become theme output", () => {
  const published = (bg) => ({
    pageExperience: { publishedAt: "2026-10-20T09:00:00.000Z", published: { homeStyle: { backgroundColor: bg } } },
  });
  for (const bad of ["red", "#fff", "#12345G", "javascript:alert(1)", "", null, 123, "#B9DEF0;behavior:url(x)"]) {
    assert.equal(theme.readPublishedCardColor(published(bad)), null, JSON.stringify(bad));
    assert.equal(theme.cardHeaderTheme(bad), null, JSON.stringify(bad));
  }
  assert.equal(theme.cardHeaderTheme(null), null);
});

// --- 2. Pale tint + 4.5:1-safe date ink -------------------------------------

test("published colors resolve to a pale tint with readable date text", () => {
  const vectors = ["#B9DEF0", "#17252B", "#FFFFFF", "#E76D26", "#000000", "#1A7A4C", "#FFD23F"];
  for (const bg of vectors) {
    const resolved = theme.cardHeaderTheme(bg);
    assert.ok(resolved, bg);
    assert.match(resolved.background, /^#[0-9A-F]{6}$/, `${bg} tint is plain hex`);
    // Themed headers always use neutral ink: operator colors never combine
    // with unrelated brand-orange text. Only the default soft fallback keeps
    // the brand-text date line.
    assert.equal(resolved.color, "#17252B", `${bg} uses neutral ink`);
    const ratio = theme.contrastRatio(resolved.color, resolved.background);
    assert.ok(ratio >= 4.5, `${bg} tint ${resolved.background} reaches ${ratio.toFixed(2)}:1`);
  }
});

test("tint mixes 15% of the published color over white", () => {
  assert.equal(theme.tintAgainstWhite("#000000"), "#D9D9D9");
  assert.equal(theme.tintAgainstWhite("#FFFFFF"), "#FFFFFF");
  assert.equal(theme.tintAgainstWhite("#B9DEF0"), "#F5FAFD");
});

test("themed headers use neutral ink; only the default soft keeps brand text", () => {
  assert.equal(theme.cardHeaderTheme("#B9DEF0").color, "#17252B");
  assert.equal(theme.cardHeaderTheme("#E76D26").color, "#17252B");
  assert.equal(theme.cardHeaderTheme("#000000").color, "#17252B");
});

test("default soft surface keeps brand-text date text readable", () => {
  const ratio = theme.contrastRatio("#A34410", "#FFF1E8");
  assert.ok(ratio >= 4.5, `fallback pairing reaches ${ratio.toFixed(2)}:1`);
});

// --- 3. Card wiring: one entry link, published theme, no per-card fetch ------

test("EventCard is one entry link with a published-only tinted zone", () => {
  const home = read("app/console/ConsoleHome.tsx");
  const card = home.slice(home.indexOf("function EventCard("), home.indexOf("export default function ConsoleHome"));
  // The entry link carries no aria-label: its accessible name comes from the
  // card contents (plus a visually hidden 열기), so visible text always stays
  // inside the name (axe label-content-name-mismatch).
  assert.doesNotMatch(card, /aria-label=\{`[^`]*열기[^`]*`\}/u);
  assert.match(card, /<span className="sr-only"> 열기<\/span>/u);
  assert.match(card, /cardHeaderTheme\(event\.themeColor\)/u);
  assert.doesNotMatch(card, /fetch\s*\(/u, "no per-card fetch; the directory bootstrap read owns the theme");
  assert.doesNotMatch(card, /draft/iu, "drafts never reach cards");
  assert.doesNotMatch(card, /onDuplicate|복제/u);
  assert.match(card, /일정 미정/u);
  assert.match(card, /시간 \$\{time\}/u, "time-only events keep their explicit label");
});

test("directory maps the published theme from the same bootstrap read", () => {
  const home = read("app/console/ConsoleHome.tsx");
  assert.match(home, /readPublishedCardColor\(workspaces\[event\.id\]\)/u);
  assert.match(home, /themeColor,/u);
  assert.match(home, /duplicateSources=\{state\.events\.map/u, "create dialog receives permission-available sources");
  assert.doesNotMatch(home, /setDuplicateSource|duplicateSource \?/u, "no per-card duplicate dialog remains");
});

// --- 4. Dialog: duplication inside, fastest new-event path by default -------

test("create dialog offers new-first with a stage-labeled source select", () => {
  const dialog = read("app/console/CreateEventDialog.tsx");
  assert.match(dialog, /만들기 방식/u);
  assert.match(dialog, /새로 만들기/u);
  assert.match(dialog, /기존 행사 복제/u);
  assert.match(dialog, /id="create-source"/u);
  assert.match(dialog, /eventStageLabel\(candidate\.stage\)/u, "source list stays stage-labeled");
  assert.match(dialog, /className=\{styles\.modeGroup\}/u, "mode radios keep the compact 20px voice");
  assert.match(dialog, /복제할 원본 행사를 선택하세요/u, "copy without a source never leaves the dialog");
  assert.match(dialog, /effectiveDuplicate \? \{\} : \{ clientId/u, "chosen source reuses the duplicate payload shape");
  assert.match(dialog, /\/duplicate`/u, "chosen source posts to the existing duplicate endpoint");
  assert.match(dialog, /입력한 행사 정보가 있습니다\. 만들기 방식을 바꾸면/u, "mode switches ask before touching a typed draft");
  assert.match(dialog, /원본 ".*의 정보로 입력 내용이 바뀝니다/u, "source switches ask before replacing fields");
  assert.match(dialog, /duplicateSources\?: DuplicateCandidate\[\]/u);
  // In-flight and unresolved writes lock the transitions synchronously:
  // replacing the payload must never orphan the pending receipt.
  assert.match(dialog, /function transitionBlocked\(\)/u);
  assert.match(dialog, /submitGateRef\.current \|\| submitting \|\| clientWriteRef\.current \|\| clientSaving/u);
  assert.match(dialog, /if \(commandIdRef\.current\) return "receipt-event"/u);
  assert.match(dialog, /if \(pendingClientRef\.current\) return "receipt-client"/u);
  assert.match(dialog, /function guardTransition\(\): boolean/u);
  assert.match(dialog, /if \(!guardTransition\(\)\) return;/u);
  assert.match(dialog, /같은 요청으로 다시 시도해 결과를 확인한 뒤에 바꾸세요/u, "locked transitions point at the same-request retry");
  assert.match(dialog, /<fieldset className=\{styles\.modeGroup\} disabled=\{submitting \|\| clientSaving\}>/u);
  assert.match(dialog, /id="create-source"[\s\S]*?disabled=\{submitting \|\| clientSaving\}/u);
  assert.match(dialog, /\{modeNotice \? <p role="alert">\{modeNotice\}<\/p> : null\}/u);
});
