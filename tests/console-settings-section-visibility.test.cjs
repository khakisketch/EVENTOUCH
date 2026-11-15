'use strict';

// Settings section visibility: there are no tabs, so every zone is visible
// and a deep link scrolls to its section (basics opens the drawer instead).
// Source-only assertions; rendered behavior belongs to the browser audit.

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

test('no tab strip remains; sections carry the deep-link anchors', () => {
  assert.doesNotMatch(SOURCE, /role="tablist"/u, 'no tab strip');
  assert.doesNotMatch(SOURCE, /role="tabpanel"/u, 'no tab panels');
  assert.doesNotMatch(SOURCE, /hidden=\{activeTab !==/u, 'no tab-gated panels');
  for (const id of ['panel-settings-intake', 'panel-settings-features', 'panel-settings-stage']) {
    assert.ok(SOURCE.includes(`id="${id}"`), `${id} anchors its section`);
  }
  assert.ok(SOURCE.includes('id="settings-basics"'), 'event card carries the basics anchor');
  assert.ok(SOURCE.includes('id="settings-page"'), 'optional disclosure keeps its deep-link id');
});

test('a hash deep link scrolls to its section and flashes it, without stealing focus', () => {
  const at = SOURCE.indexOf('const applyHash = () => {');
  assert.ok(at !== -1, 'expected the hash applier');
  const body = SOURCE.slice(at, SOURCE.indexOf('applyHash();', at));
  assert.match(body, /sectionFromHash\(window\.location\.hash\)/u, 'the hash resolves to a section');
  assert.match(body, /scrollToSection\(section\)/u, 'the section scrolls into view');
  assert.match(body, /if \(section === "basics"\) \{ setBasicsOpen\(true\); return; \}/u, 'basics opens the drawer instead of scrolling');
  const helper = SOURCE.slice(SOURCE.indexOf('const scrollToSection = useCallback'), SOURCE.indexOf('const scrollToSection = useCallback') + 600);
  assert.match(helper, /element\.scrollIntoView\(\{ block: "start" \}\)/u, 'scroll only, no focus theft');
  assert.match(helper, /flashSection\(section\)/u, 'the arrival is highlighted');
  assert.match(SOURCE, /window\.addEventListener\("hashchange", applyHash\)/u, 'back/forward hashes re-apply');
  assert.match(SOURCE, /window\.removeEventListener\("hashchange", applyHash\)/u, 'the hash listener is removed');
  assert.match(CSS, /\.sectionFlash \{/u, 'flash style exists');
});

test('focus moves only for closeStep returns and linear-next handoffs', () => {
  assert.match(SOURCE, /\.focus\(\{ preventScroll: true \}\)/u, 'focus paths exist');
  assert.match(SOURCE, /pendingHeadingFocusRef/u, 'linear-next reservation stays');
  const sync = SOURCE.slice(SOURCE.indexOf('const returnHref = readCloseReturn'), SOURCE.indexOf('window.addEventListener("hashchange"'));
  assert.match(sync, /heading\?\.focus\(\{ preventScroll: true \}\)/u, 'closeStep return focuses the section heading');
});
