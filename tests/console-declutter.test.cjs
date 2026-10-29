'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'apps/web/app', file), 'utf8');

test('overview explains registration and approval once beside their values', () => {
  const source = read('console/events/[id]/EventOverview.tsx');
  assert.match(source, /label: "신청"[^\n]*detail: "취소 제외 등록"/u);
  assert.match(source, /label: "참가 확정"[^\n]*detail: "승인된 참가자"/u);
  assert.match(source, /className=\{styles.metricDetail\}>\{metric.detail\}/u);
  assert.doesNotMatch(source, /신청은 취소 제외 · 확정은 승인된 참가자/u);
  assert.match(source, /정원 제한 없음 · 대기/u, 'capacity and waitlist remain separate configuration facts');
});

test('finished overview has one close entry beside its preconditions', () => {
  const source = read('console/events/[id]/EventOverview.tsx');
  const header = source.slice(source.indexOf('const headerActions'), source.indexOf('return (\n    <ConsolePage', source.indexOf('const headerActions')));
  assert.match(header, /currentStage === "LIVE" \? \([\s\S]*?href=\{eventCloseHref\(eventId\)\}/u);
  assert.doesNotMatch(header, /행사 마감 확인/u);
  assert.match(source, /\{finished \? \([\s\S]*?headingId="event-close-status-heading"[\s\S]*?href=\{eventCloseHref\(eventId\)\}/u);
  assert.match(source, /자동으로 단계를 바꾸지 않습니다/u);
});

test('public pages keep the top identity without a duplicate identity-only footer', () => {
  for (const file of ['event/[slug]/page.tsx', 'event/[slug]/register/page.tsx', 'event/[slug]/ticket/page.tsx', 'event/[slug]/ticket/recover/page.tsx']) {
    const source = read(file);
    assert.match(source, /className="public-page-header"/u, `${file} keeps its orientation header`);
    assert.match(source, /EVENTOUCH/u);
    assert.doesNotMatch(source, /public-page-footer/u, `${file} has no repeated brand/page-label row`);
  }
  assert.doesNotMatch(read('globals.css'), /public-page-footer/u, 'removed footer has no orphan styling');
  assert.match(read('event/[slug]/engage/EngageClient.tsx'), /<footer[\s\S]*?내 티켓으로 이동[\s\S]*?행사 안내로/u, 'task navigation in a real footer is retained');
});

test('theme draft status is mirrored visually while save owns the single announcement', () => {
  const source = read('console/events/[id]/page/ThemeWorkspace.tsx');
  // The editor starts with a compact status; only the save region is live.
  const start = source.indexOf('<div className={styles.editStatusLine}>');
  const mirror = source.slice(start, source.indexOf('</div>', start));
  assert.ok(start >= 0, 'editing-head status exists');
  assert.doesNotMatch(mirror, /aria-live=/u);
  assert.match(mirror, /dirty \? "저장되지 않은 변경" : alreadyPublished/u);
  assert.match(mirror, /저장·게시 검토/u);
  assert.equal((source.match(/aria-live="polite"/g) || []).length, 1);
  assert.match(source, /id="theme-save"[\s\S]*?className=\{styles.versionSummary\} aria-live="polite"[\s\S]*?저장되지 않은 변경/u);
  assert.match(source, /id="theme-save"[\s\S]*?게시 버전 \$\{state.publishedVersion\} · 초안 \$\{state.draftVersion\}/u);
  assert.match(source, /badges=\{\s*state.publishedAt \? <span>최근 게시/u, 'unique last-publish evidence stays in the header');
});
