'use strict';

// Frozen-report archive checklist: each prerequisite reads the live runtime
// state next to its own fix, so the operator never leaves the report detail
// to act. The open report id survives the round-trip in the hash. Print
// hygiene: the print clone drops inner ids and cleans up past afterprint.
// Source contracts pin the wiring; the console audit walks the real flow.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const REPORTS = 'app/console/events/[id]/reports/ReportsWorkspace.tsx';

test('each archive prerequisite links to its own fix', () => {
  const workspace = read('app/console/events/[id]/reports/EventCloseFlow.tsx');
  assert.match(workspace, /settings#settings-stage/u, 'stage item jumps to the stage gate');
  assert.match(workspace, /settings#settings-intake/u, 'open intake jumps to the intake switch');
  assert.match(workspace, /participants\?status=PENDING/u, 'pending approvals jump to the filtered roster');
  assert.match(workspace, /승인 대기 \{inputs\.pending\}명/u, 'pending count reads the same parent bootstrap state');
  assert.match(read(REPORTS), /pending: state\.metrics\.pending/u, 'hub receives the current pending count, not a second copy');
  assert.match(workspace, /\/programs`/u, 'open programs jump to the program screen');
  assert.match(workspace, /\/draws`/u, 'draw-side opens jump to the draws screen');
});

test('the open report survives a checklist round-trip in the hash', () => {
  const workspace = read(REPORTS);
  assert.match(workspace, /#report-\(\[\^#\]\+\)/u, 'detail id has a hash grammar');
  assert.match(workspace, /setDetailId\(decodeURIComponent\(match\[1\]\)\)/u, 'a copied URL restores the open report');
  assert.match(workspace, /window\.history\.replaceState/u, 'hash sync never pushes history entries');
  assert.doesNotMatch(workspace, /행사 설정 · 진행 단계에서 확인·전환/u, 'the context-losing single link is gone; each item owns its link');
});

test('report print drops inner ids and cleans up past afterprint', () => {
  const workspace = read(REPORTS);
  assert.match(workspace, /clone\.id = "eventouch-report-print"/u, 'print clone keeps its stylesheet identity');
  assert.match(workspace, /querySelectorAll\("\[id\]"\)\.forEach/u, 'clone descendants drop duplicate ids');
  assert.match(workspace, /removeAttribute\("id"\)/u);
  assert.match(workspace, /matchMedia\("print"\)/u, 'print-media change covers browsers without afterprint');
  assert.match(workspace, /pagehide/u, 'mid-dialog navigation still cleans up');
});
