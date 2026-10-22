'use strict';

// Retirement contract: the vanilla product is gone as a UI, and the audits
// target the Next app through the shared isolated fixture. These are static
// source assertions on purpose: they pin the seam without booting browsers
// or databases.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RETIRED_TESTS = [
  'agency-shell-presentation', 'attendee-browser-presentation', 'audit-log-presentation',
  'booth-map-data', 'booth-map-presentation', 'console-detail-presentation',
  'display-refresh', 'display-screen', 'event-operations-overview-activity',
  'field-operation-ui', 'file-presentation', 'frontend-contract', 'load-order',
  'offline-shell', 'route-map-consistency', 'server-presentation', 'server-sync-client',
  'server-ui-events', 'sidebar-navigation', 'staff-link', 'surface-presentation',
];

test('retired-vanilla-tests-are-gone', () => {
  for (const name of RETIRED_TESTS) {
    assert.equal(fs.existsSync(path.join(ROOT, 'tests', `${name}.test.cjs`)), false, `${name} must stay retired`);
  }
});

test('no-remaining-test-requires-the-retired-shell', () => {
  const files = fs.readdirSync(path.join(ROOT, 'tests')).filter((file) => file.endsWith('.test.cjs'));
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, 'tests', file), 'utf8');
    assert.doesNotMatch(source, /assets\/js\/core\.js/, `${file} must not require the retired shell`);
    assert.doesNotMatch(source, /index\.html.*script.*assets/s, `${file} must not pin the retired load order`);
  }
});

test('audit-fixture-exposes-the-shared-contract-for-main-scripts', () => {
  const fixture = require('../scripts/audit-fixture.cjs');
  assert.equal(typeof fixture.startAuditFixture, 'function');
  assert.equal(typeof fixture.seedAuditFixture, 'function');
  assert.equal(typeof fixture.auditRoutes, 'function');
  assert.equal(typeof fixture.cookieForContext, 'function');
  assert.equal(typeof fixture.resolveAuditDatabaseUrl, 'function');
  assert.equal(typeof fixture.ensureAuditDatabaseEnv, 'function');
  const routes = fixture.auditRoutes({ slug: 'audit-event-abc', eventId: 'audit-event-abc' });
  assert.equal(routes.length, 6);
  for (const name of ['home', 'attendee-home', 'register', 'screen', 'staff', 'console-participants']) {
    assert.ok(routes.some((route) => route.name === name), `fixture covers ${name}`);
  }
  const cookie = fixture.cookieForContext({ manager: { cookie: 'etko_session=abc' }, staff: { cookie: 'etko_session=xyz' } }, 'manager');
  assert.equal(cookie.name, 'etko_session');
  assert.doesNotMatch(read('scripts/audit-fixture.cjs'), /partner-demo/);
  assert.doesNotMatch(read('scripts/audit-fixture.cjs'), /Eventouch2026!/);
});

test('audits-use-the-portable-browser-without-hardcoded-paths', () => {
  for (const file of ['scripts/accessibility-audit.cjs', 'scripts/mobile-audit.cjs', 'scripts/web-audit.cjs']) {
    const source = read(file);
    assert.doesNotMatch(source, /\/home\/ksi\//, `${file} must not hardcode a user path`);
    assert.doesNotMatch(source, /partner-demo/, `${file} must not depend on the demo event`);
    assert.doesNotMatch(source, /admin@eventouch\.demo/, `${file} must not depend on demo accounts`);
    assert.match(source, /audit-fixture/, `${file} uses the shared fixture`);
    assert.match(source, /audit-browser/, `${file} uses the portable browser`);
  }
  const browser = read('scripts/audit-browser.cjs');
  assert.match(browser, /CHROMIUM_EXECUTABLE/);
  assert.doesNotMatch(browser, /\/home\/ksi\//);
});

test('audits-keep-the-production-csp-enabled', () => {
  // The Next app ships a strict script-nonce CSP. Audits must exercise real
  // hydration under that policy: axe goes in through browser-protocol
  // evaluation, never as an inline script that needs the policy weakened.
  for (const file of ['scripts/accessibility-audit.cjs', 'scripts/mobile-audit.cjs', 'scripts/web-audit.cjs', 'scripts/audit-fixture.cjs']) {
    const source = read(file);
    assert.doesNotMatch(source, /addScriptTag/, `${file} must not inject scripts through the page pipeline`);
    assert.doesNotMatch(source, /bypassCSP/, `${file} must not disable the page CSP`);
    assert.doesNotMatch(source, /CSP_REPORT_ONLY/, `${file} must not weaken the shipped policy`);
  }
  assert.match(read('scripts/accessibility-audit.cjs'), /page\.evaluate\(axeSource\)/);
  assert.match(read('scripts/web-audit.cjs'), /page\.evaluate\(axeSource\)/);
});

test('mobile-audit-keeps-72-checks-with-honest-target-exceptions', () => {
  const source = read('scripts/mobile-audit.cjs');
  assert.match(source, /iPhone SE/);
  assert.match(source, /iPad Pro landscape/);
  assert.match(source, /portrait/);
  assert.match(source, /landscape/);
  // Six routes shared with the fixture; six devices; two orientations.
  assert.match(source, /auditRoutes/);
  assert.match(source, /inline/, 'the WCAG inline-link exception is explicit');
  assert.match(source, /label/, 'the associated-label exception is explicit');
  assert.doesNotMatch(source, /#\/console\/agency/, 'no retired hash routes');
});

test('web-audit-keeps-the-attendee-home-geometry-outcomes', () => {
  const source = read('scripts/web-audit.cjs');
  for (const marker of [
    'attendeeHomeNavigation', 'without scrolling', 'outside its touch surface',
    'two-column menu', 'separate, visible regions', "keyboard.press('Enter')",
    'browser back did not restore', 'missing browser navigation state',
  ]) {
    assert.ok(source.includes(marker), `web-audit keeps: ${marker}`);
  }
});

test('skeleton-and-setup-tests-no-longer-pin-the-retired-shell', () => {
  assert.doesNotMatch(read('tests/server-skeleton.test.cjs'), /assets\/js\/core\.js/);
  assert.doesNotMatch(read('tests/server-skeleton.test.cjs'), /data\/sample\.json/);
  assert.match(read('tests/server-skeleton.test.cjs'), /api-server-never-serves-repo-or-secret-files/);
  assert.doesNotMatch(read('tests/server-security-headers.test.cjs'), /index\.html/);
  assert.doesNotMatch(read('tests/server-setup-state.test.cjs'), /assets\/js\/server-presentation/);
  assert.match(read('tests/server-setup-state.test.cjs'), /LoginForm/);
});
