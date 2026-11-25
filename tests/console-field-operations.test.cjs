// Reopened 2026-11-20 (입장 관리 + 현장 모드): the screen is now the three-step
// "입장을 받을 준비" flow (desks, staff on duty, scanning on the staff phone) with
// booths optional. The 전광판 출력 block and the 2-card KPI strip are gone; the
// display output lives in 현장 모드 (tests/web-live-mode-composition.test.cjs).
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
  // Reopened 2026-11-25: assigning staff is optional, so its header entry stays quiet.
  assert.match(source, /id="ops-staff-assign"\s+type="button"\s+variant="ghost"/u, "assignment is never the page's primary");
  assert.match(source, /window\.addEventListener\("hashchange", applyHash\)/u, "later fragments still unfold their preset");
});

test("same-day and before-the-day sections split through one summary slot", () => {
  const source = ops();
  assert.match(source, /<StepPill n=\{1\}/u, "step 1 states its status in the description slot");
  assert.match(source, /<StepPill n=\{2\} tone=\{assignableTargets === 0 \? "wait" : assignments\.length \? "ok" : "day"\}/u, "step 2 is optional: it never turns amber");
  assert.match(source, /<StepPill n=\{3\} tone="day">/u);
  assert.doesNotMatch(source, /kpiStrip|kpiCard|현장 운영 요약/u, "no big-number strip on a work screen");
  assert.match(source, /description=\{boothSummary\}/u);
  assert.match(source, /<summary[^>]*>인증 방식 · \{modeValueLabel\}<\/summary>/u);
  assert.match(source, /<summary[^>]*>부스 지도 · \{mapStatusText\}<\/summary>/u);
  assert.doesNotMatch(source, /ops-display|displaySummary|전광판 출력/u, "the display output moved to 현장 모드");
  assert.match(source, /`운영 \$\{boothOpenCount\} \/ 전체 \$\{booths\.length\}`/u);
  assert.doesNotMatch(source, /modeSummary|mapSummary/u, "the folded summaries alone carry preset state");
  for (const id of ["ops-desks", "ops-staff", "ops-scan", "ops-booths", "ops-booth-mode", "ops-booth-map"]) {
    assert.match(source, new RegExp(`headingId="${id}"`), `the ${id} section keeps its anchor`);
  }
  assert.doesNotMatch(source, /console\/events\/\$\{[^}]*\}\/(?!(?:page|programs)\b)[a-z-]+`(?!\/)/u, "handoffs use only the existing page and participation routes");
});

test("presets start folded with current values and anchor recovery", () => {
  const source = ops();
  // Reopened 2026-11-24 (owner: 진행 중 데스크 보드): the live-only setup fold is the third disclosure.
  assert.equal(source.match(/<details/g)?.length ?? 0, 3, "only the two presets and the live setup fold fold");
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
  assert.match(source, /이 기기에서 직접 처리하면 배정이 없어도 됩니다\./u);
  assert.match(source, /배정하려면 먼저 데스크나 부스를 만드세요/u);
  assert.doesNotMatch(source, /진행 중으로 전환하려면 입장 데스크에 스태프를 배정/u, "going live no longer needs an assignment");
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
    "staff.assign",
    "staff.unassign",
  ]) {
    assert.match(source, new RegExp(command.replace(".", "\\.")), `${command} still rides the command path`);
  }
  assert.doesNotMatch(source, /"display\.set"/u, "the display command is sent from 현장 모드 only");
  assert.doesNotMatch(source, /localStorage|sessionStorage/u);
  assert.match(source, /eventouch:shell-reload/u);
});
