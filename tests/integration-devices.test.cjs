const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/booths.js', '../features/integrations.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('booth QR payloads round-trip strictly', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 1, status: 'OPEN' });
  const booth = ETKO.workspace().booths[0];
  const payload = ETKO.boothPayload('evt-1', booth.id);
  assert.deepEqual(ETKO.parseBoothPayload(payload), { eventId: 'evt-1', boothId: booth.id });
  assert.throws(() => ETKO.parseBoothPayload('ET:BOOTH:evt-1'), /부스 QR/);
  assert.throws(() => ETKO.parseBoothPayload('HANDWRITTEN'), /부스 QR/);
});

test('device capabilities are simulated with Korean labels; print confirms known booths', () => {
  const ETKO = fresh();
  const caps = ETKO.deviceCaps();
  assert.equal(caps.simulated, true);
  assert.equal(ETKO.deviceLabel('camera'), '카메라');
  ETKO.saveBooth({ name: '인쇄부스', capacity: 10, limit: 1, status: 'OPEN' });
  const booth = ETKO.workspace().booths[0];
  const rec = ETKO.markPrinted(booth.id, 'A4');
  assert.equal(rec.boothId, booth.id);
  assert.throws(() => ETKO.markPrinted('b-999'), /부스를 확인/);
});
