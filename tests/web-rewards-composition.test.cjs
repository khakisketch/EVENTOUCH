'use strict';

// Approved rewards composition (2026-11-14): an oversight screen, not a
// handout desk. One row of count tabs (was: summary card with ring + tiles), then a
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
  // Reopened 2026-11-20 (owner: 카드 띠도 개수 탭으로): the summary card (ring + three tiles) is one
  // row of count tabs; the progress stays a quiet "지급 완료 n / m" text beside it.
  assert.match(rewards, /<CountTabs\s+className=\{styles\.rewardTabs\}\s+ariaLabel="상태별 보기"/u);
  assert.doesNotMatch(rewards, /styles\.ring|styles\.tile|styles\.summary/u, 'no ring or tiles');
  for (const tone of ['attention', 'waiting', 'received']) assert.match(rewards, new RegExp(`key: "${tone}"`, 'u'), `${tone} tab`);
  assert.match(rewards, /key: "attention", label: "확인 필요", count: countAttention, tone: "wait"/u, 'blocked prizes are waiting work (amber)');
  assert.match(rewards, /label: "확인 필요"[\s\S]*label: "지급 대기"[\s\S]*label: "완료·취소"/u, 'groups read 확인 필요 → 지급 대기 → 완료·취소');
  // Reopened 2026-11-20 (디자인 시스템 적용): rows are the shared ListRow + ConsoleAvatar + StatusPill; 완료·취소 is folded.
  assert.match(rewards, /<ListRow[\s\S]{0,200}leading=\{<ConsoleAvatar name=\{unassigned \? "\?"/u, 'rows lead with the recipient, an unassigned company win shows "?"');
  assert.match(rewards, /<StatusPill tone="ok" size="sm">수령 완료<\/StatusPill>/u);
  assert.match(rewards, /group\.key === "done"[\s\S]{0,400}<details key=\{group\.key\} className=\{styles\.doneFold\}/u, '완료·취소 is folded away from the waiting work');
  assert.doesNotMatch(rewards, /ConsoleToolbar|consoleUiStyles\.recordRow/u, 'no toolbar or record rows');
});

test('a blocked prize never offers 수령 처리; cancel hides inside the row; confirms and recovery stay', () => {
  assert.match(rewards, /const canFulfill = state\.featureOn && canAct && \(reward\.status === "READY" \|\| reward\.status === "FAILED"\) && !reward\.participantIssue;/u);
  assert.match(rewards, /variant="destructive"[\s\S]{0,260}경품 취소<\/ProductButton>/u, 'cancel lives in the expanded row');
  assert.match(rewards, /aria-expanded=\{expanded\}\s+aria-controls=\{bodyId\}/u, 'the row opens with a 상세 disclosure button');
  assert.match(rewards, /<ConsoleConfirm/u, 'fulfil and cancel keep their in-place confirmation');
  assert.match(rewards, /reward-recovery-heading/u, 'uncertain-outcome recovery stays at the top');
  assert.match(rewards, /id=\{`reward-participant-\$\{reward\.id\}`\} role="note"/u, 'the full reason sentence stays readable');
  assert.match(rewards, /추첨에서 수령자 지정/u);
  assert.match(rewards, /참가자 명단에서 확인/u);
  assert.match(rewards, /기프티콘 지급\(모의\)/u, 'gift fulfilment still says mock');
});

test('state is shape + colour, tokens only, 44px targets, one line per row on phones', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u);
  // State is the StatusPill word plus the avatar tone (ok / wait / neutral), never colour alone.
  assert.match(rewards, /const avatarTone: ConsoleAvatarTone = reward\.status === "RECEIVED" \? "ok"/u);
  // Reopened 2026-11-20 (shared gaps): the 44px action floor is the one shared `.product-action` rule (product-ui.css);
  // per-screen `min-height: 44px` repeats were no-ops and are gone.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'app', 'product-ui.css'), 'utf8'), /\.product-action \{[^}]*min-block-size: var\(--control-min-size\)/su, 'every action keeps a 44px target');
  assert.doesNotMatch(css, /\.rowFoot :global\(\.product-action\)/u, '44px targets come from the shared floor');
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.rowActions\s*\{[^}]*padding/u, 'on phones the action drops under the row');
  assert.doesNotMatch(css, /font-weight:\s*[1-9]\d\d\b/u, 'weights are tokens');
});

// Reopened 2026-11-19: same composition, stronger presentation. The search carries a
// glyph, group headings a mark and count (the tile share bars went with the tiles on 2026-11-20).
test('Reopened 2026-11-19: search has a glyph, groups have a mark and count', () => {
  assert.match(rewards, /<SearchIcon \/>/u);
  assert.match(rewards, /className=\{styles\.groupCount\}/u);
  assert.match(css, /\.row \+ \.row \{ border-top: 1px solid var\(--line\); \}/u);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u);
});
