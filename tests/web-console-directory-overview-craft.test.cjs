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

test('directory groups selection controls with the list and creates from the page heading', () => {
  const ready = home.slice(home.indexOf('  const viewSwitch ='));
  assert.match(ready, /headerActions=\{[\s\S]*?setCreateOpen\(true\)[\s\S]*?새 행사 만들기/u);
  const section = ready.indexOf('headingId="console-event-directory"');
  const toolbar = ready.indexOf('<ConsoleToolbar');
  assert.ok(section >= 0 && toolbar > section, 'search and filters belong to the directory workspace');
  assert.match(ready, /description=\{directoryDescription\} action=\{viewSwitch\}/u);
  assert.match(ready, /aria-pressed=\{view === "calendar"\}/u);
  assert.match(ready, /aria-pressed=\{view === "cards"\}/u);
});

test('desktop directory uses shared column geometry rather than an old card-sized floor', () => {
  for (const selector of ['.eventGrid', '.eventCard', '.eventCardLink', '.eventCardZone', '.eventCardBody', '.eventCardActions']) {
    baseRule(homeCss, selector);
  }
  assert.equal(declaration(baseRule(homeCss, '.eventCard'), 'grid-template-columns'), 'var(--directory-columns)');
  assert.equal(declaration(baseRule(homeCss, '.directoryColumns'), 'grid-template-columns'), 'var(--directory-columns)');
  assert.equal(declaration(baseRule(homeCss, '.eventCardLink'), 'grid-template-columns'), 'subgrid');
  assert.equal(declaration(baseRule(homeCss, '.eventCard'), 'min-height'), undefined);
  assert.match(home, /행사·일정<\/span><span>고객사·장소<\/span><span>진행 상태<\/span><span>후속 작업/u);
});

test('approval has one visible summary and a separate real follow-up destination', () => {
  const card = home.slice(home.indexOf('function EventCard('), home.indexOf('export default function ConsoleHome'));
  assert.equal((card.match(/승인 대기 \{event\.pending\}명 처리/g) || []).length, 1);
  assert.doesNotMatch(card, /` · 승인 대기/u);
  assert.match(card, /participants\?status=PENDING/u);
  assert.match(card, /aria-label=\{`\$\{event\.name\} 승인 대기 \$\{event\.pending\}명 처리`\}/u);
  assert.ok(card.indexOf('</ProductLink>') < card.indexOf('className={styles.approvalLink}'));
  assert.match(card, /cardHeaderTheme\(event\.themeColor\)/u);
  assert.match(homeCss.toString(), /background: var\(--card-zone, var\(--soft\)\)/u);
});

test('mobile keeps identity, client facts, stage and follow-up in the same content order', () => {
  const card = home.slice(home.indexOf('function EventCard('), home.indexOf('export default function ConsoleHome'));
  const positions = ['styles.eventCardZone', 'styles.eventClientGroup', 'styles.eventCardFoot', 'styles.eventCardActions'].map((token) => card.indexOf(token));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  const mobile = homeCss.nodes.find((node) => node.type === 'atrule' && node.params === '(max-width: 768px)');
  assert.ok(mobile);
  const row = mobile.nodes.find((node) => node.selector === '.eventCard');
  assert.equal(declaration(row, 'grid-template-columns'), 'minmax(0, 1fr)');
  assert.equal(declaration(baseRule(homeCss, '.approvalLink'), 'min-height'), '44px');
});

test('view selection stays neutral and distinct from primary execution', () => {
  const selected = baseRule(homeCss, '.viewActive');
  assert.equal(declaration(selected, 'color'), 'var(--ink)');
  assert.equal(declaration(selected, 'background'), 'var(--paper)');
  assert.match(home, /className=\{`button button-primary \$\{styles.createTrigger\}`\}/u);
});

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
  assert.match(overview, /overview\.cancellationReview \? "신청 상태 기준 · 취소 기록 확인 필요 인원 포함" : "등록 인원 기준 · 취소 제외"/u);
});
