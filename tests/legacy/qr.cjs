const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  for (const m of ['../features/qrcode.js']) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  delete globalThis.ETQR;
  require('../features/qrcode.js');
  return globalThis.ETKO;
}

function darkSet(svg) {
  const set = new Set();
  const re = /M(\d+) (\d+)h1v1h-1z/g;
  let m;
  while ((m = re.exec(svg))) set.add((Number(m[1]) - 4) + ',' + (Number(m[2]) - 4));
  return set;
}

test('ticket payload encodes deterministically as a version-1 QR', () => {
  const ETKO = fresh();
  const a = ETKO.qrSvg('EVT-1001');
  const b = ETKO.qrSvg('EVT-1001');
  assert.equal(a, b);
  assert.match(a, /viewBox="0 0 29 29"/);
  assert.match(a, /role="img"/);
  assert.match(a, /<rect[^>]*fill="#fff"/);
});

test('finder pattern is a valid 7x7 position probe', () => {
  const ETKO = fresh();
  const dark = darkSet(ETKO.qrSvg('EVT-1001'));
  for (let r = 0; r <= 6; r += 1) {
    for (let c = 0; c <= 6; c += 1) {
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      assert.equal(dark.has(r + ',' + c), edge || core, 'finder (' + r + ',' + c + ')');
    }
  }
});

test('longer booth payloads grow the matrix version', () => {
  const ETKO = fresh();
  const small = ETKO.qrSvg('EVT-1001');
  const big = ETKO.qrSvg('ET:BOOTH:evt-1:booth-1234567890');
  const size = (svg) => Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]);
  assert.ok(size(big) > size(small));
});

test('non-ASCII and empty payloads throw Korean errors', () => {
  const ETKO = fresh();
  assert.throws(() => ETKO.qrSvg('김민준'), /영문·숫자·기호/);
  assert.throws(() => ETKO.qrSvg(''), /QR 내용/);
});
