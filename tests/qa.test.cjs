const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const CSS_PATH = path.join(ROOT, 'styles', 'tokens.css');

const VIEWS = ['overview', 'participants', 'checkin', 'booth', 'participant', 'stage'];
const SECTION_IDS = {
  overview: 'overview-view',
  participants: 'participants-view',
  checkin: 'checkin-view',
  booth: 'booth-view',
  participant: 'participant-view',
  stage: 'stage-view',
};
const MOUNT_IDS = {
  overview: 'overview-mount',
  participants: 'people-list',
  checkin: 'checkin-mount',
  booth: 'booth-mount',
  participant: 'home-mount',
  stage: 'stage-mount',
};

function readHtml() {
  return fs.readFileSync(HTML_PATH, 'utf8');
}

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

// Inline (src-less) script bodies from index.html.
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// True when an aria-live element sits inside another aria-live element.
function hasNestedLiveRegion(html) {
  const voids = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    if (full.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const live = /aria-live\s*=\s*"[^"]*"/.test(full);
    if (live && stack.some((el) => el.live)) return true;
    const selfClosing = /\/>$/.test(full) || voids.has(tag);
    if (!selfClosing) stack.push({ tag, live });
  }
  return false;
}

function loadAll() {
  const sandbox = { console };
  sandbox.window = {};
  vm.createContext(sandbox);
  const files = [
    'app.js',
    'features/participants.js',
    'features/checkin.js',
    'features/booth.js',
    'features/stage.js',
  ];
  files.forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f })
  );
  const html = readHtml();
  const sync = inlineScripts(html).find((src) => src.includes('ETKO-VIEW-SYNC'));
  assert.ok(sync, 'index.html must inline the view-sync script (ETKO-VIEW-SYNC)');
  vm.runInContext(sync, sandbox, { filename: 'index-inline-sync.js' });
  return sandbox.window.ETKO || sandbox.ETKO;
}

function stubSection(mountId) {
  const mount = { innerHTML: '' };
  return {
    hiddenState: 'hidden',
    mount,
    setAttribute(k) {
      if (k === 'hidden') this.hiddenState = 'hidden';
    },
    removeAttribute(k) {
      if (k === 'hidden') this.hiddenState = null;
    },
    querySelector(sel) {
      return sel === '#' + mountId ? mount : null;
    },
  };
}

function stubDoc() {
  const sections = {};
  Object.keys(SECTION_IDS).forEach((view) => {
    sections[view] = stubSection(MOUNT_IDS[view]);
  });
  return {
    sections,
    querySelector(sel) {
      for (const view of Object.keys(SECTION_IDS)) {
        if (sel === '#' + SECTION_IDS[view]) return sections[view];
      }
      return null;
    },
  };
}

test('shell stays lang="ko" with viewport meta and Korean nav', () => {
  const html = readHtml();
  assert.match(html, /<html[^>]*lang="ko"/, 'index.html must declare lang="ko"');
  assert.match(
    html,
    /<meta[^>]*name="viewport"[^>]*content="[^"]*width=device-width[^"]*"/,
    'viewport meta must set width=device-width'
  );
  assert.match(html, /<nav[^>]*aria-label="[^"]*[가-힣][^"]*"/, 'nav must carry a Korean aria-label');
  const re = /<button[^>]*data-view="([^"]+)"[^>]*>([^<]*)<\/button>/g;
  const found = new Map();
  let m;
  while ((m = re.exec(html)) !== null) found.set(m[1], m[2].trim());
  for (const view of VIEWS) {
    assert.ok(found.has(view), `nav button data-view="${view}" must exist`);
    assert.match(found.get(view), /[가-힣]/, `nav label for "${view}" must be Korean`);
  }
});

test('all six views are mounted with Korean labels and start hidden', () => {
  const html = readHtml();
  for (const view of VIEWS) {
    const id = SECTION_IDS[view];
    assert.match(
      html,
      new RegExp(`<section[^>]*id="${id}"[^>]*hidden`),
      `section #${id} must exist and start hidden (overview is the default view)`
    );
    const tag = html.match(new RegExp(`<section[^>]*id="${id}"[^>]*>`));
    assert.ok(tag, `section #${id} must exist`);
    assert.match(tag[0], /aria-label="[^"]*[가-힣][^"]*"/, `section #${id} must carry a Korean aria-label`);
    assert.match(html, new RegExp(`id="${MOUNT_IDS[view]}"`), `mount #${MOUNT_IDS[view]} must exist`);
  }
});

test('index.html loads app.js and every feature script', () => {
  const html = readHtml();
  assert.match(html, /<script[^>]*src="app\.js"[^>]*>/, 'index.html must load app.js');
  for (const feat of ['participants', 'checkin', 'booth', 'stage']) {
    assert.match(
      html,
      new RegExp(`<script[^>]*src="features/${feat}\\.js"[^>]*>`),
      `index.html must load features/${feat}.js`
    );
  }
});

test('every view is gated behind ETKO.navigate', () => {
  const ETKO = loadAll();
  assert.equal(typeof ETKO.syncViews, 'function', 'ETKO.syncViews must exist');
  assert.ok(ETKO.viewsNavHooked, 'view sync must hook ETKO.navigate');

  const doc = stubDoc();
  for (const view of VIEWS) {
    assert.equal(ETKO.navigate(view), view, `navigate("${view}") must switch`);
    assert.equal(ETKO.syncViews(doc), true, `syncViews must activate "${view}"`);
    for (const other of VIEWS) {
      const state = doc.sections[other].hiddenState;
      if (other === view) {
        assert.equal(state, null, `section for "${view}" must show`);
      } else {
        assert.equal(state, 'hidden', `section for "${other}" must hide while on "${view}"`);
      }
    }
  }

  // Unknown views keep the current view (Task 2 contract holds through wrappers).
  ETKO.navigate('participants');
  ETKO.syncViews(doc);
  assert.equal(ETKO.navigate('nope'), 'participants');
  assert.equal(ETKO.currentView, 'participants');
  assert.equal(ETKO.syncViews(doc), true);
  assert.equal(doc.sections.participants.hiddenState, null, 'participants must stay shown');
  assert.equal(doc.sections.checkin.hiddenState, 'hidden', 'checkin must stay hidden');
});

test('live regions are sane: present, polite, never nested', () => {
  const html = readHtml();
  const liveCount = (html.match(/aria-live\s*=\s*"polite"/g) || []).length;
  assert.ok(liveCount >= 1, 'at least one aria-live="polite" region must exist');
  assert.match(html, /id="people-list"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="people-list"|id="people-list"[\s\S]*?aria-live/, 'people-list mount must stay a live region');
  assert.ok(
    !/<main[^>]*aria-live/.test(html),
    'main must not be a live region (avoids nested duplication with view mounts)'
  );
  assert.equal(hasNestedLiveRegion(html), false, 'no aria-live element may sit inside another');
});

test('focus token exists and is visible', () => {
  const css = readCss();
  assert.match(css, /--focus-ring\s*:/, '--focus-ring token must exist');
  assert.match(
    css,
    /:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)[^}]*outline-offset:/,
    ':focus-visible must use var(--focus-ring) with an outline-offset'
  );
});

test('primary touch targets meet the 44px minimum', () => {
  const css = readCss();
  assert.match(css, /--touch-min\s*:\s*44px/, '--touch-min must stay 44px');
  const blocks = (css.match(/[^{}]*min-height:\s*var\(--touch-min\)[^{}]*\{|[^{}]*\{[^}]*min-height:\s*var\(--touch-min\)[^}]*\}/g) || []).join('\n');
  for (const sel of [
    'button[data-view]',
    'button[data-bulk-in]',
    'button[data-direction]',
    'button[data-booth-mode]',
    'button[data-take]',
    'button[data-sync]',
    'button[data-home-cta]',
  ]) {
    assert.ok(blocks.includes(sel), `${sel} must enforce min-height: var(--touch-min)`);
  }
});

test('ticket input meets the 52px field height', () => {
  const css = readCss();
  const html = readHtml();
  assert.match(css, /--field-h\s*:\s*52px/, '--field-h must stay 52px');
  assert.match(
    css,
    /input\[data-ticket\][\s\S]*?min-height:\s*var\(--field-h\)/,
    'ticket input must enforce min-height: var(--field-h)'
  );
  assert.match(html, /<input[^>]*data-ticket[^>]*>/, 'index.html must carry a ticket input');
  assert.match(
    html,
    /<input[^>]*aria-label="[^"]*[가-힣][^"]*"[^>]*>/,
    'ticket input must carry a Korean aria-label'
  );
});

test('tables scroll inside the wrapper only', () => {
  const css = readCss();
  assert.match(
    css,
    /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/,
    '.table-wrap must scroll horizontally inside itself'
  );
  assert.match(css, /max-width:\s*100%/, 'media/table guards must cap max-width at 100%');
  assert.match(
    css,
    /body\s*\{[^}]*overflow-x:\s*(clip|hidden)/,
    'the page itself must never scroll sideways'
  );
});

test('breakpoints cover 320/390/1440 viewports', () => {
  const css = readCss();
  assert.match(
    css,
    /@media\s*\(\s*max-width:\s*390px\s*\)/,
    'a small-viewport query (max-width: 390px, covering 320/390) must exist'
  );
  assert.match(
    css,
    /@media\s*\(\s*min-width:\s*1440px\s*\)/,
    'a wide-viewport query (min-width: 1440px) must exist'
  );
});

test('brand tokens are preserved', () => {
  const css = readCss();
  assert.match(css, /--brand\s*:\s*#f35b2c/i, '--brand must stay #F35B2C');
  assert.match(css, /--action\s*:\s*#bc3f1b/i, '--action must stay #BC3F1B');
  assert.match(css, /--canvas\s*:\s*#faf8f5/i, '--canvas must stay #FAF8F5');
});
