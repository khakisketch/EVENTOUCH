'use strict';

// Team -> operations staff handoff (candidates 1/2) plus the same-day
// display reorder (candidate 5). Source-only assertions plus behavioral
// checks of the real helper logic; rendering and browser exercise belong
// to main.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const TEAM = 'app/console/team/TeamWorkspace.tsx';
const OPS = 'app/console/events/[id]/operations/OperationsWorkspace.tsx';

let handoff = null;
before(async () => {
  // The helper is TypeScript with an extensionless Next.js import; execute
  // the verbatim logic by rewriting only that specifier to a scratch copy.
  const web = path.join(WEB, 'app');
  const dir = '/tmp/opencode/eventouch-handoff-under-test';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'event-stage.ts'),
    fs.readFileSync(path.join(web, 'event-stage.ts'), 'utf8')
  );
  const source = fs.readFileSync(path.join(web, 'console', 'console-handoff.ts'), 'utf8');
  const rewritten = source.replace(
    /from\s+["']\.\.\/event-stage["']/,
    'from "./event-stage.ts"'
  );
  assert.notEqual(rewritten, source, 'helper must reuse eventStageLabel, not a copy');
  const helperPath = path.join(dir, 'console-handoff.under-test.ts');
  fs.writeFileSync(helperPath, rewritten);
  handoff = await import(`file://${helperPath}`);
});

// --- helper behavior: team event options -----------------------------------

test('active stages sort before closed ones, unknown stages last, stably', () => {
  const events = [
    { id: 'archived', name: '보관 행사', stage: 'ARCHIVED' },
    { id: 'mystery', name: '미지정 행사', stage: '' },
    { id: 'live', name: '진행 행사', stage: 'LIVE' },
    { id: 'draft', name: '기획 행사', stage: 'DRAFT' },
    { id: 'ended', name: '종료 행사', stage: 'ENDED' },
    { id: 'ready', name: '준비 행사', stage: 'READY' },
    { id: 'weird', name: '이상 단계', stage: 'SOMEDAY' },
    { id: 'live2', name: '진행 행사 둘', stage: 'live' },
  ];
  const sorted = handoff.sortTeamEventsForAssign(events);
  assert.deepEqual(
    sorted.map((event) => event.id),
    ['draft', 'ready', 'live', 'live2', 'ended', 'archived', 'mystery', 'weird']
  );
  // Stability: equal ranks keep bootstrap order (live before live2,
  // mystery before weird).
  assert.deepEqual(events.map((event) => event.id), [
    'archived', 'mystery', 'live', 'draft', 'ended', 'ready', 'weird', 'live2',
  ]);
});

test('option labels name the server stage and flag read-only/unknown', () => {
  assert.equal(
    handoff.teamEventOptionLabel({ id: 'e1', name: '파트너 컨퍼런스', stage: 'LIVE' }),
    '파트너 컨퍼런스 · 진행 중'
  );
  assert.equal(
    handoff.teamEventOptionLabel({ id: 'e2', name: '기획 회의', stage: 'draft' }),
    '기획 회의 · 기획'
  );
  // Archived events stay selectable but read as read-only; ended events
  // keep only their stage (assignment still writes there server-side).
  assert.equal(
    handoff.teamEventOptionLabel({ id: 'e3', name: '작년 행사', stage: 'ARCHIVED' }),
    '작년 행사 · 보관 · 읽기 전용'
  );
  assert.equal(
    handoff.teamEventOptionLabel({ id: 'e4', name: '지난 행사', stage: 'ENDED' }),
    '지난 행사 · 종료'
  );
  assert.equal(
    handoff.teamEventOptionLabel({ id: 'e5', name: '미지정 행사', stage: '' }),
    '미지정 행사 · 단계 확인 필요'
  );
  assert.equal(
    handoff.teamEventOptionLabel({ id: 'e6', name: '', stage: 'READY' }),
    'e6 · 운영 준비'
  );
});

test('assign-account param reads trimmed, absent reads empty', () => {
  assert.equal(handoff.readAssignAccountParam('?assignAccount=abc-123'), 'abc-123');
  assert.equal(handoff.readAssignAccountParam('?assignAccount=%20abc%20'), 'abc');
  assert.equal(handoff.readAssignAccountParam('?other=1'), '');
  assert.equal(handoff.readAssignAccountParam(''), '');
});

test('staff handoff href carries the person as a query before the anchor', () => {
  assert.equal(
    handoff.buildStaffAssignHandoffHref('event-1', 'staff-9'),
    '/console/events/event-1/operations?assignAccount=staff-9#ops-staff'
  );
  assert.equal(
    handoff.buildStaffAssignHandoffHref('event 1', 'a/b'),
    '/console/events/event%201/operations?assignAccount=a%2Fb#ops-staff'
  );
});

// --- team screen wiring ------------------------------------------------------

test('team parses the server stage and offers staged, sorted options', () => {
  const team = read(TEAM);
  assert.match(team, /stage: text\(event\.stage\)\.toUpperCase\(\)/u, 'stage comes from the server record');
  assert.match(team, /sortTeamEventsForAssign\(events\)/u, 'options sort active before closed');
  assert.match(team, /teamEventOptionLabel\(item\)/u, 'options read 이름 · 단계');
  assert.match(team, /buildStaffAssignHandoffHref\(chosen\.id, accountId\)/u, 'the link hands off the person as a query');
  // Lone-event preselect and the existing guidance stay.
  assert.match(team, /events\.length === 1 && events\[0\] \? events\[0\]\.id : ""/u);
  assert.match(team, /배정할 행사를 선택하세요/u);
  assert.match(team, /배정할 행사를 선택하면 이동 링크가 나타납니다/u);
  assert.match(team, /배정할 수 있는 행사가 없습니다/u);
  // The team screen still never writes: no assignment command passes here.
  assert.doesNotMatch(team, /staff\.assign/u);
  assert.doesNotMatch(team, /\/commands/u);
});

// --- operations dialog wiring -------------------------------------------------

test('operations reuses its dialog for the handed-off person, never autosubmits', () => {
  const source = read(OPS);
  // The existing preset grows one optional field; row presets are untouched.
  assert.match(source, /accountId\?: string \}/u, 'preset account is optional');
  assert.match(source, /initialAccountId=\{assignPreset\?\.accountId\}/u);
  assert.match(source, /initialAccountId\?: string;/u);
  assert.match(source, /useState\(initialAccountId \?\? ""\)/u);
  assert.match(source, /accountId !== \(initialAccountId \?\? ""\)/u, 'initial values are not dirty');
  // Generic entry still resets; row entries still carry their target.
  assert.match(source, /setAssignPreset\(null\); setAssignOpen\(true\)/u);
  assert.match(source, /setAssignPreset\(\{ type: "DESK", targetId: desk\.id \}\)/u);
  assert.match(source, /setAssignPreset\(\{ type: "BOOTH", targetId: booth\.id \}\)/u);
  assert.match(source, /disabled=\{busy \|\| !accountId \|\| !currentTarget\}/u, 'staff choice still gates submit');
  assert.equal(source.match(/staff\.assign/g)?.length ?? 0, 1, 'the existing assign call stays the only one');
});

test('handoff opens the dialog once after load, validates, then consumes the param', () => {
  const source = read(OPS);
  assert.match(source, /readAssignAccountParam\(window\.location\.search\)/u);
  assert.match(source, /assignHandoffAppliedRef\.current === eventId/u, 'one application per event');
  assert.match(source, /handoffBlocked = handoffArchived \|\| !state\.canManage/u, 'permission and archived gate the open');
  assert.match(source, /person\.role !== "STAFF" \|\| !person\.active/u, 'only active staff preselect');
  assert.match(source, /setAssignPreset\(\{ accountId: person\.id \}\)/u, 'the preset carries the person, no target');
  assert.match(source, /url\.searchParams\.delete\("assignAccount"\)/u, 'only that param is removed');
  assert.match(source, /window\.history\.replaceState/u, 'no navigation on consume');
  assert.match(source, /\$\{url\.hash\}/u, 'the hash survives the consume');
  // Invalid cases state the reason and write nothing.
  assert.match(source, /요청한 스태프를 찾을 수 없습니다/u);
  assert.match(source, /바로 배정하지 않았습니다/u);
  assert.match(source, /보관된 행사는 읽기 전용이라 배정을 열 수 없습니다/u);
  assert.match(source, /배정할 데스크나 부스가 없어 배정을 열 수 없습니다/u);
  const handoffAt = source.indexOf('Team -> operations handoff');
  const handoffBody = source.slice(handoffAt, source.indexOf('}, [state, eventId]);', handoffAt));
  assert.doesNotMatch(handoffBody, /runCommand|postCommand/u, 'the handoff itself never commands');
  assert.doesNotMatch(source, /useSearchParams/u, 'no router query hook for the handoff');
});

// --- candidate 5: display moves to second, verbatim ----------------------------

test('jump nav lists same-day work first and presets last', () => {
  const source = read(OPS);
  const navAt = source.indexOf('label="현장 운영 구역"');
  assert.ok(navAt >= 0, 'expected the operations jump nav');
  const navBlock = source.slice(navAt, navAt + 2000);
  const order = ['ops-desks', 'ops-display', 'ops-booths', 'ops-staff', 'ops-booth-mode', 'ops-booth-map'];
  let last = -1;
  for (const id of order) {
    const at = navBlock.indexOf(`"${id}"`);
    assert.ok(at > last, `${id} follows the same-day-first nav order`);
    last = at;
  }
});

test('display section sits second in the DOM with its copy and handlers intact', () => {
  const source = read(OPS);
  const order = ['ops-desks', 'ops-display', 'ops-booths', 'ops-booth-mode', 'ops-booth-map', 'ops-staff'];
  let last = -1;
  for (const id of order) {
    const at = source.indexOf(`headingId="${id}"`);
    assert.ok(at > last, `${id} follows the DOM order`);
    last = at;
  }
  assert.equal(source.match(/headingId="ops-display"/g)?.length ?? 0, 1, 'one display section, moved not copied');
  // Verbatim block: title, copy, controls, handler wiring.
  assert.match(source, /title="전광판 출력" description="지금 할 일"/u);
  assert.match(source, /htmlFor="ops-display-pick">전광판 출력 선택/u);
  assert.match(source, /<option value="">출력 고르기<\/option>/u);
  assert.match(source, /게시한 공지·공개된 프로그램만 고를 수 있습니다/u);
  assert.match(source, /선택한 출력은 아직 적용되지 않았습니다/u);
  assert.match(source, /onClick=\{\(\) => void applyDisplayChoice\(\)\}/u);
  assert.match(source, /display\.set/u);
  // No new jump machinery: the existing anchors keep working.
  assert.doesNotMatch(source, /data-skip-to/u, 'no new skip shortcuts');
});
