'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tokens = fs.readFileSync(path.join(__dirname, '../apps/web/app/tokens.css'), 'utf8');
const color = name => {
  const value = tokens.match(new RegExp(`--${name}:\\s*(#[A-Fa-f0-9]{6})`));
  assert.ok(value, `missing ${name}`);
  return value[1];
};
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
// Bright orange uses dark text; the darker hover orange uses white.
// Test the actual pair in each state without lowering the contrast floor.
for (const [background, foreground] of [['brand', 'on-brand'], ['brand-hover', 'on-brand-hover']]) {
  test(`primary ${background} keeps 4.5:1 text contrast (including hover after a retry)`, () => {
    const a = luminance(color(background)), b = luminance(color(foreground));
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(ratio >= 4.5, `${background} vs ${foreground}: ${ratio.toFixed(3)}:1`);
  });
}
