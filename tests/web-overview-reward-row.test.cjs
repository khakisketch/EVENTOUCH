'use strict';

// 운영 현황 gets one quiet "경품 확인 필요" task row (owner decision 2026-11-18).
// It must never take the single orange action, never appear when the 경품
// feature is off or nothing needs a look, and never touch the approved
// readiness links that web-event-overview-priority pins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const overview = fs.readFileSync(path.join(root, 'apps/web/app/console/events/[id]/EventOverview.tsx'), 'utf8');
const navigation = fs.readFileSync(path.join(root, 'apps/web/app/console/console-navigation.ts'), 'utf8');

test('the reward row is built from the shared count and only while the feature is on', () => {
  assert.match(overview, /import \{ countRewardAttention \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/reward-status";/);
  assert.match(overview, /rewardAttention: Array\.isArray\(event\.features\) && event\.features\.includes\("reward"\)\s*\? countRewardAttention\(workspace\)\?\.attention \?\? null : null,/);
  assert.match(overview, /if \(overview\.rewardAttention !== null && overview\.rewardAttention > 0\) \{/, 'zero or unknown shows nothing');
});

test('the row is appended after every other task so it cannot become the primary action', () => {
  const rewardAt = overview.indexOf('key: "reward-attention"');
  assert.ok(rewardAt > 0);
  for (const key of ['cancellation-review', 'approval', 'waitlist-review', 'message-attention', 'golive', 'reports']) {
    assert.ok(overview.indexOf(`key: "${key}"`) < rewardAt, `${key} stays ahead of the reward row`);
  }
  assert.ok(overview.indexOf('for (const task of overview.modulesAvailable') < rewardAt, 'participation tasks stay ahead too');
  const row = overview.slice(rewardAt, overview.indexOf('});', rewardAt));
  assert.match(row, /title: "경품 확인 필요"/);
  assert.match(row, /href: `\$\{base\}\/rewards`/);
  assert.match(row, /action: "경품 지급 현황"/);
});

// Reopened 2026-11-24 (owner: 경품 대기 한 줄, 링 필수 기준): a 경품 지급 대기 row joins the same list while live.
test('the 경품 지급 대기 row precedes the 확인 필요 row and is built from the same shared count', () => {
  const waitingAt = overview.indexOf('key: "reward-waiting"');
  assert.ok(waitingAt > 0 && waitingAt < overview.indexOf('key: "reward-attention"'));
  assert.match(overview, /countRewardAttention\(workspace\)\?\.waiting \?\? null/);
});

test('the queue still gives only its first row the primary role', () => {
  // The four readiness links stay pinned by web-event-overview-priority.test.cjs.
  const queue = fs.readFileSync(path.join(root, 'apps/web/app/console/console-ui/ConsoleTaskQueue.tsx'), 'utf8');
  assert.match(queue, /variant=\{index === 0 && !liveOverview \? "primary" : "ghost"\}/u, 'the queue still gives only its first row the primary role');
});

test('the rail names the screen as an oversight view and the action keeps its own name', () => {
  assert.match(navigation, /rewards: \{ label: "경품 지급", title: "경품 지급"/);
  const screen = fs.readFileSync(path.join(root, 'apps/web/app/console/events/[id]/rewards/RewardsWorkspace.tsx'), 'utf8');
  assert.match(screen, /aria-label="경품 지급 목록"/, 'the list region must not share the page heading name');
  assert.doesNotMatch(screen, /aria-label="경품 지급 현황"/);
  assert.match(screen, /수령 처리/, '수령 처리 stays the action name');
});
