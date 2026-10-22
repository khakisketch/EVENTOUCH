// Task-first final refinements: small, operator-legible UI contracts.
//
// Covers (1) team contact wrapping without mid-token breaks, (2) complete
// recent-activity mapping of every audit-producing server command with a
// readable unknown fallback that keeps the raw key on demand, (3) global +
// owned-module token discipline (no literal colors, no off-scale type or
// spacing), and (4) small proportion/alignment/status refinements for the
// photos upload, the import file row, and operations resource states.
// Source contracts only: copy, commands, guards and behavior stay pinned.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..", "apps", "web", "app");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");

// The helper is plain TS with trivial annotations; strip them so the test
// executes the real mapping instead of a copy of it.
function loadActivityLabels() {
  let source = read("console/team/activity-labels.ts");
  source = source.replace(/^export\s+/gm, "");
  source = source.replace(/:\s*Record<string,\s*string>/g, "");
  source = source.replace(/:\s*string\s*\|\s*null/g, "");
  source = source.replace(/:\s*string\b/g, "");
  source = source.replace(/:\s*boolean\b/g, "");
  const module = { exports: {} };
  const run = new Function(
    "module",
    "exports",
    `${source}\nmodule.exports = { ACTIVITY_LABELS, isKnownActivityType, getActivityLabel, UNKNOWN_ACTIVITY_LABEL };`
  );
  run(module, module.exports);
  return module.exports;
}

// Every audit-producing command, read from the server command sets:
// preparation + engagement + content-results + booth-map + event-evidence +
// attendee-experience (domain path) and operations.js (operations path),
// plus the participants keys for forward compatibility.
const KNOWN_COMMANDS = [
  "event.update", "event.features", "event.stage",
  "field.save", "field.move", "field.delete",
  "form.publish", "form.close",
  "group.save", "group.assign",
  "notice.save", "notice.delete",
  "program.save", "program.delete",
  "venue.save", "branding.save",
  "attendee.page.save", "attendee.page.publish",
  "module.save", "module.status", "module.reveal",
  "response.submit",
  "question.submit", "question.manage", "question.like",
  "photo.submit", "photo.moderate",
  "post.submit", "post.moderate",
  "draw.run", "draw.publish", "display.set",
  "template.save",
  "message.create", "message.cancel", "message.retry", "message.sync",
  "payment.simulate", "payment.refund-request", "payment.refund",
  "reward.create", "reward.assign", "reward.fulfill", "reward.cancel",
  "report.create", "report.update", "report.publish", "report.successor",
  "booth.map.save", "booth.map.publish", "booth.map.unpublish",
  "evidence.photo.add", "evidence.photo.move", "evidence.photo.remove",
  "lucky.assign", "lucky.config.save", "lucky.preassign",
  "roulette.spin", "roulette.config.save",
  "vote.ranked", "vote.config.save", "vote.tally",
  "team.save", "draw.program.save", "draw.program.run",
  "desk.save", "desk.set-open",
  "staff.assign", "staff.unassign",
  "check.scan", "check.correct",
  "booth.save", "booth.mode", "booth.visit",
  "reward.lookup", "reward.collect",
  "participant.create", "participant.update", "participant.status",
  "participant.self-update", "participant.cancel",
  "ticket.reissue", "participant.import",
];

test("activity labels map every known audit command to Korean", () => {
  const labels = loadActivityLabels();
  assert.equal(labels.UNKNOWN_ACTIVITY_LABEL, "기록된 작업");
  for (const command of KNOWN_COMMANDS) {
    assert.equal(labels.isKnownActivityType(command), true, `${command} is known`);
    const label = labels.getActivityLabel(command);
    assert.ok(typeof label === "string" && label.length > 0, `${command} has a label`);
    assert.notEqual(label, command, `${command} never renders its raw key`);
    assert.doesNotMatch(label, /\./u, `${command} label is prose, not a key`);
  }
});

test("activity labels keep the pinned core vocabulary", () => {
  const labels = loadActivityLabels();
  for (const [command, expected] of [
    ["report.publish", "결과 보고서 공유 완료"],
    ["report.create", "보고서 만들기"],
    ["reward.create", "경품 등록"],
    ["message.create", "메시지 발송 요청"],
    ["template.save", "템플릿 저장"],
    ["module.save", "참여 프로그램 저장"],
    ["module.status", "참여 프로그램 상태 변경"],
    ["question.submit", "Q&A 질문"],
    ["question.manage", "Q&A 답변"],
    ["notice.save", "공지 저장"],
    ["check.scan", "입퇴장 스캔"],
    ["desk.save", "데스크 저장"],
    ["booth.save", "부스 저장"],
    ["event.features", "기능 설정"],
    ["form.publish", "참가 신청 게시"],
    ["draw.program.save", "추첨 프로그램 설정 저장"],
    ["booth.mode", "부스 인증 방식 변경"],
    ["participant.import", "참가자 명단 가져오기"],
  ]) {
    assert.equal(labels.getActivityLabel(command), expected, `${command} keeps its label`);
  }
});

test("unknown activity keys stay readable with evidence on demand", () => {
  const labels = loadActivityLabels();
  assert.equal(labels.isKnownActivityType("someday.new-command"), false);
  assert.equal(labels.getActivityLabel("someday.new-command"), null);
  assert.equal(labels.isKnownActivityType("participant.future-key"), true, "future participant.* keys stay grouped");
  assert.equal(labels.getActivityLabel("participant.future-key"), null, "…but unmapped is still detectable for evidence");
  const panels = read("console/team/OperationsPanels.tsx");
  assert.match(panels, /isKnownActivityType\(entry\.type\)/u, "rows branch on known/unknown");
  assert.match(panels, /getActivityLabel\(entry\.type\) === null/u, "raw-key disclosure keys off the map, not the grouped prefix");
  assert.match(panels, /기록된 작업/u, "unknown rows read as recorded work");
  assert.match(panels, /<details className=\{teamStyles\.activityTech\}>/u, "raw key folds into an on-demand block");
  assert.match(panels, /<code>\{entry\.type\}<\/code>/u, "the raw technical key survives verbatim");
});

test("team contacts break at safe points, never mid-token or hidden", () => {
  const workspace = read("console/team/TeamWorkspace.tsx");
  assert.match(workspace, /<wbr \/>/u, "emails carry semantic break opportunities");
  assert.match(workspace, /SafeContact/u, "both invite and member emails use the safe renderer");
  assert.equal(workspace.match(/<SafeContact value=\{/g)?.length ?? 0, 2, "invite + member contacts");
  assert.doesNotMatch(workspace, /text-overflow:\s*ellipsis|overflow:\s*hidden/u, "no truncation hides contact info");
  const css = read("console/team/team.module.css");
  assert.match(css, /\.memberContact\s*\{[^}]*overflow-wrap:\s*break-word/su, "contacts fall back only when no safe point exists");
  assert.match(css, /\.memberContact\s*\{[^}]*word-break:\s*keep-all/su, "phrases stay intact");
  assert.doesNotMatch(css, /\.memberContact\s*\{[^}]*anywhere/su, "contacts never snap mid-token");
  assert.doesNotMatch(css, /\.inviteDetail\s*\{[^}]*anywhere/su, "invitation context never snaps mid-token");
  assert.doesNotMatch(css, /\.inviteDetail span\s*\{[^}]*anywhere/su, "invitation context lines never snap mid-token");
  assert.match(css, /\.teamRow\s*\{[^}]*width:\s*100%/su, "team rows own full width next to their action");
  assert.match(css, /\.memberMain\s*\{[^}]*min-width:\s*0/su, "text column keeps a shrinkable basis");
  assert.match(css, /\.memberActions\s*\{[^}]*flex:\s*none/su, "actions never squeeze the text");
  assert.match(workspace, /teamStyles\.teamRow/u);
  assert.match(workspace, /teamStyles\.memberMain/u);
  assert.match(workspace, /teamStyles\.memberActions/u);
});

test("globals use tokens: no literal colors, no off-scale type or spacing", () => {
  const css = read("globals.css");
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "globals carry no literal colors");
  for (const size of ["12px", "13px", "15px"]) {
    assert.doesNotMatch(css, new RegExp(`font-size:\\s*${size}`, "u"), `no ${size} type outside tokens`);
  }
  assert.match(css, /\.nav-badge\s*\{[^}]*color:\s*var\(--on-brand\)/su, "badge reads on-brand, not white");
  assert.match(css, /\.nav-badge\s*\{[^}]*font-size:\s*var\(--small\)/su);
  assert.match(css, /\.nav-badge\s*\{[^}]*padding-inline:\s*var\(--s2\)/su);
  assert.match(css, /\.nav-stage-dot\.nav-stage-live\s*\{\s*background:\s*var\(--success-line\)/su);
  assert.match(css, /\.nav-stage-dot\.nav-stage-planned\s*\{\s*background:\s*var\(--warning-line\)/su);
  assert.match(css, /\.status-chip\s*\{[^}]*gap:\s*var\(--s2\)/su);
  assert.match(css, /\.status-chip\s*\{[^}]*padding:\s*var\(--s1\) var\(--s3\)/su);
  assert.match(css, /\.auth-form \.auth-reset-help\s*\{[^}]*padding:\s*var\(--s2\) var\(--s3\)/su);
  // Only fixed gap/padding/margin literals count: sr-only geometry, safe-area
  // env() math and underline offsets keep their explicit values.
  assert.doesNotMatch(css, /(?:gap|padding(?:-\w+)?|margin(?:-\w+)?):[^;{}]*?\b(?:10px|6px|4px|2px)\b/u, "no off-scale gap/padding/margin literals remain");
});

test("owned modules stay token-clean", () => {
  const ops = read("console/events/[id]/operations/operations.module.css");
  assert.deepEqual(ops.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "operations carry no literal colors");
  assert.match(ops, /\.mapPoint\s*\{[^}]*color:\s*var\(--on-brand\)/su);
  assert.match(ops, /\.mapPoint\s*\{[^}]*padding:\s*var\(--s1\) var\(--s2\)/su);
  const imp = read("console/events/[id]/participants/import/import.module.css");
  assert.doesNotMatch(imp, /font-size:\s*12px/u);
  assert.match(imp, /\.importStepNumber\s*\{[^}]*font-size:\s*var\(--small\)/su);
});

test("operations resources promote an explicit textual state badge", () => {
  const source = read("console/events/[id]/operations/OperationsWorkspace.tsx");
  const css = read("console/events/[id]/operations/operations.module.css");
  assert.match(source, /styles\.resourceStatus/u, "desk and booth rows render a state badge");
  assert.match(source, /data-tone=\{desk\.open \? "good" : "muted"\}/u);
  assert.match(source, /data-tone=\{booth\.status === "OPEN" \? "good" : booth\.status === "WAITING" \? "wait" : "muted"\}/u);
  for (const copy of ["가동 중", "중지됨", "대기", "진행", "종료"]) {
    assert.match(source, new RegExp(copy, "u"), `${copy} copy survives`);
  }
  assert.match(css, /\.resourceStatus\[data-tone="good"\]\s*\{[^}]*var\(--success-soft\)/su);
  assert.match(css, /\.resourceStatus\[data-tone="good"\]\s*\{[^}]*color:\s*var\(--success\)/su);
  assert.match(css, /\.resourceStatus\[data-tone="wait"\]\s*\{[^}]*var\(--warning-soft\)/su);
  assert.match(css, /\.resourceHead\s*\{[^}]*gap:\s*var\(--s2\)/su, "name and badge share one identity row");
});

test("team domain reads as one atomic group", () => {
  const workspace = read("console/team/TeamWorkspace.tsx");
  assert.match(workspace, /lastIndexOf\("@"/u, "split point is the final @");
  assert.match(workspace, /split\(\/\(\[-_\]\+\)\/\)/u, "local part breaks only after -/_ runs");
  assert.match(workspace, /teamStyles\.contactDomain/u, "domain renders in its atomic span");
  assert.match(workspace, /<span className=\{teamStyles\.contactDomain\}>@\{value\.slice\(at \+ 1\)\}<\/span>/u, "@domain stays one unit");
  assert.match(workspace, /if \(at <= 0 \|\| at === value\.length - 1\) return <>\{value\}<\/>/u, "non-addresses render untouched");
  const css = read("console/team/team.module.css");
  assert.match(css, /\.contactDomain\s*\{[^}]*display:\s*inline-block/su);
  assert.match(css, /\.contactDomain\s*\{[^}]*width:\s*max-content/su);
  assert.match(css, /\.contactDomain\s*\{[^}]*max-width:\s*100%/su, "overlong domains wrap instead of overflowing");
  assert.match(css, /\.contactDomain\s*\{[^}]*overflow-wrap:\s*anywhere/su, "anywhere fallback lives only inside an overwide domain");
});

test("states script reveals paged activity before asserting older labels", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "web-task-first-final-states.cjs"), "utf8");
  assert.match(script, /#team-activity-more/u, "expansion uses the real more control");
  assert.match(script, /expandActivityFor\(label\)/u, "every asserted label expands first");
  assert.match(script, /attempt < 3/u, "expansion stays bounded (8 + 2 pages cover all 20)");
  assert.match(script, /9a0884f0d5e342bba250f44b7388f69a/u, "long-hash wrap dataset is seeded");
  assert.match(script, /extraordinarily-long-subdomain/u, "overlong-domain overflow dataset is seeded");
  assert.match(script, /domainAtomic/u, "rendered runs assert @domain on one line");
  assert.match(script, /photoGuidance/u, "upload guidance widths recorded for before/after");
  assert.match(script, /ch: node\.data\[offset\]/u, "Range probes read actual Text.data characters, not indexed DOM nodes");
  assert.match(script, /domainAtomic, true/u, "normal domains must occupy a single rendered line");
});

test("photos upload stacks full-width on phones; import file aligns left", () => {
  const photos = read("console/events/[id]/photos/evidence-photos.module.css");
  const mobile = photos.slice(photos.indexOf("@media (max-width: 768px)"));
  assert.match(mobile, /\.uploadArea\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su, "explanation keeps full width");
  assert.match(mobile, /\.uploadArea > :global\(\.button\)\s*\{[^}]*width:\s*100%/su, "upload action goes full-width");
  const wizard = read("console/events/[id]/participants/import/ImportWizard.tsx");
  assert.match(wizard, /filters=\{\s*<label>/su, "file picker rides the left filter slot on desktop");
  assert.match(wizard, /actions=\{\s*<button/u, "template stays a right-side action");
  assert.match(wizard, /양식 CSV/u, "template download survives the move");
});
