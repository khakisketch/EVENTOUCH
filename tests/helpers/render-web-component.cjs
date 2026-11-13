'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createRequire } = Module;
const webRoot = path.join(__dirname, '..', '..', 'apps', 'web');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const ts = webRequire('typescript');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const { parseHTML } = webRequire('linkedom');

function loadComponent(name) {
  const filename = path.join(webRoot, 'app', 'ui', `${name}.tsx`);
  const original = new Map(['.ts', '.tsx', '.css'].map(ext => [ext, require.extensions[ext]]));
  const compile = (mod, file) => {
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    mod._compile(output.outputText, file);
  };
  require.extensions['.css'] = (mod, file) => {
    if (!file.endsWith('.module.css')) throw new Error('Only local CSS Module names are stubbed');
    mod.exports = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) });
  };
  require.extensions['.ts'] = compile;
  require.extensions['.tsx'] = compile;
  try {
    const loaded = require(filename);
    return loaded.default;
  } finally {
    for (const [ext, handler] of original) {
      if (handler) require.extensions[ext] = handler;
      else delete require.extensions[ext];
    }
  }
}

function renderComponent(name, props, ...children) {
  const Component = loadComponent(name);
  const html = renderToStaticMarkup(React.createElement(Component, props, ...children));
  return parseHTML(`<html><body>${html}</body></html>`).document;
}

module.exports = { React, renderComponent, loadComponent };
