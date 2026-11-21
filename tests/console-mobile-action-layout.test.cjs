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
    // Reopened 2026-11-20: the native status picker left the toolbar (count tabs carry the
    // views), so tools and import share row 1 and creation owns row 2.
    // Reopened 2026-11-21 (owner: 명단 모바일 컨트롤 시안 A): search, 필터 and the ⋯ menu share
    // one row; 내보내기 and 명단 가져오기 live in that menu; 참가자 추가 docks at the bottom.
    assert.equal(propertyAt('.workbenchControls [data-console-toolbar="main"]', 'grid-template-columns', width), 'minmax(0, 1fr) auto 44px');
    assert.equal(propertyAt('.workbenchControls .searchField[data-toolbar-span="full"]', 'grid-row', width), '1');
    assert.equal(propertyAt('.workbenchControls .filterToggle', 'grid-column', width), '2');
    assert.equal(propertyAt('.workbenchControls .rosterUtilities', 'grid-column', width), '3', 'the ⋯ menu is the third cell of the tools row');
    assert.equal(propertyAt('.workbenchControls .utilityPair > .toolbarImport', 'display', width), 'none', 'import moved into the ⋯ menu on phones');
    assert.equal(propertyAt('.workbenchControls .utilityMenu .menuImport', 'display', width), 'inline-flex');
    assert.equal(propertyAt('.workbenchControls .utilityPair > :global([data-variant="primary"])', 'position', width), 'fixed', 'creation docks at the bottom of the screen');
    assert.equal(propertyAt('.workbenchControls .utilityPair > :global([data-variant="primary"])', 'bottom', width), 'var(--s3)');
  });
}
