const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const CSS_PATH = path.join(ROOT, 'styles', 'tokens.css');
const KO_PATH = path.join(ROOT, 'i18n', 'ko.json');

const NEW_KEYS = [
  'staff', 'qna', 'photos', 'poll', 'quiz', 'draw', 'survey',
  'messages', 'program', 'notices', 'venue', 'board',
  'results', 'settings', 'members', 'events', 'screen', 'booths',
];

function readHtml() {
  return fs.readFileSync(HTML_PATH, 'utf8');
}

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

function visibleText(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

function inlineSync(html) {
  const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].includes('ETKO-VIEW-SYNC')) return m[1];
  }
  assert.fail('index.html must inline the view-sync script (ETKO-VIEW-SYNC)');
  return '';
}

function loadShell() {
  const sandbox = { console };
  sandbox.window = {};
  vm.createContext(sandbox);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const listed = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(listed.includes('features/engagement.js'), 'index shell must list engagement for honest boot');
  for (const f of listed) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  vm.runInContext(inlineSync(html), sandbox, { filename: 'index-inline-sync.js' });
  return sandbox.window.ETKO || sandbox.ETKO;
}

function loadDirectory() {
  const sandbox = { console };
  sandbox.window = {};
  vm.createContext(sandbox);
  for (const f of ['app.js', 'features/agency.js', 'features/participants.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.window.ETKO || sandbox.ETKO;
}

test('responsive contract markers cover 320/390/768/1440', () => {
  const html = readHtml();
  const css = readCss();
  assert.match(
    html,
    /<meta[^>]*name="viewport"[^>]*content="[^"]*width=device-width[^"]*"/,
    'viewport meta must set width=device-width'
  );
  assert.match(
    css,
    /@media\s*\(\s*max-width:\s*390px\s*\)/,
    'small-viewport query (max-width: 390px, covering 320/390) must exist'
  );
  assert.match(
    css,
    /@media\s*\(\s*min-width:\s*768px\s*\)/,
    'tablet query (min-width: 768px) must exist'
  );
  assert.match(
    css,
    /@media\s*\(\s*min-width:\s*1440px\s*\)/,
    'wide-viewport query (min-width: 1440px) must exist'
  );
  assert.match(
    css,
    /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/,
    '.table-wrap must scroll horizontally inside itself'
  );
  assert.match(
    css,
    /body\s*\{[^}]*overflow-x:\s*(clip|hidden)/,
    'the page itself must never scroll sideways'
  );
});

test('results and settings mounts render behind ETKO.navigate', () => {
  const html = readHtml();
  assert.match(html, /id="results-mount"/, 'results mount must exist');
  assert.match(html, /id="settings-mount"/, 'settings mount must exist');
  assert.match(
    html,
    /<script[^>]*src="features\/results\.js"[^>]*>/,
    'index.html must load features/results.js'
  );

  const ETKO = loadShell();
  const mounts = {
    '#overview-mount': { innerHTML: '' },
    '#results-mount': { innerHTML: '' },
    '#settings-mount': { innerHTML: '' },
  };
  const section = {
    hiddenState: 'hidden',
    setAttribute(k) {
      if (k === 'hidden') this.hiddenState = 'hidden';
    },
    removeAttribute(k) {
      if (k === 'hidden') this.hiddenState = null;
    },
    querySelector(sel) {
      return mounts[sel] || null;
    },
  };
  const doc = {
    querySelector(sel) {
      return sel === '#overview-view' ? section : null;
    },
  };
  assert.equal(ETKO.navigate('overview'), 'overview');
  assert.equal(ETKO.syncViews(doc), true);
  assert.equal(section.hiddenState, null, 'overview must show on its view');
  for (const sel of ['#results-mount', '#settings-mount']) {
    assert.match(mounts[sel].innerHTML, /[가-힣]/, `${sel} must render Korean content`);
  }
});

test('ko.json carries Korean labels for all new keys', () => {
  const ko = JSON.parse(fs.readFileSync(KO_PATH, 'utf8'));
  for (const key of NEW_KEYS) {
    assert.ok(typeof ko[key] === 'string' && ko[key].trim() !== '', `ko.json missing key: ${key}`);
    assert.match(ko[key], /[가-힣]/, `ko.json label for "${key}" must be Korean`);
  }
  assert.match(readHtml(), new RegExp(ko.results), 'shell must show the results label');
  assert.match(readHtml(), new RegExp(ko.settings), 'shell must show the settings label');
});

test('no toast-only dead ends in the shell', () => {
  assert.ok(!readHtml().includes('data-action="toast"'), 'index.html must not strand toast-only actions');
});

test('no raw SELF/STAFF/PENDING keys in rendered HTML', () => {
  const ETKO = loadShell();
  const results = { innerHTML: '' };
  const settings = { innerHTML: '' };
  ETKO.renderResults(results);
  ETKO.renderSettings(settings);
  for (const [name, html] of [['index.html', readHtml()], ['results', results.innerHTML], ['settings', settings.innerHTML]]) {
    assert.ok(
      !/SELF|STAFF|PENDING/.test(visibleText(html)),
      `${name} visible text must not leak raw keys`
    );
  }
});

test('field staff reach participant detail from the directory (route table untouched)', () => {
  const ETKO = loadDirectory();
  assert.equal(
    ETKO.canRoute('STAFF', 'participant'),
    false,
    'Task 1 route table stays untouched: STAFF has no participant route'
  );
  const container = { innerHTML: '' };
  const people = [
    { id: 'p1', name: '김민준', email: 'a@x.kr', ticket: 'GENERAL', status: 'registered', code: 'EVT-1' },
  ];
  ETKO.renderPeople(container, people);
  assert.match(container.innerHTML, /data-detail="p1"/, 'directory rows must offer a detail entry');
  assert.match(container.innerHTML, /상세/, 'detail entry must be Korean');

  ETKO.navigate('participants');
  assert.equal(ETKO.openParticipantDetail('p1'), 'participant');
  assert.equal(ETKO.currentView, 'participant', 'detail entry must land on the participant view');
  assert.equal(ETKO.homeParticipantId, 'p1', 'detail entry must record its target');
});

test('shell boot loads the real feature store (no hidden wiring gap)', () => {
  const ETKO = loadShell();
  assert.equal(typeof ETKO.workspace, 'function', 'boot must provide workspace');
  assert.equal(typeof ETKO.vote, 'function', 'boot must provide engagement vote');
  assert.equal(typeof ETKO.createReport, 'function', 'boot must provide reports');
  assert.equal(typeof ETKO.scan, 'function', 'boot must provide scan');
});
