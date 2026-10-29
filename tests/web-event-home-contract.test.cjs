'use strict';

// Static UI contract for the event operator's situation board. Data and writes
// remain server-authoritative; these assertions pin the derived presentation
// rules without booting Next.js or mutating the demo workspace.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const overview = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/EventOverview.tsx'),
  'utf8'
);

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('event-home-pre-event-metrics-are-compact-and-data-backed', () => {
  const metrics = between(overview, 'function metricsForStage', 'export default function EventOverview');
  assert.match(metrics, /case "DRAFT":\s*case "READY":/);
  for (const label of ['신청', '참가 확정', '승인 대기']) {
    assert.ok(metrics.includes(label), `DRAFT/READY metric missing: ${label}`);
  }
  // Exactly three metric cards: capacity and waitlist survive as metadata,
  // never as a fourth card.
  assert.doesNotMatch(metrics, /대기 명단 \/ 정원/u);
  assert.equal((metrics.match(/label: "/g) || []).length, 3, 'exactly 3 pre-event metrics');
  assert.match(overview, /capacity|정원/u);
  assert.match(overview, /waitlist|대기/u);
  assert.match(metrics, /return \[\];/);
});

test('event-home-removes-redundant-advisory-and-readiness-blocks', () => {
  assert.doesNotMatch(overview, /problemsForStage|problemList|event-problems-heading/);
  assert.doesNotMatch(overview, /event-operations-heading|운영 준비·가동|operationsGrid/);
  assert.doesNotMatch(overview, /event-stage-heading|submitStageTransition|stageCommandIdRef/);
});

test('event-home-leads-with-action-and-keeps-stage-metrics-and-optional-design-copy', () => {
  // Reading order leads with the work queue, while desktop shows metrics in
  // a separate adjacent column. The basic design remains explicitly optional.
  const metricsAt = overview.indexOf('headingId="event-metrics-heading"');
  const scheduleAt = overview.indexOf('headingId="event-runbook-heading"');
  const readinessAt = overview.indexOf('headingId="event-readiness-heading"');
  assert.ok(metricsAt >= 0 && scheduleAt >= 0 && readinessAt >= 0);
  const queueAt = overview.indexOf('{nowSection}', overview.indexOf('return (\n    <ConsolePage'));
  assert.ok(queueAt >= 0 && queueAt < scheduleAt && scheduleAt < readinessAt && readinessAt < metricsAt, 'actions and schedule precede metrics in reading order');
  // Preparation opens with the stage band above the counts; period analysis
  // is a disclosure inside the metrics section, and the empty recent stays
  // compact. The duplicate period section was removed in the Cobalt remake.
  const bandAt = overview.indexOf('stageBand');
  assert.ok(bandAt >= 0 && bandAt < metricsAt, 'stage band tops the preparation flow');
  assert.match(overview, /analysisDetails/u);
  assert.match(overview, /recentCompact/u);
  assert.match(overview, /기본 디자인 사용 중/u);
  assert.match(overview, /꾸미기는 선택 사항/u);
  assert.doesNotMatch(overview, /아직 게시하지 않았습니다/u);
});

test('event-home-entry-rate-matches-the-report-definition', () => {
  assert.match(overview, /records\(workspace\.participants\)\.filter\(\s*\(person\) => person\.status !== "CANCELLED"\s*\)/);
  assert.match(overview, /const everIn = participantRows\.filter\(\(person\) => person\.everIn === true\)\.length/);
  assert.match(overview, /entryRate: registered \? Math\.round\(\(everIn \/ registered\) \* 100\) : 0/);
  assert.match(overview, /취소 제외 등록 대비 입장률/);
  assert.doesNotMatch(overview, /승인된 참가자[^\n]*입장률/);
});

test('event-home-refresh-stamps-a-successful-read-and-wakes-the-shell', () => {
  assert.match(overview, /updatedAt: now\.toISOString\(\)/);
  assert.match(overview, /<time dateTime=\{overview\.updatedAt\}>마지막 갱신/);
  // No silent auto-refresh promise: returning from another screen refreshes
  // on focus instead, through the shared freshness subscription.
  assert.match(overview, /다른 화면에서 돌아오면 갱신/);
  assert.match(overview, /subscribeConsoleFreshness/);
  assert.match(overview, /consoleFetch\(`\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/bootstrap`, \{ cache: "no-store" \}\)/);
  assert.match(overview, /setReloadTick\(\(tick\) => tick \+ 1\)/);
  assert.match(overview, /eventouch:shell-reload/);
  assert.match(overview, /formatCheckTime\(check\.at\)/);
  assert.match(overview, /<time className=\{styles\.timestamp\} dateTime=\{check\.at \|\| undefined\}>/);
});

test('event-home-keeps-permission-and-stage-transition-contracts', () => {
  assert.match(overview, /loginHrefForLocation\(window\.location\.pathname, window\.location\.search\)/);
  const settings = fs.readFileSync(
    path.join(ROOT, 'apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx'),
    'utf8'
  );
  assert.match(settings, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/);
  assert.match(settings, /command: "event\.stage"/);
  assert.match(settings, /commandId: stageCommandIdRef\.current/);
  assert.match(settings, /payload: \{\s*stage: nextStage\s*\}/);
  assert.match(settings, /setStageConfirm\(true\)/);
  const confirmation = fs.readFileSync(path.join(ROOT, 'apps/web/app/console/console-ui/StageTransitionConfirmation.tsx'), 'utf8');
  assert.match(settings, /<StageTransitionConfirmation/);
  assert.match(confirmation, /정말 전환합니다/);
  assert.match(confirmation, /취소/);
  assert.match(settings, /"단계 미정"/);
  assert.match(settings, /보관된 행사는 읽기 전용입니다\./);
  assert.doesNotMatch(overview, /stage:\s*"(?:LIVE|ARCHIVED)"\s*\}/);
  assert.doesNotMatch(overview, /submitStageTransition|setStageConfirm|stageCommandIdRef/);
  assert.doesNotMatch(overview, /window\.confirm/);
  assert.doesNotMatch(overview, /localStorage|sessionStorage/);
  assert.doesNotMatch(overview, /className="notice"/);
});

test('event-home-page-remains-a-thin-wrapper', () => {
  const page = fs.readFileSync(
    path.join(ROOT, 'apps/web/app/console/events/[id]/page.tsx'),
    'utf8'
  );
  assert.match(page, /<EventOverview eventId=\{id\} \/>/);
  assert.doesNotMatch(page, /fetch\(|\/commands|useState/);
});
