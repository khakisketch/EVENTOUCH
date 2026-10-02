const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/persist.js', '../features/engagement.js', '../features/media.js', '../features/stage.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function fakeBus() {
  const handlers = [];
  return {
    posted: [],
    postMessage(msg) { this.posted.push(msg); },
    addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
    fire(data) { handlers.forEach((fn) => fn({ data })); },
  };
}

function memoryBackend() {
  let saved = null;
  return { get() { return saved; }, set(v) { saved = String(v); } };
}

test('announceScreen posts the program to the bus', () => {
  const ETKO = fresh();
  const bus = fakeBus();
  ETKO.screenBus = bus;
  ETKO.stageState = { preview: 'BLACK', program: 'BLACK', disclose: [true, true], confirm: [true, true] };
  assert.equal(ETKO.announceScreen(), true);
  assert.equal(bus.posted.length, 1);
  assert.equal(bus.posted[0].type, 'eventouch-screen');
  assert.equal(bus.posted[0].program, 'BLACK');
});

test('announceScreen is a silent no-op without a bus', () => {
  const ETKO = fresh();
  ETKO.screenBus = null;
  assert.equal(ETKO.announceScreen(), false);
});

test('take announces the new program', () => {
  const ETKO = fresh();
  const bus = fakeBus();
  ETKO.screenBus = bus;
  const state = { preview: 'HOLD', program: 'LOGO', disclose: [true, true], confirm: [true, true] };
  ETKO.stageState = state;
  assert.equal(ETKO.applyTake(state), true);
  assert.ok(bus.posted.some((m) => m.program === 'HOLD'));
});

test('screen listener re-renders from the saved snapshot on message', () => {
  const ETKO = fresh();
  const backend = memoryBackend();
  ETKO.storeBackend = backend;
  ETKO.stageState = { preview: 'BLACK', program: 'BLACK' };
  ETKO.touchStore();
  ETKO.stageState = { preview: 'LOGO', program: 'LOGO' };
  const bus = fakeBus();
  ETKO.screenBus = bus;
  const box = { innerHTML: '' };
  assert.equal(ETKO.listenScreen(box), true);
  bus.fire({ type: 'eventouch-screen', program: 'BLACK' });
  assert.match(box.innerHTML, /암전 중입니다/);
});

test('stage controls link to a dedicated audience display', () => {
  const ETKO = fresh();
  ETKO.screenBus = fakeBus();
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.renderStage(box, { preview: 'LOGO', program: 'LOGO', disclose: [false, false], confirm: [false, false] });
  assert.match(box.innerHTML, /\?view=screen/);
  assert.match(box.innerHTML, /관객 화면 열기/);
});
