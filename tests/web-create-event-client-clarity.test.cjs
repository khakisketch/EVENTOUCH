'use strict';

// Event-creation customer clarity: registering a customer mid-draft commits
// immediately (the record survives a discarded draft), and duplicate mode
// cannot register inline — both facts read on screen instead of surprising
// the operator. Source contracts pin the copy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

test('event creation names the leftover customer and the duplicate limit', () => {
  const dialog = read('app/console/CreateEventDialog.tsx');
  assert.match(dialog, /등록한 고객사는 행사 작성을 취소해도 고객사 목록에 남습니다\./u, 'mid-draft remainder reads on screen');
  assert.match(dialog, /복제 중에는 고객사를 새로 등록할 수 없습니다\./u, 'duplicate-mode limit names itself');
  assert.match(dialog, /복제를 마친 뒤 행사 설정에서 바꾸거나, 고객사 화면에서 먼저 등록한 뒤 이 화면을 다시 여세요\./u, 'duplicate-mode recovery names the path');
});
