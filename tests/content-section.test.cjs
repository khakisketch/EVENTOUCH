const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('content and messages sections exist in shell, registry, views and labels', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /data-view="content"/, 'nav must offer content');
  assert.match(html, /data-view="messages"/, 'nav must offer messages');
  assert.match(html, /id="content-view"/, 'content section must exist');
  assert.match(html, /id="messages-view"/, 'messages section must exist');
  assert.match(html, /id="content-mount"/, 'content mount must exist');
  assert.match(html, /id="messages-mount"/, 'messages mount must exist');
  const ko = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'ko.json'), 'utf8'));
  assert.match(ko.content, /콘텐츠/);
  assert.match(ko.messages, /메시지/);
  for (const m of ['../app.js', '../features/agency.js', '../features/views.js']) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  require('../app.js');
  require('../features/agency.js');
  require('../features/views.js');
  const ETKO = globalThis.ETKO;
  assert.ok(ETKO.views.includes('content'), 'VIEWS must include content');
  assert.ok(ETKO.views.includes('messages'), 'VIEWS must include messages');
  assert.equal(ETKO.sectionFor('content'), 'content-view');
  assert.equal(ETKO.mountFor('messages'), 'messages-mount');
  ETKO.setRole('AGENCY');
  ETKO.navigate('overview');
  assert.equal(ETKO.navigate('content'), 'content');
  assert.equal(ETKO.navigate('messages'), 'messages');
});
