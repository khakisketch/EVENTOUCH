'use strict';

// Source contract for scripts/web-console-boundaries.cjs (long-list boundary
// helper). Static assertions only: no database, no browser, no fixture. Pins
// the strictness contract (no SKIP/silent pass/fake responses), the exact
// phase names and captures the parent wires, the real command paths, and the
// focus assertions — without pinning CSS or pixel details.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'scripts', 'web-console-boundaries.cjs');
const source = fs.readFileSync(HELPER, 'utf8');

test('boundaries helper exports the exact parent call API', () => {
  const loaded = require(HELPER);
  assert.equal(typeof loaded.auditLongListBoundaries, 'function');
  assert.deepEqual(loaded.PHASES, [
    'boundaries/photos-long-list',
    'boundaries/messages-long-history',
    'boundaries/programs-long-list',
  ]);
  assert.match(source, /async function auditLongListBoundaries\(\{\s*fixture,\s*extended,\s*baseUrl,\s*eventId,\s*ownerSession,\s*newContext,\s*check,\s*captureDir/);
  assert.match(source, /AFTER theme\/save-conflict-publish/);
  assert.match(source, /BEFORE/);
});

test('boundaries helper never skips, soft-passes, or fakes a response', () => {
  assert.doesNotMatch(source, /\.skip\s*\(/);
  assert.doesNotMatch(source, /test\.skip|it\.skip|describe\.skip/);
  assert.doesNotMatch(source, /route\.fulfill/);
  assert.doesNotMatch(source, /\.fulfill\s*\(/);
  assert.doesNotMatch(source, /focusnotconfirmed/i);
  assert.doesNotMatch(source, /catch\s*\{\s*\}/);
  assert.doesNotMatch(source, /SOLAPI/);
  const throws = source.match(/throw new Error/g) || [];
  assert.ok(throws.length >= 20, `expected rigorous assertions, found ${throws.length} throws`);
});

test('boundaries helper seeds only through real API paths with receipts', () => {
  for (const command of ['evidence.photo.add', 'message.create', 'module.save']) {
    assert.ok(source.includes(`'${command}'`), `missing real command ${command}`);
  }
  assert.match(source, /commandId/);
  assert.match(source, /status < 200 \|\| response\.status >= 300/);
  assert.match(source, /simulate:\s*true/);
  assert.match(source, /\/api\/events\/.*\/files/);
  assert.match(source, /SIMULATED/);
  assert.doesNotMatch(source, /harness\.database/);
  assert.doesNotMatch(source, /INSERT INTO/);
  assert.doesNotMatch(source, /\.query\s*\(/);
  assert.doesNotMatch(source, /launchBrowser/);
  assert.doesNotMatch(source, /startAuditFixture/);
  assert.doesNotMatch(source, /fixture\.close/);
  assert.doesNotMatch(source, /process\.env\.EVENTOUCH/);
});

test('boundaries helper asserts focus on every expansion, including detachment', () => {
  assert.match(source, /document\.activeElement/);
  assert.match(source, /focus not confirmed/);
  assert.match(source, /waitForFocus/);
  assert.match(source, /confirmFocus/);
  assert.match(source, /keyboard\.press\('Enter'\)/);
  assert.match(source, /final-expansion/);
  // Empty lists must fail, never count as verified.
  assert.match(source, /refusing to claim/);
  // Rendered + remaining must reconcile with the server total.
  assert.match(source, /remaining/);
});

test('boundaries helper pins stable workspace markers, not styling', () => {
  for (const marker of [
    '#evidence-photo-sections',
    '현장 사진 구간 선택',
    '공간구성',
    'evidence-photo-',
    '#campaign-title',
    'campaign-history-more',
    'data-history-row',
    '#program-title',
    '#program-options',
    'module-title-',
    '프로그램 만들기',
    '더 보기',
    '이전 발송 더 보기',
  ]) {
    assert.ok(source.includes(marker), `missing workspace marker ${marker}`);
  }
  for (const capture of ['long-photos.png', 'long-messages.png', 'long-programs.png']) {
    assert.ok(source.includes(capture), `missing capture ${capture}`);
  }
  assert.doesNotMatch(source, /px\)/);
  // Desktop never drives the mobile-only section select (hidden on desktop:
  // selectOption would only time out or force a hidden element).
  assert.doesNotMatch(source, /selectOption/);
});

test('boundaries helper documents synthetic seeds and local constraints', () => {
  assert.match(source, /synthetic/i);
  assert.match(source, /SIMULATED-only|SIMULATED/);
  assert.match(source, /constraints/);
  assert.match(source, /1280x900|DESKTOP_VIEWPORT/);
  assert.match(source, /always closed in finally|closeOwnerPage/);
});
