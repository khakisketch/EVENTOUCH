const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('audience screen section exists in shell, registry, views and gates', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /data-view="screen"/, 'nav must offer screen');
  assert.match(html, /id="screen-view"/, 'section must exist');
  assert.match(html, /id="screen-mount"/, 'mount must exist');
  for (const m of ['../app.js', '../features/agency.js', '../features/views.js']) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  require('../app.js');
  require('../features/agency.js');
  require('../features/views.js');
  const ETKO = globalThis.ETKO;
  assert.ok(ETKO.views.includes('screen'), 'VIEWS must include screen');
  assert.equal(ETKO.sectionFor('screen'), 'screen-view');
  assert.equal(ETKO.mountFor('screen'), 'screen-mount');
  for (const role of ['AGENCY', 'MANAGER', 'STAFF', 'CLIENT', 'VIEWER']) {
    ETKO.setRole(role);
    ETKO.navigate('overview');
    assert.equal(ETKO.navigate('screen'), 'screen', `${role} must reach screen`);
  }
});
