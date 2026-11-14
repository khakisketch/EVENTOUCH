'use strict';

// Approved attendee page studio (2026-11-14): the home takes one of three
// compositions (tile, poster, typography; the photo-first layout is reserved and
// locked), the banner can be a picture, a gradient or a solid color, and the
// editor is a live phone beside a short settings list whose rows open in place.
// The server and the web read the same style keys with the same defaults; this
// file pins that contract and the studio's structure. Save, publish review,
// conflicts, uploads and permission locks are pinned by their own tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');
const webRequire = createRequire(path.join(WEB, 'package.json'));
const ts = webRequire('typescript');
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');
const server = require('../server/attendee-home-style.js');

function loadLib() {
  const out = ts.transpileModule(read('lib/attendee-home.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, { module, exports: module.exports, require: webRequire }, { filename: 'attendee-home.ts' });
  return module.exports;
}
const lib = loadLib();
const plain = (value) => JSON.parse(JSON.stringify(value));
const fail = (status, message, field) => Object.assign(new Error(message), { status, field });

test('server and web share one default for every layout and banner key', () => {
  for (const key of ['layout', 'menuShape', 'bannerKind', 'bannerColor', 'bannerColor2', 'bannerAngle']) {
    assert.equal(plain(lib.DEFAULT_HOME_STYLE)[key], server.DEFAULT_HOME_STYLE[key], `${key} default matches`);
  }
  assert.equal(server.DEFAULT_HOME_STYLE.layout, 'tile', 'tile is the default composition');
  assert.equal(server.DEFAULT_HOME_STYLE.bannerKind, 'image', 'the picture banner stays the default');
});

test('stored styles read through the same allowlist on both sides, and an unknown layout never survives', () => {
  const stored = { layout: 'instagram', menuShape: 'list', bannerKind: 'gradient', bannerColor: '#2e3d5b', bannerColor2: 'red', bannerAngle: 'sideways' };
  const fromServer = server.normalizeHomeStyle(stored);
  const fromWeb = plain(lib.normalizeHomeStyle(stored));
  for (const key of ['layout', 'menuShape', 'bannerKind', 'bannerColor', 'bannerColor2', 'bannerAngle']) {
    assert.equal(fromWeb[key], fromServer[key], `${key} reads the same`);
  }
  assert.equal(fromServer.layout, 'tile', 'the reserved photo layout falls back');
  assert.equal(fromServer.bannerColor, '#2E3D5B', 'colors are stored uppercase');
  assert.equal(fromServer.bannerColor2, server.DEFAULT_HOME_STYLE.bannerColor2, 'a bad color falls back');
  assert.equal(fromServer.bannerAngle, 'diagonal');
});

test('saving validates the new keys strictly and leaves omitted ones alone', () => {
  const stored = server.defaultHomeStyle();
  const next = server.validateHomeStyleUpdate({ layout: 'poster', menuShape: 'list', bannerKind: 'solid', bannerColor: '#c8441f' }, stored, fail);
  assert.equal(next.layout, 'poster');
  assert.equal(next.bannerColor, '#C8441F');
  assert.equal(next.bannerColor2, stored.bannerColor2, 'omitted keys merge from the stored style');
  for (const bad of [{ layout: 'instagram' }, { layout: 'grid' }, { menuShape: 'square' }, { bannerKind: 'video' }, { bannerColor: 'blue' }, { bannerColor2: '#12345' }, { bannerAngle: 'diag' }]) {
    assert.throws(() => server.validateHomeStyleUpdate(bad, stored, fail), (error) => error.status === 400 && String(error.field).startsWith('homeStyle.'), JSON.stringify(bad));
  }
  assert.throws(() => server.assertPublishableHomeStyle({ layout: 'instagram' }, fail), (error) => error.status === 400, 'a malformed stored draft never publishes');
  assert.equal(server.assertPublishableHomeStyle(undefined, fail).layout, 'tile', 'a legacy draft publishes the default composition');
});

test('a color banner derives its own CSS and a readable tone', () => {
  const base = plain(lib.DEFAULT_HOME_STYLE);
  assert.equal(lib.bannerFillCss(base), null, 'the picture banner has no fill');
  assert.equal(lib.bannerFillCss({ ...base, bannerKind: 'solid', bannerColor: '#2E3D5B' }), '#2E3D5B');
  assert.equal(lib.bannerFillCss({ ...base, bannerKind: 'gradient', bannerColor: '#2E3D5B', bannerColor2: '#E58A4B', bannerAngle: 'vertical' }), 'linear-gradient(180deg, #2E3D5B, #E58A4B)');
  assert.equal(lib.bannerFillTone({ ...base, bannerKind: 'solid', bannerColor: '#101114' }), 'light', 'dark fills take light text');
  assert.equal(lib.bannerFillTone({ ...base, bannerKind: 'solid', bannerColor: '#FDE3D5' }), 'dark', 'pale fills take dark text');
  assert.equal(lib.readableInk('#1E2026'), '#FFFFFF');
  assert.equal(lib.readableInk('#F3EEE6'), '#17252B');
});

test('the landing renders one of three compositions with the same entries; the photo layout is not rendered', () => {
  const landing = read('app/event/[slug]/home/AttendeeHomeLanding.tsx');
  const css = read('app/event/[slug]/home/home-layouts.module.css');
  assert.match(landing, /const homeStyle = normalizeHomeStyle\(homeStyleInput\);/u, 'partial or stored styles read through the defaults');
  assert.match(landing, /layout === "typography" \? \(/u);
  assert.match(landing, /const shape = layout === "tile" \? "tile" : layout === "poster" && homeStyle\.menuShape === "circle" \? "circle" : "row";/u, 'the menu shape only varies on the poster');
  assert.match(landing, /const fill = bannerFillCss\(homeStyle\);/u);
  assert.match(landing, /const tone = fill \? bannerFillTone\(homeStyle\) : neutralBanner \? "light" : homeStyle\.textTone;/u, 'a color banner reads its own tone');
  assert.doesNotMatch(landing, /instagram/iu, 'the reserved layout has no renderer');
  assert.match(css, /\.tile \.hero \{ height: clamp\(156px, 44cqi, 230px\); \}/u);
  assert.match(css, /\.poster \.hero \{ height: clamp\(300px, 88cqi, 460px\); justify-content: flex-end; \}/u);
  assert.match(css, /\.group_tile \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/u, 'tiles are two square columns');
  assert.match(css, /\.root \.tile \{[^}]*aspect-ratio: 1;/su);
});

test('the studio is a live phone beside a short list; rows open in place; the reserved layout is locked', () => {
  const theme = read('app/console/events/[id]/page/ThemeWorkspace.tsx');
  const picker = read('app/console/events/[id]/page/LayoutPicker.tsx');
  assert.match(theme, /<LayoutPicker[\s\S]{0,700}onLayout=\{selectLayout\}/u);
  assert.match(theme, /next === "typography" && form\.homeStyle\.backgroundColor === DEFAULT_HOME_STYLE\.backgroundColor \? \{ backgroundColor: "#1E2026" \}/u, 'large type moves off only the untouched default background');
  assert.match(theme, /homeStyle\.layout !== "typography" \? <li>\{studioRow\("banner"/u, 'the banner row is hidden where there is no banner');
  assert.match(picker, /aria-disabled="true" className=\{`\$\{styles\.card\} \$\{styles\.locked\}`\}/u, 'the photo layout is a locked card');
  assert.match(picker, /사진 중심 · 곧 제공/u);
  assert.match(picker, /<AttendeeHomeLanding/u, 'cards are the real home, scaled');
  assert.match(picker, /inert>/u, 'a card thumbnail is not interactive');
  assert.match(picker, /value === "poster" \?/u, 'menu shape is offered only for the poster');
  // Banner: picture / gradient / solid, with colors through the picker.
  for (const kind of ['image', 'gradient', 'solid']) assert.match(theme, new RegExp(`value: "${kind}", name:`), `${kind} banner kind`);
  assert.match(theme, /GRADIENT_PRESETS\.map/u);
  assert.match(theme, /<ColorField label="시작 색"/u);
  assert.match(theme, /<ColorField label="끝 색"/u);
  // The phone is the page's subject and has a full view; on narrow screens the inline phone yields to it.
  assert.match(theme, /<ConsoleDialog titleId="theme-stage-title" title="참가자 홈 미리보기" presentation="stage"/u);
  const css = read('app/console/events/[id]/page/studio.module.css');
  assert.match(css, /\.stage \{ position: sticky;/u);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.phoneSlot, \.stageBar \{ display: none; \}/u);
});

test('the color field is a real picker: swatches, field, hue, hex, eyedropper, recents, banner colors', () => {
  const field = read('app/console/events/[id]/page/ColorField.tsx');
  assert.match(field, /role="radiogroup" aria-label=\{label\}/u);
  assert.match(field, /role="slider"/u);
  assert.match(field, /aria-valuetext=\{`채도 \$\{Math\.round\(hsv\.s \* 100\)\}%, 밝기 \$\{Math\.round\(hsv\.v \* 100\)\}%`\}/u, 'the field names its value in words');
  assert.match(field, /onKeyDown=\{areaKey\}/u, 'the field works from the keyboard');
  assert.match(field, /type="range"/u, 'hue is a native slider');
  assert.match(field, /"EyeDropper" in window/u, 'the eyedropper only appears where the browser has one');
  assert.match(field, /paletteFromImage/u);
  assert.match(field, /eventouch\.recent-colors/u);
  assert.match(field, /\.toUpperCase\(\)/u, 'values are stored uppercase');
  const css = read('app/console/events/[id]/page/color-field.module.css');
  assert.match(css, /\.swatch \{[^}]*width: 44px;[^}]*height: 44px;/su, 'swatches are touch-sized');
});
