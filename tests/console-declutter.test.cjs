'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'apps/web/app', file), 'utf8');

test('overview explains registration and approval once beside their values', () => {
  const source = read('console/events/[id]/EventOverview.tsx');
  assert.match(source, /label: "신청"[^\n]*detail: overview\.cancellationReview \? "신청 상태 기준" : "취소 제외 등록"/u);
  assert.match(source, /label: overview\.cancellationReview \? "승인 상태" : "참가 확정"[^\n]*detail: overview\.cancellationReview \? "취소 확인 필요 인원 포함" : "승인된 참가자"/u);
  assert.match(source, /className=\{styles.metricDetail\}>\{metric.detail\}/u);
  assert.doesNotMatch(source, /신청은 취소 제외 · 확정은 승인된 참가자/u);
  assert.match(source, /정원 제한 없음 · 대기/u, 'capacity and waitlist remain separate configuration facts');
});

test('finished overview has one close entry beside its preconditions', () => {
  const source = read('console/events/[id]/EventOverview.tsx');
  const header = source.slice(source.indexOf('const headerActions'), source.indexOf('return (\n    <ConsolePage', source.indexOf('const headerActions')));
  // 비가역 마감은 헤더가 아닌 본문 마감 구역의 단일 진입점으로만 둔다.
  assert.doesNotMatch(header, /eventCloseHref/u);
  assert.doesNotMatch(header, /행사 마감 확인/u);
  assert.match(source, /\{finished \? \([\s\S]*?headingId="event-close-status-heading"[\s\S]*?href=\{eventCloseHref\(eventId\)\}/u);
  assert.match(source, /자동으로 단계를 바꾸지 않습니다/u);
});

test('public pages keep the top identity without a duplicate identity-only footer', () => {
  // The event guide opens with the attendee home's own banner (the event name is
  // the page's h1), like the home, so it carries no separate brand header.
  const guide = read('event/[slug]/page.tsx');
  assert.match(guide, /<HomeHero\b/u, 'the event guide opens with the attendee banner');
  assert.doesNotMatch(guide, /public-page-footer/u, 'the event guide has no repeated brand/page-label row');
  for (const file of ['event/[slug]/register/page.tsx', 'event/[slug]/ticket/page.tsx', 'event/[slug]/ticket/recover/page.tsx']) {
    const source = read(file);
    assert.match(source, /<header\s+className=(?:"|\{`)public-page-header(?=["\s`])/u, `${file} keeps its orientation header`);
    assert.match(source, /EVENTOUCH/u);
    assert.doesNotMatch(source, /public-page-footer/u, `${file} has no repeated brand/page-label row`);
  }
  assert.doesNotMatch(read('globals.css'), /public-page-footer/u, 'removed footer has no orphan styling');
  assert.match(read('event/[slug]/engage/EngageClient.tsx'), /<footer[\s\S]*?내 티켓으로 이동[\s\S]*?행사 안내로/u, 'task navigation in a real footer is retained');
});

test('theme draft status lives in the save region, the single announcement', () => {
  const source = read('console/events/[id]/page/ThemeWorkspace.tsx');
  // The studio dropped the mirrored editing-head status: the settings list stays quiet and
  // only the save region (right under it) names the state and is live.
  assert.doesNotMatch(source, /editStatusLine/u);
  assert.equal((source.match(/aria-live="polite"/g) || []).length, 1);
  assert.match(source, /id="theme-save"[\s\S]*?className=\{styles.versionSummary\} aria-live="polite"[\s\S]*?저장되지 않은 변경/u);
  assert.match(source, /id="theme-save"[\s\S]*?게시 버전 \$\{state.publishedVersion\} · 초안 \$\{state.draftVersion\}/u);
  assert.match(source, /badges=\{\s*state.publishedAt \? <span>최근 게시/u, 'unique last-publish evidence stays in the header');
});
