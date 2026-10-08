const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/messaging.js', '../features/integrations.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('sendCampaign queues to the outbox without real sending', () => {
  const ETKO = fresh();
  const c = ETKO.createCampaign({ title: '안내', channel: 'SMS', target: '전체', recipientIds: ['p1'], content: '환영합니다' });
  const sent = ETKO.sendCampaign(c.id);
  assert.equal(sent.status, 'QUEUED_SIMULATION');
  assert.ok(sent.outboxId);
  const box = ETKO.outbox();
  assert.equal(box.length, 1);
  assert.equal(box[0].toCount, 1);
  assert.match(box[0].channel, /SMS/);
});

test('unknown campaign and bad channel are rejected in Korean', () => {
  const ETKO = fresh();
  assert.throws(() => ETKO.sendCampaign('cp-999'), /캠페인/);
  assert.throws(() => ETKO.createCampaign({ title: 'x', channel: 'PIGEON', target: '전체', recipientIds: ['p1'], content: 'hi' }), /채널/);
});

test('sending is gated by role: STAFF and VIEWER denied', () => {
  const ETKO = fresh();
  const c = ETKO.createCampaign({ title: '안내', channel: 'SMS', target: '전체', recipientIds: ['p1'], content: '환영합니다' });
  ETKO.setRole('STAFF');
  assert.throws(() => ETKO.sendCampaign(c.id), /권한/);
  ETKO.setRole('VIEWER');
  assert.throws(() => ETKO.sendCampaign(c.id), /권한/);
  ETKO.setRole('AGENCY');
  assert.equal(ETKO.sendCampaign(c.id).status, 'QUEUED_SIMULATION');
});
