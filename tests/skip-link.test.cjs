'use strict';

// A skip link that only moves the viewport buys nothing: the keyboard user
// still sits in the menu and has to tab through it again. The rule is that
// activating the link hands focus to the page's main region, and that the
// main region can receive focus at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const skipLink = read('apps/web/app/SkipLink.tsx');
const layout = read('apps/web/app/layout.tsx');
const consoleShell = read('apps/web/app/console/ConsoleShell.tsx');

test('the skip link moves focus to the main region, not only the viewport', () => {
  assert.match(skipLink, /event\.preventDefault\(\)/u, "the default fragment jump is replaced");
  assert.match(skipLink, /getElementById\("main-content"\)/u);
  assert.match(skipLink, /target\.focus\(\)/u, "focus moves into the page");
  assert.match(skipLink, /scrollIntoView/u, "the viewport follows the focus");
  // A main region that cannot take focus is exactly the region the link
  // hands over to, so it must be focusable.
  assert.match(skipLink, /setAttribute\("tabindex", "-1"\)/u);
});

test('the whole product uses the one skip link', () => {
  assert.match(layout, /<SkipLink \/>/u, "every page gets the skip link");
  assert.match(consoleShell, /<SkipLink \/>/u, "the console reuses the same rule");
  assert.doesNotMatch(layout, /<a className="skip-link"/u, "the plain anchor is gone");
});

test('every page main region can take focus', () => {
  const files = [
    'apps/web/app/event/[slug]/page.tsx',
    'apps/web/app/event/[slug]/home/HomeShell.tsx',
    'apps/web/app/event/[slug]/register/page.tsx',
    'apps/web/app/event/[slug]/ticket/page.tsx',
    'apps/web/app/event/[slug]/ticket/recover/page.tsx',
    'apps/web/app/event/[slug]/engage/EngageClient.tsx',
    'apps/web/app/staff/page.tsx',
    'apps/web/app/staff/events/[eventId]/page.tsx',
    'apps/web/app/screen/[slug]/page.tsx',
    'apps/web/app/login/page.tsx',
  ];
  for (const file of files) {
    const source = read(file);
    const mains = source.match(/<main[^>]*id="main-content"[^>]*>/gu) ?? [];
    assert.ok(mains.length > 0, `${file} has a main region`);
    for (const tag of mains) {
      assert.ok(tag.includes("tabIndex={-1}"), `${file} main region can take focus`);
    }
  }
});
