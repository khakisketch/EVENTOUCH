const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('stage confirmation labels meet the touch minimum', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'tokens.css'), 'utf8');
  assert.match(css, /#stage-mount label[\s\S]*?min-height:\s*44px/);
});
