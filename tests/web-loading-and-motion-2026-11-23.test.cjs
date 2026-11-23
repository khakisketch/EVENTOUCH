'use strict';

// Loading feel and motion (2026-11-23). Source contracts for the skeleton
// system; the real behaviour (skeleton shown while data is held, replaced when
// released, no overflow at 1440/390) is checked in the isolated browser run.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const APP = path.join(__dirname, '..', 'apps', 'web', 'app');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : [full];
});

test('every console screen that shows the loading panel names the shape of its screen', () => {
  const files = walk(path.join(APP, 'console')).filter((f) => /\.tsx$/.test(f));
  let seen = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<ConsoleStatePanel\b[^>]*kind="loading"[^>]*>/gu)) {
      seen += 1;
      assert.match(match[0], /shape="(overview|list|form|cards|split)"/u, `${path.relative(APP, file)} gives the skeleton a shape`);
    }
  }
  assert.ok(seen >= 19, `expected the 19 loading panels to stay on the shared state, saw ${seen}`);
});

test('skeleton is decorative, delayed, calm, and respects reduced motion', () => {
  const css = read('console/console-ui/console-skeleton.module.css');
  const tsx = read('console/console-ui/ConsoleSkeleton.tsx');
  // A fast response never flashes a skeleton: the group fades in after a delay.
  assert.match(css, /\.group\s*\{[^}]*animation:\s*skeleton-in var\(--enter\) var\(--ease-out\) 120ms both/su);
  // A slow load earns a plain sentence after 4s.
  assert.match(css, /\.hint\s*\{[^}]*4s both/su);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.block::after[\s\S]*display:\s*none/u);
  assert.match(css, /var\(--skeleton-base\)/u);
  assert.match(tsx, /aria-hidden="true"/u);
  assert.doesNotMatch(tsx, /use client|useState|useEffect/u, 'skeleton stays server-safe');
});

test('route-level loading fills the page area under the persistent shell', () => {
  const root = read('console/loading.tsx');
  const event = read('console/events/[id]/loading.tsx');
  assert.match(root, /ConsolePageSkeleton/u);
  assert.match(event, /ConsolePageSkeleton/u);
  const skeleton = read('console/console-ui/ConsoleSkeleton.tsx');
  assert.match(skeleton, /role="status"/u, 'route loading is still announced');
});

test('state panel keeps the failure path unchanged and announces loading', () => {
  const panel = read('console/console-ui/ConsoleStatePanel.tsx');
  assert.match(panel, /role="status"/u);
  assert.match(panel, /role="alert"/u);
  assert.match(panel, /다시 불러오기/u);
});

test('rail holds a placeholder for the event card while shell data loads', () => {
  const shell = read('console/ConsoleShell.tsx');
  assert.match(shell, /isEventPath && !shellData && !shellError/u);
  assert.match(shell, /nav-event-skeleton/u);
  const globals = read('globals.css');
  assert.match(globals, /\.nav-event-skeleton\s*\{/u);
  assert.match(globals, /@keyframes nav-skeleton-pulse/u);
});

test('motion curves and skeleton colours are tokens', () => {
  const tokens = read('tokens.css');
  for (const name of ['--ease-out', '--ease-in', '--skeleton-base', '--skeleton-shine']) {
    assert.match(tokens, new RegExp(`${name}:`), `${name} is defined`);
  }
});
