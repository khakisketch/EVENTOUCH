// Draws/programs usability follow-ups (operator screen review, severity mid):
// (1) the stage-draw run buttons must stay clearly disabled yet readable,
// with the unmet premise and the next action attached right next to the
// buttons (the existing "실행 전제:" line is kept, moved to the buttons,
// never duplicated); (2) the program list gets a client-side name search
// and status filter with a "전체 N개 중 M개" count and a zero-result reset.
// Source-contract only: server commands, permissions, idempotency untouched.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.resolve(__dirname, "..", "apps", "web", "app");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");

const draws = read("console/events/[id]/draws/DrawsWorkspace.tsx");
const drawsCss = read("console/events/[id]/draws/draws.module.css");
const programs = read("console/events/[id]/programs/ProgramsWorkspace.tsx");
const programsCss = read("console/events/[id]/programs/programs.module.css");

function commandsOf(source) {
  const found = new Set();
  for (const match of source.matchAll(/postCommand\(\s*"([^"]+)"/gu)) found.add(match[1]);
  return [...found].sort();
}

test("draw run buttons keep the premise line next to the buttons with a next action", () => {
  // The existing premise line survives (no text removed, no second copy).
  const premiseCount = (draws.match(/실행 전제: \{/gu) || []).length;
  assert.equal(premiseCount, 1, "the 실행 전제 line stays exactly once");
  // Buttons and the blocker live in one group so the blocker reads as
  // attached to the action, and the line names what resolves it.
  assert.match(draws, /styles\.runActions/u);
  assert.match(draws, /role="group" aria-label=\{`\$\{program\.name\} 추첨 실행`\}/u);
  assert.match(draws, /실행 전제: \{runBlockers\.join\(" · "\)\} · \{runNextAction\} 실행할 수 있습니다/u);
  assert.match(draws, /결과를 공개하면/u);
  // Screen-reader wiring survives: both run buttons describe the blocker.
  assert.match(draws, /aria-describedby=\{runBlockers\.length \? runBlockerId : undefined\}/u);
  assert.match(draws, /aria-describedby=\{\[\.\.\.stagePrerequisites, runBlockerId\]/u);
  // Still actually disabled until every premise holds.
  assert.match(draws, /disabled=\{!canRun \|\| busy !== null \|\| writeLocked\}/u);
});

test("disabled run buttons stay readable while clearly disabled, tokens only", () => {
  assert.match(drawsCss, /\.programActions \.button-primary:disabled/u);
  assert.match(drawsCss, /background: var\(--surface-muted\)/u);
  assert.match(drawsCss, /border-color: var\(--line-strong\)/u);
  assert.match(drawsCss, /color: var\(--ink\)/u);
  assert.match(drawsCss, /opacity: 1/u);
  assert.match(drawsCss, /cursor: not-allowed/u);
  assert.match(drawsCss, /\.runBlocker/u);
  for (const [name, css] of [["draws.module.css", drawsCss], ["programs.module.css", programsCss]]) {
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}/u, `${name} must use tokens.css tokens only`);
  }
});

test("program list filters client-side with a count and a zero-result reset", () => {
  // Search + status filter, same grammar as the rewards/clients lists.
  assert.match(programs, /프로그램 이름·유형 검색/u);
  assert.match(programs, /type="search"/u);
  assert.match(programs, /<option value="DRAFT">준비 중<\/option>/u);
  assert.match(programs, /<option value="OPEN">진행 중<\/option>/u);
  assert.match(programs, /<option value="CLOSED">종료<\/option>/u);
  // "전체 N개 중 M개" count with a status role.
  assert.match(programs, /전체 \{state\.modules\.length\}개 중 \{visibleModules\.length\}개/u);
  assert.match(programs, /className=\{styles\.resultCount\} role="status"/u);
  // Client-side only: filters the already-loaded modules, no new request.
  assert.match(programs, /visibleModules = state\.modules\.filter/u);
  assert.match(programs, /toLocaleLowerCase\("ko-KR"\)\.includes\(programQueryText\)/u);
  const fetches = [...programs.matchAll(/fetch\(\s*[`"']([^`"']+)/gu)].map((match) => match[1]);
  assert.deepEqual(fetches, ["/api/auth/me", "/api/bootstrap", "/api/events/${encodeURIComponent(eventId)}/commands"]);
  // Zero results guide back with a reset, without touching the real empty state.
  assert.match(programs, /조건에 맞는 프로그램이 없습니다/u);
  assert.match(programs, /검색어·상태 조건을 바꾸거나 지우고 다시 찾아보세요/u);
  assert.ok((programs.match(/검색·필터 지우기/gu) || []).length >= 2, "count line and zero-result both reset");
  assert.match(programs, /등록된 프로그램이 없습니다\. 위에서 첫 프로그램을 만드세요\./u);
});

test("draw and program command/API surface is unchanged", () => {
  assert.deepEqual(commandsOf(draws), [
    "draw.program.run",
    "draw.program.save",
    "lucky.config.save",
    "lucky.preassign",
    "reward.assign",
    "roulette.config.save",
    "team.save",
    "vote.config.save",
    "vote.tally",
  ]);
  assert.deepEqual(commandsOf(programs), [
    "draw.publish",
    "draw.run",
    "module.reveal",
    "module.save",
    "module.status",
    "photo.moderate",
    "post.moderate",
    "question.manage",
  ]);
  // Risky/side-effectful behavior reads exactly as before.
  assert.match(draws, /toStage \? "추첨하고 전광판에 표시" : "추첨 실행"/u);
  assert.match(draws, /showOnScreen: true/u);
  assert.match(programs, /퀴즈 정답을 공개할까요/u);
  assert.match(programs, /추첨을 \$\{props\.drawPending\.count\}명으로 실행할까요/u);
});

test("an explicit jump pins the current link past the scroll spy until a real scroll", () => {
  // Same bottom-of-page cause as the operations hall: the spy watches tiny
  // h2s in a narrow band a trailing section never reaches, so the jump
  // names its section at once and holds it until genuine scrolling resumes.
  assert.match(draws, /onNavigate=\{followJumpedSection\}/u, "jumps report to the pin");
  assert.match(draws, /navPinRef\.current = id;/u, "the jumped-to section is named at once");
  assert.match(draws, /if \(navPinRef\.current\) return;/u, "a stale heading cannot steal the marker");
  assert.match(draws, /const DRAW_SECTION_IDS = Object\.keys\(DRAW_SECTION_LABELS\)/u, "spy and deep links share one list");
  assert.match(draws, /followJumpedSection\(id\)/u, "a deep link pins its section too");
  assert.match(draws, /window\.addEventListener\("hashchange", applyHash\)/u, "later fragments keep working");
});
