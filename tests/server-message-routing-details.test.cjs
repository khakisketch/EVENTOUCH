'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { messageRecipientChangeAssessment, messageRecipientChangeCount, dueScheduleGuards } = require('../server/commands/content-results');
const version = (status, group) => crypto.createHash('sha256').update(JSON.stringify([status.trim().toUpperCase(), group.trim() || '일반'])).digest('hex');
const snapshot = { id: 'p1', name: '합성 참가자', phone: '01012345678', routingStatus: 'APPROVED', routingGroup: '일반', routingVersion: version('APPROVED', '일반') };
const message = { recipientRoutingReviewVersion: 1, recipientIds: ['p1'], recipientSnapshot: [snapshot], simulate: false };
const person = { id: 'p1', name: '합성 참가자', phone: '01012345678', status: 'APPROVED', group: '일반', revoked: false };

test('recipient explanation and send guard agree and mask both phone values', () => {
  const ws = { participants: [{ ...person, name: '합성 변경 이름', status: 'WAITLIST', group: 'VIP', phone: '01098765678' }] };
  const result = messageRecipientChangeAssessment(message, ws, { details: true });
  assert.equal(result.count, 1); assert.equal(messageRecipientChangeCount(message, ws), 1);
  assert.deepEqual(result.changes[0].reasons, ['status', 'group', 'phone']);
  assert.equal(result.changes[0].beforeStatus, 'APPROVED'); assert.equal(result.changes[0].afterStatus, 'WAITLIST');
  assert.equal(result.changes[0].name, '합성 참가자'); assert.equal(result.changes[0].currentName, '합성 변경 이름');
  assert.equal(result.changes[0].beforeGroup, '일반'); assert.equal(result.changes[0].afterGroup, 'VIP');
  assert.equal(result.changes[0].beforePhone, '010-****-5678'); assert.equal(result.changes[0].afterPhone, '010-****-5678');
  assert.doesNotMatch(JSON.stringify(result), /01012345678|01098765678/);
  assert.equal(messageRecipientChangeCount(message, { participants: [person] }), 0);
});

test('legacy comparison, missing, ambiguity, and damaged proof never invent old values', () => {
  const old = structuredClone(message); delete old.recipientSnapshot[0].routingStatus; delete old.recipientSnapshot[0].routingGroup;
  const legacy = messageRecipientChangeAssessment(old, { participants: [{ ...person, group: 'VIP' }] }, { details: true });
  assert.deepEqual(legacy.changes[0].reasons, ['routing']); assert.equal(legacy.changes[0].beforeGroup, null);
  const tampered = structuredClone(message); tampered.recipientSnapshot[0].routingGroup = '조작된 이전 값';
  const unverified = messageRecipientChangeAssessment(tampered, { participants: [{ ...person, group: 'VIP' }] }, { details: true });
  assert.deepEqual(unverified.changes[0].reasons, ['routing']); assert.equal(unverified.changes[0].beforeGroup, null);
  const missing = messageRecipientChangeAssessment(message, { participants: [] }, { details: true });
  assert.deepEqual(missing.changes[0].reasons, ['missing']);
  const duplicate = messageRecipientChangeAssessment(message, { participants: [person, { ...person, phone: '01098765678' }] }, { details: true });
  assert.deepEqual(duplicate.changes[0].reasons, ['ambiguous']); assert.equal(duplicate.changes[0].afterPhone, null);
  const broken = structuredClone(message); delete broken.recipientSnapshot[0].routingVersion;
  const unknown = messageRecipientChangeAssessment(broken, { participants: [person] }, { details: true });
  assert.deepEqual(unknown.changes[0].reasons, ['unavailable']);
  const truncated = structuredClone(message); truncated.recipientSnapshot = [];
  assert.deepEqual(messageRecipientChangeAssessment(truncated, { participants: [person] }, { details: true }), { count: 1, available: false, changes: [] });
  const simulated = { ...message, simulate: true };
  assert.equal(messageRecipientChangeCount(simulated, { participants: [] }), 0);
});

test('only name-personalized content blocks a changed or unconfirmed name', () => {
  const changed = { participants: [{ ...person, name: '합성 현재 이름' }] };
  const named = { ...message, body: '{{이름}}님 안내' };
  const result = messageRecipientChangeAssessment(named, changed, { details: true });
  assert.deepEqual(result.changes[0].reasons, ['name']);
  assert.equal(result.changes[0].name, '합성 참가자'); assert.equal(result.changes[0].currentName, '합성 현재 이름');
  assert.equal(messageRecipientChangeCount({ ...message, body: '안내' }, changed), 0);
  const absent = structuredClone(named); delete absent.recipientSnapshot[0].name;
  const unavailable = messageRecipientChangeAssessment(absent, changed, { details: true });
  assert.deepEqual(unavailable.changes[0].reasons, ['name-unavailable']);
  assert.equal(unavailable.changes[0].name, '이름 확인 필요');
  assert.deepEqual(messageRecipientChangeAssessment(named, { participants: [{ ...person, name: '' }] }, { details: true }).changes[0].reasons, ['name-unavailable']);
  const blank = structuredClone(named); blank.recipientSnapshot[0].name = '  ';
  const blankReview = messageRecipientChangeAssessment(blank, { participants: [{ ...person, name: '  ' }] }, { details: true });
  assert.equal(blankReview.changes[0].name, '이름 확인 필요'); assert.equal(blankReview.changes[0].currentName, null);
  const legacyEmpty = structuredClone(named); delete legacyEmpty.recipientRoutingReviewVersion; legacyEmpty.recipientSnapshot = [];
  assert.deepEqual(messageRecipientChangeAssessment(legacyEmpty, changed, { details: true }), { count: 1, available: false, changes: [] });
  const legacyDuplicate = structuredClone(named); delete legacyDuplicate.recipientRoutingReviewVersion;
  assert.deepEqual(messageRecipientChangeAssessment(legacyDuplicate, { participants: [person, { ...person }] }, { details: true }).changes[0].reasons, ['ambiguous']);
});

test('unsupported personalized text and a renamed recipient both retain their send protection', () => {
  const named = { ...message, body: '{{이름}}님 안내', channel: 'SMS', title: '합성 제목', scheduled: '2025-01-01T00:00:00Z', status: 'SCHEDULED', deliveries: [{ participantId: 'p1' }] };
  const options = { now: Date.parse('2026-01-01T00:00:00Z'), event: { name: '합성 행사' }, providerKind: 'solapi' };
  assert.equal(dueScheduleGuards(named, { participants: [{ ...person, name: '합성 🎉' }] }, options).reason, 'SMS_CHARSET_UNSUPPORTED');
  assert.equal(dueScheduleGuards(named, { participants: [{ ...person, name: '합성 변경 이름' }] }, options).reason, 'RECIPIENT_CHANGED');
  assert.equal(dueScheduleGuards({ ...named, channel: 'ALIMTALK', smsFallback: false }, { participants: [{ ...person, name: '합성 변경 이름' }] }, options).reason, 'RECIPIENT_CHANGED');
  assert.equal(dueScheduleGuards({ ...named, simulate: true }, { participants: [{ ...person, name: '합성 변경 이름' }] }, options), null);
  assert.equal(dueScheduleGuards(named, { participants: [person] }, options), null);
});
