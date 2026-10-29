'use strict';

// Source contract for scripts/web-console-boundaries.cjs (long-list boundary
// helper). Static assertions only: no database, no browser, no fixture. Pins
// the strictness contract (no SKIP/silent pass/fake responses), the exact
// phase names and captures the parent wires, the real command paths, and the
// focus assertions — without pinning CSS or pixel details.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

test('real boundary entrypoint reserves one fresh namespace without replacing caller evidence', async () => {
  const originalUmask = process.umask();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-boundaries-test-'));
  try {
    const { auditLongListBoundaries, PHASES } = require(HELPER);
    const previous = path.join(root, 'long-photos.png');
    fs.writeFileSync(previous, 'caller evidence');
    const names = [];
    const args = {
      fixture: { helpers: {} }, extended: { ownerCookie: 'synthetic' },
      baseUrl: 'http://127.0.0.1:1', eventId: 'synthetic', ownerSession: 'synthetic',
      newContext: async () => {}, captureDir: root,
      // Simulate the parent check wrapper without invoking database/browser phases.
      check: async (name) => { names.push(name); },
    };
    const result = await auditLongListBoundaries(args);
    assert.deepEqual(names, PHASES);
    const namespace = path.join(root, 'long-list-boundaries');
    assert.equal(fs.statSync(namespace).mode & 0o777, 0o700);
    assert.ok(result.captures.every(file => path.dirname(file) === namespace));
    const sentinel = result.captures[0];
    fs.writeFileSync(sentinel, 'new evidence', { flag: 'wx', mode: 0o600 });
    await assert.rejects(auditLongListBoundaries(args), /덮어쓰지 않습니다/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'new evidence');
    assert.equal(fs.readFileSync(previous, 'utf8'), 'caller evidence');
    const linkedRoot = path.join(root, 'linked-root');
    fs.mkdirSync(linkedRoot, { mode: 0o700 });
    fs.symlinkSync(namespace, path.join(linkedRoot, 'long-list-boundaries'));
    await assert.rejects(auditLongListBoundaries({ ...args, captureDir: linkedRoot }), /심볼릭 링크|안전하지/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'new evidence');
    const interruptedRoot = path.join(root, 'interrupted');
    fs.mkdirSync(interruptedRoot, { mode: 0o700 });
    const partial = path.join(interruptedRoot, 'long-list-boundaries', 'partial.png');
    const interrupted = { ...args, captureDir: interruptedRoot, check: async () => {
      fs.writeFileSync(partial, 'partial evidence', { flag: 'wx', mode: 0o600 });
      throw new Error('simulated interruption');
    } };
    await assert.rejects(auditLongListBoundaries(interrupted), /simulated interruption/);
    await assert.rejects(auditLongListBoundaries(interrupted), /덮어쓰지 않습니다/);
    assert.equal(fs.readFileSync(partial, 'utf8'), 'partial evidence');
    const raceRoot = path.join(root, 'race');
    fs.mkdirSync(raceRoot, { mode: 0o700 });
    const results = await Promise.allSettled([
      auditLongListBoundaries({ ...args, captureDir: raceRoot }),
      auditLongListBoundaries({ ...args, captureDir: raceRoot }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  } finally { process.umask(originalUmask); fs.rmSync(root, { recursive: true, force: true }); }
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
    '#history-heading',
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
