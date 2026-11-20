'use strict';

// Approved attendee page studio (2026-11-14): the home takes one of three
// compositions (tile, poster and, since 2026-11-18, the photo-first instagram
// feed of approved participant photos; the typography layout and the poster
// list menus were retired on 2026-11-19), the banner can be a picture,
// a gradient or a solid color, and the
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
  for (const key of ['layout', 'bannerKind', 'bannerColor', 'bannerColor2', 'bannerAngle']) {
    assert.equal(plain(lib.DEFAULT_HOME_STYLE)[key], server.DEFAULT_HOME_STYLE[key], `${key} default matches`);
  }
  assert.equal(server.DEFAULT_HOME_STYLE.layout, 'tile', 'tile is the default composition');
  assert.equal(server.DEFAULT_HOME_STYLE.bannerKind, 'image', 'the picture banner stays the default');
});

test('stored styles read through the same allowlist on both sides, and an unknown layout never survives', () => {
  const stored = { layout: 'grid', bannerKind: 'gradient', bannerColor: '#2e3d5b', bannerColor2: 'red', bannerAngle: 'sideways' };
  const fromServer = server.normalizeHomeStyle(stored);
  const fromWeb = plain(lib.normalizeHomeStyle(stored));
  for (const key of ['layout', 'bannerKind', 'bannerColor', 'bannerColor2', 'bannerAngle']) {
    assert.equal(fromWeb[key], fromServer[key], `${key} reads the same`);
  }
  assert.equal(fromServer.layout, 'tile', 'an unknown layout falls back to the default composition');
  assert.equal(fromServer.bannerColor, '#2E3D5B', 'colors are stored uppercase');
  assert.equal(fromServer.bannerColor2, server.DEFAULT_HOME_STYLE.bannerColor2, 'a bad color falls back');
  assert.equal(fromServer.bannerAngle, 'diagonal');
});

test('saving validates the new keys strictly and leaves omitted ones alone', () => {
  const stored = server.defaultHomeStyle();
  const next = server.validateHomeStyleUpdate({ layout: 'poster', bannerKind: 'solid', bannerColor: '#c8441f' }, stored, fail);
  assert.equal(next.layout, 'poster');
  assert.equal(next.bannerColor, '#C8441F');
  assert.equal(next.bannerColor2, stored.bannerColor2, 'omitted keys merge from the stored style');
  for (const bad of [{ layout: 'grid' }, { layout: 'Instagram' }, { bannerKind: 'video' }, { bannerColor: 'blue' }, { bannerColor2: '#12345' }, { bannerAngle: 'diag' }]) {
    assert.throws(() => server.validateHomeStyleUpdate(bad, stored, fail), (error) => error.status === 400 && String(error.field).startsWith('homeStyle.'), JSON.stringify(bad));
  }
  assert.throws(() => server.assertPublishableHomeStyle({ layout: 'grid' }, fail), (error) => error.status === 400, 'a malformed stored draft never publishes');
  assert.equal(server.assertPublishableHomeStyle(undefined, fail).layout, 'tile', 'a legacy draft publishes the default composition');
});

test('retired choices read, save and publish as their replacements and are never an error', () => {
  const stored = { layout: 'typography', menuShape: 'list' };
  assert.equal(server.normalizeHomeStyle(stored).layout, 'tile', 'a stored typography page reads as the tile home');
  assert.equal(plain(lib.normalizeHomeStyle(stored)).layout, 'tile', 'and so does the web');
  assert.ok(!('menuShape' in server.normalizeHomeStyle(stored)) && !('menuShape' in plain(lib.normalizeHomeStyle(stored))), 'menuShape is no longer a style key');
  assert.equal(server.validateHomeStyleUpdate({ layout: 'typography', menuShape: 'list' }, server.defaultHomeStyle(), fail).layout, 'tile', 'an editor tab from before the retirement saves as tile');
  assert.equal(server.assertPublishableHomeStyle({ layout: 'typography', menuShape: 'list' }, fail).layout, 'tile', 'a stored typography draft still publishes');
});

test('the photo-first instagram layout saves, publishes and reads the same on both sides', () => {
  const stored = server.defaultHomeStyle();
  const next = server.validateHomeStyleUpdate({ layout: 'instagram' }, stored, fail);
  assert.equal(next.layout, 'instagram', 'save accepts it');
  assert.equal(server.assertPublishableHomeStyle({ layout: 'instagram' }, fail).layout, 'instagram', 'publish accepts it');
  assert.equal(server.normalizeHomeStyle({ layout: 'instagram' }).layout, 'instagram', 'the public projection keeps it');
  assert.equal(plain(lib.normalizeHomeStyle({ layout: 'instagram' })).layout, 'instagram', 'the web reads it the same');
  assert.equal(server.validateHomeStyleUpdate({ textAlign: 'left' }, next, fail).layout, 'instagram', 'an unrelated edit leaves it alone');
});

test('the home feed lists approved photos only, newest first, through the caller\'s own route', () => {
  const src = (fileId) => `/files/${fileId}`;
  const photo = (id, status, extra = {}) => ({ id, status, name: '감사 참가자', caption: `사진 ${id}`, at: '2026-11-18T05:00:00.000Z', image: { fileId: `file-${id}`, type: 'image/png', size: 10 }, ...extra });
  const parsed = plain(lib.parseHomePhotos([
    photo('old', 'APPROVED', { at: '2026-11-18T04:00:00.000Z' }),
    photo('pending', 'PENDING'),
    photo('hidden', 'HIDDEN'),
    photo('new', 'APPROVED', { at: '2026-11-18T06:30:00.000Z', caption: '  개막 키노트  ', name: '  홍길동 ' }),
    photo('noimage', 'APPROVED', { image: null }),
    photo('badid', 'APPROVED', { image: { fileId: '../etc/passwd' } }),
    photo('noid', 'APPROVED', { id: '' }),
    photo('notime', 'APPROVED', { at: 'not-a-time' }),
    null, 'text', 7, [],
  ], src));
  assert.deepEqual(parsed.map((item) => item.id), ['new', 'old', 'notime'], 'approved only, newest first, unreadable time last');
  assert.deepEqual(parsed[0], { id: 'new', src: '/files/file-new', caption: '개막 키노트', name: '홍길동', at: '2026-11-18T06:30:00.000Z' });
  assert.deepEqual(plain(lib.parseHomePhotos(undefined, src)), []);
  assert.deepEqual(plain(lib.parseHomePhotos('nope', src)), []);
  assert.equal(lib.HOME_FEED_LIMIT, 12);
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

test('the landing renders one of three compositions with the same entries; the feed needs approved photos', () => {
  const landing = read('app/event/[slug]/home/AttendeeHomeLanding.tsx');
  const css = read('app/event/[slug]/home/home-layouts.module.css');
  assert.match(landing, /const homeStyle = normalizeHomeStyle\(homeStyleInput\);/u, 'partial or stored styles read through the defaults');
  assert.doesNotMatch(landing + css, /typography|typoHead/u, 'the typography layout is retired');
  assert.match(landing, /const shape = layout === "tile" \? "tile" : layout === "poster" \? "circle" : "row";/u, 'poster menus are always round');
  // The banner is shared with the event guide so both read the same published design.
  const heroSource = read('app/event/[slug]/home/HomeHero.tsx');
  assert.match(landing, /<HomeHero\b/u);
  // Reopened 2026-11-20: the fill, picture and tone rules are lib/banner-appearance, shared with the ticket / application banner.
  const appearance = read('lib/banner-appearance.ts');
  assert.match(heroSource, /useBannerAppearance\(homeStyle, keyvisual, defaultHomeBanner\)/u);
  assert.match(appearance, /const fill = bannerFillCss\(homeStyle\);/u);
  assert.match(appearance, /const tone = fill \? bannerFillTone\(homeStyle\) : neutral \? "light" : homeStyle\.textTone;/u, 'a color banner reads its own tone');
  // instagram: a feed of approved participant photos under a slim banner.
  assert.match(landing, /const layout = homeStyle\.layout === "instagram" && !photos\.length && !preview \? "tile" : homeStyle\.layout;/u, 'a public page with no approved photo reads as the tile home; the console preview keeps the layout');
  assert.match(landing, /const feed = layout === "instagram" \? \(/u);
  assert.match(landing, /\{feed\}\n\s+<nav className=\{L\.menus\}/u, 'the feed sits between the ticket and the menus');
  assert.match(landing, /photos\.slice\(0, HOME_FEED_LIMIT\)/u);
  assert.match(landing, /data-feed-photo=\{photo\.id\}/u);
  assert.match(landing, /승인된 참가자 사진이 여기에 표시됩니다/u, 'the preview says where the photos will go');
  assert.match(css, /\.instagram \.hero \{ height: clamp\(124px, 36cqi, 176px\); \}/u);
  assert.match(css, /\.tile \.ticketWrap, \.poster \.ticketWrap, \.instagram \.ticketWrap \{ margin-top: -26px; \}/u);
  assert.match(css, /\.tile \.hero \{ height: clamp\(156px, 44cqi, 230px\); \}/u);
  assert.match(css, /\.poster \.hero \{ height: clamp\(300px, 88cqi, 460px\); justify-content: flex-end; \}/u);
  assert.match(css, /\.group_tile \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/u, 'tiles are two square columns');
  assert.match(css, /\.root \.tile \{[^}]*aspect-ratio: 1;/su);
  // The floating ticket rides over the banner's lower edge (approved tile and
  // poster mock); the entry grid below it clears the banner by audit.
  // The ticket's "열기" pill sits on the brand color, so its text uses the
  // on-brand ink token (white fails contrast on the default brand), and the
  // visible word stays in the accessible name (no aria-hidden on visible text).
  // Reopened 2026-11-20: the pill is the event color and its ink (--ev-accent, falling back to the brand).
  assert.match(css, /\.ticketGo \{[^}]*background: var\(--ev-accent, var\(--brand\)\)[^}]*color: var\(--ev-on-accent, var\(--on-brand\)\)/su);
  assert.match(landing, /<span className=\{L\.ticketGo\}>열기<\/span>/u);
  assert.doesNotMatch(landing, /ticketGo\} aria-hidden/u);
});

test('the studio is a live phone beside a short list; rows open in place; the photo layout is a real choice', () => {
  const theme = read('app/console/events/[id]/page/ThemeWorkspace.tsx');
  const picker = read('app/console/events/[id]/page/LayoutPicker.tsx');
  assert.match(theme, /<LayoutPicker[\s\S]{0,700}onLayout=\{selectLayout\}/u);
  assert.doesNotMatch(theme + picker, /typography|menuShape|onMenuShape/u, 'the typography layout and the menu shape choice are retired');
  assert.match(theme, /<li>\{studioRow\("banner", "배너"/u, 'every layout has a banner');
  assert.deepEqual([...picker.matchAll(/\{ id: "(\w+)", name:/gu)].map((match) => match[1]), ['tile', 'poster', 'instagram'], 'the studio offers the tile, poster and photo layouts');
  assert.match(picker, /\{ id: "instagram", name: "인스타형", hint: "참가자 사진 피드" \}/u, 'the photo layout is a real card, no longer locked');
  assert.doesNotMatch(picker, /곧 제공|styles\.locked|aria-disabled="true"/u);
  assert.match(picker, /photos=\{photos\}/u, 'the card thumbnail is the real home with the real photos');
  assert.match(picker, /<AttendeeHomeLanding/u, 'cards are the real home, scaled');
  assert.match(picker, /inert>/u, 'a card thumbnail is not interactive');
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
