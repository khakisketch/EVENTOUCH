'use strict';

// Runtime evidence about the frontend's duplicated definitions.
//
// 23 scripts extend one global object and load order decides which definition
// wins. Some "duplicates" are layers (the later file captures the earlier value
// and calls it, so both are live) and some are plain replacements. Telling them
// apart matters: deleting a layer breaks the product.
//
// Static analysis was tried three times and gave three different answers,
// because capture expressions vary by file. So this loads every script for real,
// tags each assignment with the file that made it and a call counter, then
// invokes the winning definition and reports which earlier ones also fired.
//
// WHAT THIS PROVES
//   A chain where every definition fires is a live composition. That is
//   conclusive, and it is the thing worth knowing before editing or deleting.
//
// WHAT THIS DOES NOT PROVE
//   A definition that stays silent here is NOT proven dead. The invocation runs
//   in one synthetic state, and a winner can throw before reaching its base —
//   operator-experience.js's attendee view needs a populated workspace before
//   it calls baseAttendee(), so attendee.js reports silence for a definition
//   that really is reachable in the browser. Verify any removal candidate in
//   the actual product across preview and server modes before deleting it.
//
// Run: node scripts/definition-trace.cjs

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.cwd();
const order = (fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .match(/src="assets\/js\/([^"?]+)/g) || []).map((v) => v.replace('src="assets/js/', ''));

const calls = [];
const assignments = [];
let currentFile = '';
let nextId = 0;

function tag(name, fn) {
  const id = ++nextId;
  const wrapped = function (...args) {
    calls.push({ name, file: currentFile, id });
    return fn.apply(this, args);
  };
  assignments.push({ name, file: currentFile, id });
  return wrapped;
}

const noop = () => {};
const fakeEl = () => ({
  classList: { add: noop, remove: noop, toggle: () => false, contains: () => false },
  style: {}, dataset: {}, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  append: noop, appendChild: noop, remove: noop, insertAdjacentElement: noop,
  addEventListener: noop, removeEventListener: noop, querySelector: fakeEl, querySelectorAll: () => [], closest: fakeEl, focus: noop, click: noop,
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  isConnected: true, innerHTML: '', textContent: '', value: '', hidden: false, elements: [],
  _callback: null, removeAttribute: noop, submit: noop, reset: noop,
});
const document = {
  body: fakeEl(), documentElement: fakeEl(), head: fakeEl(),
  createElement: fakeEl, createTextNode: fakeEl, getElementById: fakeEl,
  querySelector: fakeEl, querySelectorAll: () => [], addEventListener: noop,
  removeEventListener: noop, title: '', cookie: '',
};
const window = {
  addEventListener: noop, removeEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  location: { hash: '', href: '', search: '', pathname: '/' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document, navigator: { onLine: true, userAgent: 'trace' },
  print: noop, confirm: () => true, alert: noop, open: () => null, scrollTo: noop,
  innerWidth: 1280, innerHeight: 900,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => { try { fn(0); } catch (e) {} },
};
window.window = window;

const context = vm.createContext({
  window, document, globalThis: undefined, self: window,
  console, URLSearchParams, URL, Set, Map, WeakMap, Math, JSON, Date, Object, Array, String, Number, Boolean,
  RegExp, Error, TypeError, RangeError, Promise, Intl, isNaN, parseInt, parseFloat,
  encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, structuredClone,
  navigator: window.navigator, localStorage: window.localStorage, location: window.location,
  matchMedia: window.matchMedia, requestAnimationFrame: window.requestAnimationFrame, Blob: class {},
  alert: noop, print: noop, confirm: () => true, getComputedStyle: window.getComputedStyle,
});
context.globalThis = context;

function run(file) {
  currentFile = file;
  try {
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/js', file), 'utf8'), context, { filename: file });
  } catch (error) {
    if (process.env.TRACE_VERBOSE) console.log(`[load error] ${file}: ${error.message}`);
  }
}

// core.js assigns window.ET wholesale, so the Proxy has to be installed after
// it runs and before any file that reads window.ET at load time.
run(order[0]);
const real = context.window.ET;
function guard(container, kind) {
  return new Proxy(container, {
    set(target, prop, value) {
      if (typeof value === 'function') target[prop] = tag(`${kind}:${String(prop)}`, value);
      else target[prop] = value;
      return true;
    },
  });
}
const viewsProxy = guard(real.views, 'view');
const actionsProxy = guard(real.actions, 'action');
context.window.ET = new Proxy(real, {
  get(target, prop) {
    if (prop === 'views') return viewsProxy;
    if (prop === 'actions') return actionsProxy;
    return target[prop];
  },
  set(target, prop, value) { target[prop] = value; return true; },
  has(target, prop) { return prop in target; },
});

for (const file of order.slice(1)) run(file);

// Give the definitions a plausible context and let permission checks pass.
// Without this the workflows.js permission wrapper throws before reaching the
// original action, so live definitions look dead. In-memory only.
const workspace = (real.emptyWorkspace ? real.emptyWorkspace() : {
  participants: [], desks: [], booths: [], assignments: [], checks: [], visits: [],
  messages: [], templates: [], reports: [], program: [], notices: [], groups: ['일반'],
  venue: {}, branding: {}, display: {}, price: 0,
});
real.route = { scope: 'console', page: 'checkin', eventId: 'ev1', key: 'k', params: new URLSearchParams() };
real.session = { id: 'a1', name: 'trace', role: 'AGENCY', orgOwner: true };
real.state = {
  version: 9, revision: 1, activeEventId: 'ev1',
  events: [{ id: 'ev1', name: '추적용 행사', slug: 'trace', clientId: 'c1', date: '2026-12-01',
             start: '09:00', end: '18:00', stage: 'LIVE', capacity: 10, features: ['stamp','poll','quiz','qa','draw','survey','photo','board','venue','screen','reward'] }],
  workspaces: { ev1: workspace },
  clients: [{ id: 'c1', name: '고객사' }],
  accounts: [{ id: 'a1', name: 'trace', role: 'AGENCY', active: true }],
  memberships: [{ accountId: 'a1', eventId: 'ev1', write: ['all'] }],
  invitations: [], audit: [],
};
real.can = () => true;
real.orgCan = () => true;
real.eventAllowed = () => true;
real.isOperator = () => true;
real.ui = real.ui || {};
real.ui.filters = real.ui.filters || {};

const byName = new Map();
for (const a of assignments) {
  if (!byName.has(a.name)) byName.set(a.name, []);
  byName.get(a.name).push(a);
}
process.on('uncaughtException', (error) => {
  if (process.env.TRACE_VERBOSE) console.error('[trace] ' + error.message);
});

const duplicates = [...byName.entries()].filter(([, list]) => list.length > 1);
console.log(`추적된 정의: ${assignments.length}개 · 중복 이름: ${duplicates.length}개\n`);

const E = real;
let deadTotal = 0;
const deadList = [];
for (const [name, list] of duplicates.sort((a, b) => a[0].localeCompare(b[0]))) {
  calls.length = 0;
  const [kind, bare] = name.split(':');
  const fn = kind === 'view' ? E.views[bare] : E.actions[bare];
  if (typeof fn !== 'function') continue;
  try { fn({ id: 'x', dataset: {}, selected: 'false' }); } catch (error) {}
  const fired = new Set(calls.filter((c) => c.name === name).map((c) => c.id));
  const dead = list.filter((a) => !fired.has(a.id));
  deadTotal += dead.length;
  if (dead.length) deadList.push({ name, chain: list.map((a) => a.file + (fired.has(a.id) ? '✓' : '✗')) });
  console.log(`${(dead.length ? '죽음' : '레이어').padEnd(8)}${name.padEnd(32)}${list.map((a) => a.file + (fired.has(a.id) ? '✓' : '✗')).join(' → ')}`);
}
console.log(`\n실행되지 않는 정의: ${deadTotal}개`);
