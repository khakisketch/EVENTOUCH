'use strict';

// Reopened 2026-11-24 (audit S4): on a 900px-high window the rail scrolls and the
// current page sat under the edge shadow. The rail keeps the active item in view.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const shell = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'app', 'console', 'ConsoleShell.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'app', 'globals.css'), 'utf8');

test('the desktop rail scrolls the current page into view without moving focus', () => {
  assert.match(shell, /const desktopNavRef = useRef<HTMLElement>\(null\)/u);
  assert.match(shell, /<nav ref=\{desktopNavRef\} className="side-nav desktop-side-nav"/u);
  assert.match(shell, /querySelector<HTMLElement>\('\[aria-current="page"\]'\)/u);
  assert.match(shell, /active\?\.scrollIntoView\(\{ block: "nearest" \}\)/u);
  const effect = shell.slice(shell.indexOf('const active = desktopNavRef'), shell.indexOf('const active = desktopNavRef') + 200);
  assert.doesNotMatch(effect, /\.focus\(/u, 'the menu focus policy stays disclosure-only');
});

test('rail items keep clear of the edge shadows', () => {
  assert.match(css, /\.console-sidebar \.side-nav \{[^}]*scroll-padding-block: var\(--s6\)/u);
  assert.match(css, /\.console-nav-item \{\s*scroll-margin-block: var\(--s6\)/u);
});
