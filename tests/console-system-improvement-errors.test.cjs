'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');
const source = fs.readFileSync('apps/web/lib/runtime-recovery.ts', 'utf8');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: exportsObject });
const { isChunkLoadingError } = exportsObject;

test('runtime chunk classification chooses recovery but returns no original error', () => {
  for (const error of [
    { name: 'ChunkLoadError', message: 'private url' },
    { message: 'Failed to load chunk /private/example.js' },
    { message: 'Loading chunk 42 failed.' },
    { message: 'Failed to fetch dynamically imported module: private' },
    { message: 'Importing a module script failed.' },
    'Failed to load chunk private',
  ]) assert.equal(isChunkLoadingError(error), true);
  for (const error of [null, undefined, 0, false, 'private exception', { message: 'API request failed' }]) {
    assert.equal(isChunkLoadingError(error), false);
  }
});

test('rendered recovery never exposes client messages or digests, including numeric private data', () => {
  const React = require('../apps/web/node_modules/react');
  const { renderToStaticMarkup } = require('../apps/web/node_modules/react-dom/server');
  const module = { exports: {} };
  const component = fs.readFileSync('apps/web/app/RuntimeRecovery.tsx', 'utf8');
  vm.runInNewContext(ts.transpileModule(component, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: module.exports, module,
    require(name) {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return require('../apps/web/node_modules/react/jsx-runtime');
      if (name === '../lib/runtime-recovery') return exportsObject;
      if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error(`Unexpected recovery dependency ${name}`);
    },
  });
  for (const digest of ['secret-token', 'https://private.test/token', '<script>', '01012345678', '1834910238', '1'.repeat(33)]) {
    const html = renderToStaticMarkup(React.createElement(module.exports.default, { error: { message: 'private-exception-message', digest }, standalone: true }));
    assert.doesNotMatch(html, /private-exception-message/);
    assert.equal(html.includes(digest), false, `untrusted digest ${digest} stays private`);
    assert.match(html, /화면 새로 불러오기/);
  }
});

test('hostile thrown getters cannot throw inside the error UI', () => {
  const hostile = new Proxy({}, { get() { throw new Error('private getter'); } });
  assert.equal(isChunkLoadingError(hostile), false);
});

test('full reload is called only by its explicit gated button handler', () => {
  const text = fs.readFileSync('apps/web/app/RuntimeRecovery.tsx', 'utf8');
  const tree = ts.createSourceFile('RuntimeRecovery.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const reloads = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'window.location.reload') {
      let parent = node.parent;
      while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
      reloads.push(parent?.name?.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.deepEqual(reloads, ['reloadDocument']);
  assert.match(text, /onClick=\{reloadDocument\}/);
  assert.match(text, /if \(requestGate\.current\) return;/);
  assert.doesNotMatch(text, /setTimeout|setInterval|useRouter|usePathname|useParams/);
  const effect = text.slice(text.indexOf('useEffect(()'), text.indexOf('function retrySegment'));
  assert.doesNotMatch(effect, /reload|retry|location/);
});

test('global error owns its styled document and has no router dependency', () => {
  const global = fs.readFileSync('apps/web/app/global-error.tsx', 'utf8');
  assert.match(global, /import "\.\/tokens\.css"/);
  assert.match(global, /<html lang="ko">/);
  assert.match(global, /<body/);
  assert.match(global, /<RuntimeRecovery error=\{error\} standalone/);
  assert.doesNotMatch(global, /next\/navigation|useRouter|error\.message|error\.digest/);
});

test('event boundary retries Server Component data instead of reset-only loop', () => {
  const event = fs.readFileSync('apps/web/app/event/[slug]/error.tsx', 'utf8');
  assert.match(event, /retry: \(\) => void/);
  assert.match(event, /retry=\{retry\}/);
  assert.match(event, /행사 정보를 불러오지 못했습니다/);
  assert.doesNotMatch(event, /reset\(\)|error\.message|error\.digest/);
});

test('fault injection does not label unrelated page errors as expected', () => {
  const audit = fs.readFileSync('scripts/web-system-improvement-errors.cjs', 'utf8');
  assert.match(audit, /unexpectedBrowserErrors\.length === 0/);
  assert.match(audit, /expected \? expectedBrowserErrors : unexpectedBrowserErrors/);
  for (const file of ['StaffHub.tsx', 'StaffEventWork.tsx']) {
    const source = fs.readFileSync(`apps/web/app/staff/${file}`, 'utf8');
    assert.match(source, /void ensureOperatorContext\(\)\.catch\(\(\) => \{\}\)/);
  }
});
