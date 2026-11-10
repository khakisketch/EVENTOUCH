'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { operatorMessageLookup } = require('../server/message-provider-lookup');

function message(overrides = {}) {
  return { id: 'message-12345678', status: 'SENDING', genericSubmissionUnconfirmed: true, genericAttemptActive: true,
    providerSubmission: { id: 'submission-1', kind: 'HTTP' }, recipientIds: ['person-1', 'person-2'],
    recipientSnapshot: [{ id: 'person-1', phone: '01011114444' }, { id: 'person-2', phone: '01022223333' }],
    deliveries: [{ participantId: 'person-1', status: 'SENDING' }, { participantId: 'person-2', status: 'SENDING' }], ...overrides };
}

test('operator lookup uses masked historical numbers and the HTTP reference without modifying stored data', () => {
  const source = message(), before = structuredClone(source);
  const result = operatorMessageLookup(source);
  assert.deepEqual(result.deliveries.map(item => item.providerLookup), [
    { maskedPhone: '010-****-4444', reference: 'message-12345678:person-1' },
    { maskedPhone: '010-****-3333', reference: 'message-12345678:person-2' },
  ]);
  assert.deepEqual(source, before);
  assert.doesNotMatch(JSON.stringify(result.deliveries), /01011114444|01022223333/);
});

test('unknown transport never invents a provider reference', () => {
  for (const submission of [undefined, { id: 'submission-1', kind: 'OTHER' }, { kind: 'HTTP' }]) {
    const result = operatorMessageLookup(message({ providerSubmission: submission }));
    assert.equal(result.deliveries[0].providerLookup.reference, null);
    assert.equal(result.deliveries[0].providerLookup.maskedPhone, '010-****-4444');
  }
});

test('partial or duplicate identity records never choose a different person or number', () => {
  const duplicate = message({ recipientSnapshot: [{ id: 'person-1', phone: '01011114444' }, { id: 'person-1', phone: '01022223333' }] });
  const result = operatorMessageLookup(duplicate);
  for (const delivery of result.deliveries) assert.deepEqual(delivery.providerLookup, { maskedPhone: '', reference: null });
  const duplicateIds = operatorMessageLookup(message({ recipientIds: ['person-1', 'person-1', 'person-2'] }));
  assert.deepEqual(duplicateIds.deliveries[0].providerLookup, { maskedPhone: '', reference: null });
  const duplicateDeliveries = operatorMessageLookup(message({ deliveries: [{ participantId: 'person-1', status: 'SENDING' }, { participantId: 'person-1', status: 'SENDING' }] }));
  for (const delivery of duplicateDeliveries.deliveries) assert.deepEqual(delivery.providerLookup, { maskedPhone: '', reference: null });
});

test('finished attempts and non-pending recipients do not acquire a locked lookup field', () => {
  const completed = message({ genericAttemptActive: false });
  assert.strictEqual(operatorMessageLookup(completed), completed);
  const mixed = message({ deliveries: [{ participantId: 'person-1', status: 'ACCEPTED' }, { participantId: 'person-2', status: 'SENDING' }] });
  const result = operatorMessageLookup(mixed);
  assert.equal(Object.hasOwn(result.deliveries[0], 'providerLookup'), false);
  assert.equal(result.deliveries[1].providerLookup.maskedPhone, '010-****-3333');
});
