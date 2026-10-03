const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const KO_PATH = path.join(ROOT, 'i18n', 'ko.json');
const HTML_PATH = path.join(ROOT, 'index.html');
const APP_PATH = path.join(ROOT, 'app.js');
const VIEWS_PATH = path.join(ROOT, 'features', 'views.js');

// Canonical view keys (Task 2 interface + engage slice). Singular `participant` is the
// participant home; plural `participants` is the directory. They must stay
// distinct: different ko.json keys, different nav labels, different states.
const VIEWS = ['agency-home', 'agency-events', 'agency-clients', 'agency-team', 'overview', 'participants', 'checkin', 'booth', 'participant', 'engage', 'content', 'messages', 'stage', 'screen'];
const labelKey = (view) => view;

function readButtons(html) {
  const out = new Map();
  const re = /<button[^>]*data-view="([^"]+)"[^>]*>([^<]*)<\/button>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.set(m[1], m[2].trim());
  return out;
}

function loadApp(stubDocument) {
  const src = fs.readFileSync(APP_PATH, 'utf8');
  const sandbox = { console };
  if (stubDocument !== undefined) sandbox.document = stubDocument;
  sandbox.window = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'app.js' });
  return sandbox.window.ETKO || sandbox.ETKO;
}

function loadShellApp(stubDocument) {
  const sandbox = { console, window: {} };
  if (stubDocument !== undefined) sandbox.document = stubDocument;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_PATH, 'utf8'), sandbox, { filename: 'app.js' });
  vm.runInContext(fs.readFileSync(VIEWS_PATH, 'utf8'), sandbox, { filename: 'features/views.js' });
  return sandbox.window.ETKO;
}

test('ko.json has one non-empty label per view key', () => {
  const ko = JSON.parse(fs.readFileSync(KO_PATH, 'utf8'));
  for (const view of VIEWS) {
    assert.ok(
      typeof ko[view] === 'string' && ko[view].trim() !== '',
      `ko.json missing or empty label key: ${view}`
    );
  }
});

test('participants (directory) and participant (home) are distinct labels', () => {
  const ko = JSON.parse(fs.readFileSync(KO_PATH, 'utf8'));
  assert.notEqual(
    ko.participants,
    ko.participant,
    'participants and participant must map to different ko.json values'
  );
});

test('shell is lang="ko" and every nav label equals its ko.json value', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const ko = JSON.parse(fs.readFileSync(KO_PATH, 'utf8'));
  assert.match(html, /<html[^>]*lang="ko"/, 'index.html must declare lang="ko"');
  const buttons = readButtons(html);
  for (const view of VIEWS) {
    assert.ok(buttons.has(view), `index.html missing nav button data-view="${view}"`);
    assert.equal(
      buttons.get(view),
      ko[labelKey(view)],
      `nav label for "${view}" must equal ko.json value`
    );
  }
  assert.notEqual(
    buttons.get('participants'),
    buttons.get('participant'),
    'directory and home nav buttons must have distinct labels'
  );
});

test('index.html loads app.js', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.match(html, /<script[^>]*src="app\.js"[^>]*>/, 'index.html must load app.js');
});

test('ETKO.navigate switches views and keeps current view on unknown input', () => {
  const ETKO = loadApp();
  assert.ok(ETKO, 'app.js must define ETKO');
  assert.equal(typeof ETKO.navigate, 'function', 'ETKO.navigate must be a function');
  assert.deepEqual([...ETKO.views].sort(), [...VIEWS].sort(), 'ETKO.views must list the shell views');

  assert.equal(ETKO.navigate('overview'), 'overview');
  assert.equal(ETKO.navigate('checkin'), 'checkin');
  // Unknown view keeps the current view.
  assert.equal(ETKO.navigate('nope'), 'checkin');
  assert.equal(ETKO.currentView, 'checkin');
  assert.equal(ETKO.navigate(''), 'checkin');
  assert.equal(ETKO.navigate(undefined), 'checkin');
});

test('ETKO.navigate distinguishes participants from participant', () => {
  const ETKO = loadApp();
  ETKO.navigate('participants');
  assert.equal(ETKO.currentView, 'participants');
  ETKO.navigate('participant');
  assert.equal(ETKO.currentView, 'participant');
  assert.notEqual(ETKO.currentView, 'participants');
});

test('selectLayer navigates to its default route and tracks the active layer', () => {
  const ETKO = loadShellApp();
  ETKO.navigate('overview');
  assert.equal(ETKO.currentLayer, 'event');
  assert.equal(ETKO.selectLayer('onsite'), 'checkin');
  assert.equal(ETKO.currentView, 'checkin');
  assert.equal(ETKO.currentLayer, 'onsite');
  assert.equal(ETKO.selectLayer('screen'), 'screen');
  assert.equal(ETKO.currentLayer, 'screen');
});

test('selectLayer chooses an accessible route and leaves denied layers unchanged', () => {
  const ETKO = loadShellApp();
  ETKO.currentRole = () => 'CLIENT';
  ETKO.canRoute = (_role, route) => route !== 'agency-home' && route !== 'agency-events' && route !== 'agency-clients' && route !== 'agency-team' && route !== 'checkin';
  ETKO.navigate('overview');

  assert.equal(ETKO.selectLayer('onsite'), 'booth', 'use the first permitted route when the default is denied');
  assert.equal(ETKO.currentLayer, 'onsite');

  assert.equal(ETKO.selectLayer('agency'), 'booth', 'a fully denied layer must leave the current view unchanged');
  assert.equal(ETKO.currentLayer, 'onsite');
  assert.equal(ETKO.selectLayer('missing'), 'booth', 'an unknown layer must leave the current view unchanged');
});

test('extended and unknown route attempts do not erase the contextual layer', () => {
  const ETKO = loadShellApp();
  ETKO.canRoute = () => true;
  ETKO.navigate('checkin');
  assert.equal(ETKO.currentLayer, 'onsite');
  assert.equal(ETKO.navigate('results'), 'results');
  assert.equal(ETKO.currentLayer, 'onsite');
  assert.equal(ETKO.navigate('not-a-route'), 'results');
  assert.equal(ETKO.currentLayer, 'onsite');
});

test('syncShellContext escapes event names and selects the active event', () => {
  const ETKO = loadShellApp();
  const select = { innerHTML: '', value: '' };
  const doc = {
    querySelector(selector) {
      return selector === '[data-event-context]' ? select : null;
    },
  };
  ETKO.store = {
    events: [
      { id: 'evt-1', name: '<img src=x onerror="run()">' },
      { id: 'evt-2', name: '행사 & 운영' },
    ],
    activeEventId: 'evt-2',
  };

  assert.equal(ETKO.syncShellContext(doc), true);
  assert.match(select.innerHTML, /&lt;img src=x onerror=&quot;run\(\)&quot;&gt;/);
  assert.match(select.innerHTML, /행사 &amp; 운영/);
  assert.equal(select.value, 'evt-2');
});

test('data-view buttons wire to ETKO.navigate on click', () => {
  const handlers = new Map();
  const buttons = VIEWS.map((view) => ({
    view,
    setAttribute() {},
    addEventListener(type, fn) {
      if (type === 'click') handlers.set(view, fn);
    },
  }));
  const stubDocument = {
    querySelectorAll: () => buttons,
  };
  const ETKO = loadApp(stubDocument);
  const wired = ETKO.wireNav(stubDocument);
  assert.equal(wired, VIEWS.length, 'wireNav must wire every data-view button');
  for (const view of VIEWS) {
    assert.ok(typeof handlers.get(view) === 'function', `button "${view}" must have a click handler`);
    handlers.get(view)();
    assert.equal(ETKO.currentView, view, `clicking "${view}" must navigate to "${view}"`);
  }
});
