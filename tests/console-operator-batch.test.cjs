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
  assert.match(draws, /`draw-program-\$\{program\.id\}`/u);
});

test("group assignment states its visible-only scope when rows are hidden", () => {
  const list = read("console/events/[id]/participants/ParticipantList.tsx");
  assert.match(list, /필터 밖 \$\{hiddenSelectedCount\}명/u);
  assert.match(list, /승인·그룹은 현재 필터만, 메시지는 전체 선택/u);
  assert.match(list, /화면 밖에서 선택한 \$\{hiddenSelectedCount\}명은 이번 지정에 포함되지 않습니다/u);
});

test("the report analysis names the approval backlog and the create dialog warns", () => {
  const reports = read("console/events/[id]/reports/ReportsWorkspace.tsx");
  assert.match(reports, /<span>승인 대기 \(명\)<\/span>/u);
  assert.match(reports, /승인 대기 \{pendingApproval\}명이 남아 있습니다/u);
  assert.match(reports, /participants\?status=PENDING/u);
});

test("draw and stage actions name their own prerequisites", () => {
  const draws = read("console/events/[id]/draws/DrawsWorkspace.tsx");
  assert.match(draws, /실행 전제: \{runBlockers\.join\(" · "\)\}/u);
  assert.match(draws, /!program\.published \? "결과 공개 필요"/u);
  assert.match(draws, /!screenEnabled \? "행사장 출력 꺼짐"/u);
  assert.match(draws, /moduleNeedsPublishing \? "무대 프로그램 공개 필요"/u);
  assert.match(draws, /aria-describedby=\{runBlockers\.length \? runBlockerId : undefined\}/u);
  assert.match(draws, /무대 터치 실행 전제: \{stageOnlyBlockers\.join\(" · "\)\}/u);
  assert.match(draws, /결과 공개 허용/u);
});

test("message templates use delivery families and leave photo type to composition", () => {
  const messages = read("console/events/[id]/messages/MessagingWorkspace.tsx");
  const templateChannel = messages.slice(messages.indexOf('id="template-channel"'));
  assert.match(templateChannel, /options=\{TEMPLATE_CHANNEL_CHOICES\}/u);
  for (const channel of ['SMS', 'ALIMTALK']) assert.match(messages, new RegExp(`value: "${channel}"`));
  assert.match(messages, /TEMPLATE_CHANNEL_CHOICES = MESSAGE_CHANNEL_CHOICES\.map/u);
  assert.match(messages, /사진은 발송할 때 첨부합니다\. 내용과 사진에 따라 문자 유형이 자동 결정됩니다/u);
  // A failed send has no retry path on the server, so the row must say what
  // to do instead of leaving the operator without a next step.
  assert.match(messages, /발송이 실패했습니다\. 행의 내용·대상 불러오기로 새 발송을 준비하세요/u);
});

test("the stage-board output says when a selection is not applied yet", () => {
  // Reopened 2026-11-20: the output picker moved from 입장·스태프 to 현장 모드.
  const live = read("console/events/[id]/live/LivePanes.tsx");
  assert.match(live, /선택한 출력은 아직 적용되지 않았습니다/u);
  assert.match(live, /displayChoice !== "" && displayChoice !== currentKey/u);
});

test("ending a stage protects participant work and explains the report capture basis", () => {
  const settings = read("console/events/[id]/settings/SettingsWorkspace.tsx");
  assert.match(settings, /nextStage === "ENDED" \? \(/u);
  assert.match(settings, /승인 대기 등 필요한 참가자 처리는 종료 전에 마치세요/u);
  assert.match(settings, /결과 보고서는 생성 시점 값으로 고정됩니다/u);
  assert.match(settings, /종료 뒤 마감 집계를 생성·검토하고 동결할 수 있으며/u);
});
