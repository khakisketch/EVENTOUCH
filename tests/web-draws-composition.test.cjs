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
  // Reopened 2026-11-19: the picker now leads as cards and the stage card follows it.
  assert.ok(workspace.indexOf('className={styles.picker}') < workspace.indexOf('<StagePreview'), 'the picker (what you are looking at) comes before the card');
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
  // Reopened 2026-11-20: the scenes are drawn at real device size inside DeviceFrame and scaled as a whole.
  assert.match(preview, /<DeviceFrame variant="screen"/u, 'the venue board is a 16:9 screen simulator');
  assert.match(preview, /<DeviceFrame variant="phone"/u, 'the attendee scenes sit in a phone simulator');
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
  // Reopened 2026-11-20 (디자인 시스템 적용): the layered overrides are folded into one rule set; the picker cards
  // stay at least 68px tall (96px on phones) and keep their meter slot (.pickSpacer) so the two-up grid lines up.
  assert.match(css, /\.pickRow\s*\{[^}]*min-height:\s*(?:6[89]|[7-9]\d|1\d\d)px/su);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.pickRow \{ min-height: 96px;/u);
  assert.match(css, /\.pickSpacer \{ display: block; \}/u);
  // Reopened 2026-11-20 (shared gaps): the 44px action floor is the one shared `.product-action` rule (product-ui.css);
  // per-screen `min-height: 44px` repeats were no-ops and are gone.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'app', 'product-ui.css'), 'utf8'), /\.product-action \{[^}]*min-block-size: var\(--control-min-size\)/su, 'every action keeps a 44px target');
  assert.doesNotMatch(css, /\.actFoot :global\(\.product-action\)/u, 'no local repeat of the 44px floor');
  assert.match(css, /\.stepper :is\(\[data-product-action\], \[data-action-variant\]\)\s*\{[^}]*min-height:\s*56px/su);
});

test("the phone preview's event line inherits its white ink instead of the global muted <small> gray", () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, "..", "apps", "web", "app", "console", "events", "[id]", "draws", "draws.module.css"), "utf8");
  assert.match(stylesheet, /\.phoneHead small\s*\{[^}]*color:\s*inherit/su, "gray on the navy head measured 1.68:1 in axe");
});

// Reopened 2026-11-19
test('Reopened 2026-11-19: picker cards lead, wide screens put the preview beside the actions', () => {
  assert.match(css, /\.pickRow \{[^}]*grid-template-areas: "icon name name" "meter meter count"/su);
  assert.match(css, /@media \(min-width: 1200px\) \{\s*\.stageCard \{ grid-template-columns: minmax\(0, 1\.08fr\) minmax\(0, 1fr\);/u);
  assert.match(css, /\.winnerItem::before \{\s*content: counter\(winner\);/u, 'winners carry a rank mark');
  assert.match(css, /\.runBlocker \{[^}]*border: 1px solid var\(--warning-line\)[^}]*background: var\(--warning-soft\)/su, 'run limits read as amber notes, not white buttons');
});

// Reopened 2026-11-20 (owner: previews should be device simulators)
test('Reopened 2026-11-20: previews are device simulators drawn at real size', () => {
  assert.match(preview, /import DeviceFrame from "\.\.\/\.\.\/\.\.\/console-ui\/DeviceFrame"/u);
  assert.match(css, /\.board \{[^}]*padding: 58px 77px/su, 'the board is laid out at 1280x720 and scaled by the frame');
  assert.match(css, /\.phoneScreen \{[^}]*font-size: 15px/su, 'the phone scene is laid out at a real 390px width');
});

// Reopened 2026-11-20 (참여 이벤트 통합): the draws stage is where a draw-type event is run, reached from the
// one event list. Its route, heading, ids and #hash selection stay for deep links, audits and handoffs.
test('Reopened 2026-11-20: the stage links back to 참여 이벤트 and opens 추첨 프로그램 만들기 from the template', () => {
  assert.match(workspace, /<ProductLink variant="ghost" href=\{closeHref\(`\/console\/events\/\$\{encodeURIComponent\(eventId\)\}\/programs`\)\}>참여 이벤트<\/ProductLink>/u, 'a back link to the one event list sits in the header');
  assert.match(workspace, /pageId="draws"/u, 'the page keeps its id for audits');
  assert.match(workspace, /get\("new"\) !== "program"/u, '/draws?new=program opens the existing program dialog once');
  assert.match(workspace, /window\.history\.replaceState\(null, "", `\$\{window\.location\.pathname\}\$\{window\.location\.hash\}`\)/u, 'the one-shot query is removed after use');
  for (const id of ['draws-vote', 'draws-roulette', 'draws-lucky', 'draw-program-']) assert.ok(workspace.includes(id), `#${id} still selects its item`);
});

// Reopened 2026-11-20 (디자인 시스템 적용): stage state is a StatusPill, empty blocks are ConsoleEmptyState, the run
// action and the winner cards come before everything else (settings stay folded), and the stylesheet speaks tokens.
test('Reopened 2026-11-20: shared parts and tokens, run action and winners first, no element-selector overrides', () => {
  assert.match(workspace, /import StatusPill from "\.\.\/\.\.\/\.\.\/console-ui\/StatusPill"/u);
  assert.match(workspace, /import ConsoleEmptyState from "\.\.\/\.\.\/\.\.\/console-ui\/ConsoleEmptyState"/u);
  assert.doesNotMatch(workspace, /styles\.stageKicker|styles\.empty\b|styles\.programWinners/u, 'hand-made kicker and empty blocks are gone');
  assert.match(workspace, /<ConsoleEmptyState title="아직 추첨 결과가 없습니다\."/u, 'the empty winners state keeps its text');
  assert.match(workspace, /<p className=\{styles\.winnersTitle\}>당첨자<\/p>/u, 'winners are a titled card group');
  assert.ok(workspace.indexOf('className={styles.stageAct}') < workspace.indexOf('className={styles.winners}'), 'run action precedes the winners');
  assert.match(css, /\.stagePreview \{ order: 3; \}/u, 'on phones the facts, run button and winners come before the audience preview');
  assert.doesNotMatch(css, /^\.(?:drawRecovery|luckyProgress|rouletteConflict) h[1-6]/mu, 'headings carry a class instead of an element-selector override');
  assert.doesNotMatch(css, /font-weight:\s*(?:5\d\d|6[0-4]\d|65\d|7\d\d)\b/u, 'weights are 400/600/800 only');
  assert.doesNotMatch(css, /border-radius:\s*\d+px/u, 'radii are tokens');
});
