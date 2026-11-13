// Field-day operations console: desks lead with the running count as the one
// card, booths and the display state their status in the description slot, the
// before-the-day presets stay folded with their current value in the folded
// summary, and the screen reads as one page without a sidebar nav. UI-only:
// commands, copy volume and confirm grammar stay pinned.
// Source-only assertions; rendering rides the isolated console audit.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const WEB = path.join(__dirname, "..", "apps", "web");
const read = (relative) => fs.readFileSync(path.join(WEB, relative), "utf8");

const ops = () => read("app/console/events/[id]/operations/OperationsWorkspace.tsx");
const css = () => read("app/console/events/[id]/operations/operations.module.css");

test("the operations screen reads as one page: no sidebar nav, one primary entry to assignment", () => {
  const source = ops();
  assert.doesNotMatch(source, /ConsoleSectionNav|sectionLayout="sidebar"|activeSection|navPinRef/u, "the sidebar nav and its scroll spy are gone");
  assert.match(source, /id="ops-staff-assign"/u, "the handoff focus target survives");
  assert.match(source, /variant=\{gapTargets\.length && !archived \? "primary" : "ghost"\}/u, "the page owns one primary only while some place has no one on duty");
  assert.match(source, /window\.addEventListener\("hashchange", applyHash\)/u, "later fragments still unfold their preset");
});

test("same-day and before-the-day sections split through one summary slot", () => {
  const source = ops();
  assert.match(source, /<b>\{deskOpenCount\}<\/b><span>\/ \{desks\.length\} 가동<\/span>/u, "desks lead with the running count");
  assert.match(source, /description=\{boothSummary\}/u);
  assert.match(source, /<summary[^>]*>인증 방식 · \{modeValueLabel\}<\/summary>/u);
  assert.match(source, /<summary[^>]*>부스 지도 · \{mapStatusText\}<\/summary>/u);
  assert.match(source, /description=\{displaySummary\}/u, "display names the current same-day output");
  assert.match(source, /`현재 \$\{currentDisplayLabel\}`/u);
  assert.match(source, /`운영 \$\{boothOpenCount\} \/ 전체 \$\{booths\.length\}`/u);
  assert.doesNotMatch(source, /modeSummary|mapSummary/u, "the folded summaries alone carry preset state");
  for (const id of ["ops-desks", "ops-participation", "ops-booths", "ops-booth-mode", "ops-booth-map", "ops-display", "ops-staff"]) {
    assert.match(source, new RegExp(`headingId="${id}"`), `the ${id} section keeps its anchor`);
  }
  assert.doesNotMatch(source, /console\/events\/\$\{[^}]*\}\/(?!(?:page|programs)\b)[a-z-]+`(?!\/)/u, "handoffs use only the existing page and participation routes");
});

test("presets start folded with current values and anchor recovery", () => {
  const source = ops();
  assert.equal(source.match(/<details/g)?.length ?? 0, 2, "only the two presets fold");
  assert.match(source, /<summary className=\{styles\.presetSummary\} data-disclosure-indicator="">인증 방식 · \{modeValueLabel\}<\/summary>/u);
  assert.match(source, /<summary className=\{styles\.presetSummary\} data-disclosure-indicator="">부스 지도 · \{mapStatusText\}<\/summary>/u);
  assert.match(source, /미게시/u, "an unposted map reads as 미게시 while folded");
  assert.match(source, /참가자 셀프 스캔/u, "the folded mode summary names the live value");
  assert.match(source, /useState\(\{ mode: false, map: false \}\)/u, "presets start folded on every viewport");
  assert.match(source, /open=\{presetOpen\.mode \|\| modeNeedsAttention\}/u);
  assert.match(source, /open=\{presetOpen\.map \|\| mapNeedsAttention \|\| mapUploadUncertain\}/u);
  assert.match(source, /hashchange/u, "preset deep links reveal their target");
  assert.match(source, /onToggle=\{\(event\) => setPresetOpen\(\(prev\)/u, "the operator can unfold either side by hand");
  const desksBody = source.slice(source.indexOf('headingId="ops-desks"'), source.indexOf('headingId="ops-booths"'));
  assert.doesNotMatch(desksBody, /<details/u, "desk start/stop never folds");
  const displayAt = source.indexOf('headingId="ops-display"');
  // Section-exact bounds: the display ConsoleSection opens on the same line
  // as its heading id and closes at the next section end, so the booth
  // sections below never leak into this slice.
  const displayOpen = source.lastIndexOf('<ConsoleSection', displayAt);
  const displayClose = source.indexOf('</ConsoleSection>', displayAt);
  assert.ok(displayOpen >= 0 && displayClose > displayOpen, 'display section bounds resolve');
  const displayBody = source.slice(displayOpen, displayClose);
  assert.doesNotMatch(displayBody, /<details/u, "display apply never folds");
  const style = css();
  assert.match(style, /\.presetSummary \{[\s\S]*?min-height: 44px;/u, "folded summaries keep the 44px touch floor");
  assert.match(style, /\.presetFold\[open\] \.presetSummary \{/u);
});

test("danger-adjacent presets keep their in-place confirm grammar and copy", () => {
  const source = ops();
  assert.match(source, /인증 방식을/u);
  assert.match(source, /confirmLabel="인증 방식 바꾸기"/u);
  assert.match(source, /게시된 부스 지도를 내릴까요\?/u);
  assert.match(source, /confirmLabel="게시 내리기"/u);
  assert.match(source, /초안이 아직 게시되지 않았습니다\./u);
  assert.match(source, /인증 \$\{booth\.used\}회 · 잔여 제한 없음/u, "booth load copy is untouched");
  assert.equal(source.match(/window\.confirm/g)?.length ?? 0, 3, "only the dialog dismissal gates ask natively");
});

test("staff assignment keeps its guidance and its release path", () => {
  const source = ops();
  assert.match(source, /배정된 스태프가 없습니다\. 진행 중으로 전환하려면 입장 데스크에 스태프를 배정하세요\./u);
  assert.match(source, /배정하려면 먼저 데스크나 부스를 만드세요\./u);
  assert.match(source, /진행 중 전환 조건: 등록 데스크 \{desks\.length\}개 · 데스크 배정 \{deskStaffCount\}건/u);
  assert.match(source, /staff\.assign/u);
  assert.match(source, /staff\.unassign/u);
  assert.match(source, />\s*해제\s*<\/button>/u, "the release affordance stays on the row");
});

test("display apply names its busy state on the button", () => {
  // 현장 마감 사유: 전광판 적용은 공용 작성자 잠금을 쓰므로 버튼 문구가
  // '적용 중입니다'로 바뀌어야 대기 상태가 보인다. 명령·권한 게이트 불변.
  const source = ops();
  assert.match(source, /\{busy \? "적용 중입니다" : displayChoice/);
});

test("no server contract moves with this change", () => {
  const source = ops();
  for (const command of [
    "desk.save",
    "desk.set-open",
    "booth.save",
    "booth.mode",
    "booth.map.save",
    "booth.map.publish",
    "booth.map.unpublish",
    "display.set",
    "staff.assign",
    "staff.unassign",
  ]) {
    assert.match(source, new RegExp(command.replace(".", "\\.")), `${command} still rides the command path`);
  }
  assert.doesNotMatch(source, /localStorage|sessionStorage/u);
  assert.match(source, /eventouch:shell-reload/u);
});
