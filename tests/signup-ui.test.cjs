const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/registration.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function signupBox(values) {
  const handlers = {};
  const fields = {};
  Object.keys(values).forEach((attr) => {
    fields[attr] = { value: values[attr], focused: false, focus() { this.focused = true; } };
  });
  const button = { addEventListener(type, fn) { if (type === 'click') handlers.submit = fn; } };
  return {
    handlers, fields, innerHTML: '',
    querySelector(selector) {
      const match = /^\[([^\]]+)\]$/.exec(selector);
      return match ? fields[match[1]] || null : null;
    },
    querySelectorAll(selector) { return selector === '[data-signup-submit]' ? [button] : []; },
  };
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

test('signup field labels wrap controls and phone/email use semantic types', () => {
  const ETKO = fresh();
  ETKO.setFields([
    { id: 'name', label: '이름', type: 'text', required: true },
    { id: 'phone', label: '연락처', type: 'text', required: true },
    { id: 'email', label: '이메일', type: 'email', required: false },
  ]);
  const box = { innerHTML: '' };
  ETKO.renderSignup(box);
  assert.match(box.innerHTML, /<label>연락처 <span>필수<\/span><input data-signup-phone type="tel"/);
  assert.match(box.innerHTML, /<label>이메일<input data-signup-email type="email"/);
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
  assert.match(box.innerHTML, /체크인 QR 코드/);
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
  assert.match(ETKO.lastSignupError, /이름/);
});

test('invalid signup marks the exact field, restores focus, and preserves entered values', () => {
  const ETKO = fresh();
  const box = signupBox({
    'data-signup-name': '',
    'data-signup-phone': '010-0000-0033',
    'data-signup-company': '샘플 회사',
    'data-signup-email': 'person@example.kr',
  });
  const before = ETKO.workspace().participants.length;
  ETKO.renderSignup(box);
  box.handlers.submit();
  assert.match(box.innerHTML, /data-signup-name[^>]*aria-invalid="true"/);
  assert.match(box.innerHTML, /id="signup-name-error"[^>]*>이름 항목을 입력하세요/);
  assert.match(box.innerHTML, /value="010-0000-0033"/);
  assert.match(box.innerHTML, /value="샘플 회사"/);
  assert.match(box.innerHTML, /value="person@example.kr"/);
  assert.equal(box.fields['data-signup-name'].focused, true);
  assert.equal(ETKO.workspace().participants.length, before, 'invalid signup must not be saved');
});
