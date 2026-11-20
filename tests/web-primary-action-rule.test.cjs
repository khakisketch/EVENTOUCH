'use strict';

// One primary-action colour rule (2026-11-20, shared gaps; DESIGN.md "Action role rules").
// Login used the Astryx primary (deep orange, white text) while the reset, account and invite
// submits were repainted by auth-entry.module.css with the lighter --brand fill and --on-brand
// ink. The rule is now one token pair read by ProductButton (through the Astryx theme), the
// account forms, the legacy .button-primary and the runtime-recovery action; dark faces use the
// same rule's on-dark pair.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webRoot = path.join(__dirname, '..', 'apps', 'web');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lumOf = ([r, g, b]) => {
  const [lr, lg, lb] = [r, g, b].map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
const contrast = (a, b) => { const [hi, lo] = [lumOf(a), lumOf(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const tokenHex = (tokens, name) => hexToRgb(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens)[1]);

test('ProductButton, account forms, legacy primaries and the recovery action read the same primary tokens', () => {
  const tokens = fs.readFileSync(path.join(webRoot, 'app', 'tokens.css'), 'utf8');
  assert.match(tokens, /--action-primary:\s*var\(--brand-hover\);/);
  assert.match(tokens, /--action-primary-ink:\s*var\(--on-brand-hover\);/);
  assert.match(tokens, /--action-primary-pressed:\s*var\(--brand-pressed\);/);
  assert.ok(contrast(tokenHex(tokens, '--brand-hover'), tokenHex(tokens, '--on-brand-hover')) >= 4.5, 'primary fill with white text is AA');
  assert.ok(contrast(tokenHex(tokens, '--brand-pressed'), tokenHex(tokens, '--on-brand-hover')) >= 4.5, 'pressed fill with white text is AA');
  assert.ok(contrast(tokenHex(tokens, '--brand'), tokenHex(tokens, '--on-brand')) >= 4.5, 'the on-dark primary text is AA');
  assert.ok(contrast(tokenHex(tokens, '--brand'), tokenHex(tokens, '--stage')) >= 3, 'the on-dark primary fill reads against the stage');
  // The Astryx theme the ProductButton renders with points at the same pair.
  const theme = fs.readFileSync(path.join(webRoot, 'src', 'themes', 'eventouch', 'eventouchTheme.mjs'), 'utf8');
  assert.match(theme, /'--color-accent': 'var\(--brand-hover\)'/);
  assert.match(theme, /'--color-on-accent': 'var\(--on-brand-hover\)'/);
  // The account entry frame no longer repaints submits: shape only, so login, reset, account and invite match.
  const entry = strip(fs.readFileSync(path.join(webRoot, 'app', 'auth-entry.module.css'), 'utf8'));
  assert.doesNotMatch(entry, /button\[type="submit"\][^}]*(?:background|border|color):\s*var\(--(?:brand|on-brand)/s, 'no --brand repaint of submit buttons');
  assert.doesNotMatch(entry, /brand-hover|on-brand-hover/, 'no local hover rule for submits');
  // Raw (non-ProductButton) fallbacks in globals.css use the rule, not the light --brand fill.
  const globals = strip(fs.readFileSync(path.join(webRoot, 'app', 'globals.css'), 'utf8'));
  for (const selector of ['\\.button-primary', '\\.registration-form button\\[type="submit"\\]:not\\(\\[data-product-action\\]\\)', '\\.auth-form button\\[type="submit"\\]:not\\(\\[data-product-action\\]\\)']) {
    const rule = new RegExp(`${selector}\\s*\\{[^}]*\\}`).exec(globals);
    assert.ok(rule, `${selector} exists`);
    assert.match(rule[0], /background:\s*var\(--action-primary\)/);
    assert.match(rule[0], /color:\s*var\(--action-primary-ink\)/);
  }
});

test('login, reset, account and invite submits are shaped by the entry frames but never repainted', () => {
  const login = strip(fs.readFileSync(path.join(webRoot, 'app', 'login', 'login-entry.module.css'), 'utf8'));
  assert.doesNotMatch(login, /button\[type="submit"\][^}]*(?:background|color):/s, 'the login frame does not repaint the submit');
  assert.match(login, /font-weight:\s*var\(--fw-strong\)/, 'the login submit has the same weight as the other entry submits');
  const landing = strip(fs.readFileSync(path.join(webRoot, 'app', 'landing.module.css'), 'utf8'));
  assert.match(landing, /background:\s*var\(--action-primary-on-dark\)/, 'landing CTAs use the on-dark primary pair');
  const staff = strip(fs.readFileSync(path.join(webRoot, 'app', 'staff', 'staff-event-work.module.css'), 'utf8'));
  assert.match(staff, /\.hubGo\s*\{[^}]*background:\s*var\(--action-primary-on-dark\)/s);
  const recovery = strip(fs.readFileSync(path.join(webRoot, 'app', 'runtime-recovery.module.css'), 'utf8'));
  assert.match(recovery, /\.primary\s*\{[^}]*background:\s*var\(--action-primary\)/s);
});

test('a primary ProductButton deepens to the pressed token on hover, as the primary link does', () => {
  const ui = strip(fs.readFileSync(path.join(webRoot, 'app', 'product-ui.css'), 'utf8'));
  const hover = /\.product-action\[data-product-variant="primary"\]:hover:not\(\[aria-disabled="true"\]\)\s*\{[^}]*\}/.exec(ui);
  assert.ok(hover, 'the button hover rule exists and skips locked buttons');
  assert.match(hover[0], /background-color:\s*var\(--action-primary-pressed\)/);
  assert.match(hover[0], /color:\s*var\(--action-primary-ink\)/);
  assert.match(ui, /\.product-link\[data-action-variant="primary"\]:hover\s*\{[^}]*background:\s*var\(--brand-pressed\)/, 'the link variant already used the pressed colour');
});
