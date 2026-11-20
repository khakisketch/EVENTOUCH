'use strict';

// 기간 분석(전용 화면): 운영 현황의 고정 집계(오늘·어제·최근 7일)와 같은
// 취소 제외·정정 제외·고유 입장 정의를 브라우저 로컬 날짜 범위에 그대로
// 적용한다. 계산은 apps/web/lib/period-analysis.ts가 하고(이 파일이 실제
// 모듈을 실행한다), 화면은 같은 값을 SVG·표·요약으로 보여 준다. 외부 차트
// 의존성 없음. 렌더 검증은 실제 빌드에서 감사 스크립트가 한다.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const workspace = read('apps/web/app/console/events/[id]/analysis/PeriodAnalysisWorkspace.tsx')
  + read('apps/web/app/console/events/[id]/analysis/PeriodCharts.tsx'); // Reopened 2026-11-20: charts moved to their own file
const css = read('apps/web/app/console/events/[id]/analysis/analysis.module.css');
const overview = read('apps/web/app/console/events/[id]/EventOverview.tsx');
const libSource = read('apps/web/lib/period-analysis.ts');

function loadLib() {
  const js = ts.transpileModule(libSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const sandbox = { exports: {}, module: { exports: {} } };
  vm.runInNewContext(js, { ...sandbox, require }, { filename: 'period-analysis.ts' });
  return sandbox.exports;
}
const lib = loadLib();

// 로컬 시각 문자열(타임존 영향 없이 같은 달력 날짜가 되도록 정오로 둔다).
const at = (day, hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString();

test('analysis counts per local day with the same dedupe rules as the fixed buckets', () => {
  const result = lib.analyzePeriod(
    [at('2026-11-16'), at('2026-11-17'), at('2026-11-17', 15), 'not-a-date'],
    [
      { at: at('2026-11-17', 9), key: 'p1' },
      { at: at('2026-11-17', 14), key: 'p1' }, // 같은 날 재입장은 한 명
      { at: at('2026-11-17', 10), key: 'p2' },
      { at: at('2026-11-18', 10), key: 'p1' }, // 다음 날 재입장: 일별 합에는 들어가고 기간 고유에는 한 번
    ],
    '2026-11-16',
    '2026-11-18',
  );
  assert.equal(result.error, null);
  assert.deepEqual(Array.from(result.points, (point) => [point.key, point.applications, point.entries]), [
    ['2026-11-16', 1, 0],
    ['2026-11-17', 2, 2],
    ['2026-11-18', 0, 1],
  ]);
  assert.equal(result.periodApplications, 3);
  assert.equal(result.dailyEntriesSum, 3);
  assert.equal(result.periodUnique, 2, '기간 고유 입장은 전체 기간의 중복 제거 수다');
});

test('analysis recovers from bad input and caps extreme ranges', () => {
  assert.match(lib.analyzePeriod([], [], '2026-11-25', '2026-11-20').error, /시작 날짜가 끝 날짜보다 늦습니다/);
  assert.match(lib.analyzePeriod([], [], '2026-13-01', '2026-11-20').error, /YYYY-MM-DD 형식으로 입력하세요/);
  assert.match(lib.analyzePeriod([], [], '2026-02-30', '2026-03-02').error, /YYYY-MM-DD 형식/, '존재하지 않는 날짜는 거부한다');
  const wide = lib.analyzePeriod([], [], '2026-01-01', '2027-12-31');
  assert.equal(wide.clamped, true);
  assert.equal(wide.points.length, lib.RANGE_DAYS_CAP);
  assert.equal(lib.RANGE_DAYS_CAP, 62);
  assert.equal(wide.effectiveTo, wide.points[wide.points.length - 1].key);
});

test('preset buttons resolve to the browser-local calendar days', () => {
  const now = new Date(2026, 10, 18, 13, 5); // 2026-11-18 (로컬)
  const context = { eventDate: '2026-11-10', applications: [at('2026-11-12')], entries: [{ at: at('2026-11-15'), key: 'p' }] };
  assert.deepEqual({ ...lib.presetRange('today', now, context) }, { from: '2026-11-18', to: '2026-11-18' });
  assert.deepEqual({ ...lib.presetRange('yesterday', now, context) }, { from: '2026-11-17', to: '2026-11-17' });
  assert.deepEqual({ ...lib.presetRange('last7', now, context) }, { from: '2026-11-12', to: '2026-11-18' });
  assert.deepEqual({ ...lib.presetRange('all', now, context) }, { from: '2026-11-10', to: '2026-11-18' }, '행사 전체는 가장 이른 기록·행사 날짜부터 오늘까지');
  // 행사 전에 기록이 없으면 행사 날짜 하루만 보여 준다.
  const early = new Date(2026, 10, 1, 9, 0);
  assert.deepEqual({ ...lib.presetRange('all', early, { eventDate: '2026-11-10', applications: [], entries: [] }) }, { from: '2026-11-10', to: '2026-11-10' });
});

test('calendar ranges cross months, leap days and daylight-saving changes without gaps', () => {
  for (const [from, to, keys] of [
    ['2026-12-31', '2027-01-02', ['2026-12-31', '2027-01-01', '2027-01-02']],
    ['2028-02-28', '2028-03-01', ['2028-02-28', '2028-02-29', '2028-03-01']],
    ['2026-03-07', '2026-03-09', ['2026-03-07', '2026-03-08', '2026-03-09']],
    ['2026-10-31', '2026-11-02', ['2026-10-31', '2026-11-01', '2026-11-02']],
  ]) {
    const result = lib.analyzePeriod([at(from, 0), at(to, 23)], [], from, to);
    assert.equal(result.error, null);
    assert.deepEqual(Array.from(result.points, point => point.key), keys);
    assert.equal(result.periodApplications, 2);
  }
  const exact = lib.analyzePeriod([], [], '2026-01-01', '2026-03-03');
  assert.equal(exact.clamped, false);
  assert.equal(exact.points.length, 62);
  const capped = lib.analyzePeriod([at('2026-03-04')], [{ at: at('2026-03-04'), key: 'outside' }], '2026-01-01', '2026-03-04');
  assert.equal(capped.clamped, true);
  assert.equal(capped.points.length, 62);
  assert.equal(capped.effectiveTo, '2026-03-03');
  assert.equal(capped.periodApplications, 0);
  assert.equal(capped.periodUnique, 0);
});

test('local midnight and end-of-day records stay on the browser calendar day', () => {
  const context = { eventDate: '', applications: [], entries: [] };
  for (const hour of [0, 23]) {
    const now = new Date(2027, 0, 1, hour, 15);
    assert.equal(lib.toLocalKey(now.toISOString()), '2027-01-01');
    assert.deepEqual({ ...lib.presetRange('yesterday', now, context) }, { from: '2026-12-31', to: '2026-12-31' });
    assert.deepEqual({ ...lib.presetRange('last7', now, context) }, { from: '2026-12-26', to: '2027-01-01' });
  }
});

test('analysis reuses the fixed-bucket definitions, never redefines them', () => {
  assert.match(libSource, /toLocalKey\(createdAt\)/, 'applications key off the same createdAt days');
  assert.match(workspace, /String\(person\.status \|\| ""\)\.toUpperCase\(\) !== "CANCELLED"/, 'cancelled applications stay out of the base');
  assert.match(workspace, /check\.corrected !== true/, 'corrected records stay out of entries');
  assert.match(workspace, /text\(check\.participantId\) \|\| String\(check\.id\)/, 'entries dedupe by participant');
  assert.doesNotMatch(libSource, /status ===|CANCELLED/, 'the range never invents a status filter on checks');
  assert.match(libSource, /periodUnique/, 'whole-period unique is tracked separately');
  assert.match(workspace, /기간 고유 입장/, 'the unique count is named next to the daily sum');
  assert.match(workspace, /일별 입장 합/, 'daily sums stay visible');
  assert.match(workspace, /중복 제거/, 'the difference is named, not hidden');
  assert.doesNotMatch(libSource + workspace, /toISOString\(\)\.slice\(0, 10\)/, 'no UTC slicing for day keys');
});

test('analysis screen is native SVG with the same values in table and summary', () => {
  assert.match(workspace, /<svg/, 'one native SVG, no chart library');
  assert.doesNotMatch(workspace, /from "recharts"|from "chart\.js"|from "victory"|nivo|echarts/, 'no external chart dependency');
  assert.match(workspace, /const chartLabel = `선택 기간 일별 신청·입장 막대그래프/, 'the chart carries a text equivalent');
  assert.match(workspace, /role="img" aria-label=\{label\}/, 'the label is on the svg role=img');
  assert.match(workspace, /<title>\{`/, 'each bar names its value');
  assert.match(workspace, /aria-label="선택 기간 일별 신청·입장"/, 'the table repeats the same values accessibly');
  assert.match(workspace, /기간 신청 .*일별 입장 합 .*기간 고유 입장/, 'summary states all three numbers');
  assert.match(workspace, /role="status"/, 'summary updates are announced');
  assert.match(workspace, /막대그래프 범례/, 'legend is labeled');
  assert.match(workspace, /type="date"/, 'native date inputs for 직접 선택');
  assert.match(workspace, /id="range-from"/);
  assert.match(workspace, /id="range-to"/);
  assert.match(workspace, /최대 \{RANGE_DAYS_CAP\}일까지만 봅니다/, 'clamping is announced, not silent');
  assert.match(css, /\.rangeFields input\s*\{\s*min-height: 44px/, 'date inputs keep touch targets');
  assert.match(css, /\.preset\s*\{[^}]*min-height: 44px/s, 'period buttons keep touch targets');
  // Reopened 2026-11-20 (디자인 시스템 적용): the hero is the shared StatCard (기간 고유 입장); 신청·일별 입장 합 are side figures.
  assert.match(css, /\.hero\s*\{/, 'the entry card is the hero of the summary row');
  // Reopened 2026-11-20 (shared gaps): the hero number is StatCard size="hero" and the secondary tabs are CountTabs in tablist mode.
  assert.match(workspace, /<StatCard\s+className=\{styles\.hero\}\s+size="hero"\s+label="기간 고유 입장"/, 'the hero is a StatCard');
  assert.doesNotMatch(css, /\.heroNum|\.subTab\b/, 'no local hero number or tab styles');
  assert.match(workspace, /<CountTabs\s+mode="tablist"\s+ariaLabel="세부 보기 선택"/, '시간대·소속·일별 기록 are secondary tabs');
  assert.match(css, /\.tableWrap\s*\{[^}]*overflow: auto/s, 'wide tables scroll in place');
});

test('overview keeps one summary line and the screen is reachable from the results group', () => {
  assert.doesNotMatch(overview, /function CustomRangeAnalysis|function PeriodDetails|RANGE_DAYS_CAP/, '운영 현황은 분석 본문을 갖지 않는다');
  assert.match(overview, /href=\{`\$\{base\}\/analysis`\}/);
  const nav = read('apps/web/app/console/console-navigation.ts');
  assert.match(nav, /pageIds: \["reports", "rewards", "photos", "analysis"\], defaultPageId: "reports"/);
  assert.match(nav, /analysis: \{ label: "기간 분석", title: "기간 분석", scope: "event", layout: "workspace" \}/);
  assert.match(read('apps/web/app/console/events/[id]/analysis/page.tsx'), /PeriodAnalysisWorkspace eventId=\{id\}/);
});

// Reopened 2026-11-20 (기간 분석 재설계): 비교·시간대·소속은 이미 불러온 기록에서만 계산한다.
test('previous period is the equal-length span right before, and deltas never divide by zero', () => {
  assert.deepEqual({ ...lib.previousRange('2026-11-12', 7) }, { from: '2026-11-05', to: '2026-11-11' });
  assert.deepEqual({ ...lib.previousRange('2026-03-01', 1) }, { from: '2026-02-28', to: '2026-02-28' });
  assert.equal(lib.previousRange('nope', 7), null);
  assert.equal(lib.previousRange('2026-11-12', 0), null);
  assert.deepEqual({ ...lib.periodDelta(6, 4) }, { previous: 4, change: 2, direction: 'up', percent: 50 });
  assert.deepEqual({ ...lib.periodDelta(1, 4) }, { previous: 4, change: -3, direction: 'down', percent: 75 });
  assert.deepEqual({ ...lib.periodDelta(3, 3) }, { previous: 3, change: 0, direction: 'same', percent: 0 });
  assert.equal(lib.periodDelta(5, 0).percent, null, '이전이 0이면 비율을 만들지 않는다');
});

test('hourly entries count each person once per day at the first entry hour', () => {
  const buckets = lib.hourlyEntries([
    { at: at('2026-11-17', 9), key: 'p1' },
    { at: at('2026-11-17', 14), key: 'p1' }, // 같은 날 재입장은 첫 시각 한 번
    { at: at('2026-11-17', 9), key: 'p2' },
    { at: at('2026-11-18', 10), key: 'p1' }, // 다음 날은 따로
    { at: at('2026-11-20', 10), key: 'p3' }, // 기간 밖
    { at: 'bad', key: 'p4' },
  ], '2026-11-17', '2026-11-18');
  assert.equal(buckets.length, 24);
  assert.equal(buckets[9].entries, 2);
  assert.equal(buckets[10].entries, 1);
  assert.equal(buckets[14].entries, 0);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.entries, 0), 3, '합은 일별 입장 합과 같다');
});

test('company breakdown keeps the top N, folds the rest and names blanks', () => {
  const applicants = [
    ...['A', 'A', 'A', 'B', 'B', 'C', 'D'].map((company) => ({ at: at('2026-11-17'), company })),
    { at: at('2026-11-17'), company: '  ' },
    { at: at('2026-11-10'), company: 'A' }, // 기간 밖
    { at: 'bad', company: 'A' },
  ];
  const result = lib.companyBreakdown(applicants, '2026-11-17', '2026-11-18', 2);
  assert.deepEqual(Array.from(result.top, (item) => [item.name, item.count]), [['A', 3], ['B', 2]]);
  assert.equal(result.otherCount, 2);
  assert.equal(result.otherNames, 2);
  assert.equal(result.blank, 1);
  assert.equal(result.total, 8);
});

test('niceMax rounds up to a readable axis top', () => {
  assert.equal(lib.niceMax(0), 1);
  assert.equal(lib.niceMax(3), 3);
  assert.equal(lib.niceMax(7), 10);
  assert.equal(lib.niceMax(13), 20);
  assert.equal(lib.niceMax(33), 40);
  assert.equal(lib.niceMax(45), 50);
  assert.equal(lib.niceMax(120), 200);
});

test('redesigned analysis screen compares only what the data supports and keeps one orange accent', () => {
  // Reopened 2026-11-20: 기간 분석을 운영 현황 수준으로 다시 짰다.
  assert.match(workspace, /previousRange\(fromKey, days\)/, 'comparison is the equal-length span right before');
  assert.match(workspace, /preset === "all"\) return null/, '행사 전체에는 비교할 앞 기간이 없다');
  assert.match(workspace, /showDelta = previous !== null && !previous\.error && preset !== "today"/, '오늘은 끝나지 않은 하루라 증감을 만들지 않는다');
  assert.match(workspace, /preset === "all" && !result\.clamped && periodApplications > 0 && periodUnique <= periodApplications/, '입장률은 행사 전체에서 분자가 분모를 넘지 않을 때만');
  assert.match(workspace, /data-metric="unique"/);
  assert.match(workspace, /<HourlyBars/);
  assert.match(workspace, /<CompanyBars/);
  assert.doesNotMatch(css, /var\(--brand\)\s*;[^}]*\}\s*\.barEntries/s, 'orange is not a data color');
  assert.match(css, /\.barApplications \{ fill: var\(--ink\); \}/);
  assert.match(css, /\.barEntries \{ fill: var\(--success\); \}/);
  assert.match(workspace, /<StatusPill tone="live">입장률 \{rate\}%<\/StatusPill>/, 'the single orange accent is the rate pill (StatusPill live)');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'tokens only, no raw hex');
});
