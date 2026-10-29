'use strict';

// Frozen-report local presentation: the selected article renders as-is with
// an A4/16:9 view switch that changes on-screen measure only. No new
// server endpoint, payload, version, command, or receipt; the print clone
// path is unchanged and long content paginates instead of clipping.
// Source-only assertions; rendered verification happens against live builds
// outside the suite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const reports = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/reports/ReportsWorkspace.tsx'),
  'utf8'
);
const css = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/reports/reports.module.css'),
  'utf8'
);
const globals = fs.readFileSync(path.join(ROOT, 'apps/web/app/globals.css'), 'utf8');

test('report view switch is local presentation only, defaulting to A4', () => {
  assert.match(reports, /useState<"a4" \| "wide">\("a4"\)/, 'A4 is the default view');
  assert.match(reports, /aria-pressed=\{printLayout === "a4"\}/, 'the active view is announced');
  assert.match(reports, /aria-pressed=\{printLayout === "wide"\}/, 'the presentation view is announced');
  assert.match(reports, /발표용 16:9/, 'presentation naming is explicit');
  assert.match(reports, /보기는 화면 표시만 바꿉니다/, 'view-only scope is stated, no template-editor promise');
  assert.match(reports, /PPT를 만들거나 서식을 편집하지 않습니다/, 'no PPT generation or template editing');
  assert.match(reports, /reportDocWide|reportDocA4/, 'the frozen article carries the chosen measure');
  assert.match(css, /\.reportDocA4\s*\{/, 'A4 measure exists');
  assert.match(css, /\.reportDocWide\s*\{/, '16:9 measure exists');
  assert.match(css, /\.reportViewBar \.button\s*\{[^}]*min-height:\s*44px/s, 'view controls keep touch targets');
});

test('report printing keeps the frozen clone path with pagination, no new receipts', () => {
  assert.match(reports, /clone\.dataset\.layout = printLayout/, 'the printed clone carries the chosen view');
  assert.match(reports, /clone\.id = "eventouch-report-print"/, 'print isolation id is unchanged');
  assert.match(reports, /cleanupReportPrint\(\)/, 'print cleanup is unchanged');
  assert.match(globals, /body\.report-printing > #eventouch-report-print li\s*\{\s*break-inside: avoid/, 'single rows stay intact while long lists paginate');
  assert.match(reports, /긴 내용은 페이지가 나뉘어 모두 인쇄됩니다/, 'browser print limits are stated honestly');
  for (const command of ['report.create', 'report.update', 'report.publish', 'report.successor']) {
    assert.ok(reports.includes(`"${command}"`), `${command} stays the only report surface`);
  }
  assert.doesNotMatch(reports, /report\.print|report\.export|report\.layout/, 'no new report command, endpoint, or receipt');
  // The frozen article renders the saved snapshot only; live analysis and
  // the close handoff stay outside the article and its clone.
  assert.match(reports, /<article ref=\{articleRef\}/, 'one frozen article');
  assert.match(reports, /Keep this handoff outside the frozen article/, 'live handoff stays out of print');
});
