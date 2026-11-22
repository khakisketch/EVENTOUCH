'use strict';

// 2026-11-21 (owner: 모바일 시안 선택): 행사 설정 상태 타일·고정 칩·운영 기능 묶음 타일, 그리고
// 행사 바꾸기를 메뉴(레일 카드·서랍 카드)로 옮긴 구조. 소스 단언만; 실제 동작은 브라우저에서 확인한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '..', 'apps', 'web', 'app');
const read = (...parts) => fs.readFileSync(path.join(app, ...parts), 'utf8');
const settingsDir = ['console', 'events', '[id]', 'settings'];
const toc = read(...settingsDir, 'SettingsToc.tsx');
const tocCss = read(...settingsDir, 'settings-toc.module.css');
const workspace = read(...settingsDir, 'SettingsWorkspace.tsx');
const settingsCss = read(...settingsDir, 'settings.module.css');
const globals = read('globals.css');
const rosterCss = read('console', 'events', '[id]', 'participants', 'participants.module.css');

test('the settings list is four status tiles on phones, with a dot and an optional note per section', () => {
  assert.match(tocCss, /@media \(max-width: 1024px\) \{[^@]*\.list \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(toc, /data-tone=\{toneOf\(item\)\}/);
  assert.match(toc, /tone\?: "ok" \| "attention" \| "neutral"/);
  assert.match(workspace, /id: "intake"[^\n]*note: recoveryGap \? "확인할 안내 1건" : undefined/);
  assert.match(workspace, /id: "features"[^\n]*`\$\{featureOnCount\}개 켜짐`/);
  assert.match(workspace, /const recoveryGap = isRecoveryBlocked\(verificationMode\) && !state\.recoveryContact;/);
});

test('a chip bar sticks under the phone top bar once the tiles scroll away, marks the section being read, and ends with 맨 위로', () => {
  assert.match(toc, /new IntersectionObserver/);
  assert.match(toc, /aria-current=\{active \? "location" : undefined\}/);
  assert.match(toc, /aria-label="맨 위로"/);
  assert.match(toc, /prefers-reduced-motion/);
  assert.match(tocCss, /\.chipsAnchor \{[^}]*position: sticky;[^}]*top: var\(--settings-bar-h, 57px\);[^}]*height: 0;/s, 'zero-height sticky row adds nothing to the layout');
  assert.match(toc, /measureTopBar/, 'the top bar height is measured, not assumed, so a notched phone does not hide the chips');
  assert.match(toc, /rootMargin: `-\$\{barHeight\}px 0px 0px 0px`/);
  assert.match(toc, /observe\(bar, \{ box: "border-box" \}\)/, 'padding (safe area) changes are observed, not just the content box');
  // The phone top bar is z-index 5 and owns the menu drawer: nothing here may sit above it.
  const z = Number(/\.chipsAnchor \{[^}]*z-index: (\d+)/s.exec(tocCss)[1]);
  assert.ok(z < 5, 'chip bar stays under the top bar so the drawer opens over it');
});

test('the docked 참가자 추가 button also stays under the phone top bar', () => {
  const z = Number(/\[data-variant="primary"\]\)\s*\{\s*position: fixed; z-index: (\d+)/.exec(rosterCss)[1]);
  assert.ok(z < 5, 'the drawer opens over the docked add button');
});

test('운영 기능 keeps its switches and save; only counts, tiles and the save-bar label are added', () => {
  assert.match(workspace, /featureOnCount\}개 켜짐 · \{featureTotal - featureOnCount\}개 꺼짐/);
  assert.match(workspace, /group\.ids\.filter\(\(id\) => features\.includes\(id\)\)\.length\} \/ \{group\.ids\.length\} 켜짐/);
  assert.match(workspace, /저장 안 된 변경\{featureChangeCount > 0 \? ` \$\{featureChangeCount\}개` : ""\}/);
  assert.equal((workspace.match(/<ConsoleFormActions sticky>/g) || []).length, 2, 'both save rows stay sticky and unchanged in role');
  assert.match(workspace, /<span className=\{styles\.barSection\}>운영 기능<\/span>/);
  assert.match(settingsCss, /\.featureGrid > \.check:has\(input:checked\) \{\s*background: var\(--brand-tint\)/);
  assert.match(settingsCss, /@media \(max-width: 768px\) \{\s*\.featureGrid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('행사 바꾸기 is the current-event card in the rail and the drawer; the panel is portaled so the rail cannot clip it', () => {
  const switcher = read('console', 'console-ui', 'EventSwitcher.tsx');
  assert.match(switcher, /createPortal\(panel, document\.body\)/);
  assert.match(switcher, /!panelRef\.current\?\.contains\(target\)/, 'a click inside the portaled panel is not an outside click');
  assert.match(switcher, /"live"[\s\S]*"wait"[\s\S]*"end"/);
  assert.doesNotMatch(read('console', 'console-ui', 'ConsolePage.tsx'), /EventSwitcher/);
  assert.match(globals, /\.console-menu-event > \.console-menu-section-label:first-child \{\s*display: none;/);
});

test('the rail popover follows its card on outside scroll, closes once the card is off screen, and every non-pointer close returns focus', () => {
  const switcher = read('console', 'console-ui', 'EventSwitcher.tsx');
  assert.match(switcher, /addEventListener\("scroll", onScroll, true\)/);
  assert.match(switcher, /!\(target instanceof Node && panelRef\.current\?\.contains\(target\)\)|\(target instanceof Node && panelRef\.current\?\.contains\(target\)\)\) return/, 'scrolling inside the panel is ignored; a non-node target (window) counts as outside');
  assert.match(switcher, /rect\.bottom <= 0 \|\| rect\.top >= window\.innerHeight\) \{ setOpen\(false\)/, 'no anchor left on screen -> close');
  assert.match(switcher, /setAnchor\(anchorFromCard\(\)\)/, 'otherwise the popover is re-anchored to the card');
  assert.match(switcher, /aria-current=\{current \? "true" : undefined\} onClick=\{close\}/, 'choosing an event restores focus like Escape');
});

test('the roster ⋯ menu trigger is named for everything in it', () => {
  const roster = fs.readFileSync(path.join(app, 'console', 'events', '[id]', 'participants', 'ParticipantList.tsx'), 'utf8');
  assert.match(roster, /<summary aria-label="내보내기·가져오기">/);
});
