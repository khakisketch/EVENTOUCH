const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function theme() {
  return fs.readFileSync(path.join(__dirname, '..', 'styles', 'theme.css'), 'utf8');
}

function shell() {
  return fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
}

test('theme layer uses the approved brand palette', () => {
  const css = theme();
  assert.match(css, /#f35b2c/i);
  assert.match(css, /#bc3f1b/i);
  assert.match(css, /#faf8f5/i);
});

test('theme marks the active nav item and primary actions', () => {
  const css = theme();
  assert.match(css, /\.context-nav button\[aria-current="page"\]/);
  assert.match(css, /button\[data-take\]/);
  assert.match(css, /button\[data-stamp-receive\]/);
});

test('contextual navigation selected states use existing surface tokens', () => {
  const css = theme();
  assert.match(css, /\.layer-switch button\[aria-pressed="true"\]\s*\{[^}]*border-color:\s*var\(--border\);[^}]*background:\s*var\(--surface-soft\)/);
  assert.match(css, /\.context-nav button\[aria-current="page"\]\s*\{[^}]*border-color:\s*var\(--border\);[^}]*background:\s*var\(--surface-soft\)/);
  assert.doesNotMatch(css, /#f3ddd1/i);
});

test('theme keeps feedback and audience display readable', () => {
  const css = theme();
  assert.match(css, /p\[role="alert"\]/);
  assert.match(css, /data-kind="good"/);
  assert.match(css, /#screen-view/);
});

test('semantic date and email controls and inline errors use the shared form theme', () => {
  const css = theme();
  for (const type of ['date', 'email', 'tel', 'number', 'time']) {
    assert.match(css, new RegExp('main input\\[type="' + type + '"\\]'));
  }
  assert.match(css, /aria-invalid="true"/);
  assert.match(css, /\.field-error/);
});

test('touch minimums cover newer controls', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'tokens.css'), 'utf8');
  for (const sel of ['data-lookup-submit', 'data-scene', 'data-camera-scan', 'data-camera-stop', 'data-booth-add', 'data-booth-status', 'data-booth-print']) {
    assert.match(css, new RegExp('button\\[' + sel + '\\]'));
  }
});
test('shell loads the theme layer after tokens', () => {
  const html = shell();
  const tokensAt = html.indexOf('styles/tokens.css');
  const themeAt = html.indexOf('styles/theme.css');
  assert.ok(tokensAt !== -1 && themeAt !== -1 && tokensAt < themeAt);
});
