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
  assert.match(landing, /<nav className=\{L\.menus\} aria-label="참가 메뉴">/u);
  // Preview and attendee use the same feature guard; legacy default order
  // and the mandatory ticket are exercised by web:home-menus:audit.
  assert.match(landing, /!unavailable\.includes\(menu\.key\)/u);
  assert.match(landing, /const ordered = \["qr", \.\.\.menuSettings\.order\]/u);
  // Ticket need reads on the corresponding entry, not in a detached banner.
  assert.match(landing, /L\.needTicket/u);
  assert.match(landing, /티켓 필요/u);
  // No QR is drawn on the landing itself: an attendee without a ticket must
  // still see a complete home.
  assert.doesNotMatch(landing, /QRCode/u);
  assert.doesNotMatch(landing, /styles\.entryTicket/u);
  assert.doesNotMatch(landing, /내 입장 티켓/u);
});

test("the ticket stays one tap away in the first entry", () => {
  assert.match(landing, /\{ key: "qr", label: "모바일 티켓", category: "Utility" \}/u);
  assert.match(landing, /HOME_MENUS: Menu\[\] = \[\s*\{ key: "qr"/u);
  assert.match(landing, /onOpen=\{onOpen \? \(\) => onOpen\(menu\.key\)/u);
  assert.match(landing, /onClick=\{\(\) => onOpen\?\.\("qr"\)\}/u, "the ticket card opens the ticket");
  assert.match(shell, /onOpen=\{openTab\}/u);
  assert.match(shell, /activeTab === "qr" && <TicketView slug=\{slug\} initialTicket=\{state\.ticketToken\} \/>/u);
  // The ticket itself is unchanged: the desk scans the QR on that screen.
  assert.match(ticketView, /<QRCode value=\{state\.ticket\} size=\{220\} \/>/u);
});

test("ticket need reads on the entry itself while additional paths may scroll", () => {
  assert.match(landing, /hasTicket: boolean/u);
  assert.match(landing, /L\.needTicket/u);
  assert.match(landing, /티켓 필요/u);
  assert.doesNotMatch(landing, /styles\.ticketNeeded/u);
  assert.doesNotMatch(landing, /티켓이 있어야 일부 기능/u);
  assert.match(shell, /hasTicket=\{state\.hasTicket && Boolean\(state\.ticketToken\)\}/u);
});

test("an attendee without a ticket is told how to get one", () => {
  assert.match(shell, /이 탭에서 티켓이 확인되지 않습니다\./u);
  assert.match(shell, /신청을 완료한 브라우저 탭/u);
  assert.match(shell, /행사 안내 확인/u);
  assert.match(shell, /처음 신청하기/u);
  assert.match(shell, /\/register/u);
});

test("the ticket bearer still lives in tab memory only", () => {
  // The token is read from tab memory and kept in the shell's state; it is
  // never written to persistent storage.
  assert.match(shell, /window\.sessionStorage\.getItem\(STORAGE_PREFIX \+ slug\)/u);
  // A rejected link and an explicit session selection must take precedence
  // over the old tab bearer; the normal path retains the same order.
  assert.match(shell, /const ticket = rejected \? REJECTED_TICKET_BEARER : explicitSession \? "" : fromLink \|\| getAllowedTicketForTab\(slug\) \|\| ticketRef\.current \|\| \(storageUsable \? readStoredTicket\(slug\) : ""\)/u);
  assert.match(shell, /const resolvedTicket = ticket \|\| text\(ticketData\.participant\.ticket\)/u);
  assert.match(shell, /ticketToken: resolvedTicket/u);
  assert.match(shell, /ticketRef\.current = resolvedTicket/u);
  assert.match(shell, /ticketSlugRef\.current !== slug/u);
  assert.doesNotMatch(shell, /localStorage/u);
  assert.doesNotMatch(ticketView, /localStorage\./u);
});
