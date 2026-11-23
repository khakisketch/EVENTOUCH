'use strict';

// Warm reads (2026-11-23): pointing at a menu link starts the screen's event
// bootstrap read early and parks it for the first reader. It is not a cache.
// The coordinator is executed for real; only the organization adapter and the
// network are stubbed (same boundary as console-system-improvement-reads).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');

const BOOT = '/api/events/event-1/bootstrap';
const REVIEW = '/api/events/event-1/bootstrap?messageRecipientReview=1';

function load({ fetch, clock }) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync('apps/web/lib/console-api.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  class FakeDate extends Date { static now() { return clock ? clock.now : Date.now(); } }
  const context = vm.createContext({
    exports, Response, AbortController, DOMException, Map, Set, Promise, Date: FakeDate,
    window: { setTimeout, clearTimeout },
    require(name) {
      if (name !== './operator-context') throw new Error(`unexpected import ${name}`);
      return {
        operatorFetch: (input, init) => fetch(input, init),
        subscribeOperatorContext: () => () => {},
        getOperatorContextSnapshot: () => ({ context: null, changed: false }),
        isOrganizationContextBlock: () => false,
      };
    },
  });
  vm.runInContext(source, context);
  return exports;
}
const ok = (body) => async () => Response.json(body);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a warmed read is taken by the first reader, once, with no second transport call', async () => {
  let calls = 0;
  const api = load({ fetch: async () => { calls += 1; return Response.json({ state: { n: calls } }); } });
  api.warmConsoleRead(BOOT);
  await tick();
  const first = await api.consoleFetch(BOOT, { cache: 'no-store', signal: new AbortController().signal });
  assert.deepEqual(await first.json(), { state: { n: 1 } });
  assert.equal(calls, 1, 'the screen read reused the early read');
  const second = await api.consoleFetch(BOOT);
  assert.deepEqual(await second.json(), { state: { n: 2 } }, 'a second reader gets a fresh read: warm entries are single use');
  assert.equal(calls, 2);
});

test('a write, a freshness signal or an org change drops the warm read', async () => {
  let calls = 0;
  const api = load({ fetch: async () => { calls += 1; return Response.json({ state: { n: calls } }); } });
  api.warmConsoleRead(BOOT);
  await tick();
  await api.consoleFetch('/api/events/event-1/commands', { method: 'POST', body: '{}' });
  const after = await api.consoleFetch(BOOT);
  assert.deepEqual(await after.json(), { state: { n: 3 } }, 'read after a write is fresh (warm read #1, write #2, fresh #3)');
  api.warmConsoleRead(BOOT);
  await tick();
  api.invalidateConsoleReads();
  const next = await api.consoleFetch(BOOT);
  assert.deepEqual(await next.json(), { state: { n: 5 } }, 'invalidation drops the parked read');
});

test('a warm read older than its window is not served', async () => {
  const clock = { now: 1_000_000 };
  let calls = 0;
  const api = load({ clock, fetch: async () => { calls += 1; return Response.json({ n: calls }); } });
  api.warmConsoleRead(BOOT);
  await tick();
  clock.now += 6000;
  const late = await api.consoleFetch(BOOT);
  assert.deepEqual(await late.json(), { n: 2 });
});

test('a failed warm read is dropped so the screen reads for itself', async () => {
  let calls = 0;
  const api = load({ fetch: async () => { calls += 1; return calls === 1 ? new Response('no', { status: 500 }) : Response.json({ n: calls }); } });
  api.warmConsoleRead(BOOT);
  await tick(); await tick();
  const res = await api.consoleFetch(BOOT);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { n: 2 });
});

test('only event bootstrap reads can be warmed, and each variant keeps its own key', async () => {
  let urls = [];
  const api = load({ fetch: async (input) => { urls.push(input); return Response.json({}); } });
  api.warmConsoleRead('/api/console/directory');
  api.warmConsoleRead('/api/events/event-1/participants');
  api.warmConsoleRead('/api/auth/me');
  await tick();
  assert.deepEqual(urls, [], 'nothing else is warmed');
  api.warmConsoleRead(REVIEW);
  await tick();
  await api.consoleFetch(BOOT);
  assert.deepEqual(urls, [REVIEW, BOOT], 'the plain read does not take the review variant');
});

test('a reader with its own abort signal still cancels when it aborts', async () => {
  // Like the real fetch, the stub rejects when its signal aborts.
  let release;
  const api = load({
    fetch: (input, init) => new Promise((resolve, reject) => {
      release = () => resolve(Response.json({}));
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  });
  api.warmConsoleRead(BOOT);
  const controller = new AbortController();
  const pending = api.consoleFetch(BOOT, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError' || error === controller.signal.reason);
  release();
  await tick();
  api.warmConsoleRead(BOOT);
  const already = new AbortController();
  already.abort();
  await assert.rejects(api.consoleFetch(BOOT, { signal: already.signal }));
});

test('the menu starts the read on rest/focus/touch and keeps the route-to-url rule in one place', () => {
  const shell = fs.readFileSync(path.join('apps', 'web', 'app', 'console', 'ConsoleShell.tsx'), 'utf8');
  assert.match(shell, /const match = \/\^\\\/console\\\/events\\\/\(\[\^\/\?#\]\+\)/u);
  assert.match(shell, /!page \|\| page === "messages" \? "\?messageRecipientReview=1" : ""/u);
  assert.match(shell, /onPointerOver=\{\(event\) => warmFor\(event\.target, event\.pointerType === "mouse" \? WARM_HOVER_DELAY_MS : 0\)\}/u);
  assert.match(shell, /onFocus=\{\(event\) => warmFor\(event\.target, 0\)\}/u);
  assert.match(shell, /onTouchStart=\{\(event\) => warmFor\(event\.target, 0\)\}/u);
  assert.match(shell, /onPointerOut=\{cancelWarm\}/u);
});
