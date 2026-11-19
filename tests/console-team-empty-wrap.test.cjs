'use strict';

// Team empty/error notice wrapping: Korean must wrap by word (eojeol),
// never mid-syllable like 있/습니다 at 320px.
// Reopened 2026-11-20 (디자인 시스템 적용): the team's own `.teamEmpty` override
// layer is gone. Every team empty or error notice is the shared
// ConsoleEmptyState, whose module already holds `word-break: keep-all` with an
// `overflow-wrap: anywhere` fallback, so a token wider than the row still
// breaks instead of overflowing. The team-owned revoke alert keeps its own
// wrap guard. Source-only assertions; rendering belongs to the browser audits.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..', 'apps', 'web', 'app');
const css = fs.readFileSync(path.join(appRoot, 'console', 'team', 'team.module.css'), 'utf8');
const workspace = fs.readFileSync(path.join(appRoot, 'console', 'team', 'TeamWorkspace.tsx'), 'utf8');
const empty = fs.readFileSync(path.join(appRoot, 'console', 'console-ui', 'console-empty-state.module.css'), 'utf8');
// Selectors only: prose comments may name the forbidden pattern as an example.
const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('team empty notices use the shared ConsoleEmptyState, not a team override', () => {
  assert.doesNotMatch(selectors, /\.teamEmpty/, 'the team override layer is retired');
  assert.doesNotMatch(workspace, /teamStyles\.teamEmpty|consoleUiStyles\.empty/, 'no hand-rolled empty box remains in the team screen');
  assert.match(workspace, /import ConsoleEmptyState from "\.\.\/console-ui\/ConsoleEmptyState"/);
});

test('shared empty notices keep words together with an overflow fallback', () => {
  const block = empty.slice(empty.indexOf('.empty {'), empty.indexOf('}', empty.indexOf('.empty {')) + 1);
  assert.match(block, /word-break:\s*keep-all/, 'eojeol units stay intact');
  assert.match(block, /overflow-wrap:\s*anywhere/, 'a token wider than the row still breaks instead of overflowing');
});

test('every team empty and unknown-queue notice is a ConsoleEmptyState', () => {
  const usages = workspace.match(/<ConsoleEmptyState/g) || [];
  assert.ok(usages.length >= 5, `unknown-invite, no-invite filter, member, filtered-member and permission empties, found ${usages.length}`);
  assert.match(workspace, /kind="error-soft"[\s\S]{0,80}title="대기 중인 초대를 확인할 수 없습니다\."/, 'an unknown queue is a soft error, never an empty list');
  assert.match(css, /\.inlineAlert\s*\{[^}]*word-break:\s*keep-all[^}]*overflow-wrap:\s*break-word/s);
  assert.match(workspace, /teamStyles\.inlineAlert/, 'the team-owned revoke alert keeps its local wrap guard');
});
