const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/booth.js', '../features/booths.js', '../features/integrations.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('resolveBoothQr round-trips the booth payload of the active event', () => {
  const ETKO = fresh();
  const booth = ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 2, status: 'OPEN' });
  const payload = ETKO.boothPayload(ETKO.store.activeEventId, booth.id);
  assert.equal(ETKO.resolveBoothQr(payload).id, booth.id);
});

test('resolveBoothQr rejects bad format, other events, and unknown booths in Korean', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 2, status: 'OPEN' });
  assert.throws(() => ETKO.resolveBoothQr('HANDWRITTEN'), /부스 QR을 확인하세요/);
  assert.throws(() => ETKO.resolveBoothQr('ET:BOOTH:evt-1'), /부스 QR을 확인하세요/);
  assert.throws(() => ETKO.resolveBoothQr('ET:BOOTH:evt-other:b1'), /다른 행사/);
  assert.throws(() => ETKO.resolveBoothQr('ET:BOOTH:' + ETKO.store.activeEventId + ':b999'), /부스를 찾을 수 없습니다/);
});

test('stamp mount exposes a QR input alongside the booth select', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 2, status: 'OPEN' });
  const box = { innerHTML: '' };
  ETKO.renderStamps(box, 'p1');
  assert.match(box.innerHTML, /data-stamp-qr/);
  assert.match(box.innerHTML, /data-stamp-booth/);
});

test('QR input receive records a visit for the scanned booth', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: 'A부스', capacity: 10, limit: 2, status: 'OPEN' });
  ETKO.saveBooth({ name: 'B부스', capacity: 10, limit: 2, status: 'OPEN' });
  const ws = ETKO.workspace();
  const target = ws.booths[1];
  const payload = ETKO.boothPayload(ETKO.store.activeEventId, target.id);
  const handlers = {};
  const box = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel !== '[data-stamp-receive]') return [];
      return [{ tagName: 'BUTTON', getAttribute() { return ''; }, addEventListener(t, fn) { handlers.receive = fn; } }];
    },
    querySelector(sel) {
      if (/data-stamp-qr/.test(sel)) return { value: payload };
      if (/data-stamp-booth/.test(sel)) return { value: ws.booths[0].id };
      return null;
    },
  };
  ETKO.renderStamps(box, 'p1');
  assert.ok(handlers.receive, 'receive must wire');
  handlers.receive();
  assert.equal(ws.visits.length, 1);
  assert.equal(ws.visits[0].boothId, target.id);
  assert.match(box.innerHTML, /스탬프를 받았습니다/);
});

test('QR input with a bad code surfaces a Korean alert and records nothing', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 2, status: 'OPEN' });
  const box = {
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector(sel) {
      if (/data-stamp-qr/.test(sel)) return { value: 'HANDWRITTEN' };
      if (/data-stamp-booth/.test(sel)) return { value: '' };
      return null;
    },
  };
  const handlers = {};
  box.querySelectorAll = (sel) => {
    if (sel !== '[data-stamp-receive]') return [];
    return [{ tagName: 'BUTTON', getAttribute() { return ''; }, addEventListener(t, fn) { handlers.receive = fn; } }];
  };
  ETKO.renderStamps(box, 'p1');
  handlers.receive();
  assert.equal(ETKO.workspace().visits.length, 0);
  assert.match(ETKO.lastStampError, /부스 QR/);
});
