'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/display-refresh.js'), 'utf8');

function load({ scope = 'display', hidden = false, preview = false, session = true, storageMode = 'server' } = {}) {
  let tick, delay, refreshes = 0, renders = 0;
  const E = {
    route: { scope }, previewMode: preview, storageMode,
    session: session ? { id: 'staff-session' } : null,
    remote: { status: 'connected', async bootstrap() { refreshes += 1; } },
    render() { renders += 1; },
  };
  vm.runInNewContext(source, {
    window: { ET: E, setInterval(fn, ms) { tick = fn; delay = ms; } },
    document: { visibilityState: hidden ? 'hidden' : 'visible' },
  });
  return { E, tick: () => tick(), delay, counts: () => ({ refreshes, renders }) };
}

test('screen output refreshes its existing authenticated bootstrap every five seconds', async () => {
  const app = load();
  assert.equal(app.delay, 5000);
  await app.tick();
  assert.deepEqual(app.counts(), { refreshes: 1, renders: 1 });
});

test('screen refresh pauses for hidden, preview, unauthenticated, and non-screen routes', async () => {
  for (const options of [
    { hidden: true }, { preview: true }, { session: false }, { scope: 'attendee' }, { storageMode: 'local' },
  ]) {
    const app = load(options);
    await app.tick();
    assert.deepEqual(app.counts(), { refreshes: 0, renders: 0 });
  }
});

test('screen refresh retains the previous rendered state when the network request fails', async () => {
  const app = load();
  app.E.remote.bootstrap = async () => { app.E.remote.status = 'offline'; throw new Error('offline'); };
  await app.tick();
  assert.deepEqual(app.counts(), { refreshes: 0, renders: 0 });
  assert.equal(app.E.remote.status, 'offline');
});
