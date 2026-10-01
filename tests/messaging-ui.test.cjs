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
