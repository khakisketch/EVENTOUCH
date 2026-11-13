'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.join(__dirname, '../apps/web/package.json'));
const postcss = webRequire('postcss');
const file = path.join(__dirname, '../apps/web/app/console/events/[id]/participants/participants.module.css');
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
function propertyAt(selector, property, width) {
  let value;
  postcss.parse(fs.readFileSync(file, 'utf8')).walkRules((rule) => {
    if (normalize(rule.selector) !== selector) return;
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
      if (parent.type !== 'atrule' || parent.name !== 'media') continue;
      const max = /max-width:\s*(\d+)px/.exec(parent.params);
      const min = /min-width:\s*(\d+)px/.exec(parent.params);
      if ((max && width > Number(max[1])) || (min && width < Number(min[1]))) return;
    }
    rule.walkDecls(property, (decl) => { value = normalize(decl.value); });
  });
  return value;
}
for (const width of [320, 390]) {
  test(`mobile roster uses an intentional two-row action grid at ${width}px`, () => {
    assert.equal(propertyAt('.workbenchControls span[data-toolbar-inline].utilityPair', 'grid-template-columns', width), 'minmax(0, 1fr) auto');
    assert.equal(propertyAt('.workbenchControls .utilityPair > :global([data-variant="secondary"])', 'grid-row', width), '2', 'import stays visible beside creation, not as a third cramped filter');
    assert.equal(propertyAt('.workbenchControls .utilityPair > :global([data-variant="secondary"])', 'grid-column', width), '1');
    assert.equal(propertyAt('.workbenchControls .utilityPair > :global([data-variant="primary"])', 'grid-row', width), '2');
    assert.equal(propertyAt('.workbenchControls .utilityPair > :global([data-variant="primary"])', 'grid-column', width), '2');
  });
}
