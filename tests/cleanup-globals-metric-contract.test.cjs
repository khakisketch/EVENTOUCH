'use strict';

// Cleanup contract: the globals.css `.metric-card` family stays removed.
//
// This is a reference-graph contract, not a string-absence check:
//  1. definition graph — globals.css must not define any of the removed
//     selectors (base .metric-card included);
//  2. usage graph — no shipped source under apps/web or server may reference
//     those kebab-case tokens, statically or via runtime string building
//     (otherwise the UI would carry dangling, unstyled class names);
//  3. over-deletion guard — live neighbours of the removed block must still
//     be defined and still referenced, so the cleanup cannot silently change
//     layout, copy, or behaviour.
//
// Verified dead before removal (2026-10-23): the only repo hits for the
// kebab-case family were the definitions themselves; shipped source uses the
// camelCase CSS-module twins (metricCard/metricValue/...) in
// event-overview.module.css and reports.module.css, which are untouched.
// `.metric` (globals.css) is deliberately NOT covered here: it is a separate
// selector outside the .metric-card family and awaits main's decision.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REMOVED = ['metric-card', 'metric-value', 'metric-label', 'metric-detail', 'metric-trend'];
const tokenPattern = /(^|[^a-zA-Z0-9_-])metric-(card|value|label|detail|trend)(?![a-zA-Z0-9_-])/u;
const dynamicPattern = /metric-\$\{|metric-['"`]\s*\+|['"`]\s*\+\s*.*metric/i;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:tsx|ts|jsx|js|mjs|cjs|css)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Class names defined by a stylesheet: every `.name` selector head,
// including compound selectors such as `.metric-trend.up`.
function definedClasses(css) {
  const found = new Set();
  const re = /\.([a-zA-Z][a-zA-Z0-9_-]*)/gu;
  let m;
  while ((m = re.exec(css)) !== null) found.add(m[1]);
  return found;
}

test('removed-metric-family-has-no-definitions', () => {
  const defined = definedClasses(read('apps/web/app/globals.css'));
  for (const name of REMOVED) {
    assert.equal(defined.has(name), false, `globals.css must not define .${name}`);
  }
});

test('removed-metric-family-has-no-inbound-source-references', () => {
  const offenders = [];
  for (const dir of ['apps/web', 'server']) {
    for (const file of walk(path.join(ROOT, dir), [])) {
      const text = fs.readFileSync(file, 'utf8');
      if (tokenPattern.test(text)) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], 'no shipped source may reference the removed family');
});

test('removed-metric-family-is-not-built-at-runtime', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'apps/web'), [])) {
    if (file.endsWith('.css')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (dynamicPattern.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], 'no runtime string building may target the removed family');
});

test('cleanup-kept-live-neighbours-and-added-no-hex', () => {
  const globals = read('apps/web/app/globals.css');
  const defined = definedClasses(globals);
  // status-chip is rendered by ParticipantList; the rest anchor the shared
  // state/dialog/button layer around the removed block.
  for (const name of [
    'status-chip', 'empty-state', 'state-panel', 'button', 'button-primary',
    'dialog', 'dialog-backdrop',
  ]) {
    assert.equal(defined.has(name), true, `globals.css keeps defining .${name}`);
  }
  assert.match(globals, /@import\s*["']\.\/tokens\.css["']/u, 'tokens.css import stays');
  // The file carries no hex literals; colours come from tokens.css variables.
  assert.doesNotMatch(globals, /#[0-9a-fA-F]{3,8}\b/u, 'no hex colour literals in globals.css');
  const list = read('apps/web/app/console/events/[id]/participants/ParticipantList.tsx');
  assert.match(list, /status-chip/u, 'ParticipantList still renders the live status-chip edge');
});
