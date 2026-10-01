const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('overview offers report creation wired to the snapshot store', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /data-report-create/, 'overview must offer report creation');
  assert.match(html, /ETKO\.createReport/, 'shell must call the snapshot store, not a toast');
});
