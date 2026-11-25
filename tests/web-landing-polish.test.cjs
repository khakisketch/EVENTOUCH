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
const LANDING_CSS = ['landing.module.css', 'landing-sections.module.css', 'product-preview.module.css', 'landing-play.module.css'];

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

test('the hero is one still scene: the live count with the ticket laid over it, no tabs and nothing rotating', () => {
  // Reopened 2026-11-25 (owner chose 가안): replaces the three rotating tabs.
  const home = read('page.tsx');
  const css = strip(read('landing.module.css'));
  assert.match(home, /<ProductPreview variant="live" \/>/u);
  assert.match(home, /className=\{styles\.heroPhone\}><ProductPreview variant="ticket" \/>/u);
  assert.doesNotMatch(home, /role="tablist"|role="tab"|setInterval|HERO_TABS/u, 'no tabs and no auto-rotation');
  assert.match(css, /\.heroScene \{[^}]*\bheight:\s*560px/su, 'a fixed scene height so the page below never moves');
  assert.match(css, /\.heroPhone \{[^}]*overflow:\s*hidden/su);
  // The phone sits over the list rows, never over the entry card: the card stops short of it on a wide scene.
  assert.match(read('product-preview.module.css'), /@container \(min-width: 480px\) \{\s*\.liveCanvas \.entry,\s*\.liveCanvas \.recent \{ max-width: 300px; \}/u);
});

test('the hero strip says what to know up front, in sentences that read on their own', () => {
  const home = read('page.tsx');
  for (const text of ['미리 알려 드립니다', '참가자 앱 설치 없이 링크로 신청·티켓', '문자·알림톡은 발송 연결 후 실제 발송', '고객사 포털은 제공하지 않음', '직접 눌러 보기', 'QR 입장, 실시간 현황, 결과 보고서까지.']) assert.ok(home.includes(text), `${text} is in the hero`);
  assert.doesNotMatch(home, /합성 데이터|도입 전 확인|문자 발송 연결 확인|행사 종류·일정·규모를 적을 수 있게 준비합니다|화면 구성 살펴보기/u);
});

test('the hands-on section runs the draw and the roulette in the browser and ends at check-in', () => {
  // Reopened 2026-11-25 (owner chose the 직접 눌러 보는 방식): replaces the three-moment journey tabs.
  const play = read('LandingPlay.tsx');
  assert.match(play, /무대 추첨[\s\S]*휴대폰 룰렛[\s\S]*체크인/u, 'draw, roulette, check-in in that order');
  assert.match(play, /<ProductPreview variant="ticket" \/>[\s\S]*?<ProductPreview variant="staff" \/>/u);
  // The wheel stops with the picked prize under the pointer: six equal sectors of 60 degrees.
  assert.match(play, /const target = 360 - \(pick \* 60 \+ 30\);/u);
  assert.match(play, /const PRIZES = \[[^\]]*\] as const;/u);
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
  // The check-in block names the screens by their current menu names.
  for (const label of ['입장·스태프', '현장 모드']) assert.ok(read('LandingPlay.tsx').includes(label), `${label} in the check-in block`);
  assert.doesNotMatch(home, /스태프 체크인, 부스 인증|결과 분석, 보고서/u);
});
