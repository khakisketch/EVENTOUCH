'use strict';

// Approved B composition. Behavioral suites still own command permissions,
// receipts, reload validation and recipient scope; this pins the new seams.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../apps/web/app/console/events/[id]/messages/MessagingWorkspace.module.css'), 'utf8');

test('message workbench leads with comparable history and mounts the draft without clearing it', () => {
  assert.match(source, /return <>\{history\}\{composer\}\{templates\}<\/>/u);
  assert.match(source, /\[historyOpen, setHistoryOpen\] = useState\(true\)/u);
  assert.match(source, /\[composerOpen, setComposerOpen\] = useState\(false\)/u);
  assert.match(source, /id="message-composer" hidden=\{!composerOpen\}/u);
  assert.match(source, /<table className=\{styles\.historyTable\}>/u);
  for (const label of ['발송 제목', '채널', '대상', '요청·예약', '상태', '작업']) assert.ok(source.includes(`<th scope="col">${label}</th>`));
  assert.match(source, /<tbody ref=\{historyListRef\}>/u);
  assert.match(source, /data-history-row/u);
  const close = source.slice(source.indexOf('id="message-compose-close"'), source.indexOf('id="message-compose-close"') + 450);
  assert.match(close, /setComposerOpen\(false\)/u);
  assert.doesNotMatch(close, /setSelectedIds|setCampaignDraft|campaignCreateRef|postCommand/u);
});

test('handoff, template use and failed-reload recovery reveal the mounted composer', () => {
  assert.match(source, /setSelectedIds\(valid\);\s*setComposerOpen\(true\)/u);
  assert.match(source, /function useTemplate\(template: Template\) \{\s*revealComposer\(\)/u);
  assert.match(source, /setSelectedIds\(eligible\);\s*setComposerOpen\(true\)/u);
  assert.match(source, /function reportBlockedReload\(\) \{\s*setComposerOpen\(true\)/u);
  assert.match(source, /id="message-history-search"/u);
  assert.match(source, /historyScope\.filter/u);
  assert.match(css, /grid-template-areas: "recipients draft"/u, 'DOM and visual order agree');
  assert.match(css, /\.historyTable tr\[data-history-row\]/u, 'mobile retains every field and action in compact records');
});

test('history row actions keep the full 44px touch target', () => {
  // The narrowest row action (상세, two syllables) measured 41.98px wide in
  // isolated Chromium at 320px. Height alone is not the floor: the campaign
  // action buttons carry an explicit minimum width as well.
  const actionsAt = css.indexOf('.campaignActions :global(.button)');
  assert.ok(actionsAt !== -1, 'expected the campaign action button rule');
  const actionsWindow = css.slice(actionsAt, css.indexOf('}', actionsAt) + 1);
  assert.match(actionsWindow, /min-width:\s*44px/u, 'width floor holds the shortest label');
  assert.match(actionsWindow, /min-height:\s*44px/u, 'height floor stays');
});
