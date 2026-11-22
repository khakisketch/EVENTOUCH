'use strict';

// 2026-11-22 코드 리뷰에서 확인된 결함의 수정. 순수 모듈은 직접 실행하고, 화면 안쪽은 소스 단언으로 고정한다
// (실제 동작은 격리 브라우저에서 확인).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { attendeeScreenStatuses, firstPendingTab } = require('../apps/web/lib/attendee-screen-status.ts');

const app = path.join(__dirname, '..', 'apps', 'web', 'app');
const read = (...parts) => fs.readFileSync(path.join(app, ...parts), 'utf8');
const published = { pageExperience: { publishedAt: 'x', draftVersion: 1, publishedVersion: 1 } };
const venue = (draft, map) => ({ name: '홀', address: '서울', directions: '', contact: '', description: '', map, draft: { name: '홀', address: '서울', directions: '', contact: '', description: '', map, ...draft } });

test('허브: 게시하지 않은 장소 안내 수정은 "모두 게시됨"으로 가려지지 않는다', () => {
  const event = { features: ['venue'] };
  const clean = attendeeScreenStatuses(event, { ...published, notices: [], program: [], venue: venue({}) })[1];
  assert.equal(clean.pending, 0);
  const edited = attendeeScreenStatuses(event, { ...published, notices: [], program: [], venue: venue({ address: '부산' }) })[1];
  assert.deepEqual([edited.tone, edited.pending, edited.label], ['wait', 1, '공지·안내 · 게시 전 1건']);
  const mapChanged = attendeeScreenStatuses(event, { ...published, notices: [], program: [], venue: venue({ map: { image: { fileId: 'b' }, alt: 'x' } }, { image: { fileId: 'a' }, alt: 'x' }) })[1];
  assert.equal(mapChanged.pending, 1, 'a replaced 안내도 is an unpublished edit');
  const off = attendeeScreenStatuses({ features: [] }, { ...published, notices: [], program: [], venue: venue({ address: '부산' }) })[1];
  assert.equal(off.pending, 0, 'an event without the venue feature has no 장소 안내 tab to publish from');
});

test('허브: 링크가 여는 탭의 건수를 따로 알려, 약속한 건수와 열리는 화면이 어긋나지 않는다', () => {
  const statuses = attendeeScreenStatuses({ features: ['venue'] }, { pageExperience: { publishedAt: null }, notices: [{ id: 'n', title: 't', published: false }], program: [] });
  assert.deepEqual(firstPendingTab(statuses), { tab: 'design', count: 2, tabCount: 1 });
  const hub = read('console', 'events', '[id]', 'AttendeeScreenHub.tsx');
  assert.match(hub, /pending\.count > pending\.tabCount/);
  assert.match(hub, /\$\{pendingTab\.label\} \$\{pending\.tabCount\}건부터 확인/);
});

test('허브: 가장 최근 읽기만 상태를 쓰고, 행사가 바뀌면 늦은 응답은 버려진다', () => {
  const hub = read('console', 'events', '[id]', 'AttendeeScreenHub.tsx');
  assert.match(hub, /const ticket = \+\+latest\.current;/);
  assert.match(hub, /ticket === latest\.current\) setSummary\(next\)/);
  assert.match(hub, /latest\.current \+= 1;\s*unsubscribe\(\);/);
});

test('행사 설정: 정원 빈 칸·오타는 무제한(0)으로 저장되지 않고 칸에 오류가 붙는다', () => {
  const workspace = read('console', 'events', '[id]', 'settings', 'SettingsWorkspace.tsx');
  assert.match(workspace, /if \(!\/\^\\d\+\$\/\.test\(basics\.capacity\.trim\(\)\)\) \{\s*setFailure\(\{ message: "정원은 0 이상의 숫자로 입력해 주세요\. 제한이 없으면 0을 입력합니다\.", field: "capacity" \}\);\s*return;/);
  assert.match(workspace, /capacity: Number\(basics\.capacity\.trim\(\)\),/, 'the validated value is sent as is, not through `|| 0`');
});

test('취소 확정 요청 id는 crypto.randomUUID가 없는 환경에서도 만들어진다', () => {
  const review = read('console', 'events', '[id]', 'participants', 'CancellationConflictReview.tsx');
  assert.match(review, /typeof crypto\.randomUUID === "function" \? crypto\.randomUUID\(\) : `web-\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(review, /commandId: crypto\.randomUUID\(\)/);
});

test('신청 링크 복사는 클립보드가 없는 환경에서도 실패를 알린다', () => {
  const roster = read('console', 'events', '[id]', 'participants', 'ParticipantList.tsx');
  assert.match(roster, /if \(typeof navigator\.clipboard\?\.writeText !== "function"\) \{ copyFailed\(\); return; \}/);
  assert.doesNotMatch(roster, /navigator\.clipboard\s*\n\s*\?\.writeText/);
});

test('현장 출력 선택지는 꺼진 기능의 모듈·사진을 내놓지 않는다(서버 setDisplay 계약과 같다)', () => {
  const model = read('console', 'events', '[id]', 'live', 'live-model.ts');
  assert.match(model, /if \(!enabled\.has\(module\.type\)\) return \[\];/);
  assert.match(model, /approvedPhotos: enabled\.has\("photo"\) \?/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'commands', 'engagement.js'), 'utf8');
  assert.match(server, /!list\(ctx\.event\.features\)\.includes\(type\)/, 'the server refuses a module of a feature that is off');
});
