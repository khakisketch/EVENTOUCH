'use strict';

// 2026-11-22 코드 리뷰에서 확인된 결함의 수정. 순수 모듈은 직접 실행하고, 화면 안쪽은 소스 단언으로 고정한다
// (실제 동작은 격리 브라우저에서 확인).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { attendeeScreenStatuses, firstPendingTab, normalizeVenue, venueDraftDiffers } = require('../apps/web/lib/attendee-screen-status.ts');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '..', 'apps', 'web')] }));

const app = path.join(__dirname, '..', 'apps', 'web', 'app');
const read = (...parts) => fs.readFileSync(path.join(app, ...parts), 'utf8');
// Run a TS source (or just the named top-level pieces of it) without a bundler.
function runTs(source, context = {}) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Intl, Date, Number, String, Array, Math, RegExp, ...context }, {});
  return exports;
}
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
  const statuses = attendeeScreenStatuses({ features: ['venue'] }, { pageExperience: { publishedAt: null }, notices: [{ id: 'n', title: 't', published: true, draft: { title: 't', body: '고침' } }], program: [] });
  // Reopened 2026-11-24 (H1): only a published item with an unpublished edit waits; a never-published one is 임시 저장.
  assert.deepEqual(firstPendingTab(statuses), { tab: 'design', count: 2, tabCount: 1 });
  const hub = read('console', 'events', '[id]', 'AttendeeScreenHub.tsx');
  assert.match(hub, /pending\.count > pending\.tabCount/);
  assert.match(hub, /\$\{pendingTab\.label\} \$\{pending\.tabCount\}건부터 확인/);
});

test('허브: 더 새로운 읽기만 덮어쓰고, 새 읽기가 실패해도 이미 받은 좋은 결과를 버리지 않으며, 다른 행사에는 보이지 않는다', () => {
  const hub = read('console', 'events', '[id]', 'AttendeeScreenHub.tsx');
  assert.match(hub, /const ticket = \+\+issued\.current;/);
  assert.match(hub, /if \(!next \|\| signal\?\.aborted \|\| ticket <= applied\.current\) return;\s*applied\.current = ticket;/);
  assert.match(hub, /const summary = read\?\.eventId === eventId \? read\.summary : null;/);
});

test('행사 설정: 정원 빈 칸·오타·과대값은 무제한(0)으로 저장되지 않고, 두 저장 경로가 같은 규칙과 같은 페이로드를 쓴다', () => {
  const workspace = read('console', 'events', '[id]', 'settings', 'SettingsWorkspace.tsx');
  const a = workspace.indexOf('const CAPACITY_MAX');
  const b = workspace.indexOf('const CAPACITY_MESSAGE');
  const { capacityToSave } = runTs(workspace.slice(a, b) + '\nexports.capacityToSave = capacityToSave;');
  assert.equal(capacityToSave('', '200'), null, 'empty box is not 0');
  assert.equal(capacityToSave('  ', '200'), null);
  assert.equal(capacityToSave('abc', '200'), null);
  assert.equal(capacityToSave('-5', '200'), null);
  assert.equal(capacityToSave('12.5', '200'), null);
  assert.equal(capacityToSave('9'.repeat(30), '200'), null, 'a 30-digit paste is refused, not sent as Infinity');
  assert.equal(capacityToSave('10000001', '200'), null);
  assert.equal(capacityToSave('0', '200'), 0, '0 is the explicit 제한 없음');
  assert.equal(capacityToSave('300', '200'), 300);
  assert.equal(capacityToSave('12.5', '12.5'), 12.5, 'an untouched stored value never blocks an unrelated save');
  assert.equal((workspace.match(/basicsSavePayload\(basics, state\.basics, capacity\)/g) || []).length, 2, 'direct save and slug-confirm share one payload');
  assert.equal((workspace.match(/capacityToSave\(basics\.capacity, state\.basics\.capacity\)/g) || []).length, 2, 'the slug-confirm path validates again');
  assert.equal((workspace.match(/capacity: Number\(basics\.capacity\) \|\| 0/g) || []).length, 1, 'only the saved-baseline payload keeps the lenient reading');
});

test('취소 확정 요청 id는 프로젝트 공용 randomCommandId(시계·Math.random 없는 128비트)를 쓴다', () => {
  const review = read('console', 'events', '[id]', 'participants', 'CancellationConflictReview.tsx');
  assert.match(review, /import \{ randomCommandId \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/command-id";/);
  assert.match(review, /commandId: randomCommandId\(\)/);
  assert.doesNotMatch(review, /crypto\.randomUUID|Math\.random|Date\.now/);
});

test('신청 링크 복사는 클립보드가 없는 환경에서도 실패를 알린다', () => {
  const roster = read('console', 'events', '[id]', 'participants', 'ParticipantList.tsx');
  assert.match(roster, /if \(typeof navigator\.clipboard\?\.writeText !== "function"\) \{ copyFailed\(\); return; \}/);
  assert.doesNotMatch(roster, /navigator\.clipboard\s*\n\s*\?\.writeText/);
});

test('현장 출력: 꺼진 기능의 모듈은 선택지에 없지만, 이미 송출 중이면 그 이름은 계속 보인다', () => {
  const schedule = runTs(read('console', 'events', '[id]', 'live', 'live-schedule.ts'));
  const poll = { id: 'm1', title: '만족도', type: 'poll', published: true, revealed: false, draws: [] };
  const options = (enabled) => ({ notices: [], modules: [{ ...poll, enabled }], approvedPhotos: 0, approvedQuestions: 0 });
  assert.ok(schedule.displayChoices(options(true)).some((c) => c.value === 'poll|m1'));
  assert.ok(!schedule.displayChoices(options(false)).some((c) => c.value === 'poll|m1'), 'the server would refuse it (409)');
  assert.ok(schedule.displayChoices({ notices: [], modules: [poll], approvedPhotos: 0, approvedQuestions: 0 }).some((c) => c.value === 'poll|m1'), 'a missing flag counts as on');
  const onAir = { type: 'poll', moduleId: 'm1', noticeId: '', drawId: '' };
  assert.equal(schedule.currentDisplayLabel(onAir, options(true)), '투표 · 만족도');
  assert.equal(schedule.currentDisplayLabel(onAir, options(false)), '투표 · 만족도 · 기능 꺼짐', 'not "출력 확인 필요"');
  const model = read('console', 'events', '[id]', 'live', 'live-model.ts');
  assert.match(model, /enabled: enabled\.has\(module\.type\),/);
  assert.match(model, /approvedPhotos: enabled\.has\("photo"\) \?/);
  assert.match(model, /approvedQuestions: enabled\.has\("qa"\) \?/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'commands', 'engagement.js'), 'utf8');
  assert.match(server, /!list\(ctx\.event\.features\)\.includes\(type\)/, 'the server refuses a module of a feature that is off');
});

test('허브: 장소 안내 비교는 공지 화면과 같은 정규화를 쓴다(이미지 없는 안내도는 안내도가 아니다)', () => {
  assert.equal(normalizeVenue({ map: { alt: 'x', image: null } }).map, null);
  const draftOnlyAlt = { name: '홀', map: null, draft: { name: '홀', map: { alt: 'x', image: null } } };
  assert.equal(venueDraftDiffers(draftOnlyAlt), false, 'cannot be published from the content screen, so the hub must not count it');
  const renamed = { name: '홀', map: { image: { fileId: 'a', name: '예전.png' }, alt: 'x' }, draft: { name: '홀', map: { image: { fileId: 'a', name: '새.png' }, alt: 'x' } } };
  assert.equal(venueDraftDiffers(renamed), true, 'a renamed 안내도 file is shown as a change by the content screen');
  assert.equal(venueDraftDiffers({ name: '홀', draft: { name: '홀' } }), false);
  const content = read('console', 'events', '[id]', 'content', 'ContentWorkspace.tsx');
  assert.match(content, /import \{ normalizeVenue \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/attendee-screen-status";/);
  assert.match(content, /function parseVenue\(value: unknown\): Venue \{\s*return normalizeVenue\(value\);/);
});

test('허브: 꺼진 기능의 남은 모듈·추첨은 "준비 중"으로 세지 않고, 링크는 대기 중인 하위 탭으로 간다', () => {
  const stale = { ...published, modules: [{ type: 'poll', status: 'DRAFT' }] };
  const row = attendeeScreenStatuses({ features: ['quiz'] }, stale, ['DRAFT'])[2];
  assert.equal(row.label, '참여 이벤트 · 없음', 'a switched-off poll and the draws of a draw feature that is off are ignored');
  const on = attendeeScreenStatuses({ features: ['poll', 'draw'] }, stale, ['OPEN'])[2];
  assert.equal(on.label, '참여 이벤트 · 준비 중 1건');
  const onlyProgram = attendeeScreenStatuses({ features: ['venue'] }, { ...published, notices: [], program: [{ id: 'p', title: '세션', date: '', start: '', end: '', place: '', description: '', published: true, draft: { title: '세션 수정' } }], venue: { name: '홀', draft: { name: '홀' } } })[1];
  assert.equal(onlyProgram.source, 'program');
  const venueOnly = attendeeScreenStatuses({ features: ['venue'] }, { ...published, notices: [], program: [], venue: { name: '홀', draft: { name: '새 홀' } } })[1];
  assert.equal(firstPendingTab([venueOnly]).source, 'venue');
  const hub = read('console', 'events', '[id]', 'AttendeeScreenHub.tsx');
  assert.match(hub, /#content-\$\{\(\{ notice: "notices", program: "program", venue: "venue" \}\)\[pending\.source\]\}/);
});
