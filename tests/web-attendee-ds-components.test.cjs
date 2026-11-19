'use strict';

// Attendee design-system foundation (2026-11-20, stage 2 of the design-system
// plan). The attendee components under app/event/[slug]/ui share one palette
// (--ev-* from lib/event-palette) and one mode wrapper (AttendeeSurface:
// data-attendee-mode a1 | a2). This file pins their source contract (tokens
// only, three font weights, 48px targets, reduced motion, keep-all) and renders
// them to check the roles and the mode switch. The CSS is also held to "no raw
// px font-size or radius, no hex" here, so the guard does not depend on a
// shared token-guard test existing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const WEB = path.join(__dirname, '..', 'apps/web');
const UI = path.join(WEB, 'app/event/[slug]/ui');
const webRequire = createRequire(path.join(WEB, 'package.json'));
const ts = webRequire('typescript');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

const read = (file) => fs.readFileSync(path.join(UI, file), 'utf8');
const MODULES = ['AttendeeSurface', 'AttendeeCard', 'AttendeeSectionHeader', 'AttendeeListRow', 'AttendeeStateMessage', 'BottomAction', 'AttendeeStep'];
const css = Object.fromEntries(MODULES.map((name) => [name, read(`${name}.module.css`)]));

const tokens = fs.readFileSync(path.join(WEB, 'app/tokens.css'), 'utf8');
const TOKEN_NAMES = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));
// The palette variables (lib/event-palette paletteStyle and AttendeeSurface).
const EV_VARS = new Set(['--ev-accent', '--ev-accent-strong', '--ev-accent-soft', '--ev-on-accent', '--ev-accent-ink', '--ev-ground', '--ev-ground-ink']);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the new CSS modules use tokens only: no hex, no raw px font-size or radius', () => {
  for (const [name, source] of Object.entries(css)) {
    const body = stripComments(source);
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, `${name}: no hex colors`);
    assert.doesNotMatch(body, /\brgba?\(|\bhsla?\(/, `${name}: no rgb/hsl literals`);
    for (const match of body.matchAll(/font-size\s*:\s*([^;]+);/g)) {
      assert.match(match[1].trim(), /^var\(--[a-z0-9-]+\)$/, `${name}: font-size ${match[1]} must be a token`);
    }
    for (const match of body.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;]+);/g)) {
      assert.doesNotMatch(match[1], /\d+(?:\.\d+)?px/, `${name}: radius ${match[1]} must come from tokens`);
    }
    for (const match of body.matchAll(/var\((--[a-z0-9-]+)/g)) {
      assert.ok(TOKEN_NAMES.has(match[1]) || EV_VARS.has(match[1]), `${name}: ${match[1]} is neither a tokens.css token nor an --ev-* variable`);
    }
  }
});

test('font weights stay within 400, 600 and 800', () => {
  for (const [name, source] of Object.entries(css)) {
    for (const match of stripComments(source).matchAll(/font-weight\s*:\s*([^;]+);/g)) {
      assert.ok(['400', '600', '800'].includes(match[1].trim()), `${name}: font-weight ${match[1]}`);
    }
  }
});

test('words keep together and motion respects reduced-motion', () => {
  for (const name of ['AttendeeSurface', 'AttendeeCard', 'AttendeeSectionHeader', 'AttendeeListRow', 'AttendeeStateMessage', 'BottomAction']) {
    assert.match(css[name], /word-break:\s*keep-all/, `${name} keeps Korean words together`);
  }
  for (const [name, source] of Object.entries(css)) {
    // Remove the no-preference blocks; nothing animated may remain outside them.
    let rest = stripComments(source);
    const start = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/g;
    let match;
    while ((match = start.exec(rest))) {
      let depth = 1;
      let at = match.index + match[0].length;
      while (depth > 0 && at < rest.length) depth += rest[at] === '{' ? 1 : rest[at] === '}' ? -1 : 0, at += 1;
      rest = rest.slice(0, match.index) + rest.slice(at);
      start.lastIndex = match.index;
    }
    assert.doesNotMatch(rest, /\btransition\s*:|\banimation\s*:|@keyframes|\btransform\s*:/, `${name}: motion only inside prefers-reduced-motion: no-preference`);
  }
});

test('controls are at least 48px (var(--s7)) and rows at least 56px', () => {
  assert.match(css.BottomAction, /\.button\s*\{[^}]*min-height:\s*var\(--s7\)/, 'bottom buttons are 48px or more');
  assert.match(css.BottomAction, /\.primary\s*\{[^}]*min-height:\s*calc\(var\(--s7\) \+ var\(--s2\)\)/, 'the strong action is 56px');
  assert.match(css.AttendeeListRow, /\.row\s*\{[^}]*min-height:\s*calc\(var\(--s7\) \+ var\(--s2\)\)/, 'a whole row is one 56px target');
  assert.match(css.AttendeeSectionHeader, /\.action\s*\{[^}]*min-height:\s*calc\(var\(--s7\)\)/, 'the header link is a 48px target');
  assert.match(css.AttendeeStateMessage, /\.action\s*\{[^}]*min-height:\s*var\(--s7\)/, 'the state action is 48px');
  assert.match(css.AttendeeCard, /border-radius:\s*calc\(var\(--radius-card\) \+ var\(--s1\)\)/, 'cards are 22px (18px card radius + one step)');
});

test('the bottom bar is safe-area aware, fixed inside the 520px column, and never covers content', () => {
  const bar = css.BottomAction;
  assert.match(bar, /env\(safe-area-inset-bottom/, 'safe-area padding');
  assert.match(bar, /\.bar\s*\{[^}]*position:\s*fixed[^}]*width:\s*min\(100%,\s*520px\)[^}]*margin-inline:\s*auto/s, 'centered 520px column on a desktop');
  assert.match(bar, /\.spacer\s*\{[^}]*height:/, 'a spacer reserves the bar height');
  const source = read('BottomAction.tsx');
  assert.match(source, /export function BottomActionSpacer/);
  assert.match(source, /spacer = true/, 'the bar renders its spacer unless told not to');
});

test('one mode wrapper switches a1 and a2; components only react to it', () => {
  const surface = read('AttendeeSurface.tsx');
  assert.match(surface, /data-attendee-mode=\{mode\}/);
  assert.match(surface, /paletteStyle\(/);
  assert.match(surface, /"--ev-ground"/);
  assert.match(surface, /mode = "a1"/, 'a1 is the default');
  for (const name of ['AttendeeCard', 'AttendeeSectionHeader', 'AttendeeListRow', 'AttendeeStateMessage', 'BottomAction', 'AttendeeStep']) {
    assert.doesNotMatch(read(`${name}.tsx`), /data-attendee-mode/, `${name} reads the mode, it does not set it`);
    assert.match(css[name], /\[data-attendee-mode="a2"\]/, `${name} has an a2 look`);
  }
  assert.doesNotMatch(css.AttendeeSurface, /data-attendee-mode/, 'the wrapper paints from variables');
});

test('every new component draws icons from the single AttendeeIcon source', () => {
  const icons = fs.readFileSync(path.join(WEB, 'app/event/[slug]/AttendeeIcons.tsx'), 'utf8');
  for (const name of ['calendar', 'pin', 'ticket', 'gift', 'chat', 'vote', 'chevron', 'check', 'info', 'alert']) {
    assert.match(icons, new RegExp(`case "${name}":`), `icon ${name}`);
  }
  assert.match(read('AttendeeIcon.tsx'), /from "\.\.\/AttendeeIcons"/);
  for (const name of ['AttendeeSectionHeader', 'AttendeeListRow', 'AttendeeStateMessage']) {
    assert.match(read(`${name}.tsx`), /from "\.\/AttendeeIcon"/, `${name} uses the shared icon`);
    assert.doesNotMatch(read(`${name}.tsx`), /<svg/, `${name} draws no private icons`);
  }
});

// ---- rendering ------------------------------------------------------------

function loadComponent(name) {
  const source = read(`${name}.tsx`);
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const shims = {
    react: React,
    'react/jsx-runtime': webRequire('react/jsx-runtime'),
    'next/link': { __esModule: true, default: ({ href, children, ...rest }) => React.createElement('a', { href, ...rest }, children) },
    [`./${name}.module.css`]: new Proxy({}, { get: (_, key) => String(key) }),
    './AttendeeIcon': { __esModule: true, default: ({ name: icon }) => React.createElement('svg', { 'data-icon': icon, 'aria-hidden': 'true' }) },
    '../AttendeeIcons': { __esModule: true, default: ({ name: icon }) => React.createElement('svg', { 'data-icon': icon, 'aria-hidden': 'true' }) },
    '../../../../lib/attendee-home': loadLib('attendee-home'),
    '../../../../lib/event-palette': loadLib('event-palette'),
  };
  const localRequire = (id) => {
    if (id.endsWith('.module.css')) return shims[`./${name}.module.css`];
    return id in shims ? shims[id] : webRequire(id);
  };
  vm.runInNewContext(out, { module, exports: module.exports, require: localRequire, console }, { filename: `${name}.tsx` });
  return module.exports;
}

const libCache = {};
function loadLib(file) {
  if (libCache[file]) return libCache[file];
  const out = ts.transpileModule(fs.readFileSync(path.join(WEB, `lib/${file}.ts`), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, { module, exports: module.exports, require: (id) => (id === './attendee-home' ? loadLib('attendee-home') : webRequire(id)) }, { filename: `${file}.ts` });
  libCache[file] = module.exports;
  return module.exports;
}

const html = (element) => renderToStaticMarkup(element);
const h = React.createElement;

test('AttendeeSurface applies the palette, the ground and the mode', () => {
  const Surface = loadComponent('AttendeeSurface').default;
  const a1 = html(h(Surface, { color: '#2B62EE' }, 'x'));
  assert.match(a1, /data-attendee-mode="a1"/);
  assert.match(a1, /--ev-accent:#2B62EE/);
  assert.match(a1, /--ev-ground:var\(--paper\)/, 'a1 paints white');
  const a2 = html(h(Surface, { color: '#FFE600', mode: 'a2' }, 'x'));
  assert.match(a2, /data-attendee-mode="a2"/);
  assert.match(a2, /--ev-ground:#FFE600/, 'a2 paints the event color');
  assert.match(a2, /--ev-ground-ink:#17252B/, 'dark ink on a yellow ground');
  const own = html(h(Surface, { color: '#2B62EE', mode: 'a2', ground: '#101114' }, 'x'));
  assert.match(own, /--ev-ground:#101114/, 'the event background color can be the ground');
  assert.match(own, /--ev-ground-ink:#FFFFFF/);
  assert.match(html(h(Surface, { color: 'nope', mode: 'a2' }, 'x')), /--ev-ground:#EA552E/, 'invalid colors fall back to the brand');
  assert.equal(loadComponent('AttendeeSurface').attendeeMode('a2'), 'a2');
  assert.equal(loadComponent('AttendeeSurface').attendeeMode('anything'), 'a1');
});

test('AttendeeStateMessage: error is an alert; empty and info are status', () => {
  const State = loadComponent('AttendeeStateMessage').default;
  const error = html(h(State, { kind: 'error', title: '티켓을 불러오지 못했어요', action: { label: '다시 시도', onClick() {} } }, '잠시 뒤에 다시 시도해 주세요.'));
  assert.match(error, /role="alert"/);
  assert.match(error, /<button type="button"/);
  const empty = html(h(State, { kind: 'empty', title: '아직 공지가 없어요' }));
  assert.match(empty, /role="status"/);
  assert.doesNotMatch(empty, /role="alert"/);
  assert.match(html(h(State, { kind: 'info', title: '안내', action: { label: '보기', href: '/x' } })), /role="status"[\s\S]*<a [^>]*href="\/x"/);
});

test('AttendeeListRow: the whole row is one link, one button or a static row', () => {
  const mod = loadComponent('AttendeeListRow');
  const Row = mod.default;
  const link = html(h(mod.AttendeeList, { label: '메뉴' }, h(Row, { icon: 'ticket', title: '내 티켓', meta: '입장 QR', href: '/t' })));
  assert.match(link, /<ul [^>]*role="list"[^>]*aria-label="메뉴"/);
  assert.equal((link.match(/<a /g) ?? []).length, 1, 'exactly one target per row');
  assert.match(link, /data-icon="chevron"/);
  const button = html(h(Row, { icon: 'gift', title: '경품', onClick() {} }));
  assert.match(button, /<li[^>]*><button type="button"/);
  const staticRow = html(h(Row, { icon: 'pin', title: '장소', meta: '서울' }));
  assert.doesNotMatch(staticRow, /<a |<button|chevron/);
});

test('AttendeeCard labels its region by its heading', () => {
  const Card = loadComponent('AttendeeCard').default;
  const withHeading = html(h(Card, { heading: '일정', headingLevel: 3 }, '본문'));
  const id = /aria-labelledby="([^"]+)"/.exec(withHeading)?.[1];
  assert.ok(id, 'a headed card is a labelled section');
  assert.match(withHeading, new RegExp(`<h3 id="${id.replace(/[:]/g, '\\:')}"`));
  assert.match(withHeading, /^<section/);
  assert.doesNotMatch(html(h(Card, null, '본문')), /aria-labelledby/);
});

test('AttendeeStep reads as a progressbar and clamps its range', () => {
  const Step = loadComponent('AttendeeStep').default;
  const out = html(h(Step, { current: 1, total: 3 }));
  assert.match(out, /role="progressbar"/);
  assert.match(out, /aria-valuenow="1"/);
  assert.match(out, /aria-valuemax="3"/);
  assert.match(out, /aria-valuetext="3단계 중 1단계"/);
  assert.match(html(h(Step, { current: 9, total: 3 })), /aria-valuenow="3"/);
  assert.match(html(h(Step, { current: 0, total: 3 })), /aria-valuenow="1"/);
});

test('BottomAction renders a spacer and one primary plus an optional secondary', () => {
  const mod = loadComponent('BottomAction');
  const BottomAction = mod.default;
  const one = html(h(BottomAction, { primary: { label: '신청하기', href: '/r' }, label: '신청' }));
  assert.match(one, /data-bottom-action-spacer/);
  assert.match(one, /role="group" aria-label="신청"/);
  assert.match(one, /<a [^>]*href="\/r"/);
  const two = html(h(BottomAction, { primary: { label: '제출', type: 'submit', form: 'f' }, secondary: { label: '이전', onClick() {} }, spacer: false }));
  assert.doesNotMatch(two, /data-bottom-action-spacer/);
  assert.match(two, /type="submit" form="f"/);
  assert.match(two, /<button type="button"[^>]*>이전/);
  assert.match(html(h(mod.BottomActionSpacer, { withSecondary: true })), /aria-hidden="true"/);
});

test('AttendeeSectionHeader puts the title in a heading and the action in one link', () => {
  const Header = loadComponent('AttendeeSectionHeader').default;
  const out = html(h(Header, { label: '오늘', title: '지금 할 수 있어요', action: { label: '전체 보기', href: '/all' } }));
  assert.match(out, /<h2 /);
  assert.match(out, /<a [^>]*href="\/all"/);
  assert.match(html(h(Header, { title: 'x', level: 3, inCard: true })), /<h3 /);
});
