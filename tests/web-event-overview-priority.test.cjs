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
  assert.ok(render.indexOf('headingId="event-metrics-heading"') < render.indexOf('? nowSection : null}'));
  assert.ok(render.indexOf('headingId="event-metrics-heading"') < render.indexOf('headingId="event-runbook-heading"'));
  // 2026-11-10 비평 반영 CSS 정리: 섀도잉되던 구 grid 세대를 제거하고 현행 세대를 고정한다.
  // 읽기 순서(지표 → 작업 → 일정)는 DOM 순서와 현행 grid로 그대로 보장된다.
  assert.match(css, /"metrics queue" "runbook runbook"/);
  assert.match(css, /"metrics" "queue" "runbook"/);
});

test('finished and preparation priorities precede the schedule without an archived empty queue', () => {
  const render = source.slice(source.indexOf('<div className={overview.canManageEvent ?'));
  const status = render.indexOf('headingId="event-close-status-heading"');
  const queue = render.indexOf('currentStage !== "ARCHIVED" ? nowSection : null');
  const metrics = render.indexOf('headingId="event-metrics-heading"');
  const schedule = render.indexOf('headingId="event-runbook-heading"');
  assert.ok(status >= 0 && status < metrics && metrics < queue && queue < schedule);
  assert.ok(render.indexOf('다음 진행 중 조건') < queue);
  assert.match(render, /href=\{eventCloseHref\(eventId\)\}/);
  assert.match(render, /href=\{`\$\{base\}\/reports`\}/);
  // 2026-11-10 비평 반영 CSS 정리: 종료·보관 grid 정본(아래 2식)으로 고정한다.
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
  assert.match(queueCss, /\.action\s*\{[^}]*min-height: 44px/s);
  assert.match(css, /\.pageLinkShort \{ display: inline; \}/);
});
