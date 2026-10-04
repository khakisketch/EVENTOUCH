const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/desks.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function formBox(values, actions) {
  const handlers = {};
  const fields = {};
  const buttons = {};
  Object.keys(values).forEach((attr) => {
    fields[attr] = {
      value: values[attr], focused: false,
      focus() { this.focused = true; },
    };
  });
  (actions || []).forEach((action) => {
    buttons[action.attr] = {
      tagName: 'BUTTON',
      getAttribute(name) { return name === action.attr ? action.value || '' : ''; },
      addEventListener(type, handler) { if (type === 'click') handlers[action.key] = handler; },
    };
  });
  return {
    handlers, fields, innerHTML: '',
    querySelector(selector) {
      const match = /^\[([^\]=]+)(?:="([^"]+)")?\]$/.exec(selector);
      if (!match) return null;
      const key = match[2] ? match[1] + '="' + match[2] + '"' : match[1];
      return fields[key] || null;
    },
    querySelectorAll(selector) {
      const match = /^\[([^\]]+)\]$/.exec(selector);
      if (!match) return [];
      const attr = match[1].split('=')[0];
      return actions.filter((action) => action.attr === attr).map((action) => buttons[action.attr]);
    },
  };
}

test('desk section lists units with add and select', () => {
  const ETKO = fresh();
  ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  const box = { innerHTML: '' };
  ETKO.renderDesks(box);
  assert.match(box.innerHTML, /A게이트/);
  assert.match(box.innerHTML, /data-unit-add/);
  assert.match(box.innerHTML, /data-unit-select/);
});

test('desk name, direction, and correction reason have persistent visible labels', () => {
  const ETKO = fresh();
  const person = ETKO.workspace().participants.find((item) => item.status !== 'IN');
  const unit = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(unit.id);
  ETKO.submitTicket(person.code, 'IN');
  const box = { innerHTML: '' };
  ETKO.renderDesks(box);
  assert.match(box.innerHTML, /<label>데스크 이름<input data-unit-name/);
  assert.match(box.innerHTML, /<label>입장·퇴장 구분<select data-unit-action/);
  assert.match(box.innerHTML, /<label>정정 사유 \(5~200자\)<input data-correct-reason=/);
});

test('invalid desk name stays local and preserves the selected direction', () => {
  const ETKO = fresh();
  const box = formBox({
    'data-unit-name': '',
    'data-unit-action': 'OUT',
  }, [{ attr: 'data-unit-add', key: 'add' }]);
  ETKO.renderDesks(box);
  box.handlers.add();
  assert.equal(ETKO.workspace().units.length, 0);
  assert.match(box.innerHTML, /data-unit-name[^>]*aria-invalid="true"/);
  assert.match(box.innerHTML, /id="unit-name-error"[^>]*>데스크 이름을 입력하세요/);
  assert.match(box.innerHTML, /<option value="OUT" selected>퇴장<\/option>/);
  assert.equal(box.fields['data-unit-name'].focused, true);
});

test('short correction reason stays in its row and receives focus', () => {
  const ETKO = fresh();
  const person = ETKO.workspace().participants.find((item) => item.status !== 'IN');
  const unit = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(unit.id);
  ETKO.submitTicket(person.code, 'IN');
  const log = ETKO.history()[0];
  const reasonAttr = 'data-correct-reason="' + log.id + '"';
  const box = formBox({
    'data-unit-name': 'A게이트',
    'data-unit-action': 'IN',
    [reasonAttr]: '짧음',
  }, [{ attr: 'data-correct-log', value: log.id, key: 'correct' }]);
  ETKO.renderDesks(box);
  box.handlers.correct();
  assert.equal(ETKO.history()[0].action, 'IN', 'rejected correction must not create a new record');
  assert.match(box.innerHTML, new RegExp('data-correct-reason="' + log.id + '"[^>]*aria-invalid="true"'));
  assert.match(box.innerHTML, /정정 사유는 5자 이상 200자 이하로 입력하세요/);
  assert.match(box.innerHTML, /value="짧음"/);
  assert.equal(box.fields[reasonAttr].focused, true);
});

test('active unit selection validates existence', () => {
  const ETKO = fresh();
  assert.throws(() => ETKO.setActiveUnit('u-999'), /데스크를 찾을 수 없습니다/);
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  assert.equal(ETKO.setActiveUnit(u.id), u.id);
  assert.equal(ETKO.activeUnitId, u.id);
});

test('ticket submit prefers the active unit record', () => {
  const ETKO = fresh();
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(u.id);
  const r = ETKO.submitTicket(p.code, 'IN');
  assert.equal(r.key, 'success');
  assert.equal(ETKO.history().length, 1);
  assert.equal(ETKO.history()[0].unitId, u.id);
});

test('wrong-direction unit names the desk instead of claiming no record', () => {
  const ETKO = fresh();
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  const u = ETKO.saveUnit({ name: '퇴장게이트', action: 'OUT', mode: 'desk' });
  ETKO.setActiveUnit(u.id);
  const r = ETKO.submitTicket(p.code, 'IN');
  assert.equal(r.key, 'wrong-desk');
  assert.equal(r.unitName, '퇴장게이트');
  assert.match(ETKO.checkinMessage(r.key).title, /데스크/);
});

test('offline intake queues even with an active unit; deleted unit falls back to scan', () => {
  const ETKO = fresh();
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(u.id);
  ETKO.setOnline(false);
  const queued = ETKO.submitTicket(p.code, 'IN');
  assert.equal(queued.key, 'queued');
  ETKO.setOnline(true);
  ETKO.syncQueue();
  assert.equal(ETKO.workspace().participants.find((x) => x.id === p.id).status, 'IN');
  ETKO.workspace().units = [];
  const fallback = ETKO.submitTicket(p.code, 'OUT');
  assert.equal(fallback.key, 'success');
  assert.equal(ETKO.history().length, 0);
});

test('event switch clears the active unit', () => {
  const ETKO = fresh();
  const u = ETKO.saveUnit({ name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.setActiveUnit(u.id);
  const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  assert.equal(ETKO.activeUnitId, null);
});

test('permission denial surfaces its own result, not not-found', () => {
  const ETKO = fresh();
  ETKO.setRole('VIEWER');
  const p = ETKO.workspace().participants[0];
  const ws = ETKO.workspace();
  ws.units.push({ id: 'u9', name: 'A게이트', action: 'IN', mode: 'desk' });
  ETKO.activeUnitId = 'u9';
  const r = ETKO.submitTicket(p.code, 'IN');
  assert.equal(r.key, 'no-permission');
  assert.match(ETKO.checkinMessage(r.key).title, /권한/);
  ETKO.setRole('AGENCY');
});
