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

test('event-home-metrics-follow-the-event-stage', () => {
  const metrics = between(overview, 'function metricsForStage', 'function problemsForStage');
  assert.match(metrics, /case "DRAFT":\s*case "READY":/);
  for (const label of ['신청', '참가 확정', '승인 대기', '대기 명단 \/ 정원']) {
    assert.ok(metrics.includes(label), `DRAFT/READY metric missing: ${label}`);
  }
  assert.match(metrics, /overview\.capacity > 0/);

  const live = between(metrics, 'case "LIVE":', 'case "ENDED":');
  for (const label of ['누적 입장', '현재 입장', '확정자 중 미입장', '취소 제외 등록 대비 입장률']) {
    assert.ok(live.includes(label), `LIVE metric missing: ${label}`);
  }

  const ended = between(metrics, 'case "ENDED":', 'case "ARCHIVED":');
  for (const label of ['최종 누적 입장', '취소 제외 등록 대비 입장률', '설문 응답', '보고서 상태']) {
    assert.ok(ended.includes(label), `ENDED metric missing: ${label}`);
  }
  assert.match(ended, /overview\.surveyResponseCount === null/);

  const archived = metrics.slice(metrics.indexOf('case "ARCHIVED":'));
  for (const label of ['취소 제외 등록', '최종 누적 입장', '취소 제외 등록 대비 입장률', '보고서 상태']) {
    assert.ok(archived.includes(label), `ARCHIVED summary metric missing: ${label}`);
  }
  assert.match(archived, /읽기 전용 요약/);
});

test('event-home-problems-are-data-backed-and-stage-gated', () => {
  const problems = between(overview, 'function problemsForStage', 'function displayName');
  assert.match(problems, /const pendingCanBeApproved =\s*stage !== "ENDED" && stage !== "ARCHIVED"/);
  assert.match(problems, /if \(pendingCanBeApproved && overview\.pendingApproval > 0\)/);
  assert.match(problems, /participants\?status=PENDING/);
  assert.match(problems, /stage === "READY" \|\| stage === "LIVE"/);
  assert.match(problems, /overview\.deskCount === 0 \|\| overview\.deskAssignmentCount === 0/);
  assert.match(overview, /\["FAILED", "PARTIAL", "NEEDS_CONNECTION"\]/);
  assert.match(problems, /booth\.capacity > 0 && booth\.used >= booth\.capacity/);
  assert.match(problems, /overview\.reportCount === 0 \|\| overview\.draftReportCount === overview\.reportCount/);
  assert.match(problems, /return problems\.slice\(0, 5\)/);
  assert.match(overview, /problems\.length > 0 \?/);
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
  assert.match(overview, /자동 갱신되지 않습니다/);
  assert.match(overview, /fetch\("\/api\/bootstrap", \{ cache: "no-store" \}\)/);
  assert.match(overview, /setReloadTick\(\(tick\) => tick \+ 1\)/);
  assert.match(overview, /eventouch:shell-reload/);
  assert.match(overview, /formatCheckTime\(check\.at\)/);
  assert.match(overview, /<time className=\{styles\.timestamp\} dateTime=\{check\.at \|\| undefined\}>/);
});

test('event-home-keeps-permission-and-stage-transition-contracts', () => {
  assert.match(overview, /loginHrefForLocation\(window\.location\.pathname, window\.location\.search\)/);
  assert.match(overview, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/);
  assert.match(overview, /command: "event\.stage"/);
  assert.match(overview, /commandId: stageCommandIdRef\.current/);
  assert.match(overview, /payload: \{\s*stage: nextStage\s*\}/);
  assert.match(overview, /setStageConfirm\(true\)/);
  assert.match(overview, /정말 전환합니다/);
  assert.match(overview, /취소/);
  assert.match(overview, /"단계 미정"/);
  assert.match(overview, /overview\.registrationOpen \? "접수 중" : "접수 마감"/);
  assert.match(overview, /보관된 행사는 읽기 전용입니다\./);
  assert.match(overview, /const archived = currentStage === "ARCHIVED"/);
  assert.doesNotMatch(overview, /stage:\s*"(?:LIVE|ARCHIVED)"\s*\}/);
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
