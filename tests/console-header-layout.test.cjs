'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.join(__dirname, '../apps/web/package.json'));
const ts = webRequire('typescript');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const postcss = webRequire('postcss');
const sourceFile = path.join(__dirname, '../apps/web/app/console/console-ui/ConsolePageHeader.tsx');
const cssFile = path.join(__dirname, '../apps/web/app/console/console-ui/console-ui.module.css');

function loadHeader() {
  const output = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const localRequire = (name) => {
    if (name.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (name === 'next/link') return function Link({ href, children, ...props }) { return React.createElement('a', { ...props, href }, children); };
    if (name === '../../ui/ProductButton') return { default: ({ variant = 'secondary', className, label, children, ...props }) => React.createElement('button', { ...props, className, 'data-variant': variant }, children ?? label) };
    if (name === '../../ui/ProductLink') return { default: ({ href, children, ...props }) => React.createElement('a', { ...props, href }, children) };
    return webRequire(name);
  };
  new Function('require', 'module', 'exports', output)(localRequire, mod, mod.exports);
  return mod.exports.default;
}
const Header = loadHeader();
const render = (props) => renderToStaticMarkup(React.createElement(Header, props));

test('page title and page-level action share a dedicated composition row', () => {
  const html = render({
    title: '행사',
    context: React.createElement('a', { href: '/console' }, '행사 / 합성 행사'),
    actions: React.createElement('button', { type: 'button' }, '새 행사 만들기'),
  });
  const row = /<div class="pageTitleRow">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(row, 'the title/action row is a real shared layout region');
  assert.match(row[1], /<h1\b[^>]*>행사<\/h1>/);
  assert.match(row[1], /<button type="button">새 행사 만들기<\/button>/);
  assert.doesNotMatch(row[1], /행사 \/ 합성 행사/, 'breadcrumb does not consume title/action alignment');
});

test('header preserves context, metadata, state and action semantics', () => {
  const html = render({
    title: '참가자 명단',
    context: React.createElement('a', { href: '/console/events/synthetic' }, '행사 / 합성 검증 행사'),
    meta: '2026.11.10 · 09:00–17:00',
    badges: React.createElement('span', null, '접수 중'),
    actions: React.createElement('button', { type: 'button', disabled: true, 'aria-label': '최신 내용 확인' }, '새로고침'),
  });
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /href="\/console\/events\/synthetic"/);
  for (const text of ['행사 / 합성 검증 행사', '참가자 명단', '2026.11.10 · 09:00–17:00', '접수 중']) assert.ok(html.includes(text));
  assert.match(html, /<button type="button" disabled="" aria-label="최신 내용 확인">/);
});

test('a header without actions does not manufacture an empty actions region', () => {
  const html = render({ title: '행사', meta: '합성 검증' });
  assert.doesNotMatch(html, /class="pageActions"/);
  assert.match(html, /<h1\b[^>]*>행사<\/h1>/);
});

test('shared header has one base owner instead of competing layout overrides', () => {
  const root = postcss.parse(fs.readFileSync(cssFile, 'utf8'));
  for (const selector of ['.pageHeader', '.pageIdentity', '.pageActions', '.page']) {
    const owners = root.nodes.filter((node) => node.type === 'rule' && node.selector === selector);
    assert.equal(owners.length, 1, `${selector} has one unconditional layout owner`);
  }
  assert.ok(root.nodes.some((node) => node.type === 'rule' && node.selector === '.pageTitleRow'));
});
