'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');

function moduleAt(file, extra = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  // These tests isolate the read coordinator. The organization adapter is
  // executed separately by the organizations-transport suite; stub only that
  // boundary here so coordinator counts do not include identity validation.
  const context = vm.createContext({ exports, Response, AbortController, Map, Set, Date,
    require(name) {
      if (name !== './operator-context') throw new Error(`unexpected import ${name}`);
      return {
        operatorFetch: (input, init) => extra.fetch(input, init),
        subscribeOperatorContext: () => () => {},
        getOperatorContextSnapshot: () => ({ context: null, changed: false }),
        isOrganizationContextBlock: () => false,
      };
    }, ...extra });
  vm.runInContext(source, context);
  return exports;
}

const attention = moduleAt('apps/web/lib/message-attention.ts');
test('manual due reservations are attention work, never future or malformed dates', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  assert.equal(attention.isOverdueManualMessage({ status: 'SCHEDULED', scheduled: '2026-10-24T11:00:00Z' }, now), true);
  assert.equal(attention.isOverdueManualMessage({ status: 'SCHEDULED', scheduled: '2026-10-25T11:00:00Z' }, now), false);
  assert.equal(attention.isOverdueManualMessage({ status: 'SCHEDULED', scheduled: 'invalid' }, now), false);
  assert.equal(attention.isOverdueManualMessage({ status: 'SIMULATED', scheduled: '2026-10-24T11:00:00Z' }, now), false);
  assert.equal(attention.messageNeedsAttention({ status: 'NEEDS_CONNECTION' }, now), true);
});

test('same-tab concurrent reads share transport but each gets an independently consumable body', async () => {
  let calls = 0, resolve;
  const api = moduleAt('apps/web/lib/console-api.ts', {
    window: { setTimeout, clearTimeout },
    fetch: () => { calls += 1; return new Promise((done) => { resolve = done; }); },
  });
  const first = api.consoleFetch('/api/console/directory');
  const second = api.consoleFetch('/api/console/directory');
  assert.equal(calls, 1);
  resolve(Response.json({ directory: { version: 1 } }));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(await a.json(), await b.json());
});

test('writes invalidate even uncertain outcomes and are never automatically replayed', async () => {
  let calls = 0;
  const api = moduleAt('apps/web/lib/console-api.ts', {
    window: { setTimeout, clearTimeout },
    fetch: async () => { calls += 1; throw new Error('response lost'); },
  });
  await assert.rejects(api.consoleFetch('/api/events/test/commands', { method: 'POST' }), /response lost/);
  assert.equal(calls, 1);
});

test('a read started before a write cannot restore an older snapshot', async () => {
  let reads = 0, releaseOld;
  const api = moduleAt('apps/web/lib/console-api.ts', {
    window: { setTimeout, clearTimeout },
    fetch: async (url, init) => {
      if (init?.method === 'POST') return Response.json({ ok: true });
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { releaseOld = resolve; });
      return Response.json({ revision: 'after-write' });
    },
  });
  const pending = api.consoleFetch('/api/bootstrap');
  await api.consoleFetch('/api/events/test/commands', { method: 'POST' });
  releaseOld(Response.json({ revision: 'before-write' }));
  assert.deepEqual(await (await pending).json(), { revision: 'after-write' });
  assert.equal(reads, 2);
});
