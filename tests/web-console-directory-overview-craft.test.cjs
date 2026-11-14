'use strict';

// Source-level presentation safeguards. Built browser audits own geometry,
// keyboard operation, overflow, and rendered color/contrast verification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WEB = path.join(__dirname, '..', 'apps/web');
const postcss = require(require.resolve('postcss', { paths: [WEB] }));
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');
const home = read('app/console/ConsoleHome.tsx');
const homeCss = postcss.parse(read('app/console/console-home.module.css'));
const overview = read('app/console/events/[id]/EventOverview.tsx');
const overviewCss = postcss.parse(read('app/console/events/[id]/event-overview.module.css'));

function baseRule(root, selector) {
  const rules = root.nodes.filter((node) => node.type === 'rule' && node.selectors.includes(selector));
  assert.equal(rules.length, 1, `${selector} has one owning base rule`);
  return rules[0];
}
function declaration(rule, prop) {
  return rule.nodes.find((node) => node.type === 'decl' && node.prop === prop)?.value;
}






test('overview has one current region layout and a structural schedule, not a one-line footer', () => {
  for (const selector of ['.overviewCanvas', '.overviewArchived', '.regionMetrics', '.regionQueue', '.regionRunbook', '.runbookIdle']) {
    baseRule(overviewCss, selector);
  }
  assert.match(declaration(baseRule(overviewCss, '.overviewCanvas'), 'grid-template-areas'), /"queue metrics" "runbook runbook"/u);
  assert.match(declaration(baseRule(overviewCss, '.overviewArchived'), 'grid-template-areas'), /"metrics metrics"/u);
  assert.doesNotMatch(declaration(baseRule(overviewCss, '.overviewArchived'), 'grid-template-areas'), /queue/u, 'archived layout omits the active queue');
  assert.equal(declaration(baseRule(overviewCss, '.overviewCanvas'), 'row-gap'), '0');
  assert.equal(declaration(baseRule(overviewCss, '.regionMetrics'), 'background'), 'var(--paper)');
  assert.equal(declaration(baseRule(overviewCss, '.runbookIdle'), 'display'), undefined);
  assert.match(overview, /currentStage !== "ARCHIVED" \? nowSection : null/u);
  assert.match(overview, /role="progressbar"[\s\S]*?aria-valuenow=\{entryProgress\}/u);
});

test('overview queue summary remains actual work and preserves filtered destinations', () => {
  assert.match(overview, /nowItems\.length \? <span className=\{styles.queueCount\}>\{nowItems.length\}가지/u);
  assert.match(overview, /<ConsoleTaskQueue items=\{nowItems\}/u);
  for (const token of ['status=PENDING', 'status=APPROVED', 'attendance=NOT_ENTERED', 'attendance=REVIEW', 'ticket=review']) {
    assert.ok(overview.includes(token), token);
  }
  // The default basis lives in the progress bar's accessible name; visible copy appears only when it differs.
  assert.match(overview, /overview\.cancellationReview \? "신청 상태 기준" : "취소 제외"\} 등록 대비/u);
  assert.match(overview, /const entryBasis = overview\.cancellationReview \? <p className=\{styles\.entryBasis\}>신청 상태 기준 · 취소 기록 확인 필요 인원 포함<\/p> : null;/u);
});
