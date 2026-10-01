const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('engage section exists in shell, registry, views and labels', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /data-view="engage"/, 'nav must offer engage');
  assert.match(html, /id="engage-view"/, 'section must exist');
  assert.match(html, /id="engage-mount"/, 'mount must exist');
  const ko = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'ko.json'), 'utf8'));
  assert.match(ko.engage, /참여/, 'engage label must be Korean');
  for (const m of ['../app.js', '../features/views.js']) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  require('../app.js');
  require('../features/views.js');
  const ETKO = globalThis.ETKO;
  assert.ok(ETKO.views.includes('engage'), 'VIEWS must include engage');
  assert.equal(ETKO.sectionFor('engage'), 'engage-view');
  assert.equal(ETKO.mountFor('engage'), 'engage-mount');
});
