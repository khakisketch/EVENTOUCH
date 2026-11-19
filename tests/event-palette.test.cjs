'use strict';

// Attendee design-system foundation (2026-11-20): one place derives an event's
// palette (accent, deeper accent, soft tint, ink on accent, accent as text) and
// every pair clears WCAG AA 4.5:1. The contrast math below is independent of
// the library's own, so the library cannot grade its own homework.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const WEB = path.join(__dirname, '..', 'apps/web');
const webRequire = createRequire(path.join(WEB, 'package.json'));
const ts = webRequire('typescript');

function load(file, shims = {}) {
  const source = fs.readFileSync(path.join(WEB, file), 'utf8');
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => (id in shims ? shims[id] : webRequire(id));
  vm.runInNewContext(out, { module, exports: module.exports, require: localRequire }, { filename: file });
  return module.exports;
}

const home = load('lib/attendee-home.ts');
const palette = load('lib/event-palette.ts', { './attendee-home': home });

function lum(hex) {
  const c = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SAMPLES = [
  // yellows and light colors
  '#FFE600', '#FFD400', '#FFF200', '#F5C400', '#FDE68A', '#FFFFFF', '#F5F5F5', '#E5E5E7', '#D9D9D9', '#BDBDBD', '#B9DEF0', '#FDEEE4',
  // mid greys and the mid-luminance band where dark and white both struggle
  '#75828E', '#808080', '#777777', '#9E9E9E', '#6B7280', '#8A939F',
  // near-black
  '#000000', '#101114', '#1E2026', '#17252B', '#0A0A0A', '#222222',
  // saturated blue, green, red, orange, purple, pink, teal
  '#2B62EE', '#0000FF', '#1F66C1', '#16478F', '#00A651', '#00FF00', '#2F6B4F', '#1BAF7A', '#FF0000', '#B21E35', '#EA552E', '#FF6B35',
  '#7C3AED', '#E91E63', '#009688', '#00BCD4', '#FF00FF', '#FFA500', '#8BC34A', '#795548', '#3F51B5', '#FF5722', '#2E3D5B', '#C8441F',
  // shorthand and lower-case spellings
  '#abc', '#F80', '#ea552e',
];

test('every sample color gets a palette whose text pairs meet AA 4.5:1', () => {
  assert.ok(SAMPLES.length >= 40);
  for (const color of SAMPLES) {
    const p = palette.deriveEventPalette(color);
    for (const key of ['accent', 'accentStrong', 'accentSoft', 'onAccent', 'accentInk']) {
      assert.match(p[key], /^#[0-9A-F]{6}$/, `${color} ${key} is a normalized hex`);
    }
    assert.ok(ratio(p.onAccent, p.accent) >= 4.5, `${color}: onAccent ${p.onAccent} on accent ${p.accent} = ${ratio(p.onAccent, p.accent).toFixed(2)}`);
    assert.ok(ratio(p.onAccent, p.accentStrong) >= 4.5, `${color}: onAccent on accentStrong ${p.accentStrong} = ${ratio(p.onAccent, p.accentStrong).toFixed(2)}`);
    assert.ok(ratio(p.accentInk, '#FFFFFF') >= 4.5, `${color}: accentInk ${p.accentInk} on white = ${ratio(p.accentInk, '#FFFFFF').toFixed(2)}`);
    assert.ok(ratio(p.accentInk, '#F2F2F3') >= 4.5, `${color}: accentInk ${p.accentInk} on the soft card`);
    assert.ok(ratio(p.accentInk, p.accentSoft) >= 4.5, `${color}: accentInk ${p.accentInk} on soft ${p.accentSoft} = ${ratio(p.accentInk, p.accentSoft).toFixed(2)}`);
  }
});

test('a dense sweep of the color cube never ships an unreadable pair', () => {
  let count = 0;
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const p = palette.deriveEventPalette(color);
    assert.ok(ratio(p.onAccent, p.accent) >= 4.5, `${color} onAccent`);
    assert.ok(ratio(p.onAccent, p.accentStrong) >= 4.5, `${color} onAccent on strong`);
    assert.ok(ratio(p.accentInk, '#FFFFFF') >= 4.5 && ratio(p.accentInk, p.accentSoft) >= 4.5 && ratio(p.accentInk, '#F2F2F3') >= 4.5, `${color} accentInk`);
    count += 1;
  }
  assert.equal(count, 216);
});

test('a readable accent stays itself; a light one keeps its hue as text ink', () => {
  const blue = palette.deriveEventPalette('#2B62EE');
  assert.equal(blue.accent, '#2B62EE');
  assert.equal(blue.onAccent, '#FFFFFF');
  assert.ok(ratio(blue.accentInk, blue.accentSoft) >= 4.5 && ratio('#2B62EE', blue.accentSoft) < 4.55, 'only nudged because it was just short on its tint');
  assert.equal(palette.deriveEventPalette('#1B46C2').accentInk, '#1B46C2', 'an accent that already reads is kept as is');
  const yellow = palette.deriveEventPalette('#FFE600');
  assert.equal(yellow.accent, '#FFE600');
  assert.notEqual(yellow.onAccent, '#FFFFFF', 'dark text on yellow');
  assert.notEqual(yellow.accentInk, '#FFE600', 'yellow cannot be text; it is deepened');
  assert.ok(ratio(yellow.accentInk, '#FFFFFF') >= 4.5);
});

test('accentSoft is a faint tint on white', () => {
  for (const color of ['#2B62EE', '#FFE600', '#101114', '#00A651']) {
    const { accentSoft } = palette.deriveEventPalette(color);
    assert.ok(ratio(accentSoft, '#FFFFFF') < 1.5, `${color}: ${accentSoft} stays close to white`);
    assert.notEqual(accentSoft, '#FFFFFF', `${color}: ${accentSoft} is still tinted`);
  }
  assert.equal(palette.deriveEventPalette('#000000').accentSoft, '#E3E3E3');
});

test('empty and invalid input fall back to the product brand', () => {
  const brand = palette.deriveEventPalette('#EA552E');
  assert.equal(brand.accent, '#EA552E');
  for (const bad of ['', '   ', 'garbage', 'red', '#12', '#GGGGGG', '#12345', '#1234567', 'rgb(1,2,3)', undefined, null, 42]) {
    assert.deepEqual({ ...palette.deriveEventPalette(bad) }, { ...brand }, `fallback for ${String(bad)}`);
  }
  assert.ok(ratio(brand.onAccent, brand.accent) >= 4.5 && ratio(brand.accentInk, '#FFFFFF') >= 4.5);
});

test('paletteStyle exposes the five custom properties', () => {
  const style = palette.paletteStyle('#2B62EE');
  assert.deepEqual(Object.keys(style).sort(), ['--ev-accent', '--ev-accent-ink', '--ev-accent-soft', '--ev-accent-strong', '--ev-on-accent']);
  const p = palette.deriveEventPalette('#2B62EE');
  assert.equal(style['--ev-accent'], p.accent);
  assert.equal(style['--ev-on-accent'], p.onAccent);
  assert.equal(palette.paletteStyle('nope')['--ev-accent'], '#EA552E');
});

test('readableInk and the home ground share one AA-safe algorithm', () => {
  const surface = load('lib/home-surface.ts', { './attendee-home': home });
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) {
    const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    if (color === home.DEFAULT_HOME_STYLE.backgroundColor) continue;
    const ink = home.readableInk(color);
    assert.ok(ratio(ink, color) >= 4.5, `${color} readableInk ${ink}`);
    const style = surface.homeSurfaceStyle({ ...home.DEFAULT_HOME_STYLE, backgroundColor: color });
    assert.equal(style['--home-background-ink'], ink, `${color}: the ground ink is the same pick`);
    assert.equal(style['--home-background-copy'], ink);
  }
  assert.equal(home.readableInk('#75828E'), '#000000', 'the mid-gray band that fails both near-black and white escalates');
});
