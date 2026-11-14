'use strict';

// Approved draws composition (2026-11-14): one stage card whose left half is a
// preview of what the audience actually sees (venue screen for stage draws,
// attendee phone for vote / roulette / lucky) and whose right half is what to
// do now, over a flat picker of the four jobs. Change it only on a new owner
// decision.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'apps/web/app/console/events/[id]/draws');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const workspace = read('DrawsWorkspace.tsx');
const preview = read('StagePreview.tsx');
const css = read('draws.module.css');

test('approved draws design stays locked: preview-first stage card over a flat picker', () => {
  assert.doesNotMatch(workspace, /ConsoleSectionNav|ConsoleSection\b/u, 'no tab nav and no stack of section panels');
  assert.match(workspace, /<StagePreview scene=\{scene\}/u);
  assert.ok(workspace.indexOf('<StagePreview') < workspace.indexOf('className={styles.picker}'), 'the card comes before the picker');
  assert.match(workspace, /className=\{styles\.stageInfo\}/u, 'facts left, actions right, under the preview');
  for (const key of ['"vote"', '"roulette"', '"lucky"']) assert.ok(workspace.includes(`key: ${key}`), `${key} is a picker row`);
  assert.match(workspace, /aria-pressed=\{activeKey === row\.key\}/u, 'the picker is a pressed-state group of buttons');
  assert.ok((workspace.slice(0, workspace.indexOf('function NameFilter')).match(/variant="primary"/gu) || []).length >= 1);
  assert.match(workspace, /className=\{styles\.goButton\}/u, 'the single big orange run button');
});

test('the preview is decorative, loads nothing, and names the scene in text', () => {
  assert.match(preview, /role="img" aria-label=\{label\}/u);
  assert.doesNotMatch(preview, /fetch\(|consoleFetch|useEffect|useState/u, 'a pure redraw: no data loading, no state');
  for (const scene of ['board', 'vote', 'roulette', 'lucky']) assert.match(preview, new RegExp(`scene\\.kind === "${scene}"|kind: "${scene}"`, 'u'));
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u, 'the stage palette uses rgb()/tokens, never hex');
  assert.match(css, /container-type: inline-size/u, 'the board scales its text with its own width');
});

test('every safety rule of the old sections survives inside the stage card', () => {
  for (const needle of [
    'runBlockers', 'stageOnlyBlockers', 'runBlockerId', 'stageBlockerId', 'setProgramPublished(program', 'requestProgramStatus(program',
    'saveVoteConfig', 'refreshVoteTally', 'saveRouletteConfig', 'saveLuckyConfig', 'preassignLuckyNumbers', 'assignCompanyRecipient',
  ]) assert.ok(workspace.includes(needle), `${needle} is still wired`);
  assert.match(workspace, /role="group" aria-label=\{`\$\{program\.name\} 추첨 실행`\}/u);
  assert.match(workspace, /aria-label="실행 인원 줄이기"/u);
  assert.match(workspace, /aria-label="실행 인원 늘리기"/u);
  assert.match(workspace, /<ConsoleDialog title=\{editingProgramId/u, 'program settings live in a dialog that shows the save failure');
  assert.match(workspace, /\{failure \? <p className=\{styles\.fieldError\} role="alert">\{failure\}<\/p> : null\}/u);
});

test('phone widths keep rows on one line and targets at 44px', () => {
  assert.match(css, /\.pickRow\s*\{[^}]*min-height:\s*68px/su);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.pickSpacer\s*\{\s*display:\s*none/u);
  assert.match(css, /\.actFoot :global\(\.product-action\)\s*\{\s*min-height:\s*44px/u);
  assert.match(css, /\.stepper :global\(\.product-action\)\s*\{[^}]*min-height:\s*56px/su);
});
