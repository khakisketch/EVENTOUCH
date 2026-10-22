'use strict';

// Invite-accept honesty: the STAFF hint must describe the real destination
// (the assignment hub, which can legitimately be empty) instead of promising
// a desk/booth placement, and the empty hub must say where assignments come
// from and who to ask. Source contracts pin the copy; the hub behavior
// (bootstrap read, single-assignment redirect) is covered by the staff flow
// suite and the browser audit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

test('staff invite hints describe the assignment hub, not a placement', () => {
  const invite = read('app/invite/[token]/InviteAccept.tsx');
  assert.doesNotMatch(invite, /데스크·부스 배정으로 연결/u, 'no placement promise');
  assert.match(invite, /운영자가 배정한 업무 목록/u, 'destination is the assigned-work list');
  assert.match(invite, /아직 배정되지 않았다면 대기 상태/u, 'empty hub is named up front');
});

test('empty assignment hub names its source and a contact', () => {
  const hub = read('app/staff/StaffHub.tsx');
  assert.match(hub, /배정된 업무가 없습니다\. 운영자에게 문의하세요\./u, 'existing guidance stays');
  assert.match(hub, /운영 콘솔.*현장 운영.*스태프 배정/u, 'assignment source is named');
  assert.match(hub, /초대 메일·행사 안내의 문의처/u, 'a contact path is named');
  assert.match(hub, /다시 불러오기/u, 'retry stays for a just-assigned staffer');
});
