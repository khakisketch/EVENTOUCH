'use strict';

// Reopened 2026-11-20 (attendee consolidation): the helpers every attendee screen
// copied (ticket bearer storage, command id, JSON guards, banner appearance) each
// live in one place now, and the console previews wear the attendee look. These
// tests run the shared modules and pin that the copies stay gone.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { createRequire } = require('node:module');

const WEB = path.join(__dirname, '..', 'apps/web');
const webRequire = createRequire(path.join(WEB, 'package.json'));
const ts = webRequire('typescript');
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');

function load(file, globals = {}, shims = {}) {
  const out = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, { module, exports: module.exports, ...globals, require: (id) => (id in shims ? shims[id] : webRequire(id)) }, { filename: file });
  return module.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('randomCommandId uses randomUUID when present and an unpredictable 128-bit id when it is not', () => {
  const secure = load('lib/command-id.ts', { crypto: webcrypto });
  assert.match(secure.randomCommandId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  // A non-secure context (plain http on a LAN) has getRandomValues but no randomUUID.
  const insecure = load('lib/command-id.ts', { crypto: { getRandomValues: (bytes) => webcrypto.getRandomValues(bytes) } });
  const ids = new Set(Array.from({ length: 50 }, () => insecure.randomCommandId()));
  assert.equal(ids.size, 50, 'no repeats');
  for (const id of ids) assert.match(id, /^web-[0-9a-f]{32}$/u, 'the id can recover a ticket, so it is never a clock or Math.random value');
});

function sessionStorageWorld(behavior = {}) {
  const map = new Map();
  const storage = {
    getItem: (key) => { if (behavior.read) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (behavior.write) throw new DOMException('Quota exceeded', 'QuotaExceededError'); map.set(key, String(value)); },
    removeItem: (key) => { if (behavior.remove) throw new Error('blocked'); map.delete(key); },
  };
  return { map, api: load('lib/attendee-ticket-storage.ts', { window: { sessionStorage: storage } }) };
}

test('the ticket bearer is kept per event slug in sessionStorage under the same key every screen reads', () => {
  const { map, api } = sessionStorageWorld();
  assert.equal(api.TICKET_STORAGE_PREFIX, 'eventouch.ticket.');
  assert.equal(api.readStoredTicket('synthetic'), '');
  assert.equal(api.storeTicket('synthetic', 'bearer-A'), true);
  assert.equal(map.get('eventouch.ticket.synthetic'), 'bearer-A');
  assert.equal(api.readStoredTicket('synthetic'), 'bearer-A');
  assert.equal(api.readStoredTicket('other'), '', 'another event does not share the bearer');
  api.clearStoredTicket('synthetic');
  assert.equal(map.has('eventouch.ticket.synthetic'), false);
});

test('blocked storage never throws: reads are empty, writes report false, clears are quiet', () => {
  const blocked = sessionStorageWorld({ read: true, write: true, remove: true }).api;
  assert.equal(blocked.readStoredTicket('synthetic'), '');
  assert.equal(blocked.storeTicket('synthetic', 'bearer-A'), false);
  assert.doesNotThrow(() => blocked.clearStoredTicket('synthetic'));
});

test('JSON guards read a wrong shape as empty', () => {
  const { text, asRecord } = load('lib/json-guards.ts');
  assert.equal(text('a'), 'a');
  assert.equal(text(7), '');
  assert.equal(text(null, 'fallback'), 'fallback');
  assert.equal(text(' padded '), ' padded ', 'not trimmed');
  assert.deepEqual(plain(asRecord({ a: 1 })), { a: 1 });
  for (const value of [null, undefined, [], 'x', 3, true]) assert.equal(asRecord(value), null);
});

test('banner appearance: gradient and solid banners are color fills, a picture banner follows its picture and the default art rule', () => {
  const home = load('lib/attendee-home.ts');
  const { bannerAppearance, DEFAULT_BANNER_ART } = load('lib/banner-appearance.ts', {}, { './attendee-home': home });
  const style = (patch) => ({ ...plain(home.DEFAULT_HOME_STYLE), ...patch });

  const solid = bannerAppearance(style({ bannerKind: 'solid', bannerColor: '#FFFFFF' }), null, 'legacy', false);
  assert.deepEqual(plain(solid), { fill: '#FFFFFF', imageMode: false, neutral: false, source: null, tone: 'dark' }, 'a pale fill gets dark text whatever textTone says');
  const gradient = bannerAppearance(style({ bannerKind: 'gradient', bannerColor: '#101010', bannerColor2: '#202020', bannerAngle: 'vertical', textTone: 'dark' }), '/picture.png', 'legacy', false);
  assert.equal(gradient.fill, 'linear-gradient(180deg, #101010, #202020)');
  assert.equal(gradient.source, null, 'a color banner never loads the picture');
  assert.equal(gradient.tone, 'light', 'a dark fill gets light text');

  const picture = bannerAppearance(style({ textTone: 'dark' }), '/picture.png', 'legacy', false);
  assert.deepEqual(plain(picture), { fill: null, imageMode: true, neutral: false, source: '/picture.png', tone: 'dark' }, 'a picture follows the chosen tone');
  assert.equal(bannerAppearance(style({}), null, 'legacy', false).source, DEFAULT_BANNER_ART, 'no upload shows the default art unless the agency chose none');
  const none = bannerAppearance(style({ textTone: 'dark' }), null, 'neutral', false);
  assert.deepEqual(plain(none), { fill: null, imageMode: true, neutral: true, source: null, tone: 'light' }, 'the quiet banner always reads light');
  const failed = bannerAppearance(style({ textTone: 'dark' }), '/picture.png', 'legacy', true);
  assert.deepEqual(plain(failed), { fill: null, imageMode: true, neutral: true, source: null, tone: 'light' }, 'a picture that failed to load falls back to the quiet banner');
});

test('the four screens that copied the helpers import the shared ones and keep no copy', () => {
  const screens = {
    'app/event/[slug]/home/HomeShell.tsx': ['randomCommandId', 'readStoredTicket', 'storeTicket', 'clearStoredTicket', 'text', 'asRecord', 'publicKeyvisualSource', 'STORAGE_PREFIX'],
    'app/event/[slug]/engage/EngageClient.tsx': ['randomCommandId', 'readStoredTicket', 'storeTicket', 'clearStoredTicket', 'text', 'asRecord', 'STORAGE_PREFIX'],
    'app/event/[slug]/ticket/TicketView.tsx': ['readStoredTicket', 'storeTicket', 'clearStoredTicket', 'STORAGE_PREFIX'],
    'app/event/[slug]/register/RegisterForm.tsx': ['randomCommandId'],
    'app/staff/StaffEventWork.tsx': ['randomCommandId'],
    'app/event/[slug]/register/register-data.ts': ['asRecord'],
    'app/event/[slug]/ticket/recovered-ticket.ts': ['prefix'],
  };
  for (const [file, names] of Object.entries(screens)) {
    const source = read(file);
    for (const name of names) {
      assert.doesNotMatch(source, new RegExp(`^(?:function|const)\\s+${name}\\b`, 'mu'), `${file} keeps no top-level ${name}`);
    }
  }
  assert.match(read('app/event/[slug]/home/HomeShell.tsx'), /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/attendee-ticket-storage"/u);
  assert.match(read('app/event/[slug]/ticket/TicketView.tsx'), /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/attendee-ticket-storage"/u);
  assert.match(read('app/event/[slug]/engage/EngageClient.tsx'), /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/command-id"/u);
  assert.match(read('app/event/[slug]/register/RegisterForm.tsx'), /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/command-id"/u);
  assert.match(read('app/staff/StaffEventWork.tsx'), /from "\.\.\/\.\.\/lib\/command-id"/u);
  // The published look is parsed once (event-theme) and read by the home.
  assert.match(read('app/event/[slug]/home/HomeShell.tsx'), /readAttendeeTheme\(slug, publicData\.workspace\)/u);
  assert.match(read('app/event/[slug]/event-theme.ts'), /function keyvisualSource/u);
});

test('both banners decide their fill, picture and tone through the shared hook', () => {
  for (const file of ['app/event/[slug]/home/HomeHero.tsx', 'app/event/[slug]/EventBanner.tsx']) {
    const source = read(file);
    assert.match(source, /useBannerAppearance\(/u, `${file} uses the shared banner appearance`);
    assert.doesNotMatch(source, /bannerFillCss|bannerFillTone|attendee-home-banner\.png/u, `${file} keeps no copy of the fill rules`);
  }
});

test('field errors and empty states come from the attendee components, not per-screen classes', () => {
  const engage = read('app/event/[slug]/engage/EngageClient.tsx');
  assert.doesNotMatch(engage, /styles\.fieldError/u);
  assert.match(engage, /<AttendeeFieldError\b/u);
  assert.doesNotMatch(read('app/event/[slug]/engage/engage.module.css'), /\.fieldError\b/u);
  assert.doesNotMatch(read('app/event/[slug]/home/home.module.css'), /\.emptyState\b/u);
  assert.doesNotMatch(read('app/event/[slug]/home/HomeShell.tsx'), /styles\.emptyState/u);
  // The recheck message is an AttendeeStateMessage; the stylesheet only places it.
  const css = read('app/event/[slug]/ticket/ticket.module.css');
  const rule = /\.ticketRecheckError\s*\{([^}]*)\}/u.exec(css);
  assert.ok(rule, 'the placement rule exists');
  assert.doesNotMatch(rule[1], /border|background|padding|color/u, 'no second card drawn over the state message');
});
