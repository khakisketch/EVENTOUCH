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
  const ordinaryPremise = (draws.match(/실행 전제: \{runBlockers/gu) || []).length;
  assert.equal(ordinaryPremise, 1, "ordinary draw prerequisites stay together once");
  // Buttons and the blocker live in one group so the blocker reads as
  // attached to the action, and the line names what resolves it.
  assert.match(draws, /styles\.runRow/u);
  assert.match(draws, /role="group" aria-label=\{`\$\{program\.name\} 추첨 실행`\}/u);
  assert.match(draws, /실행 전제: \{runBlockers\.join\(" · "\)\} · \{runNextAction\} 실행할 수 있습니다/u);
  assert.match(draws, /결과를 공개하면/u);
  // Screen-reader wiring survives: both run buttons describe the blocker.
  assert.match(draws, /aria-describedby=\{runBlockers\.length \? runBlockerId : undefined\}/u);
  assert.match(draws, /stageOnlyBlockers\.length \? stageBlockerId : null/u);
  assert.match(draws, /무대 터치 실행 전제: \{stageOnlyBlockers/u);
  // Still actually disabled until every premise holds.
  assert.match(draws, /disabled=\{!canRun \|\| busy !== null \|\| writeLocked\}/u);
});

test("disabled run buttons stay readable while clearly disabled, tokens only", () => {
  assert.match(drawsCss, /\.programActions \.product-action\[data-variant="primary"\]:disabled/u);
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
  // Reopened 2026-11-20 (참여 이벤트): modules and draw items share one list, so search, tabs and counts cover both.
  assert.match(programs, /이벤트 이름·유형 검색/u);
  assert.match(programs, /type="search"/u);
  // Status views are ink-underline tabs with counts (no dropdown); the search and
  // tabs appear once the list is long or a filter is active.
  assert.match(programs, /value: "OPEN", label: "진행 중"[^}]*\}[\s\S]*value: "DRAFT", label: "준비 중"[\s\S]*value: "CLOSED", label: "종료"/u);
  assert.match(programs, /<StatusTabs\s+label="진행 상태별 보기"/u);
  assert.match(read("console/events/[id]/programs/StatusTabs.tsx"), /className=\{styles\.statusTabs\} role="group" aria-label=\{label\}/u);
  assert.match(programs, /totalEvents > 8 \|\| hasProgramFilter/u);
  // "전체 N개 중 M개" count with a status role.
  assert.match(programs, /검색·필터 결과 \{visibleModules\.length \+ visibleDrawEvents\.length\}개 · 전체 \{totalEvents\}개/u);
  assert.match(programs, /className=\{styles\.resultCount\} role="status"/u);
  // Client-side only: filters the already-loaded modules, no new request.
  assert.match(programs, /visibleModules = state\.modules\.filter/u);
  assert.match(programs, /toLocaleLowerCase\("ko-KR"\)\.includes\(programQueryText\)/u);
  // All reads go through the shared transport; the event read is the scoped
  // event bootstrap, never the full directory.
  const fetches = [...programs.matchAll(/(?:consoleFetch|fetch)\(\s*[`"']([^`"']+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(fetches)], ["/api/auth/me", "/api/events/${encodeURIComponent(eventId)}/bootstrap", "/api/events/${encodeURIComponent(eventId)}/commands", "/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}", "/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(commandId)}"]);
  assert.match(programs, /command-receipts[\s\S]*?cache: "no-store"/, "status-only confirmation is an explicit fresh read");
  assert.equal(fetches.filter((url) => url.includes("/command-receipts/")).length, 4, "question, edit, module and program operation checks are explicit scoped reads");
  const operationCheck = programs.slice(programs.indexOf("async function recoverProgramOperation"), programs.indexOf("async function submitGrade"));
  assert.match(operationCheck, /command-receipts\/\$\{encodeURIComponent\(attempt\.commandId\)\}[\s\S]*?cache: "no-store"/u);
  // Zero results guide back with a reset, without touching the real empty state.
  assert.match(programs, /조건에 맞는 이벤트가 없습니다/u);
  assert.match(programs, /검색어·상태 조건을 바꾸거나 지우고 다시 찾아보세요/u);
  assert.ok((programs.match(/검색·필터 지우기/gu) || []).length >= 2, "count line and zero-result both reset");
  assert.match(programs, /첫 이벤트를 만들어 보세요/u);
});

test("draw surface stays stable and programs add response grading and question-edit decisions", () => {
  assert.deepEqual(commandsOf(draws), [
    "draw.program.run",
    "draw.program.save",
    "lucky.config.save-reviewed",
    "lucky.preassign-range-reviewed",
    "reward.assign",
    "roulette.config.save-reviewed",
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
    "question.edit.approve",
    "question.edit.reject",
    "question.manage",
    "response.grade",
  ]);
  // Risky/side-effectful behavior reads exactly as before.
  assert.match(draws, /toStage \? "추첨하고 전광판에 표시" : "추첨 실행"/u);
  assert.match(draws, /showOnScreen: true/u);
  assert.match(programs, /퀴즈 정답을 공개할까요/u);
  assert.match(programs, /추첨을 \$\{props\.drawPending\.count\}명으로 실행할까요/u);
});

test("the draw screen picks its item by selection, and deep links select too", () => {
  // The four jobs are items of one stage picker, not a scroll-spied nav, so
  // there is no pin to hold: a fragment simply selects its item.
  assert.match(draws, /const \[selectedKey, setSelectedKey\] = useState<string \| null>\(null\)/u, "one selection drives the stage card");
  assert.match(draws, /window\.addEventListener\("hashchange", applyHash\)/u, "later fragments keep working");
  assert.match(draws, /draw-program-/u, "program fragments select that program");
  assert.doesNotMatch(draws, /navPinRef|IntersectionObserver/u, "no scroll spy remains");
});
