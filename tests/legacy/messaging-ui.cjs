const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/messaging.js', '../features/integrations.js'];
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
      if (!m || !(m[1] in values)) return [];
      const attr = m[1];
      return [{
        tagName: 'BUTTON',
        getAttribute(k) { return k === attr ? values[attr].id || '' : ''; },
        addEventListener(t, fn) { handlers[attr] = fn; },
      }];
    },
    querySelector(sel) {
      const m = /^\[([^\]]+)\]$/.exec(sel);
      if (!m || !(m[1] in values)) return null;
      return { value: values[m[1]].value || '' };
    },
  };
}

function formBox(values, actions) {
  const handlers = {};
  const fields = {};
  const buttons = {};
  Object.keys(values).forEach((attr) => {
    fields[attr] = {
      tagName: attr.indexOf('content') !== -1 ? 'TEXTAREA' : 'INPUT',
      value: values[attr], focused: false,
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

test('messaging mount renders templates with save and delete', () => {
  const ETKO = fresh();
  ETKO.saveTemplate({ name: '입장안내', channel: 'SMS', content: '환영합니다' });
  const box = { innerHTML: '' };
  ETKO.renderMessaging(box);
  assert.match(box.innerHTML, /입장안내/);
  assert.match(box.innerHTML, /data-template-save/);
  assert.match(box.innerHTML, /data-template-del/);
});

test('messaging mount renders campaign compose, list with send, and outbox', () => {
  const ETKO = fresh();
  const c = ETKO.createCampaign({ title: '리마인드', channel: 'SMS', target: '전체', recipientIds: ['p1'], content: '내일 뵙겠습니다' });
  ETKO.sendCampaign(c.id);
  const box = { innerHTML: '' };
  ETKO.renderMessaging(box);
  assert.match(box.innerHTML, /리마인드/);
  assert.match(box.innerHTML, /data-campaign-save/);
  assert.match(box.innerHTML, /data-campaign-send/);
  assert.match(box.innerHTML, /발송함/);
  assert.match(box.innerHTML, /SIMULATION_ONLY/);
});

test('message forms keep labels visible and use multiline body controls', () => {
  const ETKO = fresh();
  const box = { innerHTML: '' };
  ETKO.renderMessaging(box);
  assert.match(box.innerHTML, /<label>템플릿 내용<textarea data-template-content/);
  assert.match(box.innerHTML, /<label>캠페인 메시지<textarea data-campaign-content/);
  assert.match(box.innerHTML, /<label>채널<select data-template-channel/);
  assert.match(box.innerHTML, /<label>발송 대상<select data-campaign-target/);
});

test('campaign send click appends one outbox entry per click (resend allowed)', () => {
  const ETKO = fresh();
  const c = ETKO.createCampaign({ title: '리마인드', channel: 'SMS', target: '전체', recipientIds: ['p1'], content: '내일 뵙겠습니다' });
  const box = stubBox({ 'data-campaign-send': { id: c.id } });
  ETKO.renderMessaging(box);
  box.handlers['data-campaign-send']();
  box.handlers['data-campaign-send']();
  assert.equal(ETKO.outbox().length, 2);
  assert.ok(ETKO.outbox().every((o) => o.delivery === 'SIMULATION_ONLY'));
});

test('template save click stores, empty click surfaces Korean alert', () => {
  const ETKO = fresh();
  const box = stubBox({
    'data-template-name': { value: '입장안내' },
    'data-template-content': { value: '환영합니다' },
    'data-template-channel': { value: 'SMS' },
    'data-template-save': {},
  });
  ETKO.renderMessaging(box);
  box.handlers['data-template-save']();
  assert.equal(ETKO.workspace().templates.length, 1);
  const bad = stubBox({
    'data-template-name': { value: '' },
    'data-template-content': { value: '환영합니다' },
    'data-template-save': {},
  });
  ETKO.renderMessaging(bad);
  bad.handlers['data-template-save']();
  assert.match(ETKO.lastMessagingError, /템플릿명/);
  assert.match(bad.innerHTML, /role="alert"/);
});

test('invalid template content gets a local error, focus, and keeps its draft', () => {
  const ETKO = fresh();
  const box = formBox({
    'data-template-name': '입장 안내',
    'data-template-channel': 'LMS',
    'data-template-content': '',
  }, ['data-template-save']);
  ETKO.renderMessaging(box);
  box.handlers['data-template-save']();
  assert.equal(ETKO.workspace().templates.length, 0);
  assert.match(box.innerHTML, /data-template-content[^>]*aria-invalid="true"/);
  assert.match(box.innerHTML, /id="template-content-error"[^>]*>메시지 내용[을를]?\(를\) 입력하세요/);
  assert.match(box.innerHTML, /value="입장 안내"/);
  assert.match(box.innerHTML, /<option value="LMS" selected>LMS<\/option>/);
  assert.equal(box.fields['data-template-content'].focused, true);
});

test('invalid campaign body gets a local error while title and target draft survive', () => {
  const ETKO = fresh();
  ETKO.workspace().participants = [{ id: 'p1', status: 'registered', cancelled: false }];
  const box = formBox({
    'data-campaign-title': '내일 행사 안내',
    'data-campaign-channel': 'SMS',
    'data-campaign-target': '전체',
    'data-campaign-content': '',
  }, ['data-campaign-save']);
  ETKO.renderMessaging(box);
  box.handlers['data-campaign-save']();
  assert.equal(ETKO.workspace().messages.length, 0);
  assert.match(box.innerHTML, /data-campaign-content[^>]*aria-invalid="true"/);
  assert.match(box.innerHTML, /id="campaign-content-error"[^>]*>메시지을\(를\) 입력하세요/);
  assert.match(box.innerHTML, /value="내일 행사 안내"/);
  assert.match(box.innerHTML, /<option value="전체" selected>전체 참가자<\/option>/);
  assert.equal(box.fields['data-campaign-content'].focused, true);
});
