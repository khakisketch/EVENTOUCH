const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
globalThis.ETKO = globalThis.ETKO || {};
try {
  globalThis.ETKO.sample = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'sample.json'), 'utf8')
  );
} catch (err) {}
require('../features/agency.js');
require('../features/registration.js');
require('../features/messaging.js');

const ETKO = globalThis.ETKO;

function freshEvent() {
  const id = ETKO.createEvent({
    name: '메시지 테스트 행사',
    date: '2026-11-01',
    venue: '테스트홀',
  });
  ETKO.switchEvent(id);
  return id;
}

function addPerson(name, phone) {
  return ETKO.register({ name: name, phone: phone });
}

test('brief: empty recipientIds throws a Korean target error', () => {
  assert.throws(
    () =>
      ETKO.createCampaign({
        title: '',
        channel: 'SMS',
        target: '전체',
        recipientIds: [],
        content: 'hi',
      }),
    /발송 대상/
  );
});

test('saveTemplate creates and updates a template', () => {
  freshEvent();
  const tpl = ETKO.saveTemplate({ name: '행사 안내', channel: 'SMS', content: '안녕하세요' });
  assert.ok(tpl.id);
  assert.equal(tpl.name, '행사 안내');
  assert.equal(ETKO.workspace().templates.length, 1);
  const updated = ETKO.saveTemplate({ id: tpl.id, name: '행사 안내 v2', channel: 'SMS', content: '변경' });
  assert.equal(updated.id, tpl.id);
  assert.equal(updated.content, '변경');
  assert.equal(ETKO.workspace().templates.length, 1);
});

test('saveTemplate rejects empty name/content in Korean', () => {
  freshEvent();
  assert.throws(() => ETKO.saveTemplate({ name: '', channel: 'SMS', content: 'hi' }), /템플릿/);
  assert.throws(() => ETKO.saveTemplate({ name: '안내', channel: 'SMS', content: '' }), /메시지/);
});

test('deleteTemplate removes the template', () => {
  freshEvent();
  const tpl = ETKO.saveTemplate({ name: '삭제 대상', channel: 'SMS', content: 'bye' });
  ETKO.deleteTemplate(tpl.id);
  assert.equal(ETKO.workspace().templates.length, 0);
});

test('campaignReview: target filter uses everIn, never literal status', () => {
  freshEvent();
  const a = addPerson('전체1', '010-0000-0011');
  const b = addPerson('체크인1', '010-0000-0012');
  const ws = ETKO.workspace();
  ws.participants.forEach((p) => {
    if (p.id === b.id) p.everIn = true;
  });
  // b is everIn but status stays non-IN: still counts as 체크인 참가자.
  const checked = ETKO.campaignReview({ target: '체크인 참가자' });
  assert.deepEqual(checked.recipientIds, [b.id]);
  const notIn = ETKO.campaignReview({ target: '미입장 참가자' });
  assert.deepEqual(notIn.recipientIds, [a.id]);
  const all = ETKO.campaignReview({ target: '전체' });
  assert.equal(all.count, 2);
  assert.equal(all.delivery, 'SIMULATION_ONLY');
  assert.equal(all.cost, null);
});

test('campaignReview: 선택 참가자 filters by ids', () => {
  freshEvent();
  const a = addPerson('선택1', '010-0000-0021');
  addPerson('선택2', '010-0000-0022');
  const review = ETKO.campaignReview({ target: '선택 참가자', ids: [a.id] });
  assert.deepEqual(review.recipientIds, [a.id]);
  assert.equal(review.count, 1);
});

test('createCampaign saves DRAFT with frozen ids, SIMULATION_ONLY, null cost', () => {
  freshEvent();
  const a = addPerson('수신1', '010-0000-0031');
  const b = addPerson('수신2', '010-0000-0032');
  const ids = [a.id, b.id];
  const campaign = ETKO.createCampaign({
    title: '안내 캠페인',
    channel: 'SMS',
    target: '전체',
    recipientIds: ids,
    content: '행사 안내입니다',
  });
  assert.equal(campaign.status, 'DRAFT');
  assert.equal(campaign.delivery, 'SIMULATION_ONLY');
  assert.equal(campaign.cost, null);
  assert.deepEqual(campaign.recipientIds, [a.id, b.id]);
  assert.ok(Object.isFrozen(campaign.recipientIds));
  ids.push('p999');
  assert.equal(campaign.recipientIds.length, 2);
});

test('createCampaign with scheduled sets SCHEDULED', () => {
  freshEvent();
  const a = addPerson('예약1', '010-0000-0041');
  const campaign = ETKO.createCampaign({
    title: '예약 캠페인',
    channel: '알림톡',
    target: '전체',
    recipientIds: [a.id],
    content: '예약 안내',
    scheduled: '2026-12-01T10:00',
  });
  assert.equal(campaign.status, 'SCHEDULED');
});

test('createCampaign rejects unknown recipients and bad channel', () => {
  freshEvent();
  addPerson('실존', '010-0000-0051');
  assert.throws(
    () =>
      ETKO.createCampaign({
        title: '안내',
        channel: 'SMS',
        target: '전체',
        recipientIds: ['p999'],
        content: 'hi',
      }),
    /발송 대상|참가자 상태/
  );
  const me = ETKO.workspace().participants[0].id;
  assert.throws(
    () =>
      ETKO.createCampaign({
        title: '안내',
        channel: 'PIGEON',
        target: '전체',
        recipientIds: [me],
        content: 'hi',
      }),
    /채널/
  );
});

test('createCampaign rejects empty title/content in Korean', () => {
  freshEvent();
  const a = addPerson('검증1', '010-0000-0061');
  assert.throws(
    () =>
      ETKO.createCampaign({
        title: '',
        channel: 'SMS',
        target: '전체',
        recipientIds: [a.id],
        content: 'hi',
      }),
    /캠페인 이름/
  );
  assert.throws(
    () =>
      ETKO.createCampaign({
        title: '안내',
        channel: 'SMS',
        target: '전체',
        recipientIds: [a.id],
        content: '',
      }),
    /메시지/
  );
});

test('campaigns never claim sending: no SENT status', () => {
  freshEvent();
  const a = addPerson('전송1', '010-0000-0071');
  const campaign = ETKO.createCampaign({
    title: '시뮬레이션',
    channel: 'LMS',
    target: '전체',
    recipientIds: [a.id],
    content: '내용',
  });
  assert.ok(['DRAFT', 'SCHEDULED'].indexOf(campaign.status) !== -1);
  assert.equal(campaign.delivery, 'SIMULATION_ONLY');
});
