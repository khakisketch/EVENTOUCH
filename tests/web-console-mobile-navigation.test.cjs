'use strict';

// Mobile top-menu navigation: the persistent bottom 행사/고객사 bar is gone,
// replaced by a small top "메뉴" disclosure with only the existing permitted
// destinations. These tests pin the approved unit: no bottom-bar markup or
// styles, header disclosure semantics with permission gates, closing rules,
// 44px floors, and no draft-guard bypass.
//
// Older bottom-bar presentation assertions live in web-slice-contract.test.cjs
// and stay owned by main; this file must not duplicate or edit them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

const shell = () => read('app/console/ConsoleShell.tsx');
const globalStyles = () => read('app/globals.css');

test('bottom bar markup is gone from the shell', () => {
  const source = shell();
  assert.doesNotMatch(source, /mobile-primary-nav/u);
  assert.doesNotMatch(source, /side-nav-single-root/u);
  assert.doesNotMatch(source, /workspace-events-link-mobile/u);
  assert.doesNotMatch(source, /workspace-clients-link-mobile/u);
});

test('top trigger is a labelled disclosure with one authored chevron, not unicode', () => {
  const source = shell();
  assert.match(source, /console-global-trigger/u);
  assert.match(source, /<span>메뉴<\/span>/u);
  assert.match(source, /console-global-trigger-chevron/u);
  assert.doesNotMatch(source, /console-global-trigger-icon/u);
  assert.match(source, /aria-expanded=\{globalMenuOpen\}/u);
  assert.match(source, /aria-controls="console-global-menu"/u);
  assert.doesNotMatch(source, /[☰≡▾▼]/u);
});

test('dropdown is a plain nav disclosure reusing the existing link gates', () => {
  const source = shell();
  assert.match(source, /id="console-global-menu"/u);
  assert.match(source, /aria-label="주요 메뉴"/u);
  assert.match(source, /hidden=\{!globalMenuOpen\}/u);
  // Disclosure semantics: links in a labelled nav, never a menu/modal role.
  assert.doesNotMatch(source, /id="console-global-menu"[^>]*role="menu"/u);
  assert.doesNotMatch(source, /createPortal\(\s*<nav/u);
  assert.match(source, /renderEventsLink\("workspace-events-link-global", "행사 목록"\)/u);
  assert.match(source, /renderClientsLink\("workspace-clients-link-global"\)/u);
  // Desktop labels are untouched: the override defaults back to the registry.
  assert.match(source, /label \?\? CONSOLE_PAGES\.events\.label/u);
  assert.match(source, /label \?\? CONSOLE_PAGES\.clients\.label/u);
  // Active states travel with the reused renderers, including the
  // in-event "행사" parent meaning.
  assert.match(source, /aria-current=\{isHome \? "page" : isEventPath \? "location" : undefined\}/u);
  assert.match(source, /aria-current=\{isClients \? "page" : undefined\}/u);
});

test('trigger only exists for permitted destinations, never as a fallback', () => {
  const source = shell();
  assert.match(source, /showGlobalTrigger\s*=\s*canSeeEvents \|\| canSeeClients/u);
  assert.match(source, /\{showGlobalTrigger \? \(/u);
});

test('menu closes on arrival, never on click, so a guard cancel keeps state', () => {
  const source = shell();
  assert.match(
    source,
    /globalFocusPendingRef\.current = false;\s*setGlobalMenuOpen\(false\);\s*\}, \[pathname\]/su
  );
  // Links stay plain client-side Links: no onClick closer that could run
  // before the draft guard answers.
  const eventsRenderer = source.slice(
    source.indexOf('function renderEventsLink'),
    source.indexOf('function renderClientsLink')
  );
  const clientsRenderer = source.slice(
    source.indexOf('function renderClientsLink'),
    source.indexOf('function renderEventBranch')
  );
  assert.doesNotMatch(eventsRenderer, /onClick/u);
  assert.doesNotMatch(clientsRenderer, /onClick/u);
});

test('current-destination link closes the menu; guarded leaves stay open', () => {
  const source = shell();
   // Capture precedes Link's bubble handler. Safety must not depend on
   // delegated/native listener ordering: only the same pathname is handled;
   // different destinations remain entirely with the shared draft guard.
  assert.match(source, /onClickCapture=\{handleGlobalMenuNavigate\}/u);
  assert.equal(source.match(/onClickCapture=\{handleGlobalMenuNavigate\}/gu)?.length ?? 0, 1);
  assert.doesNotMatch(source, /onClick=\{handleGlobalMenuNavigate\}/u);
  assert.match(source, /function handleGlobalMenuNavigate\(event: React\.MouseEvent<HTMLElement>\)/u);
  // Normal unmodified primary clicks only; cancelled events are respected.
  assert.match(source, /event\.defaultPrevented \|\| event\.button !== 0/u);
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/u);
  assert.match(source, /closest\("a\[href\]"\)/u);
  // Different destinations are left for the guard plus the pathname effect.
  assert.match(source, /if \(url\.pathname !== window\.location\.pathname\) return;/u);
  // Same destination: no navigation arrives, so close here with focus back
  // on the trigger and no same-page scroll reset.
  assert.match(
    source,
    /function handleGlobalMenuNavigate[\s\S]*?event\.preventDefault\(\);\s*closeGlobalMenu\(true\)/u
  );
});

test('Escape restores trigger focus; leaving never steals focus', () => {
  const source = shell();
  assert.match(source, /function closeGlobalMenu\(restoreFocus = false\)/u);
  assert.match(
    source,
    /if \(event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*closeGlobalMenu\(true\)/su
  );
  // Outside pointer closes without a focus restore.
  assert.match(
    source,
    /!globalTriggerRef\.current\?\.contains\(target\)\s*\)\s*\{\s*globalFocusPendingRef\.current = false;\s*setGlobalMenuOpen\(false\);\s*\}/su
  );
  // Non-modal focus leave: Tab exits and the popup must not cover the form.
  assert.match(source, /addEventListener\("focusin", onFocusIn\)/u);
  assert.match(source, /removeEventListener\("focusin", onFocusIn\)/u);
  // No Tab trap anywhere in the shell.
  assert.doesNotMatch(source, /["']Tab["']/u);
});

test('opening focuses the first permitted link; desktop width closes silently', () => {
  const source = shell();
  assert.match(
    source,
    /globalMenuRef\.current\s*\?\.querySelector<HTMLElement>\("a\.console-nav-item"\)\s*\?\.focus\(\)/su
  );
  assert.match(source, /min-width:\s*769px/u);
});

test('account and global menus are mutually exclusive without a focus race', () => {
  const source = shell();
  assert.match(source, /function handleGlobalMenuTrigger\(\) \{/u);
  assert.match(source, /function handleOperatorMenuTrigger\(event[\s\S]*?setGlobalMenuOpen\(false\)/u);
  assert.match(source, /function handleGlobalMenuTrigger\(\) \{[\s\S]*?setOperatorMenuOpen\(false\)/u);
  // Reaching for the global trigger while the account menu is open closes
  // it without restoring to the account trigger, so the global first link
  // ends focused.
  assert.match(source, /isGlobalTrigger \? false : true/u);
});

test('no guard bypass: shell keeps the shared leave check and native routing', () => {
  const source = shell();
  assert.match(source, /useConsoleLeaveConfirmation/u);
  assert.match(source, /confirmLeave\(\)/u);
  assert.doesNotMatch(source, /location\.(assign|replace)\(/u);
  assert.doesNotMatch(source, /window\.location\.href\s*=/u);
  assert.doesNotMatch(source, /location\.href\s*=/u);
  // The account popover keeps the single portal; the global menu is inline.
  assert.equal(source.match(/createPortal\(/gu)?.length ?? 0, 1);
});

test('mobile event group carries its own label, desktop keeps labelledby', () => {
  const source = shell();
  assert.match(source, /role="group"\s*aria-label="현재 행사 업무"/u);
  assert.match(source, /aria-labelledby=\{eventsLinkId\}/u);
});

test('bottom-bar styles are gone; ordinary bottom spacing stays', () => {
  const css = globalStyles();
  assert.doesNotMatch(css, /\.mobile-primary-nav/u);
  assert.doesNotMatch(css, /side-nav-single-root/u);
  assert.doesNotMatch(css, /72px/u);
  assert.match(
    css,
    /\.console-main\s*\{\s*padding:\s*var\(--s5\) var\(--s4\) calc\(var\(--s6\) \+ env\(safe-area-inset-bottom, 0px\)\);/u
  );
  assert.match(
    css,
    /scroll-padding-bottom:\s*calc\(var\(--s4\) \+ env\(safe-area-inset-bottom, 0px\)\)/u
  );
  // The two-row header height is unchanged, so the top offset is retained.
  assert.match(css, /scroll-padding-top:\s*calc\(var\(--s7\) \* 2/u);
});

test('header grid puts menu, brand and account on one row', () => {
  const css = globalStyles();
  assert.match(css, /"menu brand profile"/u);
  assert.match(css, /grid-template-columns:\s*auto minmax\(0,\s*1fr\) 44px/u);
  assert.match(css, /\.console-brand \.console-wordmark\s*\{[^}]*white-space:\s*nowrap/su);
});

test('trigger and popup stay phone-only in the dark sidebar voice', () => {
  const css = globalStyles();
  assert.match(css, /\.console-global-nav\s*\{\s*display:\s*none;\s*\}/u);
  assert.match(css, /\.console-global-trigger\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /\.console-global-menu\s*\{[^}]*z-index:\s*30/su);
  assert.match(css, /\.console-global-menu\s*\{[^}]*width:\s*220px/su);
  assert.match(css, /\.console-global-menu\s*\{[^}]*max-width:\s*calc\(100vw - var\(--s5\)\)/su);
  assert.match(css, /\.console-global-menu\s*\{[^}]*background:\s*var\(--nav\)/su);
  assert.match(css, /\.console-global-menu\[hidden\]\s*\{\s*display:\s*none/su);
  assert.match(css, /\.console-global-menu \.console-nav-item\s*\{[^}]*min-height:\s*44px/su);
  // The shared 44px row floor for all console menu rows is untouched.
  assert.match(css, /\.console-nav-item\s*\{[^}]*min-height:\s*44px/su);
});
