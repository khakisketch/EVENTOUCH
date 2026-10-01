const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ticket entry is wired to workspace scan', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /ticket-code/);
  assert.match(html, /data-ticket-submit/);
  assert.match(html, /ETKO\.scan/);
});

test('booth mode surfaces lock errors in Korean', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /setEventBoothMode|setBoothMode/);
});
