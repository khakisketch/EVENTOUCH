'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measureMessage, messageContentIssue } = require('../apps/web/lib/message-composition.ts');
const solapi = require('../server/messaging-solapi');
const plain = body => ({ channel: 'SMS', body, imageFileId: '' });

test('source counter matches the provider byte calculation and Unicode characters', () => {
  for (const text of ['가'.repeat(45), 'A'.repeat(91), '문자 123\n안내', '你好', '😀', '{{이름}}님']) assert.equal(measureMessage(text).bytes, solapi.messageBytes(text));
  assert.equal(measureMessage('😀').characters, 1);
  assert.equal(measureMessage('{{이름}}').personalized, true);
});

test('plain text is prevented at 2001 bytes without truncating the submitted draft', () => {
  assert.equal(messageContentIssue(plain('a'.repeat(2000))), null);
  assert.equal(messageContentIssue(plain('가'.repeat(1000))), null);
  const draft = plain('가'.repeat(1000) + 'a');
  assert.equal(messageContentIssue(draft).field, 'body');
  assert.equal(draft.body.length, 1001);
  assert.equal(messageContentIssue(plain('{{없는변수}}')).field, 'body');
});

test('Alimtalk keeps the current approved-binding body and rejects stale or archived wording', () => {
  const template = { channel: 'ALIMTALK', body: '{{이름}}님 안내입니다.', archived: false, solapiTemplateId: 'KAFIXTURE_ONLY' };
  const draft = { channel: 'ALIMTALK', body: template.body, imageFileId: '' };
  assert.equal(messageContentIssue(draft, template), null);
  assert.equal(messageContentIssue(draft).field, 'templateId');
  assert.equal(messageContentIssue({ ...draft, body: '다른 문구' }, template).field, 'templateId');
  assert.equal(messageContentIssue(draft, { ...template, archived: true }).field, 'templateId');
  assert.equal(messageContentIssue(draft, { ...template, channel: 'SMS' }).field, 'templateId');
});
