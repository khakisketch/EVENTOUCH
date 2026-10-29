// The client kept the participant home at its initial simple shape: a QR is
// not handed to every participant, so the landing is the activity entries and
// the ticket opens from the first one. The entry QR stays on the ticket
// screen, where the desk actually scans it.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const landing = read("apps/web/app/event/[slug]/home/AttendeeHomeLanding.tsx");
const shell = read("apps/web/app/event/[slug]/home/HomeShell.tsx");
const ticketView = read("apps/web/app/event/[slug]/ticket/TicketView.tsx");

test("the landing is the simple entry list and prints no QR", () => {
  assert.match(landing, /styles\.menuBoard/u);
  assert.match(landing, /HOME_MENUS\.map/u);
  // The home keeps the simple fixed menu: the ticket need reads on the
  // tile that needs it, never as a notice line above the entries.
  assert.match(landing, /menuNeedTicket/u);
  assert.match(landing, /티켓 필요/u);
  // No QR is drawn on the landing itself: an attendee without a ticket must
  // still see a complete home.
  assert.doesNotMatch(landing, /QRCode/u);
  assert.doesNotMatch(landing, /styles\.entryTicket/u);
  assert.doesNotMatch(landing, /내 입장 티켓/u);
});

test("the ticket stays one tap away in the first entry", () => {
  assert.match(landing, /\{ key: "qr", label: "모바일 티켓", category: "Utility" \}/u);
  assert.match(landing, /\{ key: "qr"/u);
  assert.match(shell, /activeTab === "qr" && <TicketView slug=\{slug\} \/>/u);
  // The ticket itself is unchanged: the desk scans the QR on that screen.
  assert.match(ticketView, /<QRCode value=\{state\.ticket\} size=\{220\} \/>/u);
});

test("the landing keeps one screen: ticket need reads on the tile itself", () => {
  // The customer decided the home stays a simple six-entry list, and the
  // web audit keeps the whole home inside the first screen on a phone. A
  // notice line above the entries pushed the tiles below the fold, so the
  // ticket need reads on the tile that needs it instead.
  assert.match(landing, /hasTicket: boolean/u);
  assert.match(landing, /menuNeedTicket/u);
  assert.match(landing, /티켓 필요/u);
  assert.doesNotMatch(landing, /styles\.ticketNeeded/u);
  assert.doesNotMatch(landing, /티켓이 있어야 일부 기능/u);
  assert.match(shell, /hasTicket=\{state\.hasTicket && Boolean\(state\.ticketToken\)\}/u);
});

test("an attendee without a ticket is told how to get one", () => {
  assert.match(shell, /티켓이 확인되지 않습니다\. 신청 후 이용하세요\./u);
  assert.match(shell, /참가 신청하기/u);
  assert.match(shell, /\/register/u);
});

test("the ticket bearer still lives in tab memory only", () => {
  // The token is read from tab memory and kept in the shell's state; it is
  // never written to persistent storage.
  assert.match(shell, /window\.sessionStorage\.getItem\(STORAGE_PREFIX \+ slug\)/u);
  assert.match(shell, /ticketToken: ticket/u);
  assert.doesNotMatch(shell, /localStorage/u);
});
