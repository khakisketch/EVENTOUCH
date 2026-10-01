const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('index shell loads full feature scripts in order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const needed = [
    'features/agency.js',
    'features/registration.js',
    'features/desks.js',
    'features/booths.js',
    'features/engagement.js',
    'features/media.js',
    'features/messaging.js',
    'features/content.js',
  ];
  for (const f of needed) {
    assert.match(html, new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing script: ${f}`);
  }
});
