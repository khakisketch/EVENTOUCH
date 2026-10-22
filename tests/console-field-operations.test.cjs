// Field-day operations console: the same-day controls (desks, display,
// staff) stay unfolded and named as 지금 할 일, the before-the-day presets
// (auth mode, booth map) fold on phones with their current value in the
// folded summary, and the jump nav sticks on phones with a readable
// position. UI-only: commands, copy volume and confirm grammar stay pinned.
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

test("the jump nav stays shared, sticks on phones, and names the position", () => {
  const source = ops();
  assert.match(source, /<ConsoleSectionNav/u, "the existing section jump UI stays");
  assert.match(source, /\{ id: "ops-desks", label: "데스크" \}/u);
  assert.match(source, /\{ id: "ops-booths", label: "부스" \}/u);
  assert.match(source, /\{ id: "ops-staff", label: "스태프 배정" \}/u);
  assert.match(source, /className=\{styles\.navSticky\}/u, "the nav gains a sticky wrapper");
  assert.match(source, /현재 위치:/u, "the current position reads out next to the nav");
  assert.match(source, /IntersectionObserver/u, "the readout follows the section in view");
  assert.match(source, /getElementById\(id\)/u, "observation targets the existing anchors");
  const style = css();
  assert.match(style, /\.navSticky \{/u);
  assert.match(
    style,
    /@media \(max-width: 768px\) [\s\S]*?\.navSticky \{\s*position: sticky;/u,
    "stickiness applies on phones only; desktop renders the shared nav as before"
  );
  assert.match(style, /background: var\(--ground\)/u, "the pinned bar uses the page ground token");
  const added = style.slice(style.indexOf(".navSticky"));
  assert.doesNotMatch(added, /#[0-9a-fA-F]{3,8}/u, "no new color literals");
});

test("same-day and before-the-day sections split through one summary slot", () => {
  const source = ops();
  assert.match(source, /description=\{deskSummary\}/u);
  assert.match(source, /description=\{boothSummary\}/u);
  assert.match(source, /description=\{modeSummary\}/u);
  assert.match(source, /description=\{mapSummary\}/u);
  assert.match(source, /description=\{staffSummary\}/u);
  assert.match(source, /description="지금 할 일"/u, "display joins the same-day side");
  assert.match(source, /`지금 할 일 · 가동 \$\{deskOpenCount\} \/ 전체 \$\{desks\.length\}`/u);
  assert.match(source, /`지금 할 일 · 운영 \$\{boothOpenCount\} \/ 전체 \$\{booths\.length\}`/u);
  assert.match(source, /`지금 할 일 · 배정 \$\{assignments\.length\}명`/u);
  assert.match(source, /`사전 설정 · \$\{modeValueLabel\}`/u);
  assert.match(source, /`사전 설정 · \$\{mapStatusText\}`/u);
  for (const id of ["ops-desks", "ops-booths", "ops-booth-mode", "ops-booth-map", "ops-display", "ops-staff"]) {
    assert.match(source, new RegExp(`headingId="${id}"`), `the ${id} section keeps its anchor`);
  }
  assert.doesNotMatch(source, /console\/events\/\$\{[^}]*\}\/(?!page)[a-z-]+`(?!\/)/u, "no new menu or route");
});

test("presets fold on phones with the current value in the folded summary", () => {
  const source = ops();
  assert.equal(source.match(/<details/g)?.length ?? 0, 2, "only the two presets fold");
  assert.match(source, /<summary className=\{styles\.presetSummary\}>인증 방식 · \{modeValueLabel\}<\/summary>/u);
  assert.match(source, /<summary className=\{styles\.presetSummary\}>부스 지도 · \{mapStatusText\}<\/summary>/u);
  assert.match(source, /미게시/u, "an unposted map reads as 미게시 while folded");
  assert.match(source, /참가자 셀프 스캔/u, "the folded mode summary names the live value");
  assert.match(source, /window\.matchMedia\("\(max-width: 768px\)"\)/u, "phones start folded, desktop starts open");
  assert.match(source, /open=\{presetOpen\.mode\}/u);
  assert.match(source, /open=\{presetOpen\.map\}/u);
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
