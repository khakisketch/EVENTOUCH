"use strict";

// Field operations (현장 운영) composition, approved 2026-11-14 (design-review
// operations-options.html, scene A3). Reopened 2026-11-19 by the owner: rows carry
// a kind tile and the gap list is amber. Reopened 2026-11-20 (owner approved
// proposal C, design-review/onsite-ux-proposal.html): the screen is renamed
// 입장 관리 and reads as three steps (desks, staff on duty, scanning on the staff
// phone) with booths optional; the 전광판 출력 block and the two-card KPI strip are
// gone (the display moved to 현장 모드, big-number strips stay off work screens).
// Reopened 2026-11-24 (owner: 진행 중 데스크 보드): while the event is LIVE the page opens on a
// desk board (one card per desk) and the three setup steps fold to one line; before and
// after the event the three numbered steps are unchanged.
// Source-only except the desk-board arithmetic, which runs the real module.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("../apps/web/node_modules/typescript");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "console", "events", "[id]", "operations");
const read = (name) => fs.readFileSync(path.join(DIR, name), "utf8");

test("approved operations design stays locked", () => {
  const ops = read("OperationsWorkspace.tsx");
  const parts = read("LocationParts.tsx");
  const css = read("operations.module.css");

  // One page, no sidebar nav; anchors survive for deep links and handoffs.
  assert.doesNotMatch(ops, /ConsoleSectionNav|sectionLayout="sidebar"/u);
  for (const id of ["ops-desks", "ops-staff", "ops-scan", "ops-booths", "ops-booth-mode", "ops-booth-map"]) {
    assert.match(ops, new RegExp(`headingId="${id}"`), `${id} keeps its anchor`);
  }
  // Reopened 2026-11-20: the three steps, each with a status pill in the description slot.
  // Reopened 2026-11-25: assignment is optional, and scanning covers this device as well as staff phones.
  for (const [n, title] of [[1, "입장 데스크 만들기"], [2, "휴대폰 스태프 \\(선택\\)"], [3, "입장 처리"]]) {
    assert.match(ops, new RegExp(`title="${title}"[\\s\\S]*?<StepPill n=\\{${n}\\}`, "u"), `step ${n} is ${title}`);
  }
  assert.match(ops, /<DeviceFrame variant="phone"/u, "step 3 previews the staff scan screen on a phone");
  assert.match(ops, /\/staff`/u, "step 3 names the staff login address");
  assert.doesNotMatch(ops, /ops-display|ops-participation|전광판 출력|ScreenIcon/u, "display and participation work left for 현장 모드");
  assert.match(ops, /\{stampEnabled \? \(\s*<ConsoleSection\s+headingId="ops-booths"/u, "booths are an optional section, only with the feature on");
  assert.doesNotMatch(ops, /styles\.kpiStrip|styles\.kpiCard/u, "no big-number strip on a work screen");
  assert.equal(ops.match(/surface="panel"/g)?.length ?? 0, 0, "no panel around a list");
  // Reopened 2026-11-20 (디자인 시스템 적용): steps are white hairline cards; the step state is a StatusPill (amber = waiting on a person).
  assert.match(css, /\.stepSection\s*\{[^}]*border:\s*1px solid var\(--line\)[^}]*border-radius:\s*var\(--r-card\)/su, "each step is a white hairline card");
  assert.match(css, /\.stepAmber\s*\{[^}]*border-color:\s*var\(--warning-line\)/su, "a step with a gap turns its border amber");
  assert.match(ops, /tone === "warn" \|\| tone === "todo" \? "wait"/u, "a waiting step is an amber pill");
  assert.match(ops, /<StatusPill tone=\{pillTone\}/u);
  assert.match(ops, /ConsoleEmptyState/u, "empty desk and booth lists use the shared empty state");
  assert.doesNotMatch(ops, /className="empty-state"/u, "no global empty-state class");
  assert.equal(ops.match(/heading="rule"/g)?.length ?? 0, 4, "the three steps and the booth card share the hairline heading");

  // A row is a name, one quiet line, faces and one control; it opens its detail.
  assert.match(parts, /export function LocationRow/u);
  assert.match(parts, /styles\.locationOpen/u);
  assert.match(ops, /<LocationRow/u);
  assert.match(ops, /onOpen=\{\(\) => setDetail\(/u);
  assert.match(parts, /<Switch/u, "desks run through a switch");
  // Reopened 2026-11-20 (디자인 시스템 적용): faces are the shared ConsoleAvatar (decorative, aria-hidden, no focus).
  assert.match(parts, /<ConsoleAvatar/u, "who is on duty reads as faces");
  assert.match(parts, /styles\.locationTile/u, "a row opens on a tile for the kind of place");
  // axe: faces inside the row button must not be focusable (an avatar tooltip adds tabindex),
  // and the button's name comes from its visible text instead of an aria-label that omits it.
  assert.doesNotMatch(parts, /<ConsoleAvatar[^>]*label=/u, "decorative faces take no focus");
  assert.doesNotMatch(parts, /<button[^>]*styles\.locationOpen[^>]*aria-label/u, "row name is its visible text");
  assert.match(ops, /<StatusDot tone=/u, "booths follow their schedule and show a state, never a switch");

  // Row actions are not a wall of buttons: nothing secondary lives in a row.
  const rows = [...ops.matchAll(/<ul className=\{styles\.locations\}>[\s\S]*?<\/ul>/gu)].map((match) => match[0]).join("\n");
  assert.equal([...ops.matchAll(/<ul className=\{styles\.locations\}>/gu)].length, 2, "desks and booths are the two location lists");
  assert.doesNotMatch(rows, /button-secondary|variant="secondary"/u, "desk and booth rows carry no secondary buttons");

  // Stopping a desk is confirmed; starting is not.
  assert.match(ops, /deskStopPending/u);
  assert.match(ops, /confirmLabel="가동 중지"/u);

  // Assignment: one quiet page-level entry (reopened 2026-11-25: assigning staff is optional).
  assert.match(ops, /id="ops-staff-assign"\s+type="button"\s+variant="ghost"/u);
  assert.match(css, /\.gapSurface\s*\{[^}]*background:\s*var\(--surface-muted\)/su, "the optional list is a quiet surface, not a warning");

  // Release lives in the detail dialog, with the same command.
  assert.match(ops, /function LocationDialog/u);
  assert.match(ops, /runCommand\("staff\.unassign"/u);

  // Dim rows stay readable: muted text, never reduced opacity.
  assert.match(css, /\.locationDim \.locationText strong\s*\{[^}]*color:\s*var\(--muted\)/su);
  assert.doesNotMatch(css, /\.location[A-Za-z]*\s*\{[^}]*opacity/su);
});

// Reopened 2026-11-24 (owner: 진행 중 데스크 보드)
test("live stage opens on a desk board and folds the setup steps", () => {
  const ops = read("OperationsWorkspace.tsx");
  const parts = read("LocationParts.tsx");
  const css = read("operations.module.css");

  // The board exists only while LIVE; every other stage keeps the three numbered steps unchanged.
  assert.match(ops, /const liveBoard = state\.kind === "ready" && state\.stage === "LIVE"/u);
  assert.match(ops, /\{liveBoard \? \(\s*<ConsoleSection\s+headingId="ops-board"\s+title="데스크 보드"/u, "the board only renders while LIVE");
  assert.match(ops, /<SetupFold\s+live=\{liveBoard\}/u);
  assert.match(ops, /if \(!live\) return <>\{children\}<\/>;/u, "preparing, ended and archived stages render the steps as before");
  assert.equal(ops.match(/headingId="ops-desks"/g)?.length, 1, "the three steps are rendered once, folded or not");

  // One card per desk, the whole card opens the existing detail, the switch and the stop confirm are reused.
  assert.match(ops, /<ul className=\{styles\.deskBoard\}>/u);
  assert.match(ops, /<DeskCard[\s\S]*?onOpen=\{\(\) => setDetail\(\{ type: "DESK", id: desk\.id \}\)\}/u);
  assert.match(ops, /<DeskCard[\s\S]*?<RunSwitch[\s\S]*?setDeskStopPending\(desk\)/u, "the card's switch reuses the confirm-before-stop flow");
  assert.equal(ops.match(/confirmLabel="가동 중지"/g)?.length, 1, "one stop confirmation serves both lists");
  assert.match(ops, /enterHref=\{canWriteEvent\(capabilities, "check\.scan"\)[\s\S]*?\/staff\/events\/\$\{encodeURIComponent\(eventId\)\}\?desk=/u, "a running desk opens on this device from its card");
  assert.match(parts, /export function DeskCard/u);
  assert.match(parts, /<button type="button" className=\{styles\.cardOpen\} onClick=\{onOpen\}>/u);
  assert.match(parts, /명 처리/u);
  assert.match(parts, /마지막 처리 \$\{last\}/u);
  assert.match(parts, /휴대폰 스태프 없음/u);
  assert.match(parts, /외 \$\{staff\.length - 1\}명/u, "several staff read as the first name plus a count");
  assert.match(parts, /variant=\{enterPrimary \? "primary" : "secondary"\} className=\{styles\.cardEnterLink\}/u, "orange only when a single desk is running");
  assert.match(ops, /enterPrimary=\{desks\.filter\(\(item\) => item\.open\)\.length === 1\}/u);
  assert.match(parts, /이 기기에서 열기/u);
  assert.match(ops, /id="ops-staff-assign"\s+type="button"\s+variant="ghost"/u, "assignment is optional and stays quiet");
  assert.doesNotMatch(parts, /접속 중|online/u, "no presence indicator: the server records none");
  // Buttons never nest: the switch and 배정 sit beside the opening button, not inside it.
  const cardOpen = parts.slice(parts.indexOf("<button type=\"button\" className={styles.cardOpen}"), parts.indexOf("</button>", parts.indexOf("className={styles.cardOpen}")));
  assert.doesNotMatch(cardOpen.slice(cardOpen.indexOf(">") + 1), /<ProductButton|<Switch|<RunSwitch|<button/u, "no control nests inside the opening button");
  assert.match(css, /\.deskBoard\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/su, "two columns on desktop");
  assert.match(css, /@media \(max-width: 768px\)\s*\{[^}]*\.deskBoard\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/su, "one column on phones");
  assert.doesNotMatch(css, /deskCard\[data-gap/u, "no one assigned is not a warning");
  assert.match(css, /\.deskCard\[data-dim="true"\] \.cardName[\s\S]*?color:\s*var\(--muted\)/u, "a stopped desk is muted text");
  assert.doesNotMatch(css, /\.(deskCard|card[A-Za-z]*)\b[^{]*\{[^}]*opacity/su, "no dimming by opacity");
  assert.match(css, /\.cardNum\s*\{[^}]*font-size:\s*var\(--text-num\)/su, "the per-desk figure uses the number token");
  assert.doesNotMatch(css, /\.deskBoard[^{]*\{[^}]*(?:display:\s*flex)/su, "desks are never merged into one summary strip");

  // Setup folds to two quiet lines; anchors still work while folded.
  assert.match(ops, /<details className=\{styles\.setupFold\} open=\{open\}/u, "the fold is a native disclosure");
  assert.match(ops, /설정 3단계/u);
  assert.match(ops, /\? `\$\{remaining\}단계 남음` : "모두 완료"/u);
  assert.match(ops, /스태프 로그인 주소/u);
  assert.match(ops, /aria-label="스태프 로그인 주소 복사"/u);
  assert.match(ops, /onClick=\{onCopy\}/u);
  assert.match(css, /\.foldSummary,\s*\.addressRow\s*\{[^}]*min-height:\s*52px/su, "the folded rows keep the touch target");
  assert.match(ops, /const SETUP_ANCHORS = new Set\(\["ops-desks", "ops-staff", "ops-scan", "ops-booths", "ops-booth-mode", "ops-booth-map"\]\)/u);
  assert.match(ops, /liveBoard && SETUP_ANCHORS\.has\(anchor\)[\s\S]*?setSetupOpen\(true\)[\s\S]*?scrollIntoView/u, "a hash on a setup anchor opens the fold and scrolls to it");
  assert.match(ops, /\}, \[liveBoard\]\);/u, "the hash is applied again once the live workspace has loaded");
  assert.match(ops, /\{stampEnabled \? \(\s*<ConsoleSection\s+headingId="ops-booths"/u, "booths stay on the setup side and only with 부스 인증 on");

  // Entry records that cannot be read are never turned into numbers.
  assert.match(ops, /deskBoardStats\(\s*workspace\.checks,\s*canManageChecks \? sourceAvailability\?\.checks === true : workspace\.checksAvailable === true,/u, "the same readability rule as 운영 현황");
  assert.match(ops, /count=\{tally \? tally\.count : null\}/u);
  assert.match(parts, /확인 불가/u);
  assert.match(ops, /출입 기록을 확인할 수 없어 처리 수를 표시하지 않습니다/u);
});

function loadDeskBoard() {
  const source = fs.readFileSync(path.join(__dirname, "..", "apps", "web", "lib", "desk-board.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const sandbox = { exports: {}, module: { exports: {} } };
  vm.runInNewContext(js, { ...sandbox, Intl, Date }, { filename: "desk-board.ts" });
  return sandbox.exports;
}

test("desk board counts follow the entry-count rules of 운영 현황", () => {
  const { deskBoardStats, cancelledParticipantIds, processedAgo } = loadDeskBoard();
  const desks = [{ id: "d1", action: "IN" }, { id: "d2", action: "IN" }, { id: "d3", action: "OUT" }];
  const at = (minutes) => new Date(Date.UTC(2026, 10, 24, 5, 0) + minutes * 60000).toISOString();
  const checks = [
    { id: "c1", participantId: "p1", action: "IN", deskId: "d1", at: at(1) },
    { id: "c2", participantId: "p1", action: "IN", deskId: "d1", at: at(5) }, // same person twice at one desk: one person
    { id: "c3", participantId: "p2", action: "IN", deskId: "d1", at: at(9), corrected: true }, // corrected away: not counted, not "last"
    { id: "c4", participantId: "p3", action: "IN", deskId: "d1", at: at(3) },
    { id: "c5", participantId: "p4", action: "IN", deskId: "d1", at: at(4) }, // cancelled participant
    { id: "c6", participantId: "p1", action: "OUT", deskId: "d1", at: at(7) }, // an exit is the last processing, not an entry
    { id: "c7", participantId: "p5", action: "IN", deskId: "d2", at: at(2) },
    { id: "c8", participantId: "p5", action: "OUT", deskId: "d3", at: at(8) },
    { id: "c9", participantId: "p6", action: "IN", deskId: "gone", at: at(9) }, // no such desk
    { id: "", participantId: "p7", action: "IN", deskId: "d2", at: at(9) }, // no id: not a usable record
  ];
  const cancelled = cancelledParticipantIds([{ id: "p4", status: "CANCELLED" }, { id: "p1", status: "APPROVED" }]);
  assert.deepEqual([...cancelled], ["p4"]);
  const stats = deskBoardStats(checks, true, desks, cancelled);
  assert.equal(stats.available, true);
  assert.deepEqual(JSON.parse(JSON.stringify(stats.byDesk.d1)), { count: 2, lastAt: at(7) });
  assert.deepEqual(JSON.parse(JSON.stringify(stats.byDesk.d2)), { count: 1, lastAt: at(2) });
  assert.deepEqual(JSON.parse(JSON.stringify(stats.byDesk.d3)), { count: 1, lastAt: at(8) }, "an exit desk counts exits");
  assert.deepEqual(JSON.parse(JSON.stringify(deskBoardStats([], true, desks).byDesk.d1)), { count: 0, lastAt: null });

  // Unreadable records never become numbers.
  assert.deepEqual(JSON.parse(JSON.stringify(deskBoardStats(checks, false, desks))), { available: false });
  assert.deepEqual(JSON.parse(JSON.stringify(deskBoardStats(undefined, true, desks))), { available: false });
  assert.deepEqual(JSON.parse(JSON.stringify(deskBoardStats([...checks, "broken"], true, desks))), { available: false });

  // "방금", "N분 전", "N시간 전", then a clock time.
  const now = Date.parse(at(0)) + 3 * 60 * 60000;
  assert.equal(processedAgo(new Date(now - 20000).toISOString(), now), "방금");
  assert.equal(processedAgo(new Date(now + 60000).toISOString(), now), "방금", "a clock a little ahead never shows a negative age");
  assert.equal(processedAgo(new Date(now - 5 * 60000).toISOString(), now), "5분 전");
  assert.equal(processedAgo(new Date(now - 125 * 60000).toISOString(), now), "2시간 전");
  assert.match(processedAgo(new Date(now - 7 * 3600000).toISOString(), now), /^\d{2}:\d{2}$|^\d+\. \d+\. \d{2}:\d{2}$|^\d+월 \d+일 \d{2}:\d{2}$/u);
  assert.equal(processedAgo(null, now), null);
  assert.equal(processedAgo("not a date", now), null);
});

test("the desk run switch keeps a 44px operable area around its 40x24 track", () => {
  // Reopened 2026-11-25: the Astryx switch input is only 40x24, below the touch floor on a tablet or phone.
  const parts = read("LocationParts.tsx");
  const css = read("operations.module.css");
  assert.match(parts, /className=\{styles\.runSwitch\}/);
  assert.match(css, /\.runSwitch\.runSwitch :global\(\.astryx-switch-field\) input\[role="switch"\][^}]*width: 44px;[^}]*height: 44px/su);
});
