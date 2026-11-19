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
  "event.update", "event.basics.save", "event.features", "event.stage",
  "field.save", "field.move", "field.delete",
  "form.publish", "form.close",
  "group.save", "group.assign",
  "notice.save", "notice.publish", "notice.publish-reviewed", "notice.delete",
  "program.save", "program.publish", "program.publish-reviewed", "program.delete",
  "venue.save", "venue.publish", "venue.publish-reviewed", "branding.save",
  "attendee.page.save", "attendee.page.publish", "attendee.page.publish-reviewed",
  "module.save", "module.status", "module.reveal",
  "response.submit",
  "question.submit", "question.manage", "question.like",
  "photo.submit", "photo.moderate",
  "post.submit", "post.moderate",
  "draw.run", "draw.publish", "display.set",
  "template.save",
  "message.create", "message.create-reviewed", "message.record-provider-check", "message.cancel", "message.retry", "message.sync",
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
  "ticket.reissue", "ticket.reissue-reviewed", "participant.import",
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
    ["message.create-reviewed", "메시지 발송 요청"],
    ["message.record-provider-check", "공급사 확인 기록"],
    ["event.basics.save", "행사 정보 변경"],
    ["template.save", "템플릿 저장"],
    ["module.save", "참여 콘텐츠 저장"],
    ["module.status", "참여 콘텐츠 상태 변경"],
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
  assert.equal(workspace.match(/<SafeContact value=\{/g)?.length ?? 0, 5, "invite + member + event-permission rows and the two drawer headers");
  assert.match(workspace, /<SafeContact value=\{invitation\.email\} \/>/u);
  assert.equal(workspace.match(/<SafeContact value=\{account\.email\} \/>/g)?.length ?? 0, 2, "both member and permission-editor rows use semantic wrapping");
  assert.doesNotMatch(workspace, />\s*\{(?:account|invitation)\.email\}\s*</u, "no direct contact rendering bypasses safe wrapping");
  assert.doesNotMatch(workspace, /text-overflow:\s*ellipsis|overflow:\s*hidden/u, "no truncation hides contact info");
  const css = read("console/team/team.module.css");
  assert.match(css, /\.personContact\s*\{[^}]*overflow-wrap:\s*break-word/su, "contacts fall back only when no safe point exists");
  assert.match(css, /\.personContact\s*\{[^}]*word-break:\s*keep-all/su, "phrases stay intact");
  assert.doesNotMatch(css, /\.personContact\s*\{[^}]*anywhere/su, "contacts never snap mid-token");
  assert.doesNotMatch(css, /\.inviteDetail\s*\{[^}]*anywhere/su, "invitation context never snaps mid-token");
  assert.doesNotMatch(css, /\.inviteDetail span\s*\{[^}]*anywhere/su, "invitation context lines never snap mid-token");
  assert.match(css, /\.personRow,\s*\.permRow\s*\{[^}]*min-width:\s*0/su, "people rows may shrink instead of overflowing");
  assert.match(css, /\.personMain\s*\{[^}]*min-width:\s*0/su, "text column keeps a shrinkable basis");
  assert.match(workspace, /teamStyles\.personRow/u);
  assert.match(workspace, /teamStyles\.personMain/u);
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
});

test("operations resources keep an explicit textual state, not color or a switch alone", () => {
  const source = read("console/events/[id]/operations/OperationsWorkspace.tsx");
  const css = read("console/events/[id]/operations/operations.module.css");
  assert.match(source, /\$\{desk\.open \? "가동 중" : "중지됨"\}/u, "a desk row says its state in words beside the switch");
  assert.match(source, /warning=\{deskIncomplete \? "정보 확인 필요" : null\}/u, "an incomplete desk says so on its row");
  assert.match(source, /<StatusDot tone=\{booth\.status === "OPEN" \? "good" : booth\.status === "WAITING" \? "wait" : "muted"\}>/u, "a booth row shows its schedule state as a dot plus word");
  for (const copy of ["가동 중", "중지됨", "대기", "진행", "종료"]) {
    assert.match(source, new RegExp(copy, "u"), `${copy} copy survives`);
  }
  // Reopened 2026-11-20 (디자인 시스템 적용): the booth state is the shared StatusPill (dot plus word), not a local .statusDot.
  const parts = read("console/events/[id]/operations/LocationParts.tsx");
  assert.match(parts, /<StatusPill tone=\{tone === "good" \? "ok" : tone === "wait" \? "info" : "neutral"\} size="sm" dot>/u);
  assert.doesNotMatch(css, /\.statusDot/u);
  assert.match(css, /\.locationDim \.locationText strong\s*\{[^}]*color:\s*var\(--muted\)/su, "a stopped row dims by muted text, never by opacity");
  assert.doesNotMatch(css, /\.location[A-Za-z]*\s*\{[^}]*opacity/su, "no row hides its words behind reduced opacity");
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
  assert.match(mobile, /\.uploadArea > :global\(\.product-action\)\s*\{[^}]*width:\s*100%/su, "upload action goes full-width");
  const wizard = read("console/events/[id]/participants/import/ImportWizard.tsx");
  assert.match(wizard, /<label data-import-dropzone/u, "the drop area is one label around the real file input");
  assert.match(wizard, /styles\.filePicker/u, "the picker owns its focusable presentation");
  assert.match(wizard, /type="file"/u, "the picker remains a native file input");
  const importCss = read("console/events/[id]/participants/import/import.module.css");
  assert.match(importCss, /\.filePicker:focus-within\s+\.fileButton\s*\{[^}]*outline:\s*3px/su, "keyboard focus is visible without :has");
  assert.match(wizard, /downloadCsv\("EVENTOUCH_import_template\.csv"/u, "template download stays one quiet link beside the format line");
  assert.match(wizard, /양식 CSV/u, "template download survives the move");
});
