const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/content.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function stubBox(values) {
  const handlers = {};
  return {
    handlers,
    innerHTML: '',
    querySelectorAll(sel) {
      const m = /^\[([^\]]+)\]$/.exec(sel);
      if (!m) return [];
      const attr = m[1];
      if (!(attr in values)) return [];
      return [{
        tagName: 'BUTTON',
        getAttribute(k) { return k === attr ? values[attr].id || '' : ''; },
        addEventListener(t, fn) { handlers[attr] = fn; },
      }];
    },
    querySelector(sel) {
      const m = /^\[([^\]]+)\]$/.exec(sel);
      if (!m) return null;
      const attr = m[1];
      if (!(attr in values)) return null;
      return { value: values[attr].value || '' };
    },
  };
}

function formBox(values, actions) {
  const handlers = {};
  const fields = {};
  const buttons = {};
  Object.keys(values).forEach((attr) => {
    fields[attr] = {
      tagName: 'INPUT', value: values[attr], focused: false,
      focus() { this.focused = true; },
    };
  });
  (actions || []).forEach((attr) => {
    buttons[attr] = {
      tagName: 'BUTTON',
      addEventListener(type, handler) { if (type === 'click') handlers[attr] = handler; },
    };
  });
  return {
    handlers, fields, buttons, innerHTML: '',
    querySelector(selector) {
      const match = /^\[([^\]]+)\]$/.exec(selector);
      return match ? fields[match[1]] || buttons[match[1]] || null : null;
    },
    querySelectorAll(selector) {
      const match = /^\[([^\]]+)\]$/.exec(selector);
      if (!match) return [];
      const item = fields[match[1]] || buttons[match[1]];
      return item ? [item] : [];
    },
  };
}

test('program add click saves, empty click surfaces Korean alert', () => {
  const ETKO = fresh();
  const box = stubBox({
    'data-program-title': { value: '개회식' },
    'data-program-time': { value: '09:00' },
    'data-program-end': { value: '09:30' },
    'data-program-location': { value: 'A홀' },
    'data-program-add': {},
  });
  ETKO.renderContent(box);
  box.handlers['data-program-add']();
  assert.equal(ETKO.workspace().program.length, 1);
  const bad = stubBox({
    'data-program-title': { value: '' },
    'data-program-time': { value: '09:00' },
    'data-program-end': { value: '09:30' },
    'data-program-location': { value: 'A홀' },
    'data-program-add': {},
  });
  ETKO.renderContent(bad);
  bad.handlers['data-program-add']();
  assert.match(ETKO.lastContentError, /프로그램명/);
  assert.match(bad.innerHTML, /role="alert"/);
});

test('content mount renders program list with add and delete', () => {
  const ETKO = fresh();
  ETKO.saveProgram({ title: '개회식', time: '09:00', end: '09:30', location: 'A홀' });
  const box = { innerHTML: '' };
  ETKO.renderContent(box);
  assert.match(box.innerHTML, /개회식/);
  assert.match(box.innerHTML, /09:00/);
  assert.match(box.innerHTML, /data-program-add/);
  assert.match(box.innerHTML, /data-program-del/);
});

test('content mount renders notice, venue and board sections', () => {
  const ETKO = fresh();
  ETKO.saveNotice({ title: '입장 안내', body: '9시까지 입장하세요' });
  ETKO.saveVenue({ name: '리버사이드 홀', address: '서울', description: '1층' });
  const box = { innerHTML: '' };
  ETKO.renderContent(box);
  assert.match(box.innerHTML, /입장 안내/);
  assert.match(box.innerHTML, /리버사이드 홀/);
  assert.match(box.innerHTML, /data-notice-add/);
  assert.match(box.innerHTML, /data-venue-save/);
  assert.match(box.innerHTML, /게시판/);
});

test('content forms keep labels visible and use time and multiline controls', () => {
  const ETKO = fresh();
  const box = { innerHTML: '' };
  ETKO.renderContent(box);
  assert.match(box.innerHTML, /<label>시작 시간<input data-program-time type="time"/);
  assert.match(box.innerHTML, /<label>종료 시간<input data-program-end type="time"/);
  assert.match(box.innerHTML, /<label>세션명<input data-program-title/);
  assert.match(box.innerHTML, /<label>공지 내용<textarea data-notice-body/);
});

test('invalid program shows a field error, restores focus, and preserves entered values', () => {
  const ETKO = fresh();
  const box = formBox({
    'data-program-title': '개회식',
    'data-program-time': '11:00',
    'data-program-end': '10:00',
    'data-program-location': 'A홀',
  }, ['data-program-add']);
  ETKO.renderContent(box);
  box.handlers['data-program-add']();
  assert.equal(ETKO.workspace().program.length, 0);
  assert.match(box.innerHTML, /data-program-end[^>]*aria-invalid="true"/);
  assert.match(box.innerHTML, /id="program-end-error"[^>]*>종료는 시작보다 늦은 당일 시간이어야 합니다/);
  assert.match(box.innerHTML, /value="개회식"/);
  assert.match(box.innerHTML, /value="11:00"/);
  assert.match(box.innerHTML, /value="10:00"/);
  assert.match(box.innerHTML, /value="A홀"/);
  assert.equal(box.fields['data-program-end'].focused, true);
});

test('invalid notice body remains in its multiline field and receives focus', () => {
  const ETKO = fresh();
  const box = formBox({
    'data-notice-title': '입장 안내',
    'data-notice-body': '',
  }, ['data-notice-add']);
  ETKO.renderContent(box);
  box.handlers['data-notice-add']();
  assert.equal(ETKO.workspace().notices.length, 0);
  assert.match(box.innerHTML, /data-notice-body[^>]*aria-invalid="true"/);
  assert.match(box.innerHTML, /id="notice-body-error"[^>]*>내용을 입력하세요/);
  assert.match(box.innerHTML, /value="입장 안내"/);
  assert.equal(box.fields['data-notice-body'].focused, true);
});
