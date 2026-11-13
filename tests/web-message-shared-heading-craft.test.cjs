'use strict';

// Source-level ownership guard; built browser checks own computed font sizes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WEB = path.join(__dirname, '..', 'apps/web');
const postcss = require(require.resolve('postcss', { paths: [WEB] }));
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');
const workspace = read('app/console/events/[id]/messages/MessagingWorkspace.tsx');
const page = read('app/console/console-ui/ConsolePage.tsx');
const header = read('app/console/console-ui/ConsolePageHeader.tsx');
const sharedCss = postcss.parse(read('app/console/console-ui/console-ui.module.css'));
const messageCss = postcss.parse(read('app/console/events/[id]/messages/MessagingWorkspace.module.css'));

test('messages use the shared page heading with its desktop and mobile scale', () => {
  assert.match(workspace, /<ConsolePage\s+pageId="messages"\s+className=\{styles\.workbenchPage\}/u);
  assert.match(page, /<ConsolePageHeader\s+title=\{title \?\? page\.title\}/u);
  assert.match(header, /className=\{styles\.pageTitleRow\}>\s*<Heading level=\{1\}>\{title\}<\/Heading>/u);

  const scales = [];
  sharedCss.walkRules('.pageIdentity h1', (rule) => {
    rule.walkDecls('font-size', (decl) => {
      scales.push({
        media: rule.parent.type === 'atrule' ? rule.parent.params : null,
        size: decl.value,
      });
    });
  });
  assert.deepEqual(scales, [
    { media: null, size: '30px' },
    { media: '(max-width: 768px)', size: '26px' },
  ]);
});

test('message CSS never overrides the shared h1 scale, including inside media queries', () => {
  const overrides = [];
  messageCss.walkRules((rule) => {
    if (!rule.selectors.some((selector) => /\bh1\b/u.test(selector))) return;
    rule.walkDecls(/^(?:font-size|font|all)$/u, (decl) => {
      overrides.push(`${rule.selector}: ${decl.prop}: ${decl.value}`);
    });
  });
  assert.deepEqual(overrides, [], 'shared ConsolePageHeader owns page-heading font size at every viewport');
});
