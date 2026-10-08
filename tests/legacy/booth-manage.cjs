const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/persist.js', '../features/qrcode.js', '../features/booth.js', '../features/booths.js', '../features/integrations.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  delete globalThis.ETQR;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function manageBox(ETKO, fields, handlers) {
  const box = {
    innerHTML: '',
    querySelectorAll(sel) {
      const map = {
        '[data-booth-add]': 'add',
        '[data-booth-status]': 'status',
        '[data-booth-print]': 'print',
      };
      const key = Object.keys(map).find((k) => sel === k || sel.indexOf(k) === 0);
      if (!key) return [];
      const btn = {
        tagName: 'BUTTON',
        getAttribute(attr) { return btn.attrs[attr]; },
        attrs: { 'data-booth-status': 'b1:OPEN', 'data-booth-print': 'b1' },
        addEventListener(t, fn) { handlers[map[key]] = fn; },
      };
      return [btn];
    },
    querySelector(sel) {
      if (/data-booth-name/.test(sel)) return { value: fields.name };
      if (/data-booth-capacity/.test(sel)) return { value: fields.capacity };
      if (/data-booth-limit/.test(sel)) return { value: fields.limit };
      if (/data-booth-status-select/.test(sel)) return { value: fields.status };
      return null;
    },
  };
  ETKO.renderBoothManage(box);
  return box;
}

function invalidManageBox(ETKO, values) {
  const handlers = {};
  const fields = {};
  Object.keys(values).forEach((attr) => {
    fields[attr] = { value: values[attr], focused: false, focus() { this.focused = true; } };
  });
  const button = { addEventListener(type, fn) { if (type === 'click') handlers.add = fn; } };
  const box = {
    handlers, fields, innerHTML: '',
    querySelector(selector) {
      const match = /^\[([^\]]+)\]$/.exec(selector);
      return match ? fields[match[1]] || null : null;
    },
    querySelectorAll(selector) { return selector === '[data-booth-add]' ? [button] : []; },
  };
  ETKO.renderBoothManage(box);
  return box;
}

test('manage lists booth payload, QR, and remaining counts', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '관리부스', capacity: 10, limit: 2, status: 'OPEN' });
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.renderBoothManage(box);
  assert.match(box.innerHTML, /관리부스/);
  assert.match(box.innerHTML, /ET:BOOTH:evt-1:b1/);
  assert.match(box.innerHTML, /<svg[^>]*viewBox/);
  assert.match(box.innerHTML, /남은 10개/);
  assert.match(box.innerHTML, /data-booth-add/);
});

test('booth quantities use labeled integer number inputs', () => {
  const ETKO = fresh();
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.renderBoothManage(box);
  assert.match(box.innerHTML, /<label>수량<input data-booth-capacity type="number" min="1" step="1"/);
  assert.match(box.innerHTML, /<label>1인 횟수<input data-booth-limit type="number" min="1" step="1"/);
});

test('invalid booth capacity stays in its field and receives focused inline error', () => {
  const ETKO = fresh();
  const box = invalidManageBox(ETKO, {
    'data-booth-name': '체험 부스',
    'data-booth-capacity': '',
    'data-booth-limit': '2',
    'data-booth-status-select': 'OPEN',
  });
  box.handlers.add();
  assert.equal(ETKO.workspace().booths.length, 0);
  assert.match(box.innerHTML, /data-booth-capacity[^>]*aria-invalid="true"/);
  assert.match(box.innerHTML, /id="booth-capacity-error"[^>]*>부스 수량을 확인하세요/);
  assert.match(box.innerHTML, /value="체험 부스"/);
  assert.match(box.innerHTML, /value="2"/);
  assert.equal(box.fields['data-booth-capacity'].focused, true);
});

test('manage add creates a booth, bad input alerts in Korean', () => {
  const ETKO = fresh();
  const handlers = {};
  manageBox(ETKO, { name: '새부스', capacity: '5', limit: '1', status: 'OPEN' }, handlers);
  assert.ok(handlers.add, 'add must wire');
  handlers.add();
  assert.equal(ETKO.workspace().booths.length, 1);
  assert.equal(ETKO.workspace().booths[0].name, '새부스');

  const badHandlers = {};
  manageBox(ETKO, { name: '', capacity: '5', limit: '1', status: 'OPEN' }, badHandlers);
  badHandlers.add();
  assert.equal(ETKO.workspace().booths.length, 1);
  assert.match(ETKO.lastBoothError, /부스 이름/);
});

test('manage status change applies, print confirm records', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '상태부스', capacity: 10, limit: 2, status: 'OPEN' });
  const handlers = {};
  const box = manageBox(ETKO, { name: 'x', capacity: '1', limit: '1', status: 'OPEN' }, handlers);
  box.querySelectorAll = (sel) => {
    if (sel !== '[data-booth-status]') return [];
    return [{ tagName: 'BUTTON', getAttribute: (a) => (a === 'data-booth-status' ? 'b1:CLOSED' : ''), addEventListener: (t, fn) => { handlers.status = fn; } }];
  };
  ETKO.renderBoothManage(box);
  handlers.status();
  assert.equal(ETKO.workspace().booths[0].status, 'CLOSED');

  const pHandlers = {};
  const box2 = manageBox(ETKO, { name: 'x', capacity: '1', limit: '1', status: 'OPEN' }, pHandlers);
  box2.querySelectorAll = (sel) => {
    if (sel !== '[data-booth-print]') return [];
    return [{ tagName: 'BUTTON', getAttribute: (a) => (a === 'data-booth-print' ? 'b1' : ''), addEventListener: (t, fn) => { pHandlers.print = fn; } }];
  };
  ETKO.renderBoothManage(box2);
  pHandlers.print();
  assert.ok(ETKO.workspace().prints.some((p) => p.boothId === 'b1'));
});

test('read-only roles see the list without controls', () => {
  const ETKO = fresh();
  ETKO.saveBooth({ name: '공개부스', capacity: 10, limit: 2, status: 'OPEN' });
  ETKO.setRole('VIEWER');
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.renderBoothManage(box);
  assert.match(box.innerHTML, /공개부스/);
  assert.match(box.innerHTML, /ET:BOOTH/);
  assert.doesNotMatch(box.innerHTML, /data-booth-add/);
  assert.doesNotMatch(box.innerHTML, /data-booth-status/);
});

test('manage notes the mode lock once visits exist', () => {
  const ETKO = fresh();
  const booth = ETKO.saveBooth({ name: '잠금부스', capacity: 10, limit: 2, status: 'OPEN' });
  const ws = ETKO.workspace();
  ws.participants.push({ id: 'p1', name: '참가', phone: '010', cancelled: false });
  ETKO.stamp({ boothId: booth.id, participantId: 'p1' });
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.renderBoothManage(box);
  assert.match(box.innerHTML, /변경할 수 없습니다/);
});

test('booth view makes current self-scan and staff-scan modes explicit', () => {
  const ETKO = fresh();
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  ETKO.boothMode = 'SELF';
  ETKO.renderBooth(box);
  assert.match(box.innerHTML, /data-booth-mode-current="SELF"/);
  assert.match(box.innerHTML, /직접 스캔/);
  assert.match(box.innerHTML, /부스 QR을 스캔해주세요/);

  ETKO.boothMode = 'STAFF';
  ETKO.renderBooth(box);
  assert.match(box.innerHTML, /data-booth-mode-current="STAFF"/);
  assert.match(box.innerHTML, /직원 스캔/);
  assert.match(box.innerHTML, /티켓을 보여주세요/);
});
