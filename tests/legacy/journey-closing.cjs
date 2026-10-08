const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/desks.js', '../features/messaging.js', '../features/media.js', '../features/engagement.js', '../features/results.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('closing journey: template, campaign simulation, frozen report snapshot', () => {
  const ETKO = fresh();
  ETKO.switchEvent('evt-1');
  const tpl = ETKO.saveTemplate({ name: '입장안내', channel: 'SMS', content: '환영합니다' });
  assert.ok(tpl.id);
  const draft = ETKO.createCampaign({ title: '리마인드', channel: 'SMS', target: '전체', recipientIds: ['p1'], content: '내일 뵙겠습니다' });
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.delivery, 'SIMULATION_ONLY');
  assert.equal(draft.cost, null);
  const scheduled = ETKO.createCampaign({ title: '당일안내', channel: 'SMS', target: '선택 참가자', recipientIds: ['p1', 'p2'], content: '오늘 뵙겠습니다', scheduled: '2026-11-01T09:00' });
  assert.equal(scheduled.status, 'SCHEDULED');
  assert.deepEqual(scheduled.recipientIds, ['p1', 'p2']);
  const report = ETKO.createReport({ title: '중간 결산', summary: '순항 중' });
  const frozen = JSON.stringify(report.metrics);
  ETKO.scan({ code: 'EVT-1001' });
  ETKO.moderatePhotos([], 'APPROVED');
  assert.equal(JSON.stringify(ETKO.reports().find((r) => r.id === report.id).metrics), frozen);
  assert.equal(ETKO.eventSummary().checked >= report.metrics.checked, true);
});
