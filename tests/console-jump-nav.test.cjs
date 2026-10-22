'use strict';

// The long console screens mix several kinds of work in one page: the field
// operations screen carries desks, booths, map, display and staffing, and the
// draw/vote screen carries stage draws, ranking votes, roulette and lucky
// numbers. Both keep the shared jump nav and both name the section in view,
// so the operator always knows which job the page is showing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const operations = read('apps/web/app/console/events/[id]/operations/OperationsWorkspace.tsx');
const operationsCss = read('apps/web/app/console/events/[id]/operations/operations.module.css');
const draws = read('apps/web/app/console/events/[id]/draws/DrawsWorkspace.tsx');
const drawsCss = read('apps/web/app/console/events/[id]/draws/draws.module.css');
const theme = read('apps/web/app/console/events/[id]/page/ThemeWorkspace.tsx');
const themeCss = read('apps/web/app/console/events/[id]/page/page.module.css');

test('the long console screens name the section in view next to the jump nav', () => {
  for (const [name, source, css] of [
    ['field operations', operations, operationsCss],
    ['draws and votes', draws, drawsCss],
    ['attendee page editor', theme, themeCss],
  ]) {
    assert.match(source, /<ConsoleSectionNav/u, `${name} keeps the shared jump nav`);
    assert.match(source, /className=\{styles\.navSticky\}/u, `${name} wraps the nav for the readout`);
    assert.match(source, /현재 위치:/u, `${name} reads out the section in view`);
    assert.match(source, /IntersectionObserver/u, `${name} follows the section in view`);
    assert.match(source, /getElementById\(id\)/u, `${name} observes the existing anchors`);
    assert.match(css, /\.navSticky \{/u, `${name} styles the nav wrapper`);
    assert.match(css, /\.navNow \{/u, `${name} styles the position readout`);
  }
});

test('a section jump moves focus into the section, not only the viewport', () => {
  // A keyboard operator who jumps to a section must continue tabbing inside
  // that section, so the jump hands focus over as well as scrolling.
  const nav = read('apps/web/app/console/console-ui/ConsoleSectionNav.tsx');
  assert.match(nav, /onClick=\{\(\) =>/u);
  assert.match(nav, /document\.getElementById\(item\.id\)/u);
  assert.match(nav, /setAttribute\("tabindex", "-1"\)/u);
  assert.match(nav, /target\.focus\(\{ preventScroll: true \}\)/u, 'focus moves directly, matching the messaging skip grammar');
  assert.match(nav, /target\.scrollIntoView\(\{ block: "start" \}\)/u, 'the viewport follows explicitly, not by browser accident');
  assert.match(nav, /instanceof HTMLElement/u, 'focus is guarded to focusable nodes');
  // The fragment must still change: a section stays copyable and reopenable.
  assert.doesNotMatch(nav, /event\.preventDefault\(\)/u);
});

test('the draw and vote screen keeps its four jobs addressable', () => {
  for (const id of ['draws-programs', 'draws-vote', 'draws-roulette', 'draws-lucky']) {
    assert.match(draws, new RegExp(`\\{ id: "${id}", label:`), `${id} stays in the nav`);
  }
  // Each section still carries its own state, so the nav is a summary too.
  assert.match(draws, /무대 추첨 · \$\{state\.drawPrograms\.length\}개/u);
  assert.match(draws, /순위 투표 · \$\{state\.voteTotal\}표/u);
});
