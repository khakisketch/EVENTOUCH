'use strict';
// Execute the actual Next page functions with React's JSX runtime. Distinct
// element keys are the React reconciliation boundary, not a source comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.resolve(__dirname, '../apps/web');
const ts = require(require.resolve('typescript', { paths: [web] }));
const jsx = require(require.resolve('react/jsx-runtime', { paths: [web] }));

function loadPage(relative) {
  const source = fs.readFileSync(path.join(web, relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => id === 'react/jsx-runtime' ? jsx : { __esModule: true, default: function Child() {} } });
  return exports.default;
}

for (const [label, file, child] of [
  ['home', 'app/event/[slug]/home/page.tsx', element => element],
  ['ticket', 'app/event/[slug]/ticket/page.tsx', element => element.props.children[1]],
  ['engage', 'app/event/[slug]/engage/page.tsx', element => element],
]) {
  test(`${label} creates a distinct React instance key for each event`, async () => {
    const page = loadPage(file);
    const first = child(await page({ params: Promise.resolve({ slug: 'event-a' }) }));
    const second = child(await page({ params: Promise.resolve({ slug: 'event-b' }) }));
    assert.equal(first.key, 'event-a');
    assert.equal(second.key, 'event-b');
    assert.equal(first.props.slug, first.key);
    assert.equal(second.props.slug, second.key);
    assert.notEqual(first.key, second.key);
  });
}
