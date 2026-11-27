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
  assert.equal((metrics.match(/label: "신청"|label: overview\.cancellationReview \? "승인 상태" : "참가 확정"|label: "승인 대기"/g) || []).length, 3, 'exactly 3 pre-event metrics');
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
  // 2026-11-19 redesign: preparing opens with the readiness board (ring, counts, check cards) and
  // live opens with the entry board; both come before the work queue, then the schedule.
  const render = overview.slice(overview.indexOf('return (\n    <ConsolePage'));
  // Reopened 2026-11-27: before the event an exception strip (only with items) precedes the board; the
  // readiness checklist lives inside the board; live and finished keep the queue after the board.
  const exceptionsAt = render.indexOf('{preparing && nowItems.length ? nowSection : null}');
  const heroAt = render.indexOf('{prepHero}');
  const liveAt = render.indexOf('{liveBoard}');
  const scheduleAt = render.lastIndexOf('headingId="event-runbook-heading"');
  const queueAt = render.indexOf('!preparing && currentStage !== "ARCHIVED" ? nowSection : null');
  const finishedMetricsAt = render.indexOf('headingId="event-metrics-heading"');
  assert.ok(exceptionsAt >= 0 && exceptionsAt < heroAt && heroAt < liveAt && liveAt < queueAt, 'the stage board leads, then the work queue');
  assert.ok(queueAt < finishedMetricsAt && finishedMetricsAt < scheduleAt, 'finished stages keep their summary between the queue and the schedule');
  assert.ok(overview.indexOf('id="event-readiness-heading"') >= 0, 'preparation keeps its readiness checklist');
  assert.match(overview, /!preparing && currentStage !== "ARCHIVED" \? nowSection : null/u, 'archived events omit the queue while retaining metrics and close status');
  assert.ok(overview.indexOf('board.steps') >= 0 && overview.indexOf('board.steps') < overview.indexOf('board.countCard'), 'stage steps top the preparation board above the counts');
  assert.ok(render.indexOf('headingId="event-close-status-heading"') < finishedMetricsAt, 'finished events keep close status ahead of metrics');
  assert.match(overview, /href=\{`\$\{base\}\/analysis`\}/u, '기간 분석은 전용 화면으로 연결하는 한 줄만 둔다');
  assert.doesNotMatch(overview, /analysisDetails|<summary>기간 분석<\/summary>/u, '운영 현황에는 기간 분석 접이식을 두지 않는다');
  assert.match(overview, /recentCompact/u);
  assert.match(overview, /기본 디자인 사용 중/u);
  assert.match(overview, /꾸미기는 선택 사항/u);
  assert.doesNotMatch(overview, /아직 게시하지 않았습니다/u);
});

test('event-home-entry-rate-matches-the-report-definition', () => {
  assert.match(overview, /records\(workspace\.participants\)\.filter\(\s*\(person\) => String\(person\.status \|\| ""\)\.toUpperCase\(\) !== "CANCELLED"\s*\)/);
  assert.match(overview, /const everIn = participantRows\.filter\(\(person\) => person\.everIn === true\)\.length/);
  assert.match(overview, /entryRate: registered \? Math\.round\(\(everIn \/ registered\) \* 100\) : 0/);
  assert.match(overview, /"취소 제외"\} 등록 대비/);
  assert.doesNotMatch(overview, /승인된 참가자[^\n]*입장률/);
});

test('event-home-refresh-stamps-a-successful-read-and-wakes-the-shell', () => {
  assert.match(overview, /updatedAt: now\.toISOString\(\)/);
  assert.match(overview, /<time dateTime=\{overview\.updatedAt\}>마지막 갱신/);
  // Focus still refreshes the page. The timer is scoped to the live
  // operator overview and manual refresh still wakes the shell.
  assert.match(overview, /다른 화면에서 돌아오면 갱신/);
  assert.match(overview, /subscribeConsoleFreshness/);
  assert.match(overview, /const endpoint = `\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/bootstrap`/);
  assert.match(overview, /consoleFetch\(version \? `\$\{endpoint\}\?ifVersion=\$\{encodeURIComponent\(version\)\}&messageRecipientReview=1` : `\$\{endpoint\}\?messageRecipientReview=1`, \{\s*cache: "no-store", signal: controller\.signal/);
  assert.match(overview, /setReloadRequest\(\(\{ sequence \}\) => \(\{ sequence: sequence \+ 1, automatic: false \}\)\)/);
  assert.match(overview, /eventouch:shell-reload/);
  assert.match(overview, /formatCheckTime\(check\.at\)/);
  assert.match(overview, /<time className=\{styles\.checkTime\} dateTime=\{check\.at \|\| undefined\}>/);
});

test('event-home-keeps-permission-and-stage-transition-contracts', () => {
  assert.match(overview, /loginHrefForLocation\(window\.location\.pathname, window\.location\.search\)/);
  const settings = fs.readFileSync(
    path.join(ROOT, 'apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx'),
    'utf8'
  );
  assert.match(settings, /\/api\/events\/\$\{encodeURIComponent\(attempt\.eventId\)\}\/commands/);
  assert.match(settings, /command: "event\.stage"/);
  assert.match(settings, /const commandId = stageCommandIdRef\.current/);
  assert.match(settings, /const payload = \{\s*stage: nextStage\s*\}/);
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
