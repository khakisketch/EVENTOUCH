'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.join(__dirname, '..');
const ts = createRequire(path.join(root, 'apps/web/package.json'))('typescript');

test('rich product actions put their leading decorative icon in the public icon slot', () => {
  const violations = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!file.endsWith('.tsx')) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node) {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'ProductButton') {
          const hasIcon = node.openingElement.attributes.properties.some(attribute => attribute.name?.getText(source) === 'icon');
          const children = node.children.filter(child => !(ts.isJsxText(child) && !child.text.trim()));
          const first = children[0];
          if (!hasIcon && children.length > 1 && first && (ts.isJsxElement(first) || ts.isJsxSelfClosingElement(first))) {
            const name = (first.tagName || first.openingElement.tagName).getText(source);
            if (name === 'svg' || name.endsWith('Icon')) violations.push(`${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(path.join(root, 'apps/web/app'));
  assert.deepEqual(violations, [], 'Icons inside the text slot break icon-and-label row layout');
});
