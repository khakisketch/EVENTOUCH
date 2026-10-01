const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('switches meet 44px touch height', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'tokens.css'), 'utf8');
  assert.match(css, /\[role="switch"\][\s\S]*?min-height:\s*44px/);
});

test('dialog handles Escape and exposes Korean notice', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /Escape/);
  assert.match(html, /화면을 표시하지 못했습니다/);
});
