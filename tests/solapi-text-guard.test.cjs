'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { smsCharacterGuard, dueScheduleGuards } = require('../server/commands/content-results');
const { createSolapiProvider } = require('../server/messaging-solapi');

const event = { id: 'event', slug: 'event', name: '합성 행사', date: '2027-01-16' };
const workspace = { participants: [
  { id: 'a', name: '합성 참가자', phone: '01011112222', status: 'APPROVED' },
  { id: 'b', name: '합성 🎉', phone: '01011113333', status: 'APPROVED' },
], luckyNumbers: [] };
const base = {
  channel: 'SMS', title: '기록 제목', body: '{{이름}}님 환영합니다', simulate: false,
  recipientIds: ['a', 'b'],
  recipientSnapshot: workspace.participants.map(({ id, name, phone }) => ({ id, name, phone })),
  deliveries: workspace.participants.map(({ id }) => ({ participantId: id, status: 'WAITING' })),
};
const check = (message, extra = {}) => smsCharacterGuard(message, workspace, { event, providerKind: 'solapi', ...extra });

test('Solapi checks every rendered recipient, without returning personal content', () => {
  const result = check(base);
  assert.deepEqual(result, { reason: 'SMS_CHARSET_UNSUPPORTED', missing: 1, field: 'ids', personalized: true });
  assert.equal(JSON.stringify(result).includes('합성'), false);
  assert.equal(check(base, { providerKind: 'http' }), null);
  assert.equal(check({ ...base, simulate: true }), null);
  assert.equal(check({ ...base, body: '안내 🎉' }).field, 'body');
});

test('only actually sent LMS or MMS subject is checked', () => {
  const one = { ...base, recipientIds: ['a'], recipientSnapshot: [base.recipientSnapshot[0]], deliveries: [base.deliveries[0]], title: '제목 🎉' };
  assert.equal(check({ ...one, body: '짧은 문자' }), null, 'short SMS does not carry a subject');
  assert.equal(check({ ...one, body: '가'.repeat(46) }).field, 'title');
  assert.equal(check({ ...one, channel: 'MMS', body: '사진' }).field, 'title');
});

test('Alimtalk without fallback accepts its own text; fallback is checked without changing old default', () => {
  const alimtalk = { ...base, channel: 'ALIMTALK' };
  assert.equal(check({ ...alimtalk, smsFallback: false }), null);
  assert.equal(check({ ...alimtalk, smsFallback: true }).reason, 'SMS_CHARSET_UNSUPPORTED');
  assert.equal(check(alimtalk).reason, 'SMS_CHARSET_UNSUPPORTED');
});

test('corrupt recipient snapshots fail closed instead of guessing', () => {
  for (const snapshot of [null, [], [null], [base.recipientSnapshot[0], base.recipientSnapshot[0]]]) {
    assert.equal(check({ ...base, recipientSnapshot: snapshot }).reason, 'SMS_CHARSET_REVIEW_UNAVAILABLE');
  }
});

test('all reviewed, snapshot and delivery IDs must represent the same nonempty set', () => {
  const corrupt = [
    { recipientIds: [] },
    { recipientIds: ['a', 'a'] },
    { recipientIds: ['a', 'other'] },
    { recipientSnapshot: [base.recipientSnapshot[0]] },
    { recipientSnapshot: [base.recipientSnapshot[0], { id: 'other' }] },
    { deliveries: null },
    { deliveries: [base.deliveries[0]] },
    { deliveries: [base.deliveries[0], base.deliveries[0]] },
    { deliveries: [base.deliveries[0], { participantId: 'other' }] },
  ];
  for (const mutation of corrupt) {
    const result = check({ ...base, ...mutation });
    assert.equal(result.reason, 'SMS_CHARSET_REVIEW_UNAVAILABLE');
    assert.equal(check({ ...base, ...mutation, channel: 'ALIMTALK', smsFallback: false }).reason, 'SMS_CHARSET_REVIEW_UNAVAILABLE');
    assert.equal(check({ ...base, ...mutation }, { providerKind: 'http' }), null);
  }
  assert.equal(check({ ...base, recipientSnapshot: [...base.recipientSnapshot].reverse(), deliveries: [...base.deliveries].reverse() }).reason, 'SMS_CHARSET_UNSUPPORTED');
});

test('scheduled execution uses the same guard with current event and recipient state', () => {
  const due = { ...base, status: 'SCHEDULED', scheduled: '2020-01-01T00:00:00Z' };
  assert.equal(dueScheduleGuards(due, workspace, { event, providerKind: 'solapi' }).reason, 'SMS_CHARSET_UNSUPPORTED');
  assert.equal(dueScheduleGuards(due, workspace, { event, providerKind: 'http' }), null);
});

test('Solapi adapter holds the entire batch and fallback choice changes only Alimtalk transport', async () => {
  let calls = 0;
  const provider = createSolapiProvider({ configured: true, apiKey: 'test', apiSecret: 'test', sender: '01011112222', kakaoPfId: 'test', host: 'http://127.0.0.1' }, {
    fetchImpl: async () => { calls += 1; throw new Error('must not call network'); },
  });
  const request = [
    { participantId: 'a', channel: 'SMS', to: '01011112222', text: '{{이름}}', variables: { 이름: '정상' } },
    { participantId: 'b', channel: 'SMS', to: '01011113333', text: '{{이름}}', variables: { 이름: '합성 🎉' } },
  ];
  const result = await provider.sendBatch(request);
  assert.equal(result.reason, 'SMS_CHARSET_UNSUPPORTED');
  assert.equal(result.rejected.length, 2);
  assert.equal(calls, 0);
  const args = { channel: 'ALIMTALK', to: '01011112222', text: '안내 🎉', templateId: 'test' };
  assert.equal(provider.buildMessage(args).error, 'SMS_CHARSET_UNSUPPORTED');
  assert.equal(provider.buildMessage({ ...args, smsFallback: false }).message.kakaoOptions.disableSms, true);
  assert.equal(provider.buildMessage({ ...args, text: '안내', smsFallback: true }).message.kakaoOptions.disableSms, false);
});
