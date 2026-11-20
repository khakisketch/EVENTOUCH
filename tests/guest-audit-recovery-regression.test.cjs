'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WEB = path.resolve(__dirname, '../apps/web');
const ts = require(path.join(WEB, 'node_modules/typescript'));
const { renderToStaticMarkup } = require(path.join(WEB, 'node_modules/react-dom/server'));
const jsx = require(path.join(WEB, 'node_modules/react/jsx-runtime'));
const ENGAGE = 'app/event/[slug]/engage/EngageClient.tsx';
const TICKET = 'app/event/[slug]/ticket/TicketView.tsx';
const source = file => fs.readFileSync(path.join(WEB, file), 'utf8');
const tree = file => ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

// Execute the production loading branch, including the actual event handler,
// rather than mirroring the control's markup or retry implementation.
function loadingView() {
  const parsed = tree(TICKET);
  let block;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(parsed) === 'state.kind === "loading"') block = node.thenStatement.getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(block, 'production ticket loading branch');
  let tick = 0;
  const sandbox = { exports: {}, require: name => { assert.equal(name, 'react/jsx-runtime'); return jsx; }, styles: { ticketLoadingRetry: 'loading-retry', passMessage: 'pass-message' }, AttendeeStateMessage: ({ title, children }) => jsx.jsxs('div', { children: [title, children] }), pass: true, setReloadTick: update => { tick = update(tick); } };
  vm.createContext(sandbox);
  vm.runInContext(compile(`globalThis.renderLoading = () => ${block}`), sandbox);
  const element = sandbox.renderLoading();
  const controls = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.props?.className === 'loading-retry') controls.push(node);
    for (const child of [node.props?.children].flat(Infinity)) walk(child);
  }
  walk(element);
  assert.equal(controls.length, 1);
  return { element, retry: controls[0], tick: () => tick };
}

test('ticket loading has a native same-document recovery target before hydration without exposing the bearer', () => {
  const { element, retry } = loadingView();
  assert.equal(retry.type, 'a', 'an unhydrated React-only button cannot reload the ticket document');
  assert.equal(retry.props.href, '', 'native reload uses the current document, not a rendered bearer URL');
  const linkedDocument = new URL('https://fixture.invalid/event/synthetic/ticket?ticket=synthetic-private-bearer');
  assert.equal(new URL(retry.props.href, linkedDocument).href, linkedDocument.href);
  const html = renderToStaticMarkup(element);
  assert.ok(!html.includes('synthetic-private-bearer'));
  assert.ok(!/javascript:|onclick=/i.test(html), 'native recovery must not depend on inline script');
});

test('hydrated loading recovery prevents document navigation and advances the in-tab retry epoch once', () => {
  const view = loadingView();
  let prevented = 0;
  view.retry.props.onClick({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'keep a memory-only bearer in the current document');
  assert.equal(view.tick(), 1);
});

// Only network/browser boundaries are synthetic. The production effect,
// parsers, storage helpers, and request-deadline implementation run unchanged.
function engageWorld(settlement) {
  const storage = new Map();
  const writes = [];
  const timers = new Map();
  let timerId = 0;
  const old = deferred();
  let oldSignal;
  const location = { search: '?ticket=bearer-A', pathname: '/event/synthetic/engage', hash: '' };
  const publicData = { event: { id: 'event', name: 'Synthetic Event' } };
  const ticketData = (id, ticket) => ({ event: publicData.event, participant: { id, ticket, name: id, status: 'APPROVED' }, workspace: { modules: [], questions: [], photos: [], posts: [] } });
  const sandbox = {
    console, URLSearchParams, AbortController, DOMException,
    slug: 'synthetic', liveSlugRef: { current: 'synthetic' }, ticketSlugRef: { current: 'synthetic' }, ticketRef: { current: '' },
    ticketStorageAvailable: () => true, getAllowedTicketForTab: () => '', isTicketRejected: () => false,
    clearSessionForTab() {}, clearTicketRejected() {}, allowSessionForTab() {}, markTicketRejected: () => writes.push('rejected'), REJECTED_TICKET_BEARER: 'rejected',
    // The page reads the event's home color for its ground; these races do not care which.
    normalizeHomeStyle: () => ({ backgroundColor: '#B9DEF0' }),
    // Reopened 2026-11-19: the page header also wears the published banner.
    readAttendeeTheme: () => ({}),
    window: {
      location, history: { replaceState(_state, _title, url) { location.search = new URL(url, 'https://fixture.invalid').search; } },
      sessionStorage: {
        getItem: key => storage.get(key) || null,
        setItem: (key, value) => { storage.set(key, value); writes.push(value); },
        removeItem: key => { storage.delete(key); writes.push('removed'); },
      },
    },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    setState: value => { sandbox.state = value; },
    fetch: async (url, init) => {
      if (!url.endsWith('/ticket')) return response(publicData);
      if (init.headers?.authorization === 'Bearer bearer-B') return response(ticketData('participant-B', 'bearer-B'));
      oldSignal = init.signal;
      if (settlement === 'aborted') return new Promise((resolve, reject) => {
        old.promise.then(resolve);
        init.signal.addEventListener('abort', () => reject(new DOMException('Superseded', 'AbortError')), { once: true });
      });
      return old.promise;
    },
  };
  sandbox.window.setTimeout = sandbox.setTimeout;
  sandbox.window.clearTimeout = sandbox.clearTimeout;
  vm.createContext(sandbox);
  const parsed = tree(ENGAGE);
  const declarations = [];
  let effect;
  function visit(node) {
    // Reopened 2026-11-20: text/asRecord and the ticket storage helpers are shared lib modules (loaded below), not engage-private copies.
    if (ts.isFunctionDeclaration(node) && ['parseModule'].includes(node.name?.text)) declarations.push(node.getText(parsed));
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect' && node.arguments[0]?.getText(parsed).includes('async function load')) effect = node.arguments[0].getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(effect, 'production participant load effect');
  const exports = {};
  sandbox.exports = exports;
  vm.runInContext(compile(source('lib/request-deadline.ts')), sandbox);
  vm.runInContext(compile(source('lib/json-guards.ts')), sandbox);
  vm.runInContext(compile(source('lib/attendee-ticket-storage.ts')), sandbox);
  Object.assign(sandbox, exports);
  vm.runInContext(compile(`${declarations.join('\n')}\nglobalThis.startEffect = ${effect};`), sandbox);
  return { sandbox, storage, writes, old, oldSignal: () => oldSignal, timers, ticketData };
}

for (const settlement of ['aborted', 'uncancellable']) for (const result of ['failure', 'success']) {
  test(`superseded engage ${settlement} ${result} cannot clear or replace the new participant bearer`, async () => {
    const world = engageWorld(settlement);
    const stopA = world.sandbox.startEffect();
    await flush();
    assert.ok(world.oldSignal(), 'first ticket read is in flight before retry');
    stopA();
    assert.equal(world.oldSignal().aborted, true);
    world.sandbox.window.location.search = '?ticket=bearer-B';
    const stopB = world.sandbox.startEffect();
    await flush();
    assert.equal(world.sandbox.state.kind, 'ready');
    assert.equal(world.sandbox.state.participantId, 'participant-B');
    const writesBeforeLateSettlement = [...world.writes];
    world.old.resolve(result === 'failure' ? response({}, 404) : response(world.ticketData('participant-A', 'bearer-A')));
    await flush();
    assert.equal(world.sandbox.state.kind, 'ready');
    assert.equal(world.sandbox.state.participantId, 'participant-B');
    assert.equal(world.sandbox.ticketRef.current, 'bearer-B');
    assert.equal(world.storage.get('eventouch.ticket.synthetic'), 'bearer-B');
    assert.deepEqual(world.writes, writesBeforeLateSettlement, 'no stale identity, rejection marker, or storage writes');
    stopB();
    assert.equal(world.timers.size, 0);
  });
}
