// Contracts for the operator console evaluation round: irreversible actions
// ask first, counts name their basis, and control names match what they do.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "apps", "web", "app");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("a prize payout asks before an irreversible step", () => {
  const rewards = read("console/events/[id]/rewards/RewardsWorkspace.tsx");
  // The server refuses a cancel once the prize is received, so the single
  // irreversible action must confirm like its neighbour does.
  assert.match(rewards, /처리한 뒤에는 취소할 수 없습니다/u);
  assert.match(rewards, /ConsoleConfirm/u);
  assert.doesNotMatch(rewards, /window\.confirm/u);
});

test("the roster count names that it includes cancellations", () => {
  const list = read("console/events/[id]/participants/ParticipantList.tsx");
  // The overview and the report count "취소 제외 등록"; the roster said
  // "전체 N명" for a different set, so the two numbers looked inconsistent.
  assert.match(list, /전체 \$\{state\.people\.length\}명\(취소 포함\)/u);
  assert.match(list, /전체 \$\{state\.people\.length\}명\(취소 포함\)/u);
});

test("the roster search is named for what it actually searches", () => {
  const list = read("console/events/[id]/participants/ParticipantList.tsx");
  assert.match(list, /id="roster-search-label">이름·소속·연락처 검색</u);
  assert.doesNotMatch(list, /id="roster-search-label">참가자 이름 검색/u);
});
