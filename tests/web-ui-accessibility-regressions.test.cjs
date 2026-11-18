'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('embedded content preview does not skip heading levels and retains the approved title style', () => {
  const directory = path.join(__dirname, '../apps/web/app/console/events/[id]/content');
  const preview = fs.readFileSync(path.join(directory, 'ContentPhonePreview.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(directory, 'content-preview.module.css'), 'utf8');
  assert.match(preview, /<h2 style=\{\{ color: readableInk\(background\) \}\}>\{eventName\}<\/h2>/);
  assert.doesNotMatch(preview, /<h3 style=\{\{ color: readableInk\(background\) \}\}>\{eventName\}/);
  assert.match(css, /\.hero h2\s*\{[^}]*font-size: var\(--h3\)/s);
  assert.doesNotMatch(css, /\.hero h3/);
});


test('reward empty titles are section headings without changing their visual style', () => {
  const rewards = fs.readFileSync(path.join(__dirname, '../apps/web/app/console/events/[id]/rewards/RewardsWorkspace.tsx'), 'utf8');
  for (const title of ['등록된 경품이 없습니다.', '조건에 맞는 경품이 없습니다.']) {
    assert.ok(rewards.includes(`<h2 className={consoleUiStyles.emptyTitle}>${title}</h2>`));
  }
  const css = fs.readFileSync(path.join(__dirname, '../apps/web/app/console/console-ui/console-ui.module.css'), 'utf8');
  assert.match(css, /\.empty \.emptyTitle\s*\{[^}]*font-size: var\(--h3\)/s);
  assert.match(css, /\.empty \.emptyTitle\s*\{\s*line-height: inherit;\s*letter-spacing: inherit;/);
});

test('settings anchor wrappers do not duplicate their named ConsoleSection landmarks', () => {
  const settings = fs.readFileSync(path.join(__dirname, '../apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx'), 'utf8');
  for (const key of ['intake', 'features']) {
    const wrapper = settings.match(new RegExp(`<section\\s+id="panel-settings-${key}"[^>]*>`));
    assert.ok(wrapper, '기존 스크롤 앵커와 구성은 보존한다');
    assert.doesNotMatch(wrapper[0], /aria-labelledby/);
    assert.ok(settings.includes(`<ConsoleSection headingId="settings-${key}"`), '안쪽 이름 있는 구역은 보존한다');
  }
});


test('landing tab panel uses an allowed native element and mobile inquiry has a landmark', () => {
  const landing = fs.readFileSync(path.join(__dirname, '../apps/web/app/page.tsx'), 'utf8');
  assert.match(landing, /<section className=\{styles\.consoleEvidence\} role="tabpanel"/);
  assert.doesNotMatch(landing, /<figure[^>]*role="tabpanel"/);
  assert.match(landing, /<nav className=\{styles\.mobileCta\} aria-label="모바일 도입 문의"/);
});

test('staff assignment link derives its accessible name from all visible content', () => {
  const staff = fs.readFileSync(path.join(__dirname, '../apps/web/app/staff/StaffHub.tsx'), 'utf8');
  const link = staff.match(/<ProductLink className=\{workStyles\.hubRowLink\}[^>]*>/);
  assert.ok(link);
  assert.doesNotMatch(link[0], /aria-label=/);
});

test('engagement status text uses ink chosen for the event background', () => {
  const css = fs.readFileSync(path.join(__dirname, '../apps/web/app/event/[slug]/engage/engage.module.css'), 'utf8');
  assert.match(css, /\.state\s*\{[^}]*color: var\(--engage-ink, var\(--ink\)\)/s);
});
