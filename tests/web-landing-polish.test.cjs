'use strict';

// Reopened 2026-11-20 (landing follows the new product): the public landing
// shows the product as it looks now (C1 console, A1 attendee phone), keeps the
// hero from jumping when its tab changes, and stays inside the design tokens.
// The landing is outside tests/web-design-tokens-guard.test.cjs on purpose; this
// file holds the same three rules (weights, radii, colours) for its own files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '../apps/web/app');
const read = (file) => fs.readFileSync(path.join(app, file), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const LANDING_CSS = ['landing.module.css', 'landing-sections.module.css', 'product-preview.module.css'];

test('the console preview draws the real menu and an overview built around one entry number', () => {
  const preview = read('ProductPreview.tsx');
  const navigation = read('console/console-navigation.ts');
  const real = new Set([...navigation.matchAll(/label: "([^"]+)"/gu)].map((match) => match[1]));
  const rail = ['운영 현황', '참가자 명단', '메시지', '참가자 페이지', '공지·안내', '참여 이벤트', '입장·스태프', '행사 설정', '현장 모드', '결과 보고서'];
  for (const label of rail) {
    assert.ok(real.has(label), `${label} is a menu name of the product`);
    assert.ok(preview.includes(label), `${label} is in the drawn menu`);
  }
  // The menu names that were retired with the first redesign stay out of the drawing.
  assert.doesNotMatch(preview, /현장 운영|참여 콘텐츠(?! 보기)|지금 할 일|행사 일정/u, '참여 콘텐츠 보기 is the attendee ticket button, the menu name is 참여 이벤트');
  // 운영 현황 is one big entry number with a list beside it (DESIGN.md, 운영 현황).
  assert.match(preview, /누적 입장/u);
  assert.match(preview, /현장 모드 열기/u);
  assert.match(preview, /styles\.entry\b/u);
  // The staff phone is the dark scan screen, not a form.
  assert.match(preview, /styles\.viewfinder/u);
  for (const label of ['코드 입력', '명단 찾기', '최근 처리']) assert.ok(preview.includes(label), `${label} is on the staff bar`);
});

test('every hero tab fills one fixed stage so the page below does not move', () => {
  const home = read('page.tsx');
  const css = strip(read('landing.module.css'));
  assert.match(home, /<ProductPreview variant=\{activeHero\.id\} \/>/u);
  assert.match(home, /className=\{styles\.heroStage\}/u, 'the preview sits in the stage');
  assert.match(css, /\.heroStage \{[^}]*\bheight:\s*var\(--hero-stage-h\)/su, 'a height, not a min-height');
  assert.match(css, /\.heroStage \{[^}]*overflow:\s*hidden/su);
  assert.doesNotMatch(css, /\.heroStage \{[^}]*min-height/su);
  assert.match(css, /--hero-stage-h:/u);
  // The caption under the stage has the same number of lines on every tab.
  assert.match(css, /\.consoleCaption[^{]*\{[^}]*(min-height|flex-direction: column)/su);
});

test('the hero tabs work from the keyboard as one tab stop', () => {
  const home = read('page.tsx');
  assert.match(home, /role="tablist"[\s\S]*?role="tab"[\s\S]*?aria-selected/u);
  assert.match(home, /tabIndex=\{tab\.id === heroTab \? 0 : -1\}/u, 'the chosen tab is the only tab stop');
  assert.match(home, /aria-controls="hero-panel"/u);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(home.includes(key), `${key} moves between the tabs`);
  assert.match(home, /prefers-reduced-motion/u, 'the hero never turns by itself for people who asked for less motion');
});

test('the journey keeps one stage height and shows the chosen moment as a caption on small screens', () => {
  const css = strip(read('landing-sections.module.css'));
  const flow = read('LandingFlow.tsx');
  assert.match(css, /\.flowStage \{[^}]*\bheight:\s*var\(--flow-stage-h\)/su);
  assert.doesNotMatch(css, /\.flowStage \{[^}]*min-height/su);
  assert.match(flow, /styles\.flowCaption/u);
});

test('landing styles use only the 400 / 600 / 800 weights, token radii and no hex colours', () => {
  for (const file of LANDING_CSS) {
    const css = strip(read(file));
    for (const [, value] of css.matchAll(/font-weight:\s*([^;}]+)/gu)) {
      assert.match(value.trim(), /^(400|600|800|var\(--fw-(regular|strong|heavy)\))$/u, `${file}: font-weight ${value.trim()}`);
    }
    for (const [, value] of css.matchAll(/border-radius:\s*([^;}]+)/gu)) {
      assert.doesNotMatch(value, /\d+(\.\d+)?px/u, `${file}: border-radius ${value.trim()} should be a --r-* or --radius-* token`);
    }
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu, `${file}: a hex colour`);
    assert.doesNotMatch(css, /font-size:\s*[^;}]*\d(\.\d+)?px/u, `${file}: a raw px font-size`);
  }
});

test('the landing states only numbers and features the product has', () => {
  const home = read('page.tsx');
  const compare = read('LandingCompare.tsx');
  assert.doesNotMatch(home, /평균 일주일|100명 이상|열 배|\d+% 단축/u, 'no invented figures');
  assert.doesNotMatch(compare, /실시간/u, 'the roster refreshes on its own schedule; do not call it real time');
  // The result section names what the report screen really offers.
  assert.match(home, /PPTX/u);
  // The journey names the screens by their current menu names.
  for (const label of ['입장·스태프', '현장 모드', '결과 보고서']) assert.ok(home.includes(label), `${label} in the journey`);
  assert.doesNotMatch(home, /스태프 체크인, 부스 인증|결과 분석, 보고서/u);
});
