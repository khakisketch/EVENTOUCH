'use strict';

// Approved 결과 보고서 composition (2026-11-15, option "최종안": tabs + 문서
// 카드 + PPTX 내보내기 — design-review/reports-option-final.html). One
// always-visible 보고서 panel: an ink-underline switcher picks a saved
// version, the desk (gray surface) centers that version as a bordered A4/
// 16:9 document card, and a fixed-width rail holds 결과 분석 (always live)
// above 실행 (A4/16:9 toggle, edit/publish or successor, export group —
// PPTX/JSON/인쇄 — and the close handoff). 결과 분석·보고서 내용 are no
// longer separate tabs an operator must click through; both are part of the
// one panel now. Behavior (idempotent report.create/update/publish/successor,
// draft guard, permission gates, archived read-only, A4/16:9 print clone,
// the full close checklist) is pinned by web-reports-presentation.test.cjs
// and web-reports-archive-checklist.test.cjs; this file locks the visual
// composition. Change it only on a new owner decision.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'apps/web/app/console/events/[id]/reports');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const workspace = read('ReportsWorkspace.tsx');
const closeFlow = read('EventCloseFlow.tsx');
const css = read('reports.module.css');
const tokens = fs.readFileSync(path.join(ROOT, 'apps/web/app/tokens.css'), 'utf8');

test('the shared section nav keeps exactly two destinations, no 결과 분석/보고서 내용 tabs', () => {
  assert.match(workspace, /initialId="reports-list"/u);
  assert.match(workspace, /items=\{\[\s*\{ id: "event-close", label: "행사 마감" \},\s*\{ id: "reports-list", label: "보고서", fragment: detail \? reportFragment\(detail\.id\) : "reports-list" \},\s*\]\}/u, 'the open report stays addressable through the 보고서 tab fragment');
  assert.doesNotMatch(workspace, /label: "결과 분석"|label: "보고서 내용"/u, '결과 분석·보고서 내용 no longer gate visibility behind a click');
});

test('saved reports are picked through an ink-underline tab switcher, not a row list', () => {
  assert.match(workspace, /className=\{styles\.switchbar\} role="tablist" aria-label="보고서 선택"/u);
  assert.match(workspace, /role="tab" aria-selected=\{detail\?\.id === report\.id\}/u, 'the open report is the selected tab');
  assert.match(workspace, /className=\{styles\.reportTab\} onClick=\{\(\) => openReport\(report\.id\)\}/u);
  assert.match(workspace, /\{report\.status === "PUBLISHED" \? "공유 완료" : "초안"\}/u, 'each tab carries the same published/draft state as a short label');
  assert.match(css, /^\.switchbar \{/mu);
  assert.match(css, /^\.reportTab \{/mu);
  assert.match(css, /\.reportTab\[aria-selected="true"\] \{/u, 'the selected tab reads in ink, underlined');
  // The accessible name for making a new one stays exactly what the audit
  // and button-role fixtures already pin; the mockup's short "+ 만들기"
  // is a visual label only, not the real control's name.
  assert.match(workspace, />\s*보고서 만들기\s*</u, 'create action keeps its full accessible name');
});

test('the desk centers the selected report as a bordered document card', () => {
  assert.match(workspace, /className=\{styles\.pageDesk\}/u);
  assert.match(workspace, /<article ref=\{articleRef\} id="report-detail"/u);
  assert.match(workspace, /className=\{styles\.cardBand\} style=\{\{ background: detail\.color \}\}/u, 'the band carries the report\'s own theme color');
  assert.match(workspace, /className=\{styles\.cardPad\}/u);
  assert.match(css, /^\.pageDesk \{/mu);
  assert.match(css, /^\.cardBand \{/mu);
  assert.match(css, /^\.reportDoc \{[\s\S]*?box-shadow: var\(--shadow-raised\);/mu, 'the card is the one shadowed surface, the lone "anchor card" rule');
});

test('registration composition uses the three reserved series colors only on this chart', () => {
  assert.match(workspace, /function reportGroupChart/u);
  assert.match(workspace, /SERIES_COLORS\[index % SERIES_COLORS\.length\]/u);
  assert.match(workspace, /const SERIES_COLORS = \["var\(--series-blue\)", "var\(--series-orange\)", "var\(--series-aqua\)"\];/u);
  assert.match(tokens, /--series-blue: #2a78d6;/u);
  assert.match(tokens, /--series-orange: #eb6834;/u);
  assert.match(tokens, /--series-aqua: #1baf7a;/u);
  // The dataviz-validated palette is reserved for this one chart: no other
  // screen in the product may reference these three tokens.
  const grep = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.next') grep(full, out); }
      else if (/\.(tsx|css)$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  const offenders = grep(path.join(ROOT, 'apps/web/app'))
    .filter((file) => !file.endsWith(path.join('reports', 'ReportsWorkspace.tsx'))
      && !file.endsWith(path.join('reports', 'reports.module.css'))
      && !file.endsWith(path.join('apps', 'web', 'app', 'tokens.css')))
    .filter((file) => /--series-(blue|orange|aqua)/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], 'series colors stay scoped to the reports screen');
  // A chart segment only ever comes from fully verified counts; a missing,
  // non-integer, negative, or all-zero total cancels the whole chart.
  assert.match(workspace, /if \(counts\.some\(\(count\) => typeof count !== "number" \|\| !Number\.isSafeInteger\(count\) \|\| count < 0\)\) return null;/u);
});

test('report-vs-current attendance renders as a dumbbell, with the exact numbers still in a disclosed table', () => {
  assert.match(workspace, /function dumbbellPercents/u);
  assert.match(workspace, /className=\{styles\.dumbbell\}/u);
  assert.match(workspace, /<details className=\{styles\.diff\}>/u);
  assert.match(workspace, /보고서-최근 집계 비교표 보기/u);
  // The underlying comparison data and its live/current semantics are
  // untouched (same detailAttendanceChanges, same table markup).
  assert.match(workspace, /detailAttendanceChanges\.map\(\(\{ label, saved, current \}\) => \{/u);
  assert.match(workspace, /<th scope="row">\{label\}<\/th><td className=\{styles\.num\}>\{saved\}명<\/td><td className=\{styles\.num\}>\{current\}명<\/td>/u);
});

test('참여 콘텐츠 and 만족도 add a same-color bar list / meter, never fabricating a value', () => {
  assert.match(workspace, /function programChartRows/u);
  assert.match(workspace, /className=\{styles\.barlist\}/u);
  assert.match(workspace, /function overallSurveyAverage/u);
  assert.match(workspace, /if \(values\.some\(\(value\) => !Number\.isFinite\(value\) \|\| value < 0 \|\| value > 5\)\) return null;/u, 'an aggregate meter never averages over an unverifiable value');
  assert.match(css, /^\.barlist,\n\.boothBarList \{/mu);
  assert.match(css, /^\.meter \{/mu);
});

test('the rail holds 결과 분석 (always live) above 실행 (actions for the open report)', () => {
  assert.match(workspace, /className=\{styles\.railSide\}/u);
  assert.match(workspace, /className=\{styles\.analysisBox\} id="reports-analysis" data-workspace-section="reports-analysis"/u);
  assert.match(workspace, /className=\{styles\.actionBox\}/u);
  // 결과 분석 is unconditional; 실행 only exists once a report is open.
  const deskIndex = workspace.indexOf('className={styles.deskColumn}');
  const analysisIndex = workspace.indexOf('className={styles.analysisBox}');
  const actionIndex = workspace.indexOf('{detail ? (\n              <div className={styles.actionBox}>');
  assert.ok(deskIndex > -1 && analysisIndex > deskIndex, 'desk precedes the rail in source/DOM order');
  assert.ok(actionIndex > -1, '실행 box is gated on an open report');
  assert.match(css, /^\.railSide \{/mu);
  assert.match(css, /^\.analysisBox \{/mu);
  assert.match(css, /^\.actionBox \{/mu);
});

test('실행 keeps the A4/16:9 toggle, exports as PPTX/JSON/인쇄, and the close handoff', () => {
  assert.match(workspace, /aria-pressed=\{printLayout === "a4"\}/u);
  assert.match(workspace, /aria-pressed=\{printLayout === "wide"\}/u);
  assert.match(workspace, /className=\{styles\.exportGroup\}/u);
  assert.match(workspace, /PPTX로 내보내기/u);
  assert.match(workspace, /원본 파일 저장 \(JSON\)/u, 'JSON export keeps its full existing label');
  assert.match(workspace, /인쇄하기/u);
  assert.match(workspace, /className=\{styles\.closeBack\}/u);
  assert.match(workspace, /data-close-report-next/u);
  assert.match(workspace, /data-report-close-return/u);
  // No new server command: PPTX stays a client-only function, like xlsx.
  assert.doesNotMatch(workspace, /report\.pptx|report\.export|report\.print/u);
  for (const command of ['report.create', 'report.update', 'report.publish', 'report.successor']) {
    assert.ok(workspace.includes(`"${command}"`), `${command} stays the only report write surface`);
  }
});

test('exportPptx dynamically imports pptxgenjs, fetches each approved photo, and skips one failure without blocking the rest', () => {
  assert.match(workspace, /async function exportPptx\(report: Report\)/u);
  assert.match(workspace, /const PptxGenJS = \(await import\("pptxgenjs"\)\)\.default;/u);
  assert.match(workspace, /pres\.write\(\{ outputType: "blob" \}\)/u);
  assert.match(workspace, /`EVENTOUCH_report_v\$\{report\.version\}\.pptx`/u);
  assert.match(workspace, /consoleFetch\(`\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/files\/\$\{encodeURIComponent\(fileId\)\}`, \{ cache: "no-store" \}\)/u);
  assert.match(workspace, /\} catch \{\s*\/\/ Skip only this photo; the rest of the export still proceeds\./u);
});

test('pptxgenjs is declared as a client dependency, same pattern as xlsx', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/package.json'), 'utf8'));
  assert.ok(pkg.dependencies.pptxgenjs, 'pptxgenjs is a direct dependency');
  assert.ok(pkg.dependencies.xlsx, 'the existing client-only export dependency is untouched');
});

test('the close map keeps a one-line status plus the full 7-step checklist, folded', () => {
  assert.match(closeFlow, /className=\{styles\.statusLine\}/u);
  assert.match(closeFlow, /className=\{styles\.statusDot\}/u);
  assert.match(closeFlow, /마감 \$\{stepNumber\}\/7/u);
  assert.match(closeFlow, /<details className=\{styles\.closeDetails\}>/u);
  assert.match(closeFlow, /전체 마감 단계와 전제 확인/u);
  // All seven checklist items and their links are unchanged.
  assert.match(closeFlow, /승인 대기 \{inputs\.pending\}명 — 참가 확정과 구분되며/u);
  assert.match(closeFlow, /보고서 생성·검토·공유 완료 기록 — 초안도 집계가 고정됩니다/u);
  assert.match(closeFlow, /보관 — 접수와 진행 프로그램을 모두 닫은 종료 행사에서 기존 확인을 거칩니다/u);
  assert.match(css, /^\.statusLine \{/mu);
});

test('no raw hex or rgb() in the stylesheet outside the one validated series-color set', () => {
  const withoutSeriesVars = css.replace(/--series-(blue|orange|aqua):?[^;]*;?/g, '');
  assert.doesNotMatch(withoutSeriesVars, /#[0-9a-fA-F]{3,8}\b/u);
  assert.doesNotMatch(css, /rgb\(/u);
});
