const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function tokens() {
  return fs.readFileSync(path.join(__dirname, '..', 'styles', 'tokens.css'), 'utf8');
}

function theme() {
  return fs.readFileSync(path.join(__dirname, '..', 'styles', 'theme.css'), 'utf8');
}

test('tokens carry the refined visual system values', () => {
  const css = tokens();
  assert.match(css, /--surface-soft/, 'tokens miss surface-soft');
  assert.match(css, /--radius/, 'tokens miss radius');
  assert.match(css, /--shadow/, 'tokens miss shadow');
  assert.match(css, /--focus-ring:\s*3px/, 'focus ring must be the 3px product treatment');
});

test('theme sets the product body treatment', () => {
  const css = theme();
  assert.match(css, /letter-spacing:\s*-0\.01em/, 'body misses refined tracking');
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/, 'body misses antialiasing');
});

test('theme buttons follow the refined hierarchy with motion', () => {
  const css = theme();
  assert.match(css, /transition:/, 'buttons miss transitions');
  assert.match(css, /:hover/, 'buttons miss hover treatment');
  assert.match(css, /:active/, 'primary buttons miss press treatment');
  assert.match(css, /:focus-visible/, 'theme misses refined focus treatment');
  assert.match(css, /box-shadow:\s*var\(--focus\)/, 'focus misses the soft ring shadow');
});

test('theme cards use surface, radius token and shadow', () => {
  const css = theme();
  assert.match(css, /border-radius:\s*var\(--radius\)/, 'cards miss radius token');
  assert.match(css, /box-shadow:\s*var\(--shadow\)/, 'cards miss shadow');
});

test('theme tables follow the refined ledger treatment', () => {
  const css = theme();
  assert.match(css, /\.table-wrap/, 'theme misses table-wrap treatment');
  assert.match(css, /tbody tr:hover/, 'tables miss row hover');
  assert.match(css, /font-variant-numeric:\s*tabular-nums/, 'numeric cells miss tabular figures');
});

test('theme empty states are soft panels, not dashed boxes', () => {
  const css = theme();
  assert.match(css, /\[data-empty\]/, 'theme misses the empty pattern');
  assert.doesNotMatch(css, /dashed/, 'empty states must not use dashed borders');
  assert.match(css, /background:\s*var\(--surface-soft\)/, 'empty states miss the soft panel');
});

test('theme feedback keeps the three kinds with refined type', () => {
  const css = theme();
  for (const kind of ['good', 'warn', 'bad']) {
    assert.match(css, new RegExp('data-kind="' + kind + '"'), `feedback misses ${kind}`);
  }
  assert.match(css, /line-height:\s*1\.5/, 'feedback misses refined leading');
});

test('theme forms use the refined label and field treatment', () => {
  const css = theme();
  assert.match(css, /::placeholder/, 'fields miss placeholder treatment');
  assert.match(css, /border-radius:\s*9px/, 'fields miss the refined radius');
});

test('theme respects reduced motion', () => {
  const css = theme();
  assert.match(css, /prefers-reduced-motion/, 'theme misses reduced-motion handling');
});

test('overview results render as labeled stat blocks', () => {
  for (const m of ['../app.js', '../features/agency.js', '../features/results.js']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  require('../app.js');
  require('../features/agency.js');
  require('../features/results.js');
  const ETKO = globalThis.ETKO;
  const box = { innerHTML: '' };
  ETKO.renderResults(box);
  assert.match(box.innerHTML, /stat-value/, 'results miss stat values');
  assert.match(box.innerHTML, /입장률/, 'results miss the rate label');
  assert.match(box.innerHTML, /<section class="panel" aria-label="행사 결과">/, 'results miss labeled section');
});
