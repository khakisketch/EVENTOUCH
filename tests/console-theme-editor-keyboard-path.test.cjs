// 참가자 페이지 편집기 키보드 경로 (사용성 감사 후속):
// 편집 필드가 저장·게시 동작보다 앞에 몰려 있어 키보드로 초안 저장이
// 25 Tab 이상 걸렸다. 편집 폼 앞단의 보이는 이동 수단이 실제 저장
// 조작으로 포커스를 옮긴다. 기능 추가가 아니라 이동 수단만 늘리므로
// 서버 계약·커맨드·문구·정보량은 그대로다.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const theme = read('apps/web/app/console/events/[id]/page/ThemeWorkspace.tsx');
const themeCss = read('apps/web/app/console/events/[id]/page/page.module.css');

function cssBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} styles exist`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `${selector} block closes`);
  return css.slice(open + 1, close);
}

test('the edit form opens with a visible jump to the save actions', () => {
  // The link lives inside the edit region, ahead of every editing field.
  const controlsAt = theme.indexOf('<div className={styles.controls} id="theme-edit">');
  assert.ok(controlsAt >= 0, 'the edit region keeps its anchor');
  const skipAt = theme.indexOf('styles.editorSkip', controlsAt);
  const firstFieldsetAt = theme.indexOf('<fieldset', controlsAt);
  const firstInputAt = theme.indexOf('id="home-background"', controlsAt);
  assert.ok(skipAt >= 0, 'the in-form skip link exists');
  assert.ok(skipAt < firstFieldsetAt, 'the link comes before the first field group');
  assert.ok(skipAt < firstInputAt, 'the link comes before the first input');
  // A natively focusable anchor with a real href: keyboard reachable even
  // if the script handler never runs.
  assert.match(theme, /<a className=\{styles\.editorSkip\} href="#theme-save-draft"[^>]*onClick=\{jumpToSaveActions\}/u);
  // Wording names the destination and the skipping, so it cannot be
  // mistaken for the top jump nav labels (편집 / 저장·게시 / 미리보기).
  assert.match(theme, /편집 항목을 건너뛰고 저장·게시로 이동/u);
  for (const navLabel of ['편집', '저장·게시', '미리보기']) {
    assert.notEqual('편집 항목을 건너뛰고 저장·게시로 이동', navLabel, 'distinct from the jump nav label');
  }
  assert.doesNotMatch(theme, />편집<\/a>/u, 'no bare 편집 duplicate of the jump nav');
  assert.doesNotMatch(theme, />저장·게시<\/a>/u, 'no bare 저장·게시 duplicate of the jump nav');
});

test('activating the link hands focus to the save actions with the viewport', () => {
  // Same rule as the global skip link: replace the fragment jump, focus the
  // target, then bring the viewport along. Focus — not scroll alone — is
  // what saves the 25 tabs.
  assert.match(theme, /const saveActionsRef = useRef<HTMLDivElement>\(null\)/u);
  assert.match(theme, /event\.preventDefault\(\)/u, 'the default fragment jump is replaced');
  assert.match(theme, /saveActionsRef\.current/u);
  assert.match(theme, /\.focus\(\{ preventScroll: true \}\)/u, 'focus moves into the save region');
  assert.match(theme, /\.scrollIntoView\(\{ block: "start" \}\)/u, 'the viewport follows the focus');
  // The landing target is the real save region: focusable by script only
  // (tab order unchanged) and wrapping the actual save button.
  assert.match(theme, /<div id="theme-save" ref=\{saveActionsRef\} tabIndex=\{-1\} className=\{`\$\{styles\.saveAnchor\} \$\{styles\.saveBar\}`\}>/u);
  assert.match(themeCss, /\.saveBar\s*\{[^}]*position:\s*sticky/su);
  const saveRegionAt = theme.indexOf('<div id="theme-save"');
  const saveButtonAt = theme.indexOf('초안 저장', saveRegionAt);
  const publishButtonAt = theme.indexOf(': "게시"', saveRegionAt);
  assert.ok(saveRegionAt >= 0 && saveButtonAt > saveRegionAt, 'the save button lives inside the landing target');
  assert.ok(publishButtonAt > saveButtonAt, 'publish still follows save inside the region');
  // The next Tab stop after the focused region is the save button itself:
  // no tabbable control sits between the region start and 초안 저장.
  const between = theme.slice(saveRegionAt, saveButtonAt);
  assert.doesNotMatch(between, /<input/u, 'no input steals the first Tab stop');
  assert.doesNotMatch(between, /<select/u, 'no select steals the first Tab stop');
  assert.doesNotMatch(between, /<button/u, 'no earlier button steals the first Tab stop');
});

test('the top jump nav marks the position on its own links, with no second readout', () => {
  assert.match(theme, /<ConsoleSectionNav/u, 'the shared jump nav stays');
  for (const item of ['{ id: "theme-edit", label: "편집" }', '{ id: "theme-save", label: "저장·게시" }', '{ id: "home-preview-heading", label: "미리보기" }']) {
    assert.ok(theme.includes(item), `${item} stays in the nav`);
  }
  assert.match(theme, /activeId=\{activeSection\}/u, 'the tracked section drives the active link');
  assert.doesNotMatch(theme, /현재 위치:/u, 'no separate position readout duplicates the links');
  assert.match(theme, /IntersectionObserver/u, 'the section follower stays');
  assert.match(themeCss, /\.navSticky \{/u);
  assert.doesNotMatch(themeCss, /\.navNow \{/u, 'the readout style is gone');
});

test('the in-form jump is visible, touch-sized, and token-styled', () => {
  const skip = cssBlock(themeCss, '.editorSkip');
  assert.match(skip, /min-height: 44px/u, '44px touch target');
  assert.match(skip, /background: var\(--info-soft\)/u);
  assert.match(skip, /color: var\(--info\)/u);
  assert.match(skip, /border: 1px solid var\(--info-line\)/u);
  assert.doesNotMatch(skip, /clip:/u, 'never visually hidden like sr-only');
  assert.doesNotMatch(skip, /translateY\(-200%\)/u, 'never parked off-canvas like the global skip link');
  assert.doesNotMatch(skip, /#[0-9a-fA-F]{3,8}/u, 'new styles use tokens.css tokens only');
  assert.match(themeCss, /\.editorSkip:focus-visible \{/u, 'keyboard focus stays visible');
  const anchor = cssBlock(themeCss, '.saveAnchor');
  assert.match(anchor, /scroll-margin-top: var\(--s4\)/u);
  assert.match(themeCss, /\.saveAnchor:focus \{/u, 'the programmatic focus target shows its outline');
  assert.doesNotMatch(anchor, /#[0-9a-fA-F]{3,8}/u, 'landing target styles use tokens only');
});

test('no copy removed, no server contract touched', () => {
  // Existing fieldset legends and helper copy survive untouched.
  for (const copy of ['<legend>배경</legend>', '<legend>배너 이미지</legend>', '<legend>소개와 노출</legend>', '<legend>문구와 배치</legend>', '되돌리기', '초안 저장', '게시하기']) {
    assert.ok(theme.includes(copy), `existing copy survives: ${copy}`);
  }
  // The only commands stay the page save/publish pair.
  const commands = [...theme.matchAll(/command: "(attendee\.[^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(commands, ['attendee.page.publish', 'attendee.page.save']);
  const fetches = [...theme.matchAll(/fetch\(\s*[`"']([^`"']+)/gu)].map((match) => match[1]);
  // The file upload builds its URL into a variable first (fetch(url, …)),
  // so only the literal auth/bootstrap/command fetches appear here.
  assert.deepEqual(fetches, [
    '/api/auth/me',
    '/api/bootstrap',
    '/api/events/${encodeURIComponent(eventId)}/commands',
    '/api/events/${encodeURIComponent(eventId)}/commands',
  ]);
  assert.doesNotMatch(theme, /postCommand\(/u, 'no new command plumbing added');
});

test("the skip control carries the product-wide hook the audit measures", () => {
  assert.match(theme, /data-skip-to="theme-save-draft"/u);
  assert.match(theme, /id="theme-save-draft"/u);
  assert.match(theme, /tabIndex=\{-1\}/u);
});
