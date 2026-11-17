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
  assert.match(client, /"--engage-ink": readableInk\(state\.ground\)/u);
  assert.match(css, /\.page\s*\{[^}]*background:\s*var\(--engage-ground\)/su);
});

test('kinds are tabs, shown only for kinds the event has and only with more than one', () => {
  assert.match(client, /const typeOrder = \[\.\.\.new Set\(state\.modules\.map\(\(module\) => module\.type\)\)\]/u);
  assert.match(client, /typeOrder\.length > 1 \? \(/u);
  assert.match(client, /aria-label="참여 종류"/u);
  assert.match(client, /aria-pressed=\{type === currentType\}/u);
  assert.match(client, /requestedType \?\? typeOrder\[0\]/u, 'a ?program= link opens its own kind');
  assert.match(client, /visibleModules\.map\(\(module, index\)/u);
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
  for (const text of ['response.submit', 'question.submit', 'expectedContentVersion', '참여 내용이 변경됐습니다', '서버 처리 결과 확인', '요청 결과 확인', '이미 제출했습니다. 참여해 주셔서 감사합니다.', '참가 확정 후 참여할 수 있습니다']) {
    assert.ok(client.includes(text), `${text} stays`);
  }
});
