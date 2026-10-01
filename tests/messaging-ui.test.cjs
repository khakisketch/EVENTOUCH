const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/messaging.js', '../features/integrations.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
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
