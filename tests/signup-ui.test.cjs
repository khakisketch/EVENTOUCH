const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/registration.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('signup mount renders form fields with required marks and submit', () => {
  const ETKO = fresh();
  ETKO.setFields([
    { id: 'name', label: '이름', type: 'text', required: true },
    { id: 'phone', label: '연락처', type: 'text', required: true },
    { id: 'meal', label: '식단', type: 'select', required: false, options: ['일반', '비건'] },
  ]);
  const box = { innerHTML: '' };
  ETKO.renderSignup(box);
  assert.match(box.innerHTML, /이름/);
  assert.match(box.innerHTML, /필수/);
  assert.match(box.innerHTML, /비건/);
  assert.match(box.innerHTML, /data-signup-submit/);
});

test('signup submit registers and shows ticket, invalid shows field-named alert', () => {
  const ETKO = fresh();
  const handlers = {};
  const box = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel !== '[data-signup-submit]') return [];
      return [{ tagName: 'BUTTON', getAttribute() { return ''; }, addEventListener(t, fn) { handlers.submit = fn; } }];
    },
    querySelector(sel) {
      const values = { '[data-signup-name]': '신규참가', '[data-signup-phone]': '010-0000-0099' };
      if (sel in values) return { value: values[sel] };
      return null;
    },
  };
  ETKO.renderSignup(box);
  assert.ok(handlers.submit, 'submit must wire');
  handlers.submit();
  assert.match(box.innerHTML, /등록 완료/);
  assert.match(box.innerHTML, /티켓 코드/);
  const bad = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel !== '[data-signup-submit]') return [];
      return [{ tagName: 'BUTTON', getAttribute() { return ''; }, addEventListener(t, fn) { bad.fn = fn; } }];
    },
    querySelector() { return { value: '' }; },
  };
  ETKO.renderSignup(bad);
  bad.fn();
  assert.match(bad.innerHTML, /role="alert"/);
});
