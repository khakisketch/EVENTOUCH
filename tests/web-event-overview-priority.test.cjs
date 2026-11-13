'use strict';

// Source contract only; rendered ordering and interaction require the isolated build audit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'apps/web/app/console/events/[id]');
const source = fs.readFileSync(path.join(root, 'EventOverview.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'event-overview.module.css'), 'utf8');

test('operator reading order puts work and actual metrics before the schedule', () => {
  const render = source.slice(source.indexOf('<div className={overview.canManageEvent ?'));
  const queue = render.indexOf('{currentStage !== "ARCHIVED" ? nowSection : null}');
  const metrics = render.indexOf('headingId="event-metrics-heading"');
  const schedule = render.indexOf('headingId="event-runbook-heading"');
  assert.ok(queue >= 0 && queue < metrics && metrics < schedule, 'active queue precedes metrics and schedule');
  assert.match(render, /currentStage !== "ARCHIVED" \? nowSection : null/u, 'archived stage suppresses only the queue section');
  assert.match(css, /"queue metrics" "runbook runbook"/);
  assert.match(css, /"queue" "metrics" "runbook"/);
});

test('finished and preparation priorities precede the schedule without an archived empty queue', () => {
  const render = source.slice(source.indexOf('<div className={overview.canManageEvent ?'));
  const status = render.indexOf('headingId="event-close-status-heading"');
  const queue = render.indexOf('{currentStage !== "ARCHIVED" ? nowSection : null}');
  const metrics = render.indexOf('headingId="event-metrics-heading"');
  const schedule = render.indexOf('headingId="event-runbook-heading"');
  assert.ok(status >= 0 && status < queue && queue < metrics && metrics < schedule);
  assert.match(render, /currentStage !== "ARCHIVED" \? nowSection : null/u, 'archived events omit the active queue');
  assert.ok(schedule > metrics, 'schedule follows the metrics in JSX');
  assert.match(source, /preparing \? \(/u, 'preparation branch remains explicit');
  assert.match(source, /headingId="event-readiness-heading"/u, 'preparation keeps its readiness section');
  assert.match(render, /href=\{eventCloseHref\(eventId\)\}/);
  assert.match(render, /href=\{`\$\{base\}\/reports`\}/);
  assert.match(css, /"status status" "metrics metrics" "runbook runbook"/);
  assert.match(css, /"status" "metrics" "runbook"/);
});

test('overview retains accurate filters, counts and recovery surfaces', () => {
  assert.match(source, /status=PENDING/);
  assert.match(source, /status=APPROVED&attendance=NOT_ENTERED/);
  assert.match(source, /overview\.everIn/);
  assert.match(source, /overview\.approved/);
  assert.match(source, /overview\.confirmedNotEntered/);
  for (const marker of ['기간 분석', '현재·다음 일정', '최근 입퇴장', '참가자 페이지 링크 복사', '이전에 불러온 내용은 유지됩니다']) {
    assert.ok(source.includes(marker), marker);
  }
});

// Approved overview design (2026-11-13). See DESIGN.md "운영 현황 확정 구성"; change only with a new user decision.
test('approved overview design stays locked', () => {
  const queue = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/console/console-ui/ConsoleTaskQueue.tsx'), 'utf8');
  // Entry: ink bar, one legend, one roster link, shared by live and finished summaries.
  assert.equal((source.match(/\{entryLegend\((true|currentStage !== "ARCHIVED")\)\}/g) || []).length, 2, 'live and finished share the legend');
  assert.equal((source.match(/className=\{styles\.liveRosterLinks\}/g) || []).length, 1, 'one legend block');
  assert.doesNotMatch(source, /styles\.(entryFoot|notEntered)\b/u, 'no roster tiles');
  assert.match(css, /\.entryFill \{[^}]*background: var\(--ink\)/su, 'progress reads in ink');
  assert.match(css, /\.entryRate \{\s*color: var\(--ink\)/u);
  // Header: one stage pill; intake and D-day are text.
  assert.match(css, /\.intakeBadge,\s*\.dDay \{[^}]*border: 0;[^}]*background: none/su);
  // Recent activity: time, rail dot, details timeline.
  for (const marker of ['styles.checkTime', 'styles.checkRail', 'styles.checkDot', 'styles.checkDetails']) assert.ok(source.includes(marker), marker);
  // Exactly one primary on live: the hero owns it, so the queue never adds another.
  assert.match(source, /<Link variant=\{live \? "primary" : "ghost"\} href=\{`\$\{base\}\/operations`\}>/u);
  assert.match(queue, /variant=\{index === 0 && !liveOverview \? "primary" : "ghost"\}/u);
  // Utilities are ghost links, not white boxes.
  assert.match(source, /<Link variant="ghost" href=\{`\$\{base\}\/settings#settings-stage`\}>진행 단계 설정<\/Link>/u);
  assert.equal((source.match(/<Link variant="ghost" className=\{styles\.readinessLink\}/g) || []).length, 4);
  assert.match(css, /\.stageBand \{\s*max-width: none;/u);
});

test('compact work rows and mobile page action retain readable names and controls', () => {
  const queue = fs.readFileSync(path.join(__dirname, "..", "apps/web/app/console/console-ui/ConsoleTaskQueue.tsx"), "utf8");
  const queueCss = fs.readFileSync(path.join(__dirname, "..", "apps/web/app/console/console-ui/console-task-queue.module.css"), "utf8");
  assert.match(source, /<ConsoleTaskQueue items=\{nowItems\}/);
  assert.match(queue, /item\.hint \? <p className=\{styles\.hint\}>/);
  assert.match(source, /aria-label="참가자 페이지 열기"/);
  assert.match(source, /className=\{styles\.pageLinkShort\}>참가자 페이지</);
  assert.match(source, /참가자 페이지 링크 복사/);
  assert.match(source, /href=\{eventCloseHref\(eventId\)\}/);
  assert.match(queueCss, /\.queue > li \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(queueCss, /\.action\s*\{[^}]*min-height: var\(--control-min-size\)/s);
  const tokens = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/tokens.css'), 'utf8');
  assert.match(tokens, /--control-min-size:\s*44px/u, 'shared control token retains the 44px floor');
  assert.match(css, /\.pageLinkShort \{ display: inline; \}/);
});
