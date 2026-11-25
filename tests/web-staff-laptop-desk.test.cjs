"use strict";

// Laptop desk (owner decision 2026-11-25: "복잡한 과정은 벗기고 쓰기 좋은 화면"): an operator
// opens a desk from the console without being assigned to it, a USB scanner works with no field
// focused, the wide screen keeps a result until the next ticket, and the name tag can print on
// entry. The scanner and scope rules run the real modules.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("../apps/web/node_modules/typescript");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
function load(file, requires = {}) {
  const js = ts.transpileModule(read(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const sandbox = { exports: {}, require: (name) => { assert.ok(name in requires, `unexpected import ${name}`); return requires[name]; } };
  vm.runInNewContext(js, sandbox);
  return sandbox.exports;
}
const scanner = load("apps/web/app/staff/scanner-input.ts");
// Values built inside the vm context have their own prototypes; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const capabilities = load("apps/web/lib/event-capabilities.ts");
const { buildStaffScopes } = load("apps/web/app/staff/staff-scope.ts", { "../../lib/event-capabilities": capabilities });
const work = read("apps/web/app/staff/StaffEventWork.tsx");

const CODES = { ":": ["Semicolon", true], "-": ["Minus", false], "_": ["Minus", true], "/": ["Slash", false], "?": ["Slash", true], "=": ["Equal", false], ".": ["Period", false] };
function keys(text, { start = 1000, gap = 10, terminator = "Enter" } = {}) {
  const list = [...text].map((char) => {
    if (/[a-z]/.test(char)) return [`Key${char.toUpperCase()}`, false];
    if (/[A-Z]/.test(char)) return [`Key${char}`, true];
    if (/[0-9]/.test(char)) return [`Digit${char}`, false];
    return CODES[char];
  });
  const typed = [...text];
  if (terminator) { list.push([terminator, false]); typed.push(terminator); }
  return list.map(([code, shiftKey], index) => ({ key: typed[index], code, shiftKey, ctrlKey: false, metaKey: false, altKey: false, timeStamp: start + index * gap }));
}
const feed = (read_, events) => plain(events.map(read_).filter((value) => value !== null));

test("a scanner burst becomes the exact ticket, also with a Korean input method or Caps Lock", () => {
  const ticket = "ET:event-1:T-aB3_x9";
  assert.deepEqual(feed(scanner.createScanBuffer(), keys(ticket)), [ticket]);
  assert.deepEqual(feed(scanner.createScanBuffer(), keys(ticket, { terminator: "Tab" })), [ticket]);
  const url = "http://host/e/x/ticket?ticket=T-abc123";
  assert.deepEqual(feed(scanner.createScanBuffer(), keys(url)), [url]);
  const hangul = keys(ticket).map((key) => key.code === "Enter" ? key : { ...key, key: key.code.startsWith("Key") ? "ㄷ" : "Process" });
  assert.deepEqual(feed(scanner.createScanBuffer(), hangul), [ticket], "rebuilt from the physical keys");
  const capsed = keys(ticket).map((key) => ({ ...key, key: /^[a-z]$/i.test(key.key) ? (key.shiftKey ? key.key.toLowerCase() : key.key.toUpperCase()) : key.key, getModifierState: () => true }));
  assert.deepEqual(feed(scanner.createScanBuffer(), capsed), [ticket]);
  // Shift keys arrive between characters and must not end the burst.
  const withShift = keys(ticket).flatMap((key) => key.shiftKey ? [{ ...key, code: "ShiftLeft" }, key] : [key]);
  assert.deepEqual(feed(scanner.createScanBuffer(), withShift), [ticket]);
});

test("ordinary typing, shortcuts and stale bursts never submit", () => {
  assert.deepEqual(feed(scanner.createScanBuffer(), keys("hong")), []);
  assert.deepEqual(feed(scanner.createScanBuffer(), keys("T-1")), [], "too short to be a ticket");
  const read_ = scanner.createScanBuffer(100);
  const half = keys("ET:event", { terminator: null });
  const rest = keys(":T-abcdef", { start: 5000 });
  assert.deepEqual(feed(read_, [...half, ...rest]), [], "a pause starts over");
  const shortcut = keys("ET:event-1:T-abc");
  shortcut[3] = { ...shortcut[3], ctrlKey: true };
  assert.deepEqual(feed(scanner.createScanBuffer(), shortcut), []);
});

const events = [{ id: "e1", name: "행사", stage: "LIVE", features: ["stamp"] }, { id: "e2", name: "끝난 행사", stage: "ENDED" }];
const workspace = { desks: [{ id: "d1", name: "정문", action: "IN", open: true }, { id: "d2", name: "후문", action: "OUT", open: false }], booths: [], assignments: [] };
const workspaces = { e1: workspace, e2: workspace };

test("an operator opens every desk without an assignment; permission and stage still limit it", () => {
  const owner = buildStaffScopes(events, workspaces, { viewer: { id: "a", role: "AGENCY" }, memberships: [] });
  assert.deepEqual(plain(owner.map((scope) => scope.eventId)), ["e1"], "ended events are not field work");
  assert.deepEqual(plain(owner[0].desks.map((desk) => desk.id)), ["d1", "d2"]);
  assert.equal(owner[0].operator, true);
  assert.deepEqual(plain(owner[0].assignments.map((item) => item.targetId)), ["d1", "d2"]);
  const manager = (write) => buildStaffScopes(events, workspaces, { viewer: { id: "m", role: "MANAGER" }, memberships: [{ accountId: "m", eventId: "e1", write }] });
  assert.equal(manager(["onsite"])[0].desks.length, 2);
  assert.equal(manager(["messages"]).length, 0, "no field permission, no desks");
});

test("a staff account still sees only what it was assigned", () => {
  const staff = { viewer: { id: "s", role: "STAFF" } };
  assert.equal(buildStaffScopes(events, workspaces, staff).length, 0);
  const assigned = { e1: { ...workspace, assignments: [{ id: "as1", type: "DESK", targetId: "d1" }] } };
  const scope = buildStaffScopes([events[0]], assigned, staff)[0];
  assert.deepEqual(plain(scope.desks.map((desk) => desk.id)), ["d1"]);
  assert.equal(scope.operator, false);
});

test("the desk screen: scanner without focus, result held on wide screens, auto print on entry", () => {
  assert.match(work, /window\.addEventListener\("keydown", onKey, true\)/u);
  assert.match(work, /<ScannerKeys onScan=\{onScannerCode\} \/>/u);
  // A held result (unconfirmed, locked or needing a decision) refuses the next scan.
  const handler = work.slice(work.indexOf("function onScannerCode"), work.indexOf("const resultPerson"));
  for (const hold of ["result.uncertain", "writeLocked", "pendingScanRef.current", "printPending", "rewardHold", "!ready"]) assert.ok(handler.includes(hold), `scanner waits on ${hold}`);
  // Reopened 2026-11-25: the console screen returns to waiting by itself; a laptop offers no camera.
  assert.match(work, /const holdForNextScan = wide && !cameraMounted && !embedded;/u);
  assert.match(work, /const laptop = wide && finePointer;/u);
  assert.match(work, /const cameraOffered = !laptop && !selfBooth && !noCamera;/u);
  assert.match(work, /\{autoMs && !holdForNextScan && !printPending \? <AutoAdvance/u);
  assert.match(work, /setPrintJob\(autoPrintRef\.current && isDesk && !recordStatus && scanAction === "IN" && participantId/u, "only a fresh entry prints by itself");
  assert.match(work, /autoPrintRef\.current = autoPrint && wide;/u);
  assert.match(work, /--kiosk-printing/u, "silent printing is explained as a browser start option");
  assert.match(work, /const deskCameraTile = \(wide && activeTask === "desk"\) \|\| Boolean\(arrivalCard\.arrival\);/u, "on a laptop desk, or with a person on the card, the camera is a quiet fallback");
  assert.match(work, /\{!deskCameraTile && !cameraMounted && cameraOffered \? \(\s*<ProductButton/u);
  assert.doesNotMatch(work, /sessionStorage|localStorage/u, "the field screen keeps nothing in device storage");
});
