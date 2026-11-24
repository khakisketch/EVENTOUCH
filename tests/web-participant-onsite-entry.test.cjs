'use strict';

// 현장 입장 처리 (2026-11-24, owner): an operator admits a person registered at the door from the
// roster, with the existing check.scan command. Static source assertions pin the seam without booting
// Next.js; the server rule (operator + participantId + deskId, no assignment) is proven in
// tests/server-operations.test.cjs. Rendered behaviour is checked in the browser by main.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'apps', 'web', 'app', 'console', 'events', '[id]', 'participants');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const entry = read('OnsiteEntry.tsx');
const list = read('ParticipantList.tsx');
const css = read('participants.module.css');

test('entry uses the existing check.scan command by participant id at an IN desk, never a new command', () => {
  assert.match(entry, /command: "check\.scan"/);
  assert.match(entry, /payload: \{ deskId: attempt\.deskId, participantId: attempt\.participantId, expectedAction: "IN" \}/);
  assert.doesNotMatch(entry, /assignmentId/, 'an operator needs no staff assignment');
  assert.doesNotMatch(entry, /command: "check\.(?:reviewed-exit|correct|reconcile)"|"OUT"/, 'no exit handling in this change');
  assert.match(list, /canWriteEvent\(capabilities, "check\.scan"\)/, 'the same onsite grant the server asks for');
});

test('desk candidates are open IN desks; an unreadable list is not the same as no desk', () => {
  const fn = entry.slice(entry.indexOf('export function readEntryDesks'), entry.indexOf('// "입장함'));
  assert.match(fn, /if \(!Array\.isArray\(workspace\.desks\)\) return null;/);
  assert.match(fn, /desk\.open === false/);
  assert.match(fn, /toUpperCase\(\) !== "IN"/);
  assert.match(list, /entryDesks: readEntryDesks\(workspace\)/);
  assert.match(list, /entryRecords: readEntryRecords\(workspace\)/);
});

test('the entry offer needs LIVE, APPROVED, not inside, and says why otherwise', () => {
  const fn = entry.slice(entry.indexOf('export function entryState'), entry.indexOf('const REMEMBER_KEY'));
  assert.match(fn, /!context\.canScan \|\| person\.erased/, 'no grant, no offer; erased people are skipped');
  assert.match(fn, /"APPROVED", "PENDING", "WAITLIST"\]\.includes\(status\)\) return \{ kind: "none" \}/, 'cancelled and unknown people show nothing');
  assert.match(fn, /if \(person\.inside\)/);
  assert.match(fn, /입장함", found \? formatEntryTime\(found\.at\) : "", found\?\.deskName/);
  assert.match(fn, /!== "LIVE"\) return \{ kind: "reason", text: "행사가 진행 중일 때 입장 처리할 수 있습니다\."/);
  assert.match(fn, /"승인한 뒤 입장 처리할 수 있습니다\."/);
  assert.match(fn, /"열려 있는 입장 데스크가 없습니다 — 입장·스태프에서 데스크를 만들고 가동하세요\.", deskLink: true/);
  assert.match(fn, /context\.desks === null/);
  assert.match(entry, /href=\{`\/console\/events\/\$\{encodeURIComponent\(eventId\)\}\/operations`\}/);
  // The order matters: the stage and status reasons come before the desk reasons.
  assert.ok(fn.indexOf('!== "LIVE"') < fn.indexOf('status === "PENDING"') && fn.indexOf('status === "PENDING"') < fn.indexOf('context.desks === null'));
});

test('desk choice: one desk is automatic, several get a select remembered per event in sessionStorage', () => {
  assert.match(entry, /\}에서 처리<\/p>/);
  assert.match(entry, /state\.desks\.length > 1 \? <label className=\{styles\.entryDeskPick\}>/);
  assert.match(entry, /eventouch\.onsite-entry-desk\.\$\{eventId\}/);
  assert.match(entry, /try \{ return window\.sessionStorage\.getItem\(REMEMBER_KEY\(eventId\)\)/);
  assert.match(entry, /try \{ window\.sessionStorage\.setItem\(REMEMBER_KEY\(eventId\), deskId\); \} catch/);
  assert.match(entry, /desks\.find\(\(desk\) => desk\.id === chosenDeskId\) \?\? desks\.find\(\(desk\) => desk\.id === readRememberedDesk\(eventId\)\) \?\? desks\[0\]/);
});

test('the sheet has exactly one primary: 입장 처리, named for the person, 44px+ and double-click safe', () => {
  assert.match(entry, /variant="primary" className=\{styles\.entryAction\} aria-label=\{`\$\{person\.name\} 입장 처리`\}/);
  assert.equal((entry.match(/variant="primary"/g) ?? []).length, 1);
  assert.match(entry, /disabled=\{locked \|\| entry\.busy \|\| entry\.blocked \|\| otherPending \|\| !desk \|\| Boolean\(entry\.pending\)\}/);
  assert.match(css, /\.entryAction \{[^}]*min-height: 48px/);
  assert.match(css, /\.entryNoticeAction \{[^}]*min-height: 44px/);
  assert.match(css, /\.entryDeskPick select \{[^}]*min-height: 44px/);
  // Right under the status pill, before the "신청 정보 수정" list, in its own sheet row.
  assert.ok(list.indexOf('<EntrySheetBlock') > list.indexOf('styles.sheetPrimary') && list.indexOf('<EntrySheetBlock') < list.indexOf('className={styles.participantDetails}'));
  assert.match(css, /\.rosterSheet > \.entryBlock \{ grid-row: 6;/);
  assert.match(css, /\.rosterSheet > \.participantDetails \{ grid-row: 7;/);
  assert.match(css, /grid-template-rows: auto auto auto auto auto auto auto auto 1fr auto;/);
});

test('right after a door registration in a LIVE event the notice carries 바로 입장 처리 as a secondary action', () => {
  assert.match(list, /const addedId = data\.participant\.id;/, 'the create response already carries the new id');
  assert.match(list, /addDraft\.registrationType === "ONSITE" && state\.kind === "ready" && state\.eventStage\.toUpperCase\(\) === "LIVE"/);
  assert.match(list, /\.status === "APPROVED"/);
  assert.match(list, /setNoticeEntry\(addedOnsite \? \{ id: addedId, notice: `\$\{added\}님을 등록했습니다\.` \} : null\)/);
  assert.match(list, /noticeEntry && notice === noticeEntry\.notice/);
  assert.match(list, /state\.people\.find\(\(item\) => item\.id === noticeEntry\.id\)/);
  assert.match(entry, /variant="secondary" className=\{styles\.entryNoticeAction\} aria-label=\{`\$\{person\.name\} 바로 입장 처리`\}/);
  assert.match(entry, /\{entry\.busy \? "입장 처리 중…" : "바로 입장 처리"\}/);
});

test('result: success notice with the desk and a fresh roster; failures say what to do; lost answers replay the same id', () => {
  assert.match(entry, /`\$\{info\.name\}님을 입장 처리했습니다 · \$\{info\.deskName\}`/);
  assert.match(list, /setNotice\(`\$\{info\.name\}님을 입장 처리했습니다 · \$\{info\.deskName\}`\)/);
  assert.match(entry, /await callbacksRef\.current\.onRefresh\(\)/, 'the roster is re-read before the entry is called done');
  assert.match(entry, /body\.id !== attempt\.participantId \|\| body\.action !== "IN" \|\| body\.checkId !== attempt\.commandId\) \{ uncertain\(\); return; \}/);
  assert.match(entry, /response\.status >= 500 \|\| \[408, 425, 429\]\.includes\(response\.status\)\) \{ uncertain\(\); return; \}/);
  assert.match(entry, /text\(body\?\.error\) \|\| "입장 처리하지 못했습니다\."/, 'the server sentence is shown');
  for (const code of ['ALREADY_CHECKED_IN', 'DESK_CLOSED', 'DESK_ACTION_CHANGED', 'CHECK_ATTENDANCE_REVIEW_REQUIRED']) assert.match(entry, new RegExp(`${code}:`));
  assert.match(entry, /abandonOperatorAttempt\(attempt\.commandId\); forgetOperatorReceipt\(attempt\.commandId\)/);
  assert.match(entry, /manageOperatorReceipt\(pending\.commandId\)/);
  assert.match(entry, /newCommandId\(\)/);
  assert.match(entry, /if \(!desk \|\| busy \|\| attemptRef\.current\) return;/, 'a pending attempt is only replayed, never replaced');
  assert.match(entry, /const attempt = attemptRef\.current;\s+if \(attempt\) void execute\(attempt, true\)/);
  assert.match(entry, /useConsoleDraftGuard\(busy \|\| Boolean\(pending\)/);
  assert.match(list, /gate: writeBusyRef/, 'shares the roster in-flight gate');
});

test('accessibility: alerts for failures, status for results, and the sheet cannot close mid-request', () => {
  assert.match(entry, /kind=\{outcome\.kind === "error" \? "error" : "warning"\}/);
  assert.match(entry, /<p className="sr-only" role="status">\{done\}<\/p>/);
  assert.match(list, /busy=\{savingId === selectedPerson\.id \|\| entry\.busy\}/);
  assert.match(list, /<EntryOutcome entry=\{entry\} \/>/, 'a failure after the sheet closed still shows on the page');
});

test('scope: no exit, bulk or staff-screen change; roster list composition untouched', () => {
  assert.doesNotMatch(entry, /selectedIds|bulk/i);
  assert.doesNotMatch(css, /\.participantRow[^{]*\{[^}]*entry/);
  // Only the primary 참가자 추가 stays orange in the toolbar; the notice button is not primary.
  assert.doesNotMatch(entry.slice(entry.indexOf('export function EntryNoticeButton')), /variant="primary"/);
});

test('DESIGN.md records the reopening', () => {
  const design = fs.readFileSync(path.join(__dirname, '..', 'DESIGN.md'), 'utf8');
  assert.match(design, /Reopened 2026-11-24 \(owner: 현장 등록 직후 입장 처리\)/);
});
