// Task-flow shortcuts without new functionality: (1) a published notice row
// can be sent to the venue screen directly, and (2) each desk/booth row shows
// its staff and opens the existing assignment dialog preselected.
// UI-only: commands, copy volume, confirm grammar, permissions, stages,
// tokens, and the venue/draft guards stay pinned. Source-only assertions;
// rendering rides the isolated console audit (main owns render/runtime).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const WEB = path.join(__dirname, "..", "apps", "web");
const read = (relative) => fs.readFileSync(path.join(WEB, relative), "utf8");

const content = () => read("app/console/events/[id]/content/ContentWorkspace.tsx");
const ops = () => read("app/console/events/[id]/operations/OperationsWorkspace.tsx");
const contentCss = () => read("app/console/events/[id]/content/content.module.css");
const opsCss = () => read("app/console/events/[id]/operations/operations.module.css");

test("content: a published notice shows live screen status and a direct output action", () => {
  const source = content();
  // Bootstrap truth for the status: the workspace display is parsed, not
  // invented, and the screen feature gates the shortcut.
  assert.match(source, /display: \{ type: string; noticeId: string \}/u);
  assert.match(source, /asRecord\(workspace\.display\)/u);
  assert.match(source, /screenEnabled: features\.includes\("screen"\)/u);
  // Status badge reuses the existing badge tokens. The display reference
  // survives unpublishing server-side and the board only shows published
  // notices, so the label names the actual state instead of claiming output.
  assert.match(source, /전광판 출력으로 선택됨/u);
  assert.match(source, /전광판 선택됨 · 비공개로 출력되지 않음/u);
  assert.match(source, /전광판 선택됨 · 기능 꺼짐/u);
  assert.doesNotMatch(source, /전광판 출력 중/u, "no label may claim live output from a stale reference");
  assert.match(source, /onDisplay = state\.display\.type === "notice" && state\.display\.noticeId === item\.id/u);
  assert.match(source, /const displayBadge = !onDisplay/u);
  assert.match(source, /!state\.screenEnabled/u);
  assert.match(source, /!item\.published/u);
  // The row action is secondary, labelled, and busy-guarded.
  assert.match(source, /requestNoticeDisplay/u);
  assert.match(source, /applyNoticeDisplay/u);
  assert.match(source, /"전광판 출력"/u, "the row action reads 전광판 출력");
  assert.match(source, /`notice-display:\$\{item\.id\}`/u);
  // Explicit external-output confirmation carries the notice title.
  assert.match(source, /<ConsoleConfirm/u);
  assert.match(source, /행사장 전광판에 출력할까요\?/u);
  assert.match(source, /외부 화면에 나옵니다/u);
  assert.match(source, /confirmLabel="전광판 출력"/u);
  // The write reuses the existing command path and refresh discipline.
  assert.match(source, /postCommand\("display\.set", \{ type: "notice", noticeId: item\.id \}\)/u);
  assert.match(source, /setNotice\("전광판 출력을 바꿨습니다\."\)/u);
  assert.match(source, /await load\(true\)/u);
});

test("content: no autopublish, hidden when it must be, old buttons intact", () => {
  const source = content();
  assert.match(source, /const canOutput = canOutputNotice && item\.published;/u);
  assert.match(source, /canOutputNotice = state\.screenEnabled && state\.canManage && !archived/u);
  assert.match(source, /\{canOutput \? \(/u, "the action hides instead of disabling");
  assert.match(source, /\{noticeDisplayPendingId === item\.id && canOutput && noticeDeletePendingId !== item\.id \? \(/u);
  assert.match(source, /\{noticeDeletePendingId === item\.id && noticeDisplayPendingId !== item\.id \? \(/u, "output and delete confirms never share a row");
  assert.match(source, /\{displayBadge \? \(/u, "the status shows only on the referenced row");
  // Mutual exclusivity: opening one confirm clears the other, and both
  // requests refuse while any command is in flight.
  assert.match(source, /function requestNoticeDisplay\(item: Notice\) \{\s*if \(busy !== null \|\| archived\) return;\s*setNoticeDeletePendingId\(null\);\s*setNoticeDisplayPendingId\(item\.id\);/u);
  assert.match(source, /function requestNoticeDelete\(item: Notice\) \{\s*if \(busy !== null \|\| archived\) return;\s*setNoticeDisplayPendingId\(null\);\s*setNoticeDeletePendingId\(item\.id\);/u);
  assert.match(source, /busy=\{busy !== null\}/u, "both confirms disable while a write runs");
  assert.match(source, /commandBusyRef\.current/u, "the shared in-flight gate still guards applies");
  assert.doesNotMatch(source, /published: true, pinned[\s\S]{0,200}display\.set|display\.set[\s\S]{0,200}published: true/u, "publishing and output stay separate writes");
  for (const label of ["편집", "게시", "고정", "삭제"]) {
    assert.ok(source.includes(label), `the existing ${label} affordance stays`);
  }
  assert.match(source, /공지를 삭제할까요/u, "the delete confirm copy is untouched");
  assert.match(source, /보관된 행사는 읽기 전용입니다/u);
  assert.match(source, /콘텐츠를 관리할 운영 권한이 없습니다/u);
  const added = source.slice(source.indexOf("noticeDisplayPendingId"));
  assert.doesNotMatch(added, /localStorage|sessionStorage|location\.hash|useSearchParams/u, "no fragment/query handoff for the direct operation");
});

test("content: an accepted refresh invalidates pending output intent, failures keep it retryable", () => {
  const source = content();
  // Any successful notice/content write refreshes through load(true), so an
  // accepted canonical snapshot clears the pending output confirm: the
  // notice may have been edited or unpublished-then-republished underneath.
  const loadBody = source.slice(
    source.indexOf("async function load(silent = false)"),
    source.indexOf("useEffect(() => {")
  );
  const accepted = loadBody.slice(loadBody.indexOf('kind: "ready"'));
  assert.match(accepted, /setNoticeDisplayPendingId\(null\)/u, "accepted workspace clears the output intent");
  assert.match(accepted, /Preserve an independently dirty venue draft/u, "venue preservation stays intact");
  assert.match(accepted, /venueBaselineRef\.current = venue;/u);
  for (const failed of ["콘텐츠 정보를 불러오지 못했습니다.", "행사를 찾을 수 없습니다.", "연결하지 못했습니다. 다시 시도하세요."]) {
    const at = loadBody.indexOf(failed);
    assert.ok(at >= 0, `the failed branch still reports: ${failed}`);
    const around = loadBody.slice(Math.max(0, at - 200), at + 200);
    assert.doesNotMatch(around, /setNoticeDisplayPendingId/u, "failed loads keep the confirm for retry");
  }
  // Own success clears after the successful load; a rejected write leaves
  // the confirm open and only releases the busy gate.
  const applyBody = source.slice(
    source.indexOf("async function applyNoticeDisplay"),
    source.indexOf("function openProgramCreate()")
  );
  assert.match(applyBody, /await load\(true\);\s*\n(\s*\/\/[^\n]*\n)+\s*setNoticeDisplayPendingId\(null\);/u, "own success clears after the accepted load");
  const applyFinally = applyBody.slice(applyBody.indexOf("} finally {"));
  assert.doesNotMatch(applyFinally, /setNoticeDisplayPendingId/u, "failure keeps the confirm for retry");
  assert.match(applyFinally, /setBusy\(null\);/u, "failure still releases the busy gate");
});

test("content: tokens only, venue draft stays independent", () => {
  const source = content();
  assert.match(source, /\$\{styles\.badge\} \$\{displayBadge\.live \? styles\.badgeOn : ""\}/u, "the status reuses the badge grammar, success tone only when actually selected for output");
  const style = contentCss();
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}/u, "no new color literals");
  assert.match(source, /venueBaselineRef\.current/u, "the venue baseline still guards silent reloads");
  assert.match(source, /Preserve an independently dirty venue draft/u);
});

test("operations: each desk and booth row names its staff", () => {
  const source = ops();
  assert.match(source, /deskStaffNames = assignments/u);
  assert.match(source, /boothStaffNames = assignments/u);
  assert.match(source, /assignment\.type === "DESK" && assignment\.targetId === desk\.id/u);
  assert.match(source, /assignment\.type === "BOOTH" && assignment\.targetId === booth\.id/u);
  assert.match(source, /accountName\.get\(assignment\.accountId\)/u, "names come from the loaded accounts");
  const emptyCount = source.match(/배정된 스태프 없음/g)?.length ?? 0;
  assert.equal(emptyCount, 2, "desk rows and booth rows each name the empty state");
  assert.match(source, /`배정: \$\{deskStaffNames\.join\(", "\)\}`/u, "nonempty desk staff read with a 배정 prefix");
  assert.match(source, /`배정: \$\{boothStaffNames\.join\(", "\)\}`/u, "nonempty booth staff read with a 배정 prefix");
});

test("operations: row assignment reuses the generic dialog preselected, never autosubmits", () => {
  const source = ops();
  // The generic #ops-staff action keeps its exact accessible name and defaults.
  assert.match(source, /headingId="ops-staff"/u);
  assert.match(source, /setAssignPreset\(null\); setAssignOpen\(true\)/u, "generic open resets the preset");
  assert.match(source, /initialType=\{assignPreset\?\.type \?\? \(desks\.length \? "DESK" : "BOOTH"\)\}/u);
  // Row actions are visible with the same label but carry a distinctive
  // accessible name so an exact-name query still finds only the generic one.
  assert.match(source, /aria-label=\{`\$\{desk\.name\}에 스태프 배정`\}/u);
  assert.match(source, /aria-label=\{`\$\{booth\.name\}에 스태프 배정`\}/u);
  assert.match(source, /setAssignPreset\(\{ type: "DESK", targetId: desk\.id \}\)/u);
  assert.match(source, /setAssignPreset\(\{ type: "BOOTH", targetId: booth\.id \}\)/u);
  // The dialog preselects without submitting: staff choice stays required.
  assert.match(source, /initialTargetId\?: string;/u);
  assert.match(source, /useState\(initialTargetId \?\? ""\)/u);
  assert.match(source, /targetId !== \(initialTargetId \?\? ""\)/u, "the dirty baseline is the preset, not a blank");
  assert.match(source, /disabled=\{busy \|\| !accountId \|\| !currentTarget\}/u, "staff selection still gates submit");
  assert.doesNotMatch(source, /onSubmit\(\{ accountId, type, targetId: currentTarget \}\)[\s\S]{0,80}auto|autoSubmit/u);
  // Prefill resets: close clears the preset and the dialog unmounts per open.
  assert.match(source, /setAssignPreset\(null\); \}\}/u);
  assert.match(source, /\{assignOpen \? \(\s*<AssignDialog/u, "the dialog mounts fresh on each open");
  assert.match(source, /targets\.some\(\(target\) => target\.id === targetId\) \? targetId : ""/u, "a stale target coerces to unchosen");
});

test("operations: gates, commands, and touch reuse stay pinned", () => {
  const source = ops();
  assert.match(source, /disabled=\{busy \|\| writeBlocked\}/u);
  assert.match(source, /title=\{writeBlocked \? writeBlockedReason : undefined\}/u);
  assert.match(source, /runCommand\("staff\.assign"/u);
  assert.equal(source.match(/staff\.assign/g)?.length ?? 0, 1, "the existing assign call stays the only one");
  assert.match(source, /staff\.unassign/u, "the release path is untouched");
  assert.match(source, /배정된 스태프가 없습니다\. 진행 중으로 전환하려면 입장 데스크에 스태프를 배정하세요\./u);
  assert.match(source, /className="button button-secondary"/u, "row actions reuse the shared button sizing");
  assert.doesNotMatch(source, /location\.hash|useSearchParams|router\.push\([^)]*#/u, "no fragment/query handoff for the direct operation");
  const style = opsCss();
  // #fff in .mapPoint predates this change; nothing new may appear.
  assert.doesNotMatch(style.replace(/#fff/g, ""), /#[0-9a-fA-F]{3,8}/u, "no new color literals");
});
