'use strict';

// Approved rewards composition (2026-11-14): an oversight screen, not a
// handout desk. One summary card (progress ring + three status tiles), then a
// flat ledger by urgency with recipient avatars. Change it only on a new owner
// decision.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'apps/web/app/console/events/[id]/rewards');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const rewards = read('RewardsWorkspace.tsx');
const css = read('rewards.module.css');

test('approved rewards design stays locked: summary card, then a ledger by urgency', () => {
  assert.match(rewards, /className=\{styles\.summary\}/u);
  assert.match(rewards, /styles\.ring/u, 'progress ring');
  for (const tone of ['attention', 'waiting', 'received']) assert.match(rewards, new RegExp(`"${tone}"`, 'u'), `${tone} tile`);
  assert.match(rewards, /label: "확인 필요"[\s\S]*label: "지급 대기"[\s\S]*label: "완료·취소"/u, 'groups read 확인 필요 → 지급 대기 → 완료·취소');
  assert.match(rewards, /className=\{styles\.avatar\}/u, 'rows lead with the recipient, not a prize icon');
  assert.match(rewards, /data-tone=\{unassigned \? "none"/u, 'an unassigned company win shows a dashed "?"');
  assert.doesNotMatch(rewards, /ConsoleToolbar|ConsoleSection\b|consoleUiStyles\.recordRow/u, 'no toolbar, section panel or record rows');
});

test('a blocked prize never offers 수령 처리; cancel hides inside the row; confirms and recovery stay', () => {
  assert.match(rewards, /const canFulfill = state\.featureOn && canAct && \(reward\.status === "READY" \|\| reward\.status === "FAILED"\) && !reward\.participantIssue;/u);
  assert.match(rewards, /variant="destructive"[\s\S]{0,260}경품 취소<\/ProductButton>/u, 'cancel lives in the expanded row');
  assert.match(rewards, /<details className=\{styles\.rowDetails\}>/u);
  assert.match(rewards, /<ConsoleConfirm/u, 'fulfil and cancel keep their in-place confirmation');
  assert.match(rewards, /reward-recovery-heading/u, 'uncertain-outcome recovery stays at the top');
  assert.match(rewards, /id=\{`reward-participant-\$\{reward\.id\}`\} role="note"/u, 'the full reason sentence stays readable');
  assert.match(rewards, /추첨에서 수령자 지정/u);
  assert.match(rewards, /참가자 명단에서 확인/u);
  assert.match(rewards, /기프티콘 지급\(모의\)/u, 'gift fulfilment still says mock');
});

test('state is shape + colour, tokens only, 44px targets, one line per row on phones', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u);
  assert.match(css, /\.avatar i\s*\{/u, 'corner badge carries the state by shape');
  assert.match(css, /\.pill\s*\{[^}]*min-height:\s*26px/su);
  assert.match(css, /\.rowSummary\s*\{[^}]*min-height:\s*72px/su);
  assert.match(css, /\.rowGo\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.rowGo\s*\{\s*position:\s*static/u);
});

// Reopened 2026-11-19: same composition, stronger presentation. Tiles carry a
// share bar, the search a glyph, group headings a mark and count.
test('Reopened 2026-11-19: tiles show a share bar, search has a glyph, groups have a mark and count', () => {
  assert.match(rewards, /className=\{styles\.tileBar\}/u);
  assert.match(rewards, /Math\.round\(\(count \/ activeTotal\) \* 100\)/u, 'the bar is count over non-cancelled total, never invented');
  assert.match(rewards, /<SearchIcon \/>/u);
  assert.match(rewards, /className=\{styles\.groupCount\} aria-hidden="true"/u, 'the count chip does not change the heading name');
  assert.match(css, /\.row \+ \.row \{ border-top: 1px solid var\(--line\); \}/u);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u);
});
