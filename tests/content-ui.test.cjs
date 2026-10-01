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
