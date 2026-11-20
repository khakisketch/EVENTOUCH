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

// Reopened 2026-11-20 (shared gaps): count-tabs joins the token-only list (its weights and radii are tokens now).
const CSS_FILES = ['console-empty-state', 'status-pill', 'console-avatar', 'stat-card', 'list-row', 'count-tabs'];

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
  // Reopened 2026-11-20 (shared gaps): the pressed state is still `aria-pressed` in the default filter mode.
  assert.match(source, /: \{ "aria-pressed": selected \}/);
  assert.doesNotMatch(source, /size\?:/);
});

// ---------------------------------------------------------------------------
// Reopened 2026-11-20 (shared gaps): optional additions to the foundation. Every
// addition is opt-in; the default output asserted above is unchanged.
// ---------------------------------------------------------------------------

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lumOf = ([r, g, b]) => {
  const [lr, lg, lb] = [r, g, b].map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
const contrast = (a, b) => { const [hi, lo] = [lumOf(a), lumOf(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const tokenHex = (tokens, name) => hexToRgb(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens)[1]);

test('shared-gap tokens are added without changing existing ones', () => {
  const tokens = fs.readFileSync(path.join(webRoot, 'app', 'tokens.css'), 'utf8');
  assert.match(tokens, /--text-stage:\s*48px;/, 'hero number step (equal to the old per-screen --display override)');
  for (const step of ['8', '12', '16', '24', '72', '88']) {
    assert.match(tokens, new RegExp(`--on-dark-${step}:\\s*color-mix\\(in srgb, var\\(--paper\\) ${step}%, transparent\\);`), `--on-dark-${step}`);
  }
  for (const role of ['ok', 'wait', 'danger']) assert.match(tokens, new RegExp(`--on-dark-${role}:\\s*var\\(--(success|warning|danger)-line\\);`), `--on-dark-${role}`);
  // Nothing from the foundation moved.
  assert.match(tokens, /--text-num:\s*34px;/);
  assert.match(tokens, /--brand-hover:\s*#C7441C;/);
});

test('on-dark status colours keep 4.5:1 against the stage face, washed and plain', () => {
  const tokens = fs.readFileSync(path.join(webRoot, 'app', 'tokens.css'), 'utf8');
  const stage = tokenHex(tokens, '--stage');
  const mix = (fg, bg, share) => fg.map((v, i) => Math.round(v * share + bg[i] * (1 - share)));
  for (const [token, line] of [['--on-dark-ok', '--success-line'], ['--on-dark-wait', '--warning-line'], ['--on-dark-danger', '--danger-line']]) {
    const color = tokenHex(tokens, line);
    assert.ok(contrast(color, stage) >= 4.5, `${token} on stage = ${contrast(color, stage).toFixed(2)}`);
    assert.ok(contrast(color, mix(color, stage, 0.16)) >= 4.5, `${token} on its 16% wash = ${contrast(color, mix(color, stage, 0.16)).toFixed(2)}`);
  }
  assert.ok(contrast(tokenHex(tokens, '--side-muted'), stage) >= 4.5, 'the quiet on-dark pill text');
});

test('StatusPill passes DOM attributes through and keeps its own markers', () => {
  const Pill = component('StatusPill');
  const html = render(Pill, { tone: 'ok', id: 'p1', title: '확인됨', role: 'status', 'aria-live': 'polite', 'data-reward-pill': 'x', 'data-status-pill': 'spoofed', 'data-size': 'spoofed' }, '완료');
  assert.match(html, /id="p1"/);
  assert.match(html, /title="확인됨"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-reward-pill="x"/);
  assert.match(html, /data-status-pill="ok"/, 'the tone marker cannot be spoofed');
  assert.match(html, /data-size="md"/, 'the size marker cannot be spoofed');
  assert.doesNotMatch(html, /spoofed/);
  assert.match(render(Pill, { className: 'extra' }, 'x'), /class="pill extra"/);
});

test('StatusPill on-dark tones and list alignment are opt-in', () => {
  const Pill = component('StatusPill');
  for (const tone of ['on-dark', 'on-dark-ok', 'on-dark-wait', 'on-dark-danger']) {
    assert.match(render(Pill, { tone, size: 'sm', dot: true }, '라벨'), new RegExp(`data-status-pill="${tone}" data-size="sm"`));
  }
  assert.doesNotMatch(render(Pill, {}, 'x'), /data-align/, 'no alignment attribute by default');
  for (const align of ['start', 'center', 'end']) assert.match(render(Pill, { align }, 'x'), new RegExp(`data-align="${align}"`));
  const css = strip(readUi('status-pill.module.css'));
  assert.match(css, /data-status-pill="on-dark"\][^}]*background:\s*transparent[^}]*var\(--stage-line\)[^}]*color:\s*var\(--side-muted\)/s, 'quiet outline on the stage');
  for (const role of ['ok', 'wait', 'danger']) {
    assert.match(css, new RegExp(`data-status-pill="on-dark-${role}"\\][^}]*color:\\s*var\\(--on-dark-${role}\\)`, 's'), `on-dark-${role} text`);
    assert.match(css, new RegExp(`data-status-pill="on-dark-${role}"\\][^}]*color-mix\\(in srgb, var\\(--on-dark-${role}\\) 16%`, 's'), `on-dark-${role} wash`);
  }
  for (const align of ['start', 'center', 'end']) assert.match(css, new RegExp(`data-align="${align}"\\]\\s*\\{\\s*justify-self:\\s*${align}`), `${align} places the pill in its cell`);
});

test('ListRow forwards id, data and aria attributes and a heading title', () => {
  const ListRow = component('ListRow');
  const row = render(ListRow, { title: '행사', as: 'li', id: 'row-1', 'data-reward-row': '', 'aria-label': '경품 행', titleAs: 'h3', titleProps: { id: 'row-1-title', tabIndex: -1 } });
  assert.match(row, /^<li id="row-1" data-reward-row="" aria-label="경품 행" class="row" data-list-row="static"/);
  assert.match(row, /<h3 id="row-1-title" tabindex="-1" class="title">행사<\/h3>/);
  const link = render(ListRow, { title: '프로그램', href: '/x', titleAs: 'h3' });
  assert.match(link, /<a class="body" href="\/x"><span class="main"><h3 class="title">프로그램<\/h3>/, 'a link row may hold a heading');
  const button = render(ListRow, { title: '버튼 행', onClick: () => {}, titleAs: 'h3' });
  assert.match(button, /<span class="title">버튼 행<\/span>/, 'a heading may not live in a <button>: the button row keeps a span');
  assert.doesNotMatch(button, /<h3/);
  assert.match(render(ListRow, { title: 'x' }), /<span class="title">x<\/span>/, 'default title is still a span');
});

test('ListRow center, wide trailing, separate action and timeline slots', () => {
  const ListRow = component('ListRow');
  const row = render(ListRow, {
    title: '추첨', center: React.createElement('i', null, 'bar'), trailing: React.createElement('b', null, '12'), trailingWidth: 'free',
    action: React.createElement('input', { type: 'checkbox', 'aria-label': '켜기' }), href: '/draw',
  });
  assert.match(row, /data-has-action="true"/);
  assert.match(row, /<span class="center"><i>bar<\/i><\/span><span class="trailing" data-width="free"><b>12<\/b><\/span>/, 'center sits before trailing; free lifts the cap');
  assert.match(row, /<\/a><span class="action"><input type="checkbox" aria-label="켜기"\/><\/span>/, 'the control is a sibling of the link, never inside it');
  assert.equal((row.match(/<a /g) || []).length, 1);
  assert.doesNotMatch(render(ListRow, { title: 'x', trailing: 'y' }), /data-width|data-has-action|class="center"/, 'defaults add nothing');

  const timeline = render(ListRow, { title: '김민수 입장', as: 'li', variant: 'timeline', time: React.createElement('time', { dateTime: '2026-11-20T09:00' }, '09:00'), railTone: 'ok' });
  assert.match(timeline, /data-list-row-variant="timeline"/);
  assert.match(timeline, /<span class="time"><time date[tT]ime="2026-11-20T09:00">09:00<\/time><\/span><span class="rail" data-rail="ok" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(render(ListRow, { title: 'x' }), /class="time"|class="rail"/);
});

test('ListRow cover row: the title holds one button, other slots stay clickable above it', () => {
  const ListRow = component('ListRow');
  const { ListRowOpen } = load(path.join(UI, 'ListRow.tsx'));
  const row = render(ListRow, {
    as: 'li', cover: true, title: React.createElement(ListRowOpen, { 'aria-label': '이름 수정' }, '이름'),
    trailing: React.createElement('button', { type: 'button' }, '위로'),
  });
  assert.match(row, /data-list-row="cover"/);
  assert.match(row, /<button type="button" class="titleOpen" aria-label="이름 수정">이름<\/button>/);
  assert.equal((row.match(/<button /g) || []).length, 2, 'the cover button plus the trailing control, no nesting');
  const css = strip(readUi('list-row.module.css'));
  assert.match(css, /\.titleOpen::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/s);
  assert.match(css, /data-list-row="cover"\] \.trailing[^{]*\{[^}]*z-index:\s*1/s, 'trailing controls sit above the cover');
  assert.match(css, /\.titleOpen:focus-visible::after\s*\{[^}]*outline:\s*3px solid var\(--focus\)/s);
});

test('ListRow summary mode is the <summary> of a <details>', () => {
  const ListRow = component('ListRow');
  const html = render(ListRow, { as: 'summary', title: '룰렛', titleAs: 'h3', chevron: true, trailing: '진행 중', id: 'sum-1' });
  assert.match(html, /^<summary id="sum-1" class="row body summary" data-list-row="interactive" data-density="comfortable">/);
  assert.match(html, /<h3 class="title">룰렛<\/h3>/);
  assert.match(html, /<span class="chevron" aria-hidden="true"><svg/);
  assert.doesNotMatch(html, /<a |<button|<div class="body"/, 'the summary is the one element');
  const css = strip(readUi('list-row.module.css'));
  assert.match(css, /details\[open\] > \.summary \.chevron\s*\{[^}]*rotate\(90deg\)/s);
  assert.match(css, /\.summary::-webkit-details-marker\s*\{\s*display:\s*none/s);
});

test('ConsoleEmptyState amber tone, small size and the documented title element', () => {
  const Empty = component('ConsoleEmptyState');
  const amber = render(Empty, { tone: 'amber', size: 'sm', title: '배정된 스태프가 없습니다', titleAs: 'h3' });
  assert.match(amber, /data-console-empty="empty" data-tone="amber" data-size="sm"/);
  assert.match(amber, /<h3 class="title">/);
  const plain = render(Empty, { title: 'x' });
  assert.doesNotMatch(plain, /data-tone|data-size/, 'defaults add nothing');
  assert.match(plain, /<p class="title">x<\/p>/, 'the default title element stays p');
  assert.match(readUi('ConsoleEmptyState.tsx'), /titleAs defaults to `p`[\s\S]*`titleAs="h3"`/, 'titleAs is documented');
  const css = strip(readUi('console-empty-state.module.css'));
  assert.match(css, /data-tone="amber"\][^}]*border-color:\s*var\(--warning-line\)[^}]*background:\s*var\(--warning-soft\)/s);
  assert.match(css, /data-tone="amber"\] \.title\s*\{[^}]*color:\s*var\(--warning\)/s);
});

test('CountTabs tablist mode: roles, ids, roving tabindex and the keyboard model', () => {
  const CountTabs = component('CountTabs');
  const { nextCountTabKey } = load(path.join(UI, 'CountTabs.tsx'));
  const items = [{ key: 'notice', label: '공지', count: 3 }, { key: 'program', label: '일정' }, { key: 'venue', label: '장소 안내' }];
  const html = render(CountTabs, { mode: 'tablist', ariaLabel: '콘텐츠 종류', idPrefix: 'content-tab-', controls: 'content-panel', value: 'program', onChange: () => {}, items });
  assert.match(html, /role="tablist" aria-label="콘텐츠 종류"/);
  assert.doesNotMatch(html, /role="group"|aria-pressed/);
  assert.match(html, /role="tab" id="content-tab-program" aria-selected="true" aria-controls="content-panel" tabindex="0"/);
  assert.match(html, /role="tab" id="content-tab-notice" aria-selected="false" aria-controls="content-panel" tabindex="-1"/);
  assert.equal((html.match(/<em /g) || []).length, 1, 'a tab without count has no badge');
  const perTab = render(CountTabs, { mode: 'tablist', ariaLabel: 'x', controls: (key) => `panel-${key}`, value: null, onChange: () => {}, items });
  assert.match(perTab, /aria-controls="panel-notice"/);
  assert.match(perTab, /data-tab="notice"[^>]*tabindex="0"/, 'with no selection the first tab is the tab stop');

  assert.equal(nextCountTabKey(items, 'notice', 'ArrowRight'), 'program');
  assert.equal(nextCountTabKey(items, 'venue', 'ArrowRight'), 'notice', 'wraps forward');
  assert.equal(nextCountTabKey(items, 'notice', 'ArrowLeft'), 'venue', 'wraps back');
  assert.equal(nextCountTabKey(items, 'program', 'Home'), 'notice');
  assert.equal(nextCountTabKey(items, 'program', 'End'), 'venue');
  assert.equal(nextCountTabKey(items, 'program', 'Enter'), null);
  assert.equal(nextCountTabKey(items.map((item) => (item.key === 'program' ? { ...item, disabled: true } : item)), 'notice', 'ArrowRight'), 'venue', 'disabled tabs are skipped');
});

test('CountTabs filter mode is unchanged and adds fit and a narrowing toggle', () => {
  const CountTabs = component('CountTabs');
  const items = [{ key: 'all', label: '전체', count: 12 }, { key: 'live', label: '진행 중', count: 1 }];
  const html = render(CountTabs, { ariaLabel: '진행 단계', value: 'all', onChange: () => {}, items });
  assert.match(html, /role="group" aria-label="진행 단계"/);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /role="tab"|tabindex|data-fit|class="toggle"/);
  assert.match(render(CountTabs, { ariaLabel: 'x', value: 'all', onChange: () => {}, items, fit: 'wrap' }), /data-fit="wrap"/);
  assert.match(render(CountTabs, { ariaLabel: 'x', value: 'all', onChange: () => {}, items, fit: 'fill' }), /data-fit="fill"/);

  const toggled = render(CountTabs, {
    ariaLabel: 'x', value: 'all', onChange: () => {}, items,
    toggle: { key: 'pending', label: '승인 대기만', count: 3, pressed: true, tone: 'wait', ariaLabel: '승인 대기 있는 행사만 보기 (3건)', onChange: () => {} },
  });
  assert.match(toggled, /class="toggle" data-toggle="pending" data-selected="true" data-tone="wait" aria-pressed="true" aria-label="승인 대기 있는 행사만 보기 \(3건\)"/);
  const css = strip(readUi('count-tabs.module.css'));
  assert.match(css, /data-fit="wrap"\] \.track\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /data-fit="fill"\] \.tab\s*\{[^}]*flex:\s*1 1 0/s);
  assert.match(css, /\.tab\[data-selected="true"\]/, 'the chosen tab is styled from data-selected for both behaviours');
});

test('StatCard hero size and ConsoleAvatar logo are opt-in', () => {
  const StatCard = component('StatCard');
  const Avatar = component('ConsoleAvatar');
  const hero = render(StatCard, { label: '기간 고유 입장', value: 128, unit: '명', size: 'hero' });
  assert.match(hero, /data-stat-card="default" data-stat-size="hero"/);
  assert.doesNotMatch(render(StatCard, { label: 'a', value: 1 }), /data-stat-size/);
  const statCss = strip(readUi('stat-card.module.css'));
  assert.match(statCss, /data-stat-size="hero"\] \.value\s*\{[^}]*font-size:\s*var\(--text-stage\)/s);

  const logo = render(Avatar, { name: '한울', size: 'lg', src: '/api/clients/c1/files/f1' });
  assert.match(logo, /data-logo="true"/);
  assert.match(logo, /<img class="logo" src="\/api\/clients\/c1\/files\/f1" alt=""\/>/);
  assert.match(logo, /aria-hidden="true"/, 'still decorative unless labelled');
  assert.doesNotMatch(logo, />한<\/span>/, 'the logo replaces the initial');
  assert.doesNotMatch(render(Avatar, { name: '한울' }), /data-logo|<img/);
  const avatarCss = strip(readUi('console-avatar.module.css'));
  assert.match(avatarCss, /data-logo="true"\][^}]*border-radius:\s*var\(--r-ctl\)[^}]*background:\s*var\(--surface-work\)/s);
  assert.match(avatarCss, /\.logo\s*\{[^}]*object-fit:\s*contain/s);
});

test('ConsoleFormActions sticky is opt-in layout only', () => {
  const Actions = component('ConsoleFormActions');
  assert.doesNotMatch(render(Actions, {}, 'x'), /formActionsSticky/);
  assert.match(render(Actions, { sticky: true }, 'x'), /class="formActions formActionsSticky"/);
  const css = strip(readUi('console-ui.module.css'));
  assert.match(css, /\.formActionsSticky\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0[^}]*border-top:\s*1px solid var\(--line\)[^}]*background:\s*var\(--surface-work\)/s);
});
