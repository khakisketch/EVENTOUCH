'use strict';

// Team empty/error notice wrapping: Korean must wrap by word (eojeol),
// never mid-syllable like 있/습니다 at 320px. Regression pins the
// CSS-module provenance: each CSS module hashes its own class names, so a
// team selector can only outrank the shared `.empty h3` / global `p` with
// same-module classes (doubled `.teamEmpty.teamEmpty`). A cross-module
// selector such as `.teamEmpty.empty` compiles both names with the TEAM
// hash while the JSX `empty` carries the console-ui hash — it never matches.
// Source-only assertions; rendering belongs to main.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..', 'apps', 'web', 'app');
const css = fs.readFileSync(path.join(appRoot, 'console', 'team', 'team.module.css'), 'utf8');
const workspace = fs.readFileSync(path.join(appRoot, 'console', 'team', 'TeamWorkspace.tsx'), 'utf8');
// Selectors only: prose comments may name the forbidden pattern as an
// example, so strip them before the absence check.
const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('team empty notices win with same-module doubled specificity only', () => {
  assert.match(css, /\.teamEmpty\.teamEmpty h3/, 'doubled self-class outranks the foreign .empty h3 regardless of module order');
  assert.match(css, /\.teamEmpty\.teamEmpty p/, 'doubled self-class outranks the global p rule regardless of module order');
  assert.doesNotMatch(selectors, /\.teamEmpty\.empty/, 'no cross-module selector: the team hash can never match the console-ui empty hash');
  assert.doesNotMatch(css, /teamStyles\.empty/, 'no team-module .empty class is referenced anywhere here');
});

test('team empty notices keep words together with an overflow fallback', () => {
  const block = css.slice(css.indexOf('.teamEmpty.teamEmpty h3'), css.indexOf('}', css.indexOf('.inlineAlert')) + 1);
  assert.match(block, /word-break:\s*keep-all/, 'eojeol units stay intact');
  assert.match(block, /overflow-wrap:\s*break-word/, 'a token wider than the row still breaks instead of overflowing');
});

test('team empty shells pair the shared empty with the team override', () => {
  const usages = workspace.match(/consoleUiStyles\.empty\} \$\{teamStyles\.teamEmpty\}/g) || [];
  assert.equal(usages.length, 2, `pending-invite and member empties both layer the override, found ${usages.length}`);
  assert.match(workspace, /teamStyles\.inlineAlert/, 'the team-owned revoke alert keeps its local wrap guard');
});
