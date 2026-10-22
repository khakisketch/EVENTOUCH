'use strict';

// Staff assignment dialog: an empty staff directory must hand the operator a
// way forward (team invite deep link + reopen guidance with the target kept),
// and a stale preset target must read out loud instead of silently blocking
// save. Source contracts pin the copy and the state path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const OPS = 'app/console/events/[id]/operations/OperationsWorkspace.tsx';

test('empty staff directory links to the invite screen with reopen guidance', () => {
  const workspace = read(OPS);
  assert.match(workspace, /팀·권한에서 현장 스태프 초대/u, 'invite entry names its destination');
  assert.match(workspace, /href="\/console\/team"/u, 'invite entry is a deep link, not prose');
  assert.match(workspace, /초대 수락 후 다시 여세요\. 닫기 전 고른 데스크·부스 대상은 유지됩니다\./u, 'reopen keeps the chosen target');
});

test('closing the dialog keeps the preset target', () => {
  const workspace = read(OPS);
  assert.match(workspace, /onClose=\{\(\) => \{ setAssignDirty\(false\); setAssignOpen\(false\); \}\}/u, 'dismissal no longer drops the preset');
  assert.match(workspace, /if \(ok\) \{ setAssignDirty\(false\); setAssignOpen\(false\); setAssignPreset\(null\); \}/u, 'only a committed assignment clears the preset');
});

test('a stale assignment target warns inline instead of blocking silently', () => {
  const workspace = read(OPS);
  assert.match(workspace, /targetStale = targetId !== "" && currentTarget === ""/u, 'staleness is detected, not swallowed');
  assert.match(workspace, /선택한 담당 대상을 찾을 수 없습니다\. 삭제되었거나 부스 인증 방식이 바뀌어 목록에서 빠졌습니다\./u, 'the warning names why');
  assert.match(workspace, /담당 대상을 다시 선택하세요\./u, 'the warning names the fix');
});
