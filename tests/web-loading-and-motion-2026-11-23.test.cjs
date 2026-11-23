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

test('dialogs, drawers, menus and popovers ease in; buttons settle on press', () => {
  const globals = read('globals.css');
  assert.match(globals, /@keyframes surface-rise/u);
  assert.match(globals, /\.dialog\s*\{\s*animation:\s*surface-rise var\(--enter\) var\(--ease-out\) backwards/u);
  assert.match(globals, /\.dialog-backdrop\s*\{\s*animation:\s*surface-fade/u);
  assert.match(globals, /\.operator-menu,\s*\.console-global-menu\s*\{\s*animation:\s*surface-drop/u);
  assert.match(globals, /\.console-nav-item:active[\s\S]*?background:\s*var\(--nav-active\)/u, 'tap highlight is off, so pressed state is drawn');
  const ui = read('console/console-ui/console-ui.module.css');
  assert.match(ui, /:global\(\.dialog\)\.drawerPanel\s*\{\s*animation:\s*drawer-in-right/u);
  assert.match(ui, /animation-name:\s*drawer-in-bottom/u, 'phones get a bottom sheet entrance');
  assert.match(read('console/console-ui/event-switcher.module.css'), /animation:\s*panel-in var\(--enter\) var\(--ease-out\)/u);
  assert.match(read('console/console-ui/event-switcher.module.css'), /\.chevron\s*\{[^}]*transition:\s*transform var\(--exit\)/su);
  assert.match(read('console/console-ui/list-row.module.css'), /\.summary \.chevron\s*\{\s*transition:\s*transform var\(--exit\)/u);
  const product = read('product-ui.css');
  assert.match(product, /transition:\s*transform var\(--exit\) var\(--ease-out\)/u);
  assert.match(product, /:active\s*\{\s*transform:\s*translateY\(1px\)/u);
});

test('participation screen refreshes quietly and only while idle', () => {
  const engage = read('event/[slug]/engage/EngageClient.tsx');
  assert.match(engage, /ENGAGE_REFRESH_INTERVAL_MS = 15000/u);
  // Same condition as the leave warning: typed input, drafts, conflicts, pending requests, submitting.
  assert.match(engage, /refreshBlockedRef\.current = hasInput \|\| Object\.keys\(previousResponseDrafts\)\.length > 0 \|\| Object\.keys\(contentConflicts\)\.length > 0 \|\| hasMemoryRequest \|\| submitting !== null/u);
  assert.match(engage, /document\.visibilityState !== "visible"/u);
  assert.match(engage, /if \(refreshBlockedRef\.current \|\| inFlightRef\.current\) return;/u);
  // A silent refresh never swaps a readable screen for an error.
  assert.match(engage, /const fail = \(next: EngageState\) => \{ if \(!silent\) setState\(next\); \}/u);
  assert.doesNotMatch(engage, /setState\(\{ kind: "failed"/u, 'every failure in the load goes through fail()');
});

test('home keeps quiet tabs fresh on a slow beat and keeps what is on screen if a refresh fails', () => {
  const home = read('event/[slug]/home/HomeShell.tsx');
  assert.match(home, /HOME_IDLE_REFRESH_INTERVAL_MS = 20000/u);
  assert.match(home, /live \? HOME_REFRESH_INTERVAL_MS : HOME_IDLE_REFRESH_INTERVAL_MS/u);
  assert.match(home, /if \(sameContext\) return current;/u);
});

test('the notice editor loads on demand with a placeholder', () => {
  const content = read('console/events/[id]/content/ContentWorkspace.tsx');
  assert.match(content, /dynamic\(\(\) => import\("\.\/RichEditor"\), \{\s*ssr: false/u);
  assert.doesNotMatch(content, /import RichEditor from/u);
  assert.match(read('event/[slug]/home/HomeHero.tsx'), /decoding="async" fetchPriority="high"/u);
});

test('shell does not show the choose-an-organization gate while the context is still loading', () => {
  const shell = read('console/ConsoleShell.tsx');
  assert.match(shell, /!organization\.context && organization\.loading && !organization\.error\s*\?\s*\(/u);
  assert.match(shell, /<ConsolePageSkeleton shape="list" \/>\s*\)\s*:\s*!organization\.context \?/u);
  assert.match(read('../lib/use-operator-context.ts'), /loading: true/u, 'the snapshot starts as loading, so the first paint is never the gate');
});
