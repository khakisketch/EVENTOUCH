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
  assert.match(source, /\{history\}\{composer\}\{templates\}/u);
  assert.match(source, /<ConsoleSectionNav mode="tabs" label="메시지 업무"/u);
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

// Reopened 2026-11-24 (owner: 시안 A): there is no composeStep; each entry path reveals the mounted
// composer. Reopened 2026-11-26: the zones are always visible, so no path opens a panel; the list dialog opens only
// when a reloaded set needs a decision.
test('handoff, template use and failed-reload recovery reveal the mounted composer', () => {
  assert.doesNotMatch(source, /setComposeStep|composeStep/u, 'no step state remains');
  assert.match(source, /setSelectedIds\(valid\);\s*setComposerOpen\(true\)/u);
  const apply = source.slice(source.indexOf('function applyTemplate('), source.indexOf('function useTemplate('));
  assert.match(apply, /if \(template\.archived\)/u);
  assert.match(apply, /if \(!composerOpen\) \{ focusComposerOnOpenRef\.current = true; revealComposer\(\); \}/u, 'an inline pick never jumps the page');
  assert.match(source, /setSelectedIds\(eligible\);\s*const nextStep = eligible\.length && !excluded && !source\.recipientChangeCount \? 2 : 1;\s*setComposerOpen\(true\)/u);
  assert.match(source, /function reportBlockedReload\(\) \{\s*setComposerOpen\(true\)/u);
  // The opened composer lands on the first pill of the sentence.
  assert.match(source, /document\.getElementById\("campaign-who-pill"\)\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(source, /id="message-history-search"/u);
  assert.match(source, /historyScope\.filter/u);
  // Reopened 2026-11-24: sentence + writing column, with the preview as the narrow side column.
  assert.match(css, /\.composeGrid\[data-layout="simple"\] \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(260px, 320px\)/u, 'writing column plus one narrow preview');
  assert.match(css, /\.historyTable tr\[data-history-row\]/u, 'mobile retains every field and action in compact records');
});

test('history row actions keep the full 44px touch target', () => {
  // The narrowest row action (상세, two syllables) measured 41.98px wide in
  // isolated Chromium at 320px. Height alone is not the floor: the campaign
  // action buttons carry an explicit minimum width as well.
  // Reopened 2026-11-20 (shared gaps): both floors come from the one shared `.product-action` rule (product-ui.css), so the
  // per-screen 44px declarations were removed; only the type size and padding stay local.
  const productUi = fs.readFileSync(path.join(__dirname, '../apps/web/app/product-ui.css'), 'utf8');
  assert.match(productUi, /\.product-action \{[^}]*min-block-size: var\(--control-min-size\);[^}]*min-inline-size: var\(--control-min-size\)/su, 'width and height floors hold the shortest label');
  const actionsAt = css.indexOf('.campaignActions :is([data-product-action], [data-action-variant])');
  assert.ok(actionsAt !== -1, 'expected the campaign action button rule');
  const actionsWindow = css.slice(actionsAt, css.indexOf('}', actionsAt) + 1);
  assert.doesNotMatch(actionsWindow, /min-(?:width|height):\s*(?:[0-3]\d|4[0-3])px/u, 'no local rule lowers the shared 44px floor');
});
