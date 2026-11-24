'use strict';

// Locks the approved engage screen (DESIGN.md "참여하기 확정 구성", mockup
// engage-options.html, option B "행사 색 위의 탭과 카드"): kind tabs over
// white program cards on the event's own color; the write contracts do not
// change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '../apps/web/app/event/[slug]/engage');
const client = fs.readFileSync(path.join(dir, 'EngageClient.tsx'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'engage.module.css'), 'utf8');

test('the page sits on the event color and picks a readable ink', () => {
  assert.match(client, /normalizeHomeStyle\(.*homeStyle\)\.backgroundColor/su);
  // Reopened 2026-11-20: the ground and its ink come from AttendeeSurface (a1 white, a2 the event's own color).
  assert.match(client, /attendeeLook\(/u);
  assert.match(css, /--engage-ground:\s*var\(--ev-ground, var\(--paper\)\)/u);
  assert.match(css, /--engage-ink:\s*var\(--ev-ground-ink, var\(--ink\)\)/u);
  assert.match(css, /\.page\s*\{[^}]*background:\s*var\(--engage-ground\)/su);
});

test('kinds are tabs, shown only for kinds the event has and only with more than one', () => {
  assert.match(client, /const typeOrder = \[\.\.\.new Set\(state\.modules\.map\(\(module\) => module\.type\)\)\]/u);
  assert.match(client, /typeOrder\.length > 1 \? \(/u);
  assert.match(client, /aria-label="참여 종류"/u);
  assert.match(client, /aria-pressed=\{type === currentType\}/u);
  assert.match(client, /requestedType \?\? typeOrder\[0\]/u, 'a ?program= link opens its own kind');
  // Reopened 2026-11-20: programs to do lead; finished ones (a submitted poll, quiz or survey, or a closed program) fold into one list.
  assert.match(client, /activeModules\.map\(\(module, index\) => renderModule\(module, index, false\)\)/u);
  assert.match(client, /doneModules\.map\(\(module, index\) => renderModule\(module, index, true\)\)/u);
  assert.match(client, /완료한 참여 \{doneModules\.length\}개/u);
  assert.match(client, /open=\{requestedProgram \? module\.id === requestedProgram : !folded && index === 0\}/u, 'a ?program= link still opens its own program');
});

test('an unfinished poll, quiz or survey is a dot on its tab, not a count', () => {
  assert.match(client, /\["poll", "quiz", "survey"\]\.includes\(module\.type\) && module\.status !== "CLOSED" && !state\.submittedModuleIds\.includes\(module\.id\)/u);
  assert.match(css, /\.todoDot\s*\{[^}]*var\(--brand\)/su);
});

test('program state is a chip and choices are hairline rows with the radio on the text line', () => {
  assert.match(client, /data-state=\{hasPending/u);
  for (const state of ['todo', 'done', 'check', 'end']) assert.match(css, new RegExp(`span\\[data-state="${state}"\\]`));
  assert.match(css, /\.moduleCard \.choiceRow\s*\{[^}]*display:\s*flex/su, 'beats the card label rule that stacked the radio above its text');
  assert.match(css, /\.scoreChoice:has\(input:checked\)\s*\{[^}]*background:\s*var\(--ink\)/su);
});

test('a voted poll shows its public counts as bars', () => {
  assert.match(client, /aria-label="투표 결과"/u);
  assert.match(client, /data-mine=\{props\.pollChoice === option \|\| undefined\}/u);
  assert.match(css, /\.resultRow i\s*\{[^}]*var\(--info-soft\)/su);
});

test('submit, recovery and conflict contracts are unchanged', () => {
  for (const text of ['response.submit', 'question.submit', 'expectedContentVersion', '참여 내용이 변경됐습니다', '서버 처리 결과 확인', '요청 결과 확인', '제출을 마쳤습니다. 참여해 주셔서 감사합니다.', '참가 확정 후 참여할 수 있습니다']) {
    assert.ok(client.includes(text), `${text} stays`);
  }
});

// Reopened 2026-11-19: the page is an activity hub. The published banner names
// the event, a progress card counts the attendee's own answered programs, kinds
// are icon tabs, each card opens with its kind icon, and the way out is one
// quiet list. The write contracts above do not change.
test('the hub opens with the published banner and the attendee\'s own progress', () => {
  assert.match(client, /<EventBanner theme=\{state\.theme\} title=\{state\.eventName\} titleAs="h1"/u);
  assert.match(client, /theme: readAttendeeTheme\(slug, publicData\.workspace\)/u);
  assert.match(client, /\["poll", "quiz", "survey"\]\.includes\(module\.type\) && \(module\.status !== "CLOSED" \|\| state\.submittedModuleIds\.includes\(module\.id\)\)/u, 'only answerable programs count, from the attendee\'s own submissions');
  assert.match(client, /role="progressbar"[^>]*aria-valuenow=\{progressDone\}/u);
  assert.match(css, /\.progressBar i\s*\{[^}]*var\(--ink\)/su, 'the bar is ink, not orange');
});

test('kind tabs and cards carry a kind icon; the way out is a quiet list on the page ink', () => {
  assert.match(client, /<AttendeeIcon name=\{typeIcon\(type\)\} size=\{18\} \/>\{typeLabel\(type\)\}/u);
  assert.match(client, /className=\{styles\.kindIcon\} aria-hidden="true"/u);
  assert.match(css, /summary span\[data-state\]\s*\{/u, 'the state chip rule no longer catches the icon');
  // Reopened 2026-11-20: the way out is AttendeeListRow rows in one soft card (white on an a2 ground).
  assert.match(client, /<AttendeeListRow icon="ticket" title="내 티켓으로 이동"/u);
  assert.match(css, /\.pageFooter\s*\{[^}]*color-mix\(in srgb, var\(--ink\) 5%/su);
});
