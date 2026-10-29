// One grammar for irreversible console commands: the screen states the
// effect and the operator confirms in place. Dialog dismissal gates keep the
// shared ConsoleDialog/canClose contract and stay native.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.resolve(__dirname, "..", "apps", "web", "app");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");
const consoleRoot = path.join(appRoot, "console");

function consoleFiles(dir = consoleRoot, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) consoleFiles(full, found);
    else if (entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

const GATE = /canClose|dirty|UNCONFIRMED_WRITE_CLOSE_MESSAGE|작성 중|확인하지 못했|이동할까요|열어두|유실|입력한 행사 정보|입력 내용이 바뀝/;

test("the shared confirmation announces itself and takes focus", () => {
  const component = read("console/console-ui/ConsoleConfirm.tsx");
  assert.match(component, /aria-label="실행 확인"/u);
  assert.match(component, /role="group"/u);
  assert.match(component, /confirmRef\.current\?\.focus\(\)/u);
  assert.match(component, /onCancel/u);
  assert.match(component, /disabled=\{busy\}/u);
});

test("no console command still confirms through a native dialog", () => {
  const offenders = [];
  const dirtyDismissals = [];
  for (const file of consoleFiles()) {
    const relative = path.relative(appRoot, file);
    const lines = read(relative).split("\n");
    let scope = "";
    lines.forEach((line, index) => {
      const fn = line.match(/^\s*function (\w+)\s*\(/);
      if (fn) scope = fn[1];
      if (!line.includes("window.confirm")) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      if (GATE.test(line)) return;
      // Dirty-dismissal guards only abandon unsaved input; they never run an
      // effectful operation. Allowed in the team permission editor, where the
      // same DIRTY_CLOSE_MESSAGE constant names the discarded scope draft —
      // and only inside the three switch paths that would drop it.
      if (
        relative === "console/team/TeamWorkspace.tsx" &&
        /window\.confirm\(DIRTY_CLOSE_MESSAGE\)/.test(line) &&
        ["openEditor", "changeEvent", "cancelEdit"].includes(scope)
      ) {
        dirtyDismissals.push(`${relative}:${index + 1} ${scope}`);
        return;
      }
      offenders.push(`${relative}:${index + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], "effectful commands must confirm in place");
  assert.deepEqual(
    [...new Set(dirtyDismissals.map((entry) => entry.split(" ").pop()))].sort(),
    ["cancelEdit", "changeEvent", "openEditor"],
    "the team editor guards every dirty scope switch, and only those"
  );
});

test("every screen that changes something irreversible uses the shared confirmation", () => {
  const cases = [
    ["console/events/[id]/messages/MessagingWorkspace.tsx", /발송 요청|실제 발송 시도/u],
    ["console/events/[id]/rewards/RewardsWorkspace.tsx", /처리한 뒤에는 취소할 수 없습니다/u],
    ["console/events/[id]/participants/ParticipantList.tsx", /취소하면 발급된 티켓은 무효화/u],
    ["console/events/[id]/draws/DrawsWorkspace.tsx", /추첨하고 전광판에 표시/u],
    ["console/events/[id]/programs/ProgramsWorkspace.tsx", /퀴즈 정답을 공개할까요/u],
    ["console/events/[id]/content/ContentWorkspace.tsx", /공지를 삭제할까요/u],
    ["console/events/[id]/operations/OperationsWorkspace.tsx", /인증 방식을/u],
    ["console/events/[id]/photos/EvidencePhotosWorkspace.tsx", /보관함 분류를/u],
    ["console/events/[id]/page/ThemeWorkspace.tsx", /게시하기/u],
    ["console/team/TeamWorkspace.tsx", /ISSUED_LINK_LOSS_MESSAGE/u],
    ["console/clients/ClientsList.tsx", /removeSummary/u],
  ];
  for (const [file, pattern] of cases) {
    const source = read(file);
    assert.match(source, /ConsoleConfirm/u, `${file} must use the shared confirmation`);
    assert.match(source, pattern, `${file} must state its effect before confirming`);
  }
});

test("the stage-draw work comes first and setup forms fold away", () => {
  const draws = read("console/events/[id]/draws/DrawsWorkspace.tsx");
  assert.ok(
    draws.indexOf('headingId="draws-programs"') < draws.indexOf('headingId="draws-vote"'),
    "the live stage draw is the first section"
  );
  assert.match(draws, /id: "draws-programs", label: "무대 추첨"/u);
  assert.match(draws, /setupDetails/u);
  assert.match(draws, /추첨 프로그램 설정/u);
  assert.match(draws, /룰렛 운영 설정/u);
  assert.match(draws, /럭키번호 범위 설정/u);
});

test("the roster keeps one-tap approval and folds the rest of the row tools", () => {
  const list = read("console/events/[id]/participants/ParticipantList.tsx");
  const css = read("console/events/[id]/participants/participants.module.css");
  assert.match(list, /승인/u);
  // The toggle says what it opens, and names the participant for a screen
  // reader: the row list is read one row at a time.
  assert.match(list, /상세/u);
  // The accessible name has to contain the visible label (WCAG label in name).
  assert.match(list, /aria-label=\{`\$\{person\.name\} 참가자 상세`\}/u);
  assert.match(list, /const detailsOpen = toolsOpenId === person\.id/u);
  assert.match(list, /aria-expanded=\{detailsOpen\}/u);
  // The row no longer grows a card; details open in the roster inspector.
  // The toggle keeps its aria-expanded/id contract and the inspector owns
  // the same status/reward gates and cancel confirm.
  assert.match(list, /showRowActions \? \(/u);
  assert.match(list, /rosterInspector/u);
  assert.match(css, /\.participantActions \.rowToolsToggle \{\s*display: inline-flex;/u);
  assert.match(css, /\.participantDetails \{/u);
  assert.match(css, /\.rowConfirm \{\s*grid-column: 1 \/ -1;/u);
});

test("the import wizard shows its three steps from the first screen", () => {
  const wizard = read("console/events/[id]/participants/import/ImportWizard.tsx");
  assert.match(wizard, /importSteps/u);
  assert.match(wizard, /aria-label="명단 가져오기 단계"/u);
  assert.match(wizard, /"파일 선택", "열 연결", "검토 후 반영"/u);
  assert.match(wizard, /aria-current=\{state === "current" \? "step" : undefined\}/u);
});
