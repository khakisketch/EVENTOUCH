const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/booths.js', '../features/integrations.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('stamp mount lists booths with status and my count', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 1, status: 'OPEN' });
  const box = { innerHTML: '' };
  ETKO.renderStamps(box, 'p1');
  assert.match(box.innerHTML, /체험부스/);
  assert.match(box.innerHTML, /운영 중/);
  assert.match(box.innerHTML, /내 스탬프 0개/);
  assert.match(box.innerHTML, /data-stamp-booth/);
  assert.match(box.innerHTML, /data-stamp-receive/);
});

test('stamp receive records visit, over-limit refuses in Korean', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 1, status: 'OPEN' });
  const booth = ETKO.workspace().booths[0];
  const handlers = {};
  const box = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel !== '[data-stamp-receive]') return [];
      return [{ tagName: 'BUTTON', getAttribute() { return ''; }, addEventListener(t, fn) { handlers.receive = fn; } }];
    },
    querySelector(sel) {
      if (/data-stamp-booth/.test(sel)) return { value: booth.id };
      return null;
    },
  };
  ETKO.renderStamps(box, 'p1');
  assert.ok(handlers.receive, 'receive must wire');
  handlers.receive();
  assert.equal(ETKO.workspace().visits.length, 1);
  ETKO.renderStamps(box, 'p1');
  box.handlers2 = null;
  const box2 = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel !== '[data-stamp-receive]') return [];
      return [{ tagName: 'BUTTON', getAttribute() { return ''; }, addEventListener(t, fn) { box2.fn = fn; } }];
    },
    querySelector(sel) {
      if (/data-stamp-booth/.test(sel)) return { value: booth.id };
      return null;
    },
  };
  ETKO.renderStamps(box2, 'p1');
  box2.fn();
  assert.match(ETKO.lastStampError, /1인당/);
  assert.match(box2.innerHTML, /role="alert"/);
});
