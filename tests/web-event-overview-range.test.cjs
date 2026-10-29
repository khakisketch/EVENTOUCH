'use strict';

// Arbitrary-range period analysis: the same cancelled/corrected/dedupe
// definitions as the fixed today/yesterday/7-day buckets, applied to
// browser-local from/to dates, with a native SVG plus the same values in an
// accessible table and summary. No external chart dependency, no frozen
// report or KPI redefinition. Source-only assertions; rendered verification
// happens against live builds outside the suite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const overview = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/EventOverview.tsx'),
  'utf8'
);
const css = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/event-overview.module.css'),
  'utf8'
);

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('range analysis reuses the fixed-bucket definitions, never redefines them', () => {
  const custom = between(overview, 'const RANGE_DAYS_CAP', 'export default function EventOverview');
  // Same cancelled-excluded applications (createdAt) as the fixed buckets.
  assert.match(custom, /toLocalKey\(createdAt\)/, 'applications key off the same createdAt days');
  assert.match(overview, /person\.status !== "CANCELLED"/, 'fixed-bucket cancelled exclusion stays the authority');
  // Same uncorrected-IN dedupe per participant: no cancelled filter on
  // checks, corrected excluded upstream, unique keys per day.
  assert.match(custom, /entriesByDay\.get\(key\)\?\.size/, 'daily entries stay per-day unique');
  assert.match(overview, /check\.corrected !== true/, 'corrected exclusion stays upstream');
  assert.doesNotMatch(custom, /status ===|CANCELLED/, 'the range never invents a status filter on checks');
  // Distinct whole-period unique versus daily sums.
  assert.match(custom, /periodUnique/, 'whole-period unique is tracked separately');
  assert.match(custom, /dailyEntriesSum/, 'daily sums stay visible next to the unique count');
  assert.match(custom, /일별 합의 합과 다를 수 있습니다|일별 합의 합과 다를|중복 제거/, 'the difference is named, not hidden');
});

test('range analysis recovers from bad input and caps extreme ranges', () => {
  const custom = between(overview, 'const RANGE_DAYS_CAP', 'export default function EventOverview');
  assert.match(custom, /RANGE_DAYS_CAP = 62/, 'extreme ranges cap instead of exploding');
  assert.match(custom, /시작 날짜가 끝 날짜보다 늦습니다/, 'start-after-end names the fix');
  assert.match(custom, /YYYY-MM-DD 형식으로 입력하세요/, 'invalid input names the format');
  assert.match(custom, /최대 \{RANGE_DAYS_CAP\}일까지만 봅니다/, 'clamping is announced, not silent');
  assert.match(custom, /parseLocalDay/, 'calendar dates validate round-trip, never UTC-shifted');
  // Browser-local days everywhere: inputs are date fields, keys come from
  // the local calendar, never toISOString slicing.
  assert.match(custom, /type="date"/, 'native date inputs');
  assert.match(custom, /localDateKey/, 'browser-local day keys');
  assert.doesNotMatch(custom, /toISOString\(\)\.slice\(0, 10\)/, 'no UTC slicing for day keys');
});

test('range chart is native SVG with the same values in table and summary', () => {
  const custom = between(overview, 'const RANGE_DAYS_CAP', 'export default function EventOverview');
  assert.match(custom, /<svg/, 'one native SVG, no chart library');
  assert.doesNotMatch(overview, /from "recharts"|from "chart\.js"|from "victory"|nivo|echarts/, 'no external chart dependency');
  assert.match(custom, /aria-label=\{`선택 기간 일별 신청·입장 막대그래프/, 'the chart carries a text equivalent');
  assert.match(custom, /<title>\{`/, 'each bar names its value');
  assert.match(custom, /aria-label="선택 기간 일별 신청·입장"/, 'the table repeats the same values accessibly');
  assert.match(custom, /기간 신청 .*일별 입장 합 .*기간 고유 입장/, 'summary states all three numbers');
  assert.match(custom, /role="status"/, 'summary updates are announced');
  // Legend and touch targets.
  assert.match(custom, /막대그래프 범례/, 'legend is labeled');
  assert.match(css, /\.rangeFields input\s*\{\s*min-height: 44px/, 'date inputs keep touch targets');
  assert.match(css, /\.rangeLegend li\s*\{[^}]*min-height: 44px/, 'legend rows keep touch targets');
  // Mobile: the table scrolls inside the existing period block, nothing
  // overflows the viewport by construction.
  assert.match(css, /\.periodBlock\s*\{[^}]*overflow-x: auto/, 'wide tables scroll in place');
});
