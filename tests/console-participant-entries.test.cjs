// Participant roster entries: a hand-written registration is a first-class
// path next to the file import, and the roster says which way a participant
// was collected.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("the roster offers hand-written registration next to the file tool", () => {
  const list = read("apps/web/app/console/events/[id]/participants/ParticipantList.tsx");
  assert.match(list, /참가자 추가/u);
  assert.match(list, /파일로 등록/u);
  assert.match(list, /목록 CSV · \{visiblePeople\.length\}명/u);
  // The file import is a tool, not the only door into the roster.
  assert.match(list, /participants\/import/u);
  // Adding one participant posts the ordinary command path with a stable id.
  assert.match(list, /command: "participant\.create"/u);
  assert.match(list, /pendingAddRef/u);
  assert.match(list, /writeBusyRef\.current/u);
});

test("the add dialog keeps the working fields first and names the collection mode", () => {
  const list = read("apps/web/app/console/events/[id]/participants/ParticipantList.tsx");
  assert.match(list, /title="참가자 추가"/u);
  assert.match(list, /htmlFor="participant-add-name"/u);
  assert.match(list, /htmlFor="participant-add-phone"/u);
  assert.match(list, /id="participant-add-type"/u);
  assert.match(list, /<option value="PRE">사전 등록<\/option>/u);
  assert.match(list, /<option value="ONSITE">현장 등록<\/option>/u);
  assert.match(list, /사전 등록은 이름이 이미 정해진 명단/u);
});

test("an empty roster names the ways to fill it instead of only waiting", () => {
  const list = read("apps/web/app/console/events/[id]/participants/ParticipantList.tsx");
  assert.match(list, /참가자를 직접 추가하거나 파일로 등록할 수 있습니다/u);
  assert.match(list, /행사 설정의 참가 접수를 열어 주세요/u);
  assert.match(list, /참가 신청 링크 복사/u);
});

test("the server records how a participant was collected", () => {
  const server = read("server/commands/participants.js");
  assert.match(server, /requestedType === 'PRE' \? 'PRE' : 'ONSITE'/u);
  assert.match(server, /등록 방식을 확인하세요/u);
});

test("waiting applications can be settled in one action", () => {
  const list = read("apps/web/app/console/events/[id]/participants/ParticipantList.tsx");
  // The server applies one status to many ids; the roster finally uses it.
  assert.match(list, /id="roster-approve-selected"/u);
  assert.match(list, /command: "participant\.status"/u);
  assert.match(list, /payload: \{ ids, status: "APPROVED" \}/u);
  assert.match(list, /status === "PENDING"/u);
  assert.match(list, /명을 승인했습니다/u);
});
