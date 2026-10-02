const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/persist.js', '../features/qrcode.js', '../features/registration.js', '../features/checkin.js', '../features/desks.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  delete globalThis.ETQR;
  delete globalThis.jsQR;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function rasterize(svg, scale) {
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]);
  const dark = new Set();
  const re = /M(\d+) (\d+)h1v1h-1z/g;
  let m;
  while ((m = re.exec(svg))) dark.add(Number(m[1]) + ',' + Number(m[2]));
  const W = size * scale;
  const data = new Uint8ClampedArray(W * size * scale * 4);
  for (let y = 0; y < size * scale; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = dark.has(Math.floor(x / scale) + ',' + Math.floor(y / scale)) ? 0 : 255;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: W, height: size * scale };
}

test('vendored decoder reads our encoder output', () => {
  fresh();
  const jsQR = require('../features/jsqr-decoder.js');
  const svg = globalThis.ETKO.qrSvg('EVT-1001');
  const { data, width, height } = rasterize(svg, 6);
  const out = jsQR(data, width, height);
  assert.ok(out && out.data === 'EVT-1001');
});

test('decodeQrPixels seam decodes, refuses blanks, needs a decoder', () => {
  const ETKO = fresh();
  globalThis.jsQR = () => ({ data: 'EVT-1002' });
  assert.equal(ETKO.decodeQrPixels(new Uint8ClampedArray(16), 2, 2), 'EVT-1002');
  globalThis.jsQR = () => null;
  assert.throws(() => ETKO.decodeQrPixels(new Uint8ClampedArray(16), 2, 2), /읽지 못했습니다/);
  delete globalThis.jsQR;
  assert.throws(() => ETKO.decodeQrPixels(new Uint8ClampedArray(16), 2, 2), /판독기/);
});

test('checkin mount offers QR photo intake when readable', () => {
  const ETKO = fresh();
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.renderCheckin(box);
  if (typeof FileReader === 'undefined') {
    assert.doesNotMatch(box.innerHTML, /data-qr-file/);
  } else {
    assert.match(box.innerHTML, /data-qr-file/);
  }
});

test('QR photo pipeline decodes and submits the ticket', async () => {
  const ETKO = fresh();
  const person = ETKO.registerSelf({ name: '스캔참가', phone: '010-0000-1001' });
  globalThis.jsQR = () => ({ data: person.code });

  const pixels = new Uint8ClampedArray([0, 0, 0, 255]);
  globalThis.FileReader = function () {};
  globalThis.FileReader.prototype.readAsDataURL = function () {
    this.result = 'data:image/png;base64,iVBORw0KGgo=';
    if (this.onload) this.onload();
  };
  const fakeCtx = { drawImage() {}, getImageData: () => ({ data: pixels, width: 1, height: 1 }) };
  const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
  globalThis.Image = function () {
    this.width = 1;
    this.height = 1;
  };
  const origCreate = typeof document !== 'undefined' && document.createElement;
  globalThis.document = { createElement: () => fakeCanvas };
  Object.defineProperty(globalThis.Image, 'prototype', { value: {} });

  const file = { name: 'qr.png' };
  let loadedSrc = '';
  Object.defineProperty(globalThis.Image.prototype, 'src', {
    configurable: true,
    set(v) { loadedSrc = v; if (this.onload) this.onload(); },
    get() { return loadedSrc; },
  });

  try {
    const code = await ETKO.decodeQrFile(file);
    assert.equal(code, person.code);
    const result = ETKO.submitTicket(code, 'IN');
    assert.equal(result.kind, 'good');
    assert.equal(ETKO.workspace().participants.find((p) => p.id === person.id).status, 'IN');
  } finally {
    delete globalThis.FileReader;
    delete globalThis.Image;
    delete globalThis.document;
    delete globalThis.jsQR;
  }
  assert.ok(origCreate === false || true);
});
