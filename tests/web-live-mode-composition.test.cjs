"use strict";

// 현장 모드 (the day-of control room), owner decision 2026-11-20, proposal C
// (design-review/onsite-ux-proposal.html). Source contracts only: rendering rides
// the real browser check (scripts/web-live-mode-audit.cjs). The screen is a view
// and control surface over EXISTING commands; it adds no server command.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const WEB = path.join(__dirname, "..", "apps", "web");
const DIR = path.join(WEB, "app", "console", "events", "[id]", "live");
const read = (name) => fs.readFileSync(path.join(DIR, name), "utf8");
const ts = require(require.resolve("typescript", { paths: [WEB] }));

function load(name) {
  const code = ts.transpileModule(read(name), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Intl, Date, Number, String, Array, Math, RegExp }, { filename: name });
  return exports;
}

test("the live room has three panes, a top bar and keeps its stack order", () => {
  const workspace = read("LiveWorkspace.tsx");
  const panes = read("LivePanes.tsx");
  const css = read("live.module.css");
  const page = read("page.tsx");

  assert.match(page, /<LiveWorkspace eventId=\{id\} \/>/u);
  assert.match(workspace, /pageId="live"/u, "ConsolePage keeps data-console-page=\"live\"");
  for (const pane of ["cues", "stage", "side"]) assert.match(panes, new RegExp(`data-live-pane="${pane}"`, "u"));
  // Top bar: event name, clock, entry progress, venue-display pill, way back.
  assert.match(workspace, /eventName/u);
  assert.match(workspace, /입장 <b>/u);
  assert.match(workspace, /행사장 화면 송출 중/u);
  assert.match(workspace, />관리 화면으로</u);
  // Source order is cues, stage, side (focus order = reading order); phones keep the
  // preview first by folding the cues pane, never by reordering the DOM.
  const order = ["<LiveCuesPane", "<LiveStagePane", "<LiveSidePane"].map((tag) => workspace.indexOf(tag));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], "cues, stage, side in DOM order");
  assert.match(css, /@container \(min-width: 880px\)\s*\{[^}]*grid-template-columns:\s*240px minmax\(0, 1fr\) 280px/su, "three panes from 880px of room width");
  assert.match(css, /@container \(min-width: 1080px\)\s*\{[^}]*grid-template-columns:\s*280px minmax\(0, 1fr\) 320px/su, "roomier columns on wide rooms");
  assert.match(panes, /<details className=\{styles\.cuesFold\} open=\{open\}/u, "the schedule folds on narrow rooms");
  assert.match(panes, /LIVE_THREE_PANES = 880/u, "the fold follows the room width used by the layout");
  // The left pane names today's order with done/current/next; the center shows the venue screen in a TV frame.
  assert.match(panes, /aria-current=\{cue\.status === "current" \? "step" : undefined\}/u);
  assert.match(panes, /<DeviceFrame variant="screen"/u);
  assert.match(panes, /\/screen\/\$\{encodeURIComponent\(model\.eventSlug\)\}/u);
  assert.match(panes, /data-live-tv/u);
  // Right pane: response count, next, reviews, rewards waiting.
  for (const heading of ["실시간 응답", "다음에 할 일", "검토 대기", "경품 지급 대기"]) assert.match(panes, new RegExp(heading, "u"));
});

test("every write is an existing command with its existing confirmation and recovery", () => {
  const hook = read("useLiveCommand.ts");
  const workspace = read("LiveWorkspace.tsx");
  const panes = read("LivePanes.tsx");

  assert.match(hook, /LIVE_COMMANDS = \["display\.set", "module\.status", "module\.reveal", "draw\.run", "draw\.publish", "draw\.program\.run", "reward\.fulfill"\]/u, "no new command names");
  assert.match(hook, /`\/api\/events\/\$\{encodeURIComponent\(attempt\.eventId\)\}\/commands`/u);
  assert.match(hook, /command-receipts\//u, "server check without resending");
  for (const confirm of ["confirmsOperationsCommand", "confirmsProgramOperation", "confirmsDrawRun"]) assert.match(hook, new RegExp(confirm, "u"));
  assert.match(hook, /issued\.current\.get\(fingerprint\)/u, "the same request keeps its command id");
  assert.match(hook, /manageOperatorReceipt/u);
  assert.match(hook, /await waitForOperatorReceiptIdle\(commandId\)/u, "a confirmed result releases its pointer only after the response observer is idle");
  assert.match(workspace, /서버 처리 확인/u);
  assert.match(workspace, /같은 요청 다시 시도/u);
  assert.match(workspace, /확인 전 그만두기/u);
  // The operator confirms the irreversible ones in place, as the source screens do.
  assert.match(panes, /<ConsoleConfirm/u);
  for (const copy of ["을\\(를\\) 열까요\\?", "을\\(를\\) 마감할까요\\?", "퀴즈 정답을 공개할까요\\?", "추첨을 \\$\\{next\\.count\\}명으로 실행할까요\\?", "의 결과를 참가자에게 공개할까요\\?"]) {
    assert.match(panes, new RegExp(copy, "u"));
  }
  assert.match(workspace, /payload: \{ id: target\.id, status: next\.to \}/u);
  assert.match(workspace, /expectedRevision: program\.revision/u);
  assert.match(workspace, /showOnScreen: true/u);
  assert.match(workspace, /payload: \{ id: target\.id, expectedDrawId: next\.drawId \}/u);
  assert.match(workspace, /command: "reward\.fulfill", payload: \{ id: rewardId \}/u);
  // Event controls: one primary at a time (열기 or 마감); the rest are supporting.
  assert.match(panes, /variant="primary" size="lg" disabled=\{locked\} onClick=\{\(\) => props\.onConfirm\(\{ kind: "status", moduleId: selected\.id, to: "CLOSED" \}\)\}/u);
});

test("gates: stage, permission and feature decide what can be pressed", () => {
  const workspace = read("LiveWorkspace.tsx");
  const panes = read("LivePanes.tsx");
  assert.match(workspace, /model\.stage === "DRAFT" \|\| model\.stage === "READY"/u);
  assert.match(workspace, /행사를 진행 중 단계로 바꾸면 사용할 수 있습니다/u);
  assert.match(workspace, /settings#settings-stage/u);
  assert.match(workspace, /const live = model\.stage === "LIVE"/u, "ended and archived are read-only");
  for (const [key, command] of [["display", "display.set"], ["programs", "module.status"], ["draws", "draw.program.run"], ["rewards", "reward.fulfill"]]) {
    assert.match(workspace, new RegExp(`${key}: live && .*canWriteEvent\\(capabilities, "${command.replace(".", "\\.")}"\\)`, "u"), `${key} gate mirrors ${command}`);
  }
  assert.match(workspace, /screenOn && canWriteEvent/u, "the display control needs the screen feature");
  // Read-only operators get no controls at all (not disabled ones).
  assert.match(panes, /\{props\.canDisplay \? \(/u);
  assert.match(panes, /\{writable \? \(/u);
  assert.match(panes, /\{canRewards \? \(/u);
  assert.match(workspace, /현장 진행 권한이 없어 조회만 할 수 있습니다/u);
});

test("refresh follows the console pattern and never wipes a good read", () => {
  const workspace = read("LiveWorkspace.tsx");
  assert.match(workspace, /subscribeConsoleFreshness/u);
  assert.match(workspace, /document\.visibilityState !== "visible"/u);
  assert.match(workspace, /visibilitychange/u);
  assert.match(workspace, /ifVersion=/u);
  assert.match(workspace, /POLL_VISIBLE_MS = 10000/u);
  assert.match(workspace, /마지막 갱신/u);
  assert.match(workspace, /data-live-refresh-error/u);
  assert.match(workspace, /setState\(\(current\) => current\.kind === "ready" \? current :/u, "a failed refresh keeps the previous data");
  assert.match(workspace, /aria-live="polite"/u);
  assert.match(workspace, /useConsoleDraftGuard/u);
});

test("dark stage uses tokens and local custom properties, 48px targets, reduced motion", () => {
  const css = read("live.module.css");
  assert.match(css, /--room-ground:\s*var\(--stage\)/u);
  assert.doesNotMatch(css, /#[0-9A-Fa-f]{3,8}\b/u, "no raw colors");
  assert.match(css, /min-block-size:\s*48px/u);
  assert.match(css, /prefers-reduced-motion: reduce/u);
  assert.match(css, /word-break:\s*keep-all/u);
  assert.doesNotMatch(read("LivePanes.tsx") + read("LiveWorkspace.tsx"), /<ProductButton[^>]*className="button button-/u, "buttons state their role with variant");
});

test("cue states follow the clock; a title ties a participation event to its cue", () => {
  const { liveCues, titlesMatch, displayChoices, currentDisplayLabel } = load("live-schedule.ts");
  const program = (id, title, start, end) => ({ id, title, date: "2027-01-16", start, end, place: "" });
  const programs = [program("a", "개회", "13:00", "13:20"), program("b", "오프닝 OX 퀴즈", "13:20", "13:35"), program("c", "세션 1", "13:35", "14:20"), program("d", "럭키 드로우", "16:40", "17:00")];
  const at = (hh, mm) => new Date(2027, 0, 16, hh, mm);
  const status = (now) => liveCues(programs, "2027-01-16", now).cues.map((cue) => cue.status).join(",");
  assert.equal(status(at(13, 24)), "done,current,next,upcoming");
  assert.equal(status(at(12, 0)), "next,upcoming,upcoming,upcoming");
  assert.equal(status(at(18, 0)), "done,done,done,done");
  // A past day is all done and a future day all upcoming (one is "next").
  const onDay = (date) => programs.map((item) => ({ ...item, date }));
  assert.equal(liveCues(onDay("2027-01-15"), "2027-01-15", at(13, 24)).cues.every((cue) => cue.status === "done"), true);
  assert.equal(liveCues(onDay("2027-01-17"), "2027-01-17", at(13, 24)).cues.map((cue) => cue.status).join(","), "next,upcoming,upcoming,upcoming");
  // No cue on the event date but some today: today's order is shown.
  assert.equal(liveCues(programs, "2026-12-01", at(13, 24)).date, "2027-01-16");
  // An open-ended cue runs until the next one starts.
  const open = [program("x", "A", "10:00", ""), program("y", "B", "11:00", "")];
  assert.equal(liveCues(open, "2027-01-16", at(10, 30)).cues.map((cue) => cue.status).join(","), "current,next");
  assert.equal(liveCues(open, "2027-01-16", at(11, 30)).cues.map((cue) => cue.status).join(","), "done,current");

  assert.equal(titlesMatch("오프닝 OX 퀴즈", "OX 퀴즈"), true);
  assert.equal(titlesMatch("세션 1 · Q&A", "세션 1 Q&A"), true);
  assert.equal(titlesMatch("개회", "럭키 드로우"), false);

  // The output picker mirrors the server contract: unpublished or unrevealed things are not offered.
  const options = {
    notices: [{ id: "n1", title: "공지", published: true }, { id: "n2", title: "초안", published: false }],
    modules: [
      { id: "p1", title: "투표", type: "poll", published: true, revealed: false, draws: [] },
      { id: "q1", title: "퀴즈", type: "quiz", published: true, revealed: false, draws: [] },
      { id: "q2", title: "공개 퀴즈", type: "quiz", published: true, revealed: true, draws: [] },
    ],
    approvedPhotos: 2, approvedQuestions: 0,
  };
  assert.equal(displayChoices(options).map((choice) => choice.value).join(" "), "idle| notice|n1 poll|p1 quiz|q2 photo|");
  assert.equal(currentDisplayLabel({ type: "idle", moduleId: "", noticeId: "", drawId: "" }, options), "유휴 화면");
  assert.equal(currentDisplayLabel({ type: "poll", moduleId: "p1", noticeId: "", drawId: "" }, options), "투표 · 투표");
});

// Reopened 2026-11-20 (shared gaps): the stage's status pill is the shared StatusPill's on-dark tones, not a local LivePill,
// and the room's CSS no longer needs !important or a global .product-action override.
test("the stage status pill is the shared StatusPill with on-dark tones", () => {
  const panes = read("LivePanes.tsx");
  const css = read("live.module.css");
  assert.ok(!fs.existsSync(path.join(DIR, "LivePill.tsx")), "the local LivePill is gone");
  assert.doesNotMatch(panes, /LivePill/u);
  assert.match(panes, /import StatusPill, \{ type StatusPillTone \} from "\.\.\/\.\.\/\.\.\/console-ui\/StatusPill"/u);
  assert.match(panes, /module\.status === "OPEN" \? "on-dark-ok" : module\.status === "DRAFT" \? "on-dark-wait" : "on-dark"/u);
  assert.equal((panes.match(/<StatusPill tone=\{statusTone\((?:module|selected)\)\} size="sm" dot>/gu) || []).length, 3, "all three status labels use it");
  assert.doesNotMatch(css, /\.pill\b|\.pillDot/u, "no local pill styles");
  assert.match(css, /\[data-status-pill\^="on-dark"\]/u, "a picked chip lifts the pill from the room's own CSS");
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(bare, /!important/u, "margins use a zero-specificity reset instead");
  assert.doesNotMatch(bare, /:global\(\.product-action\)/u);
});

// Reopened 2026-11-26 (door-day audit): the top bar names the cumulative figure, shows who is
// inside, measures both against approved people, and counts the same waiting people as the desks.
test("entry figures use the desk's rules for approved, inside and waiting", () => {
  const code = ts.transpileModule(read("live-model.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const stubs = {
    "../../../../../lib/participation-work": { PARTICIPATION_TYPES: [], participationSnapshot: () => ({}) },
    "../../../../../lib/reward-status": { rewardBucket: () => "waiting", rewardParticipantIssue: () => null },
  };
  vm.runInNewContext(code, { exports, require: (name) => stubs[name] }, { filename: "live-model.ts" });
  const person = (id, extra = {}) => ({ id, status: "APPROVED", inside: false, everIn: false, ...extra });
  const participants = [
    person("inside", { inside: true, everIn: true }),
    person("left", { everIn: true }),
    person("coming"),
    person("pending", { status: "PENDING" }),
    person("waitlist", { status: "WAITLIST" }),
    person("pending-inside", { status: "PENDING", inside: true, everIn: true }),
    person("cancelled", { status: "CANCELLED", everIn: true }),
    person("revoked", { revoked: true, inside: true, everIn: true }),
    person("withdrawn", { cancelled: true }),
    person("erased", { erased: true }),
    person("closed-desk"),
    person("exit-desk"),
  ];
  const open = (participantId, deskId = "in", extra = {}) => ({ id: `a-${participantId}-${deskId}`, participantId, deskId, handedAt: null, cancelledAt: null, ...extra });
  const workspace = {
    participants,
    desks: [{ id: "in", action: "IN", open: true }, { id: "side", action: "IN" }, { id: "stopped", action: "IN", open: false }, { id: "out", action: "OUT", open: true }],
    arrivals: [
      open("coming"), open("left", "side"), open("pending"), open("waitlist"),
      open("inside"), open("cancelled"), open("revoked"), open("withdrawn"), open("erased"), open("nobody"),
      open("closed-desk", "stopped"), open("exit-desk", "out"),
      open("exit-desk", "in", { handedAt: "2026-11-26T00:00:00Z" }), open("closed-desk", "in", { cancelledAt: "2026-11-26T00:00:00Z" }),
    ],
  };
  const model = exports.parseLiveModel({ events: [{ id: "e", stage: "LIVE", features: [] }], workspaces: { e: workspace } }, "e", { role: "AGENCY", userId: "u" });
  assert.deepEqual([model.approved, model.everIn, model.inside, model.waiting], [5, 2, 1, 4]);
  const unread = exports.parseLiveModel({ events: [{ id: "e" }], workspaces: { e: {} } }, "e", { role: "AGENCY", userId: "u" });
  assert.deepEqual([unread.approved, unread.inside, unread.waiting], [null, null, 0]);
  const workspaceSource = read("LiveWorkspace.tsx");
  assert.match(workspaceSource, /누적 입장 <b>\{model\.everIn \?\? 0\}<\/b>/u);
  assert.match(workspaceSource, /· 지금 안에 \{model\.inside\}/u);
  assert.match(workspaceSource, /const entryPct = model\.approved \?/u);
});
