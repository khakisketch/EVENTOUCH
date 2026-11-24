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
  // Reopened 2026-11-20 (디자인 시스템 적용): the layered overrides are folded into one rule set.
  // Reopened 2026-11-24 (owner: 다음 할 일 카드): the picker card stretches to its row (the foot sits at the bottom, so a
  // two-up grid lines up without a meter spacer) and on phones the pill and the next-step button stack, button full width.
  assert.match(css, /\.pickCard \{[^}]*grid-template-rows: 1fr auto[^}]*height: 100%/su);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.pickFoot \{ flex-direction: column; align-items: stretch; \}/u);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.pickNext \{ margin-left: 0; width: 100%; \}/u);
  assert.doesNotMatch(css, /\.pickSpacer/u, 'the meter spacer is gone with the old card');
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
  // Reopened 2026-11-24: the card's button row is icon, name, count over an optional meter (the pill and next step sit in .pickFoot).
  assert.match(css, /\.pickRow \{[^}]*grid-template-areas: "icon name count" "meter meter meter"/su);
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
  assert.match(workspace, /import StatusPill(?:, \{ type StatusPillTone \})? from "\.\.\/\.\.\/\.\.\/console-ui\/StatusPill"/u);
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

// Reopened 2026-11-24 (owner: 다음 할 일 카드). Approved proposal G (card shape H) in the 2026-11-24 review: every tool card
// says its state and offers at most one white next-step button; a tool with nothing to show the audience swaps the preview
// for a dashed empty phone and puts that next step in the page's one orange button.
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, '');

test('Reopened 2026-11-24: tool cards carry a state pill and one white next-step button', () => {
  assert.match(workspace, /<div className=\{styles\.pickCard\} data-selected=\{activeKey === row\.key\}>/u);
  assert.match(workspace, /<StatusPill tone=\{row\.pill\.tone\} dot=\{row\.pill\.dot\}>\{row\.pill\.label\}<\/StatusPill>/u);
  const nextButtons = workspace.match(/<ProductButton[^>]*className=\{styles\.pickNext\}[^>]*>/gu) || [];
  assert.equal(nextButtons.length, 1, 'one JSX site: each card has at most one next step');
  assert.match(nextButtons[0], /variant="secondary"/u, 'a card button is white, never orange');
  // The next-step mapping (DESIGN.md table): label per tool state.
  for (const label of ['팀 등록하기', '투표 열기', '경품 설정하기', '공개하기', '번호 배정하기', '운영 시작하기', '결과 공개하기']) {
    assert.ok(workspace.includes(`label: "${label}"`), `${label} is a next step`);
  }
  for (const label of ['팀 등록 필요', '설정 전', '준비됨', '진행 중', '마감', '공개 필요', '배정 전', '일부 배정', '배정 완료', '승인 참가자 없음']) {
    assert.ok(workspace.includes(`label: "${label}"`), `${label} is a state pill`);
  }
  // A vote with no teams says what it needs, not "마감"; the stored status values are untouched.
  const votePill = workspace.slice(workspace.indexOf('const votePill'), workspace.indexOf('const voteNext'));
  assert.ok(votePill.indexOf('voteNeedsTeams ? { label: "팀 등록 필요"') > votePill.indexOf('state.voteTotal > 0 ? { label: "마감"'), 'closed with votes stays 마감; closed without votes asks for teams');
  assert.match(workspace, /state\.voteConfig\.status === "CLOSED" && state\.voteTotal === 0/u, 'team and open steps only before the first vote locks the setup');
  // Steps reuse the existing setup and confirmations: they select the card and point at the folded form or dialog.
  for (const id of ['id="draws-vote-setup"', 'id="draws-team-setup"', 'id="draws-roulette-setup"', 'id="lucky-preassign-all"']) assert.ok(workspace.includes(id), `${id} is a focus target`);
  assert.match(workspace, /startStep\("vote", \["draws-vote-setup", "draws-team-setup"\], "draws-team-name"\)/u);
  assert.match(workspace, /requestProgramStatus\(item, "OPEN"\)/u, 'a draft program starts through its existing confirmation');
  assert.match(workspace, /togglePublishProgram\(item\)/u, 'publishing shares the switch path (an empty program asks first)');
  // The default card is the one that needs the operator most.
  assert.match(workspace, /rows\.find\(\(row\) => row\.key === `program:\$\{runningProgram\.id\}`\)[\s\S]*rows\.find\(\(row\) => row\.next\) \?\? rows\[0\]/u);
  assert.doesNotMatch(workspace, /defaultProgram/u, 'no default of "the first program or the closed vote"');
  // Anchors and the premise lines stay as they were.
  for (const kept of ['`draw-program-${program.id}`', '`draws-${kind}`', '실행 전제: {runBlockers.join(" · ")}', '무대 터치 실행 전제: {stageOnlyBlockers.join(" · ")}', 'id="stage-screen-prerequisite"']) {
    assert.ok(workspace.includes(kept), `${kept} stays`);
  }
});

test('Reopened 2026-11-24: an empty tool shows a dashed phone and the page\'s one orange next step', () => {
  assert.match(workspace, /className=\{styles\.emptyPhone\} aria-hidden="true"><span>고른 카드의 객석 화면이 여기에 나와요<\/span>/u);
  assert.match(workspace, /data-empty=\{emptyMode \? "true" : undefined\}/u);
  assert.match(workspace, /empty: state\.pollEnabled && state\.teams\.length === 0/u, 'no teams: nothing to preview');
  assert.match(workspace, /empty: state\.drawEnabled && savedPrizeCount === 0/u, 'no saved prize: nothing to preview');
  assert.match(workspace, /empty: state\.drawEnabled && state\.luckyIssued === 0/u, 'no number issued: nothing to preview');
  // The orange: exactly one hero button, and the folded settings forms step down to white while it shows.
  const heroes = workspace.match(/<ProductButton[^>]*className=\{styles\.emptyAction\}[^>]*>/gu) || [];
  assert.equal(heroes.length, 1);
  assert.match(heroes[0], /variant="primary"/u);
  assert.equal((workspace.match(/variant=\{heroPrimary \? "secondary" : "primary"\}/gu) || []).length, 2, 'roulette save and the lucky batch button yield to the hero');
  assert.match(workspace, /const heroPrimary = emptyMode && activeRow\.next !== null;/u);
  // Header: the back link is ghost and 추첨 프로그램 만들기 is white; neither is the page's main action.
  assert.match(workspace, /<ProductLink variant="ghost"[^>]*>참여 이벤트<\/ProductLink>/u);
  assert.match(workspace, /<ProductButton type="button" variant="secondary"[^>]*onClick=\{openCreateProgram\}>추첨 프로그램 만들기<\/ProductButton>/u);
  // The blue "공개 상태로 전환한 무대만…" line is gone; the same hand-off is a quiet line beside the empty phone.
  assert.doesNotMatch(workspace, /공개 상태로 전환한 무대만|stagePrerequisiteActions/u);
  assert.match(workspace, /<div className=\{styles\.drawHint\}>/u);
  assert.match(workspace, /참여 이벤트에서 추첨 무대를 만들고 공개하세요\./u, 'the link keeps its text and destination for the audits');
  assert.match(workspace, /\{drawHint\}\s*<\/div>\s*\{stageNotesNode\}/u, 'in the empty stage the hint sits in the info column');
  // CSS: dashed phone, tablet keeps two columns, phone stacks with a full-width button.
  const sheet = stripComments(css);
  assert.match(sheet, /\.emptyPhone \{[^}]*border: 2px dashed var\(--line-strong\)/su);
  assert.match(sheet, /@media \(min-width: 769px\) and \(max-width: 1199px\) \{\s*\.stageCard\[data-empty="true"\] \{ grid-template-columns:/u);
  assert.match(sheet, /\.emptyAction \{ justify-self: stretch; width: 100%; \}/u);
  assert.match(sheet, /\.emptyAction \{[^}]*min-height: 56px/su);
  assert.doesNotMatch(sheet, /#[0-9a-fA-F]{3,8}\b/u);
});
