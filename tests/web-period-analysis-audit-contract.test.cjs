'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('period analysis browser regression is an executable blocking CI gate with collected evidence', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(scripts['web:period-analysis:audit'], 'node scripts/web-period-analysis-audit.cjs');
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /for log in[^\n]*\bweb-period-analysis-audit\b/);
  assert.equal(ci.split('run_gate "web-period-analysis-audit" npm run web:period-analysis:audit').length, 2);
  assert.doesNotMatch(ci, /run_gate "web-period-analysis-audit" pending/);
});

test('period analysis audit owns an isolated real fixture and does not mock successful data or reuse its calculation', () => {
  const audit = read('scripts/web-period-analysis-audit.cjs');
  assert.match(audit, /prepareCaptureDir/);
  assert.match(audit, /ensureRunTmpDir/);
  assert.match(audit, /await startAuditFixture\(\)/);
  assert.match(audit, /f\.harness\.database/);
  assert.match(audit, /await f\?\.close\(\)/);
  assert.match(audit, /clock\.setFixedTime/);
  assert.equal((audit.match(/\.fulfill\(/g) || []).length, 1);
  assert.match(audit, /route\.fulfill\(\{ status: 403/);
  assert.match(audit, /timezoneId: 'Asia\/Seoul'/);
  assert.match(audit, /assertNumbers\(page, \[4, 6, 5\], LAST7\)/);
  assert.doesNotMatch(audit, /analyzePeriod|require\([^\n]*period-analysis|\.skip\(|\/Users\//);
});

// Reopened 2026-11-20: 기간 분석 has no rail item; the report page links to it and the rail keeps 결과 보고서 active.
test('workbench navigation keeps the analysis destination reachable from the report page', () => {
  assert.ok(read('scripts/web-workbench-audit.cjs').includes("['결과 보고서','reports']"));
  assert.match(read('apps/web/app/console/events/[id]/reports/ReportsWorkspace.tsx'), /id="reports-open-analysis"/);
});
