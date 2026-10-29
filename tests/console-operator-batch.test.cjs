// Contracts for the operator-console information batch: what an agency
// operator must see to finish a task without guessing.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "apps", "web", "app");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("a draw prize names its draw program and links to that program", () => {
  const rewards = read("console/events/[id]/rewards/RewardsWorkspace.tsx");
  // The prize points at a draw program (source.programId), not at a module:
  // looking the name up in the module list hid every program name.
  assert.match(rewards, /workspace\.drawPrograms/);
  assert.match(rewards, /drawTitles\.set\(program\.id, text\(program\.name/u);
  assert.doesNotMatch(rewards, /module\.type === "draw" && typeof module\.id === "string"/u);
  assert.match(rewards, /drawProgramId: programId/);
  // The link must land on the program row, not the section top.
  assert.match(rewards, /#draw-program-\$\{encodeURIComponent\(reward\.drawProgramId\)\}/u);
  const draws = read("console/events/[id]/draws/DrawsWorkspace.tsx");
  assert.match(draws, /id=\{`draw-program-\$\{program\.id\}`\}/u);
});

test("group assignment states its visible-only scope when rows are hidden", () => {
  const list = read("console/events/[id]/participants/ParticipantList.tsx");
  assert.match(list, /숨김 \$\{hiddenSelectedCount\}명\(그룹 지정 제외\)/u);
  assert.match(list, /화면 밖에서 선택한 \$\{hiddenSelectedCount\}명은 이번 지정에 포함되지 않습니다/u);
});

test("the report analysis names the approval backlog and the create dialog warns", () => {
  const reports = read("console/events/[id]/reports/ReportsWorkspace.tsx");
  assert.match(reports, /<span>승인 대기 \(명\)<\/span>/u);
  assert.match(reports, /승인 대기 \{pendingApproval\}명이 남아 있습니다/u);
  assert.match(reports, /participants\?status=PENDING/u);
});

test("a blocked draw run states every missing prerequisite in one line", () => {
  const draws = read("console/events/[id]/draws/DrawsWorkspace.tsx");
  assert.match(draws, /실행 전제: \{runBlockers\.join\(" · "\)\}/u);
  assert.match(draws, /!program\.published \? "결과 공개 필요"/u);
  assert.match(draws, /!screenEnabled \? "행사장 출력 꺼짐"/u);
  assert.match(draws, /moduleNeedsPublishing \? "무대 프로그램 공개 필요"/u);
  assert.match(draws, /aria-describedby=\{runBlockers\.length \? runBlockerId : undefined\}/u);
});

test("message templates cover the channels a campaign can send, including MMS", () => {
  const messages = read("console/events/[id]/messages/MessagingWorkspace.tsx");
  const templateChannel = messages.slice(messages.indexOf('id="template-channel"'));
  assert.match(templateChannel, /<option value="SMS">/u);
  assert.match(templateChannel, /<option value="LMS">/u);
  assert.match(templateChannel, /<option value="MMS">MMS · 이미지<\/option>/u);
  assert.match(templateChannel, /<option value="ALIMTALK">/u);
  assert.match(templateChannel, /MMS 이미지는 발송할 때 첨부합니다/u);
  // A failed send has no retry path on the server, so the row must say what
  // to do instead of leaving the operator without a next step.
  assert.match(messages, /발송이 실패했습니다\. 행의 내용·대상 불러오기로 새 발송을 준비하세요/u);
});

test("the stage-board output says when a selection is not applied yet", () => {
  const operations = read("console/events/[id]/operations/OperationsWorkspace.tsx");
  assert.match(operations, /선택한 출력은 아직 적용되지 않았습니다/u);
  assert.match(operations, /displayChoice && displayChoice !== currentDisplayValue/u);
});

test("ending a stage protects participant work and explains the report capture basis", () => {
  const settings = read("console/events/[id]/settings/SettingsWorkspace.tsx");
  assert.match(settings, /nextStage === "ENDED" \? \(/u);
  assert.match(settings, /승인 대기 등 필요한 참가자 처리는 종료 전에 마치세요/u);
  assert.match(settings, /결과 보고서는 생성 시점 값으로 고정됩니다/u);
  assert.match(settings, /종료 뒤 마감 집계를 생성·검토하고 동결할 수 있으며/u);
});
