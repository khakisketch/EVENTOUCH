'use strict';

// Contract for the console design-system foundation components
// (2026-11-20, direction C1): ConsoleEmptyState, StatCard/StatRow, StatusPill,
// ConsoleAvatar, ListRow and ConsoleSection heading="rule". Components are
// rendered to static markup (no browser) and their CSS modules are read as
// source: props, accessible names, token-only styling, 44px targets and
// reduced-motion safety.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const webRoot = path.join(__dirname, '..', 'apps', 'web');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const ts = webRequire('typescript');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const UI = path.join(webRoot, 'app', 'console', 'console-ui');

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  cache.set(file, mod);
  const localRequire = (name) => {
    if (name.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_t, key) => String(key) }) };
    if (name === 'next/link') {
      return { __esModule: true, default: function Link({ href, children, ...props }) { return React.createElement('a', { ...props, href }, children); } };
    }
    if (name.startsWith('.')) {
      const base = path.resolve(path.dirname(file), name);
      const found = ['.tsx', '.ts'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate));
      if (!found) throw new Error(`Unresolved relative import ${name} from ${file}`);
      return load(found);
    }
    return webRequire(name);
  };
  new Function('require', 'module', 'exports', output)(localRequire, mod, mod.exports);
  return mod.exports;
}
const component = (name, exportName = 'default') => load(path.join(UI, `${name}.tsx`))[exportName];
const render = (Component, props, ...children) => renderToStaticMarkup(React.createElement(Component, props, ...children));
const readUi = (name) => fs.readFileSync(path.join(UI, name), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const CSS_FILES = ['console-empty-state', 'status-pill', 'console-avatar', 'stat-card', 'list-row'];

test('foundation tokens exist in tokens.css with the documented values', () => {
  const tokens = fs.readFileSync(path.join(webRoot, 'app', 'tokens.css'), 'utf8');
  const expected = {
    '--fw-regular': '400', '--fw-strong': '600', '--fw-heavy': '800',
    '--text-xs': '12px', '--text-sm': '14px', '--text-md': '15px', '--text-lg': '18px',
    '--text-xl': '22px', '--text-2xl': '28px', '--text-num': '34px',
    '--lh-tight': '1.2', '--lh-body': '1.55', '--ls-heading': '-.03em', '--ls-num': '-.04em',
    '--r-ctl': '10px', '--r-card': '16px', '--r-pill': '999px',
    '--surface-work': 'var(--paper)', '--surface-sunken': 'var(--surface-muted)', '--surface-accent-soft': 'var(--brand-tint)',
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.match(tokens, new RegExp(`${name}:\\s*${value.replace(/[().]/g, '\\$&')};`), `${name}: ${value}`);
  }
  // Additive: the legacy names remain for screens that have not migrated.
  for (const legacy of ['--radius-card', '--radius-large', '--small', '--label', '--h3']) {
    assert.match(tokens, new RegExp(`${legacy}:`), `${legacy} stays`);
  }
});

test('foundation CSS uses tokens only, keeps keep-all and respects reduced motion', () => {
  for (const name of CSS_FILES) {
    const css = strip(readUi(`${name}.module.css`));
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}(?![\w-])/, `${name}: no hex`);
    assert.doesNotMatch(css, /rgba?\(/i, `${name}: no rgb()`);
    assert.doesNotMatch(css, /font-size:\s*[^;]*\d+px/, `${name}: font sizes come from --text-*`);
    for (const [, value] of css.matchAll(/font-weight:\s*([^;}]+)/g)) assert.match(value.trim(), /^var\(--fw-(regular|strong|heavy)\)$/, `${name}: font weights come from --fw-*`);
    for (const [, value] of css.matchAll(/border-radius:\s*([^;}]+)/g)) assert.match(value.trim(), /^var\(--r-(ctl|card|pill)\)$/, `${name}: radii come from --r-*`);
    assert.doesNotMatch(css, /!important/, `${name}: no !important`);
    assert.doesNotMatch(css, /:global/, `${name}: no global overrides`);
    if (/transition\s*:/.test(css)) assert.match(css, /prefers-reduced-motion:\s*reduce/, `${name}: transitions respect reduced motion`);
  }
});

test('every foundation component file documents what it replaces', () => {
  for (const name of ['ConsoleEmptyState', 'StatCard', 'StatusPill', 'ConsoleAvatar', 'ListRow']) {
    const source = readUi(`${name}.tsx`);
    assert.match(source, /design-system foundation \(2026-11-20/, `${name} header`);
    assert.match(source, /Replaces/, `${name} says what it replaces`);
  }
});

test('ConsoleEmptyState renders the three kinds with optional icon and action', () => {
  const Empty = component('ConsoleEmptyState');
  const base = render(Empty, { title: '아직 참가자가 없습니다', description: '명단을 가져오면 여기에 나타납니다.' });
  assert.match(base, /data-console-empty="empty"/);
  assert.match(base, /<p class="title">아직 참가자가 없습니다<\/p>/);
  assert.match(base, /<p class="description">/);
  assert.doesNotMatch(base, /class="icon"|class="action"|role=/);

  const filtered = render(Empty, { kind: 'filtered', title: '조건에 맞는 참가자가 없습니다' });
  assert.match(filtered, /data-console-empty="filtered"/);

  const soft = render(Empty, {
    kind: 'error-soft',
    title: '불러오지 못했습니다',
    titleAs: 'h3',
    icon: React.createElement('svg'),
    action: React.createElement('button', { type: 'button' }, '다시 시도'),
  });
  assert.match(soft, /data-console-empty="error-soft"/);
  assert.match(soft, /role="status"/);
  assert.match(soft, /<h3 class="title">불러오지 못했습니다<\/h3>/);
  assert.match(soft, /<span class="icon" aria-hidden="true"><svg/);
  assert.match(soft, /<div class="action"><button type="button">다시 시도<\/button><\/div>/);

  const css = strip(readUi('console-empty-state.module.css'));
  assert.match(css, /\.empty\s*\{[^}]*border:\s*1px dashed/s, 'empty is dashed');
  assert.match(css, /data-console-empty="filtered"\][^{]*\{[^}]*border-style:\s*solid/s, 'filtered is flat');
  assert.match(css, /word-break:\s*keep-all/);
});

test('StatCard prints label, tabular number, unit and detail and can be one link', () => {
  const StatCard = component('StatCard');
  const html = render(StatCard, { label: '승인 대기', value: 6, unit: '명', detail: '오늘 3명 증가', tone: 'wait' });
  assert.match(html, /<div class="card" data-stat-card="wait">/);
  assert.match(html, /<span class="label">승인 대기<\/span>/);
  assert.match(html, /<strong class="value">6<\/strong><span class="unit">명<\/span>/);
  assert.match(html, /<span class="detail">오늘 3명 증가<\/span>/);

  const plain = render(StatCard, { label: '체크인', value: '128' });
  assert.match(plain, /data-stat-card="default"/);
  assert.doesNotMatch(plain, /class="unit"|class="detail"/);

  const link = render(StatCard, { label: '체크인', value: 128, href: '/console/events/e1/participants' });
  assert.match(link, /^<a class="card link" data-stat-card="default" href="\/console\/events\/e1\/participants">/);

  const css = strip(readUi('stat-card.module.css'));
  assert.match(css, /\.value\s*\{[^}]*font-size:\s*var\(--text-num\)[^}]*letter-spacing:\s*var\(--ls-num\)[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.match(css, /\.link:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/s);
  assert.match(css, /\.card\s*\{[^}]*min-height:\s*var\(--control-min-size\)/s);
});

test('StatRow groups cards, names the group and folds for phones', () => {
  const { StatRow } = load(path.join(UI, 'StatCard.tsx'));
  const StatCard = component('StatCard');
  const html = render(StatRow, { columns: 3, ariaLabel: '입장 현황' }, React.createElement(StatCard, { label: 'a', value: 1 }));
  assert.match(html, /<div class="row" data-stat-row="3" role="group" aria-label="입장 현황">/);
  assert.match(render(StatRow, {}, null), /data-stat-row="4"/);
  assert.doesNotMatch(render(StatRow, {}, null), /role=/);
  const css = strip(readUi('stat-card.module.css'));
  assert.match(css, /@media \(max-width: 768px\)[^{]*\{[^}]*data-stat-row="4"\][^}]*repeat\(2/s);
  assert.match(css, /@media \(max-width: 480px\)/);
});

test('StatusPill has seven tones, two sizes and a decorative dot', () => {
  const Pill = component('StatusPill');
  for (const tone of ['ok', 'wait', 'info', 'danger', 'neutral', 'live', 'ink']) {
    assert.match(render(Pill, { tone }, '라벨'), new RegExp(`data-status-pill="${tone}"`));
  }
  const defaults = render(Pill, {}, '대기');
  assert.match(defaults, /data-status-pill="neutral" data-size="md"/);
  assert.match(render(Pill, { size: 'sm', dot: true, tone: 'live' }, '진행 중'), /data-size="sm"><i class="dot" aria-hidden="true"><\/i>진행 중<\/span>/);
  assert.doesNotMatch(defaults, /class="dot"/);

  const css = strip(readUi('status-pill.module.css'));
  assert.match(css, /data-status-pill="live"\][^}]*color:\s*var\(--brand-text\)/s, 'orange text is --brand-text');
  assert.doesNotMatch(css, /var\(--brand\)[^;]*;?[^}]*color:\s*(#fff|var\(--paper\))/s, 'never white on --brand');
  assert.doesNotMatch(css, /background:\s*var\(--brand\)\s*;/, 'no --brand fill');
  for (const pair of ['success', 'warning', 'info', 'danger']) {
    assert.match(css, new RegExp(`background:\\s*var\\(--${pair}-soft\\)[^}]*color:\\s*var\\(--${pair}\\)`, 's'), `${pair} tint pair`);
  }
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(css, /word-break:\s*keep-all/);
});

test('tinted pairs used by the foundation meet 4.5:1 text contrast', () => {
  const tokens = fs.readFileSync(path.join(webRoot, 'app', 'tokens.css'), 'utf8');
  const get = (name) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens)[1];
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const pairs = [
    ['--success', '--success-soft'], ['--warning', '--warning-soft'], ['--info', '--info-soft'],
    ['--danger', '--danger-soft'], ['--brand-text', '--brand-tint'], ['--muted', '--surface-muted'],
    ['--paper', '--ink'], ['--success', '--paper'], ['--warning', '--paper'],
  ];
  for (const [fg, bg] of pairs) {
    assert.ok(ratio(get(fg), get(bg)) >= 4.5, `${fg} on ${bg} = ${ratio(get(fg), get(bg)).toFixed(2)}`);
  }
});

test('ConsoleAvatar shows the first grapheme, is decorative unless labelled, and has three sizes', () => {
  const Avatar = component('ConsoleAvatar');
  const { firstGrapheme } = load(path.join(UI, 'ConsoleAvatar.tsx'));
  assert.equal(firstGrapheme('  김민수'), '김');
  assert.equal(firstGrapheme('alice'), 'A');
  assert.equal(firstGrapheme('👩‍💻 dev'), '👩‍💻');
  assert.equal(firstGrapheme('   '), '?');

  const decorative = render(Avatar, { name: '김민수', tone: 'ok' });
  assert.match(decorative, /aria-hidden="true"/);
  assert.doesNotMatch(decorative, /role=|aria-label/);
  assert.match(decorative, /data-console-avatar="ok" data-size="md"/);
  const labelled = render(Avatar, { name: '박지은', size: 'lg', label: '박지은 대기 중' });
  assert.match(labelled, /role="img" aria-label="박지은 대기 중"/);
  assert.doesNotMatch(labelled, /aria-hidden/);

  const css = strip(readUi('console-avatar.module.css'));
  for (const [size, px] of [['sm', 28], ['md', 34], ['lg', 48]]) {
    assert.match(css, new RegExp(`data-size="${size}"\\][^}]*width:\\s*${px}px`), `${size} is ${px}px`);
  }
  assert.match(css, /border-radius:\s*var\(--r-pill\)/);
});

test('ListRow is one target when it has href or onClick and static otherwise', () => {
  const ListRow = component('ListRow');
  const link = render(ListRow, {
    title: '김민수', meta: '개발팀', href: '/console/p/1', chevron: true,
    leading: React.createElement('i', null, 'A'), trailing: React.createElement('b', null, '승인'),
  });
  assert.match(link, /data-list-row="interactive" data-density="comfortable"/);
  assert.match(link, /<a class="body" href="\/console\/p\/1">/);
  assert.match(link, /<span class="leading"><i>A<\/i><\/span>/);
  assert.match(link, /<span class="title">김민수<\/span><span class="meta">개발팀<\/span>/);
  assert.match(link, /<span class="chevron" aria-hidden="true"><svg/);
  assert.equal((link.match(/<a /g) || []).length, 1, 'exactly one link per row');

  const button = render(ListRow, { title: 'x', onClick: () => {}, density: 'dense', current: true });
  assert.match(button, /<button type="button" class="body" aria-current="true">/);
  assert.match(button, /data-density="dense"/);

  const staticRow = render(ListRow, { title: '정적', chevron: true, as: 'li' });
  assert.match(staticRow, /^<li class="row" data-list-row="static"/);
  assert.match(staticRow, /<div class="body">/);
  assert.doesNotMatch(staticRow, /class="chevron"|<a |<button/, 'a static row has no target and no chevron');

  const css = strip(readUi('list-row.module.css'));
  assert.match(css, /\.body\s*\{[^}]*min-height:\s*var\(--control-min-size\)/s, 'dense row keeps a 44px target');
  assert.match(css, /data-density="comfortable"\] \.body\s*\{[^}]*min-height:\s*60px/s);
  assert.match(css, /:hover\s*\{[^}]*background:\s*var\(--surface-sunken\)/s, 'hover surface');
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/s);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('ConsoleSection heading="rule" is opt-in and leaves the default output unchanged', () => {
  const source = readUi('ConsoleSection.tsx');
  assert.match(source, /heading\?:\s*"default"\s*\|\s*"rule"/);
  assert.match(source, /heading = "default"/);
  assert.match(source, /heading === "rule" \? styles\.sectionRule : ""/);
  const css = strip(readUi('console-ui.module.css'));
  assert.match(css, /\.sectionRule > :global\(\.astryx-section\) > \.sectionHead\s*\{[^}]*border-bottom:\s*1px solid var\(--line\)/s);
  assert.match(css, /\.sectionRule \.sectionTitle\s*\{[^}]*font-size:\s*var\(--text-lg\)[^}]*font-weight:\s*var\(--fw-strong\)/s);
  // The unchanged default title style still precedes the opt-in override.
  assert.ok(css.indexOf('.sectionTitle {') < css.indexOf('.sectionRule .sectionTitle'));
});

test('CountTabs keeps its current contract (no output change from the foundation)', () => {
  const source = readUi('CountTabs.tsx');
  assert.match(source, /tone\?: "wait" \| "default"/);
  assert.match(source, /aria-pressed=\{value === item\.key\}/);
  assert.doesNotMatch(source, /size\?:/);
});
