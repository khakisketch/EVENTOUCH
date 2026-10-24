'use strict';

// Settings tab visibility: the active tab stays inside the horizontal tab
// strip on click/keyboard/hash/back and on viewport-width changes, using only
// the tablist's own scrollLeft — never document scrolling or focus theft.
// Source-only assertions; rendered behavior belongs to main's browser audit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx'),
  'utf8'
);
const CSS = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/settings/settings.module.css'),
  'utf8'
);

function adjustBody() {
  const start = SOURCE.indexOf('const keepActiveTabVisible = useCallback(() => {');
  assert.ok(start !== -1, 'expected the visibility adjust function');
  const end = SOURCE.indexOf('}, []);', start);
  assert.ok(end > start, 'expected the adjust function to close');
  return SOURCE.slice(start, end);
}

test('the tablist attaches a callback ref so mount adjusts even without a tab change', () => {
  // Loading renders first with no tablist; when ready mounts the tabs with
  // the same activeTab, an [activeTab]-only effect would never run. The
  // callback ref guarantees one adjustment at attach time, including the
  // initial deep link (#settings-stage).
  assert.match(SOURCE, /ref=\{attachTabsRef\}/u, 'tablist uses the attach callback ref');
  assert.match(SOURCE, /tabsRef\.current = node;/u, 'the callback keeps the shared ref');
  const attachAt = SOURCE.indexOf('const attachTabsRef = useCallback((node: HTMLDivElement | null)');
  assert.ok(attachAt !== -1, 'expected the attach callback');
  const attachBody = SOURCE.slice(attachAt, SOURCE.indexOf('}, [keepActiveTabVisible]);', attachAt));
  assert.match(attachBody, /if \(node\) keepActiveTabVisible\(\);/u, 'attach adjusts once when the list mounts');
});

test('the adjustment corrects scrollLeft by rect delta, never offsetParent math', () => {
  const body = adjustBody();
  // offsetLeft reads off the offsetParent, not the tablist, so outer padding
  // skews it. Rect differences are padding/border agnostic on both sides.
  assert.match(body, /list\.getBoundingClientRect\(\)/u, 'list rect is read');
  assert.match(body, /active\.getBoundingClientRect\(\)/u, 'active tab rect is read');
  assert.match(body, /activeRect\.left - listRect\.left/u, 'left delta is derived');
  assert.match(body, /activeRect\.right - listRect\.right/u, 'right delta is derived');
  assert.match(body, /list\.scrollLeft \+= deltaLeft;/u, 'left overflow shifts by delta only');
  assert.match(body, /list\.scrollLeft \+= deltaRight;/u, 'right overflow shifts by delta only');
  // The ban targets offsetParent math in the adjustment logic only; the
  // explanatory comment naming offsetLeft stays. Scope to property access.
  assert.doesNotMatch(body, /\.offsetLeft\b/u, 'no offsetParent-based origin in the adjustment');
  assert.doesNotMatch(body, /\.offsetWidth\b/u, 'no offsetParent-based width in the adjustment');
});

test('the effect re-applies on tab switches and width changes without stealing scroll or focus', () => {
  assert.match(SOURCE, /useEffect\(\(\) => \{\s*keepActiveTabVisible\(\);/u, 'the effect re-applies the adjustment');
  assert.match(SOURCE, /\[activeTab, keepActiveTabVisible\]\)/u, 'tab switches re-run the effect');
  assert.match(SOURCE, /window\.addEventListener\("resize", keepActiveTabVisible\)/u, 'width changes re-apply');
  assert.match(SOURCE, /window\.removeEventListener\("resize", keepActiveTabVisible\)/u, 'the width listener is removed');
  const body = adjustBody();
  assert.doesNotMatch(body, /scrollIntoView/u, 'no document scrolling from the adjustment');
  assert.doesNotMatch(body, /\.focus\(/u, 'no focus theft from the adjustment');
  assert.doesNotMatch(body, /window\.scrollTo|window\.scrollBy/u, 'no window scrolling from the adjustment');
});

test('tabs, panels, dirty marks and the mobile help stay intact', () => {
  assert.match(SOURCE, /role="tablist"/u);
  assert.match(SOURCE, /role="tab"/u);
  assert.match(SOURCE, /role="tabpanel"/u);
  assert.match(SOURCE, /tabIndex=\{selected \? 0 : -1\}/u, 'roving tabindex stays');
  assert.match(SOURCE, /aria-controls=\{`panel-\$\{tab\.anchor\}`\}/u, 'tab/panel wiring stays');
  assert.match(SOURCE, /hidden=\{activeTab !==/u, 'panels stay mounted hidden');
  assert.match(SOURCE, /tabDirtyDot/u, 'dirty dots stay');
  assert.match(SOURCE, /저장 안 됨/u);
  assert.match(SOURCE, /설정 4개 구역 · 좌우로 밀어 진행 단계까지 확인하세요/u, 'mobile overflow help stays');
  assert.match(CSS, /\.tabsHelp\s*\{[^}]*font-size:\s*var\(--small\)/su, 'help uses tokens');
  assert.match(CSS, /@media \(min-width:\s*769px\)\s*\{[^}]*\.tabsHelp\s*\{[^}]*display:\s*none/su, 'help hides where all four tabs fit');
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}/u);
});
