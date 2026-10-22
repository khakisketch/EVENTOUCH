// Attendee ticket and recovery: the QR is the hero, the recovery path is
// one step at a time, and no state is a dead end.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const ticket = read("apps/web/app/event/[slug]/ticket/TicketView.tsx");
const recover = read("apps/web/app/event/[slug]/ticket/recover/RecoverForm.tsx");

test("the ticket screen points at what the attendee has to do", () => {
  assert.match(ticket, /입장할 때 이 QR을 보여 주세요/u);
  // The QR is the thing shown at the desk, so nothing else may look like the
  // primary action on the same card.
  assert.match(ticket, /className=\{styles\.buttonSecondary\} href=\{`\/event\/\$\{encodeURIComponent\(slug\)\}\/engage`\}/u);
  assert.doesNotMatch(ticket, /className=\{styles\.buttonPrimary\} href=\{`\/event\/\$\{encodeURIComponent\(slug\)\}\/engage`\}/u);
});

test("a missing or failed ticket always offers a way forward", () => {
  assert.match(ticket, /ticket\/recover/u);
  assert.match(ticket, /다시 신청하기/u);
  assert.match(ticket, /행사 안내로/u);
});

test("the recovery flow shows one step at a time", () => {
  assert.match(recover, /1\. 신청할 때 입력한 연락처로 인증번호를 받으세요/u);
  assert.match(recover, /2\. 문자로 받은 인증번호를 입력해 주세요/u);
  assert.match(recover, /10분 안에 입력해 주세요/u);
  assert.match(recover, /연락처 바꾸기/u);
  assert.match(recover, /내 티켓 열기/u);
});
