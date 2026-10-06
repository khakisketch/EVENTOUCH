const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function boot(search) {
  const bodyAttrs = {};
  const mainAttrs = {};
  const body = {
    setAttribute(name, value) { bodyAttrs[name] = value; },
    removeAttribute(name) { delete bodyAttrs[name]; },
    getAttribute(name) { return bodyAttrs[name] || null; },
  };
  const main = {
    setAttribute(name, value) { mainAttrs[name] = value; },
    getAttribute(name) { return mainAttrs[name] || null; },
  };
  const document = {
    body,
    querySelectorAll() { return []; },
    querySelector(selector) { return selector === 'main' ? main : null; },
  };
  const window = { document, location: { search } };
  const sandbox = { console, document, window };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  return { ETKO: window.ETKO, bodyAttrs, mainAttrs };
}

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

test('?view=screen boots the standalone audience route and marks shell-free mode', () => {
  const { ETKO, bodyAttrs, mainAttrs } = boot('?view=screen');
  assert.equal(ETKO.currentView, 'screen');
  assert.equal(bodyAttrs['data-screen-mode'], 'true');
  assert.equal(mainAttrs['data-current-view'], 'screen');
});

test('normal operator URL lands on the agency home, not an event detail', () => {
  const { ETKO, bodyAttrs } = boot('');
  assert.equal(ETKO.currentView, 'agency-home');
  assert.equal(bodyAttrs['data-screen-mode'], undefined);
});

test('navigating into and out of the audience route toggles standalone mode', () => {
  const { ETKO, bodyAttrs } = boot('');
  ETKO.navigate('screen');
  assert.equal(bodyAttrs['data-screen-mode'], 'true');
  ETKO.navigate('overview');
  assert.equal(bodyAttrs['data-screen-mode'], undefined);
});

test('standalone audience CSS hides operator chrome and fills the viewport', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'theme.css'), 'utf8');
  assert.match(css, /body\[data-screen-mode="true"\]\s+\.app-sidebar,\s*body\[data-screen-mode="true"\]\s+\.workspace-topbar\s*\{[^}]*display:\s*none/);
  assert.match(css, /body\[data-screen-mode="true"\]\s+\.workspace\s*>\s*main\s*\{[^}]*min-height:\s*100vh/);
  assert.match(css, /body\[data-screen-mode="true"\]\s+#screen-view\s*\{[^}]*min-height:\s*100vh/);
});
