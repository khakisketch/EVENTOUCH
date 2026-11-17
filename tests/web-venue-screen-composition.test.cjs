'use strict';

// Locks the approved venue screen (DESIGN.md "행사장 대형 화면 확정 구성",
// mockup screen-options.html, option A "어두운 무대"): every scene except the
// draw sits on the dark stage, sized for a room; the program row in progress
// is highlighted from the server's clock. Selection rules, the draw scene and
// the stale notice do not change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '../apps/web/app/screen/[slug]');
const board = fs.readFileSync(path.join(dir, 'DisplayBoard.tsx'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'board-stage.module.css'), 'utf8');
const ts = require(path.join(__dirname, '../apps/web/node_modules/typescript'));

function sessionLive() {
  const start = board.indexOf('function sessionLive');
  const source = board.slice(start, board.indexOf('\n}\n', start) + 3);
  const code = ts.transpileModule(`type ProgramItem = { date: string; start: string; end: string };\n${source}\nglobalThis.sessionLive = sessionLive;`, { compilerOptions: { target: 'ES2020' } }).outputText;
  const sandbox = { Date, Number, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.sessionLive;
}

test('every scene but the draw is on the dark stage', () => {
  assert.match(board, /drawSelected \? drawStyles\.cinematicBoard : stageStyles\.dark/u);
  assert.match(board, /display-board display-idle \$\{stageStyles\.dark\}/u);
  assert.match(board, /<section className=\{`display-board \$\{stageStyles\.dark\}`\} aria-live="off">/u);
  assert.match(css, /\.dark:global\(\.display-board\)\s*\{[^}]*background:\s*var\(--stage\)/su);
  assert.match(css, /\.dark:global\(\.display-board\)\s*\{[^}]*position:\s*fixed/su, 'the stage fills the screen like the draw stage');
});

test('type is sized for a room, not for a window', () => {
  assert.match(css, /\.display-frame\) h2\s*\{[^}]*font-size:\s*clamp\(34px,\s*6vw,\s*116px\)/su);
  assert.match(css, /\.poll-row\)\s*\{[^}]*font-size:\s*clamp\(18px,\s*2\.7vw,\s*52px\)/su);
});

test('a poll is one row per option with the leader in orange, and counts stay public', () => {
  assert.match(board, /data-leader=\{count > 0 && count === Math\.max/u);
  assert.match(board, /<span className="poll-name">\{option\}<\/span>/u);
  assert.match(css, /\.poll-row\[data-leader="true"\]\) :global\(\.poll-bar\) span\s*\{[^}]*var\(--brand\)/su);
});

test('the program row in progress is read from the server clock', () => {
  assert.match(board, /serverOffsetRef\.current = serverDate - Date\.now\(\)/u);
  assert.match(board, /res\.headers\.get\("date"\)/u);
  assert.match(board, /data-live=\{live \? "true" : undefined\}/u);
  assert.match(css, /\.program-item\[data-live="true"\]\)\s*\{[^}]*var\(--brand\)/su);
  const live = sessionLive();
  const at = (text) => Date.parse(`2027-01-16T${text}:00`);
  const session = { date: '2027-01-16', start: '09:30', end: '10:30' };
  assert.equal(live(session, '', at('09:29')), false);
  assert.equal(live(session, '', at('09:30')), true, 'the start minute counts');
  assert.equal(live(session, '', at('10:29')), true);
  assert.equal(live(session, '', at('10:30')), false, 'the end minute does not');
  assert.equal(live({ ...session, date: '' }, '2027-01-16', at('10:00')), true, 'the event date fills a missing day');
  assert.equal(live({ date: '2027-01-16', start: '09:30', end: '' }, '', at('10:00')), false, 'no end, no highlight');
  assert.equal(live(session, '', 0), false, 'no clock yet, no highlight');
});

test('selection rules, the draw scene and the stale notice are unchanged', () => {
  for (const text of ['data.display.type === "poll"', 'module.revealed', 'data.questions.slice(0, 4)', 'data.photos.slice(0, 6)', 'richPlainText', 'DrawReveal', '연결 확인 중 · 마지막 화면입니다', 'prefersReducedMotion']) {
    assert.ok(board.includes(text), `${text} stays`);
  }
});
