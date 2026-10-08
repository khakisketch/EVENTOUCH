const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/persist.js', '../features/qrcode.js', '../features/checkin.js', '../features/desks.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  delete globalThis.ETQR;
  delete globalThis.jsQR;
  delete globalThis.navigator;
  delete globalThis.BarcodeDetector;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function stubCamera(detectFn) {
  const stopped = [];
  const stream = { getTracks: () => [{ stop: () => stopped.push(true) }] };
  globalThis.navigator = { mediaDevices: { getUserMedia: async () => stream } };
  globalThis.BarcodeDetector = function () {};
  globalThis.BarcodeDetector.prototype.detect = detectFn;
  return stopped;
}

test('camera intake stays hidden without camera hardware', () => {
  const ETKO = fresh();
  assert.equal(ETKO.cameraSupported(), false);
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.renderCheckin(box);
  assert.doesNotMatch(box.innerHTML, /data-camera-scan/);
});

test('camera button appears when capture and detection exist', () => {
  const ETKO = fresh();
  stubCamera(async () => [{ rawValue: 'EVT-1001' }]);
  try {
    assert.equal(ETKO.cameraSupported(), true);
    const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
    ETKO.renderCheckin(box);
    assert.match(box.innerHTML, /data-camera-scan/);
  } finally {
    delete globalThis.navigator;
    delete globalThis.BarcodeDetector;
  }
});

test('single frame scan reads the native detector result', async () => {
  const ETKO = fresh();
  stubCamera(async () => [{ rawValue: 'EVT-1002' }]);
  try {
    const fakeVideo = { videoWidth: 640, videoHeight: 480 };
    assert.equal(await ETKO.scanCameraFrame(fakeVideo), 'EVT-1002');
  } finally {
    delete globalThis.navigator;
    delete globalThis.BarcodeDetector;
  }
});

test('frame scan falls back to the vendored decoder without BarcodeDetector', async () => {
  const ETKO = fresh();
  const stopped = stubCamera(null);
  delete globalThis.BarcodeDetector;
  globalThis.jsQR = () => ({ data: 'EVT-1003' });
  const pixels = new Uint8ClampedArray([0, 0, 0, 255]);
  const fakeCanvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels, width: 1, height: 1 }) }) };
  globalThis.document = { createElement: () => fakeCanvas };
  try {
    const fakeVideo = { videoWidth: 1, videoHeight: 1 };
    assert.equal(await ETKO.scanCameraFrame(fakeVideo), 'EVT-1003');
  } finally {
    delete globalThis.navigator;
    delete globalThis.document;
    delete globalThis.jsQR;
  }
  assert.ok(stopped !== null);
});

test('frame scan with no readable code throws a Korean error', async () => {
  const ETKO = fresh();
  stubCamera(async () => []);
  globalThis.document = { createElement: () => { throw new Error('no canvas'); } };
  try {
    await assert.rejects(ETKO.scanCameraFrame({ videoWidth: 1, videoHeight: 1 }), /읽지 못했습니다/);
  } finally {
    delete globalThis.navigator;
    delete globalThis.BarcodeDetector;
    delete globalThis.document;
  }
});

test('live scan dedupes repeats and releases the camera on stop', async () => {
  const ETKO = fresh();
  const stopped = stubCamera(async () => [{ rawValue: 'EVT-1004' }]);
  const seen = [];
  const fakeVideo = {};
  try {
    const handle = await ETKO.startCameraScan(fakeVideo, (code) => seen.push(code), { intervalMs: 10 });
    await new Promise((res) => setTimeout(res, 60));
    ETKO.stopCameraScan(handle);
    await new Promise((res) => setTimeout(res, 30));
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((c) => c === 'EVT-1004'));
    const firstBurst = seen.length;
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(seen.length, firstBurst);
    assert.ok(stopped.length >= 1);
  } finally {
    delete globalThis.navigator;
    delete globalThis.BarcodeDetector;
  }
});
