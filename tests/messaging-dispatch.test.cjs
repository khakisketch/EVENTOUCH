const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchCampaign, resolveDelivery } = require('../server/messaging');

// Minimal stand-in for the database handle these functions use: one locked
// read and one write per transaction. It keeps the workspace object live so
// assertions can read the state that was persisted.
function fakeDatabase(workspace) {
  const writes = [];
  return {
    workspace,
    writes,
    query: async () => ({ rows: [{ payload: workspace }] }),
    async transaction(fn) {
      return fn({
        async query(sql, params) {
          if (/SELECT payload FROM event_workspaces/.test(sql)) return { rows: [{ payload: workspace }] };
          if (/UPDATE event_workspaces/.test(sql)) {
            writes.push({ sql, params });
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
      });
    },
  };
}

// A provider shaped like the Solapi adapter: batch acceptance plus polling.
function batchProvider({ registered, rejected = [], groupId = 'G4V-1', poll = {} }) {
  return {
    state: { connected: true },
    async sendBatch() {
      return { accepted: true, registered, rejected, groupId, deliveryUnconfirmed: true };
    },
    async groupMessages() {
      return {
        ok: true,
        messages: Object.fromEntries(
          registered.map((entry, index) => [`M${index + 1}`, { messageId: `M${index + 1}`, to: entry.phone }])
        ),
      };
    },
    async pollResults() {
      return { ok: true, results: poll };
    },
  };
}

const workspaceWith = (deliveries) => ({
  messages: [{
    id: 'msg-1',
    title: '안내',
    body: '본문',
    channel: 'SMS',
    status: 'SENDING',
    deliveries,
    recipientSnapshot: deliveries.map((delivery, index) => ({
      id: delivery.participantId, name: delivery.name || `참가자${index}`, phone: delivery.phone,
    })),
  }],
});

const baseDispatch = {
  eventId: 'e-1',
  messageId: 'msg-1',
  channel: 'SMS',
  text: '본문',
  recipients: [
    { participantId: 'p1', name: '가', phone: '01011111111', variables: { 이름: '가' } },
    { participantId: 'p2', name: '나', phone: '01022222222', variables: { 이름: '나' } },
  ],
};

// --- batch dispatch --------------------------------------------------------

test('a-batch-provider-result-is-not-recorded-as-sent', async () => {
  // Acceptance is not arrival. Marking this SENT would be the exact lie the
  // product must not tell.
  const workspace = workspaceWith([
    { participantId: 'p1', name: '가', phone: '01011111111', status: 'SENDING' },
    { participantId: 'p2', name: '나', phone: '01022222222', status: 'SENDING' },
  ]);
  const db = fakeDatabase(workspace);
  const provider = batchProvider({ registered: [{ participantId: 'p1', accepted: true }, { participantId: 'p2', accepted: true }] });

  const result = await dispatchCampaign(db, provider, baseDispatch);

  assert.equal(result.message.status, 'SENDING');
  assert.equal(result.deliveryUnconfirmed, true);
  assert.equal(result.message.acceptedCount, 2);
  assert.equal(result.message.providerGroupId, 'G4V-1');
  assert.ok(result.message.deliveries.every((delivery) => delivery.status === 'SENDING'));
});

test('accepted-deliveries-carry-the-provider-message-id-needed-to-poll', async () => {
  const workspace = workspaceWith([
    { participantId: 'p1', name: '가', phone: '01011111111', status: 'SENDING' },
    { participantId: 'p2', name: '나', phone: '01022222222', status: 'SENDING' },
  ]);
  const db = fakeDatabase(workspace);
  const provider = batchProvider({
    registered: [
      { participantId: 'p1', accepted: true, phone: '01011111111' },
      { participantId: 'p2', accepted: true, phone: '01022222222' },
    ],
  });

  const result = await dispatchCampaign(db, provider, baseDispatch);
  assert.equal(result.message.deliveries[0].solapiMessageId, 'M1');
  assert.equal(result.message.deliveries[1].solapiMessageId, 'M2');
});

test('a-rejected-recipient-is-recorded-as-failed-while-the-rest-proceed', async () => {
  const workspace = workspaceWith([
    { participantId: 'p1', name: '가', phone: '01011111111', status: 'SENDING' },
    { participantId: 'p2', name: '나', phone: '01022222222', status: 'SENDING' },
  ]);
  const db = fakeDatabase(workspace);
  const provider = batchProvider({
    registered: [{ participantId: 'p1', accepted: true, phone: '01011111111' }],
    rejected: [{ participantId: 'p2', reason: 'PROVIDER_REJECTED', error: '수신번호 오류' }],
  });

  const result = await dispatchCampaign(db, provider, baseDispatch);
  const failed = result.message.deliveries.find((delivery) => delivery.participantId === 'p2');
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error, /수신번호 오류/);
  assert.equal(result.message.status, 'SENDING', 'the rest are still in flight');
});

test('a-campaign-where-nothing-was-accepted-is-failed', async () => {
  const workspace = workspaceWith([{ participantId: 'p1', name: '가', phone: '01011111111', status: 'SENDING' }]);
  const db = fakeDatabase(workspace);
  const provider = {
    state: { connected: true },
    async sendBatch() { return { accepted: false, reason: 'NOT_CONFIGURED' }; },
  };

  const result = await dispatchCampaign(db, { ...provider, groupMessages: undefined }, {
    ...baseDispatch,
    recipients: [{ participantId: 'p1', name: '가', phone: '01011111111' }],
  });

  assert.equal(result.message.status, 'FAILED');
  assert.equal(result.message.acceptedCount, 0);
  assert.equal(result.message.deliveries[0].status, 'FAILED');
});

test('an-unresolvable-recipient-in-the-provider-response-is-failed-not-ignored', async () => {
  const workspace = workspaceWith([{ participantId: 'p1', name: '가', phone: '01011111111', status: 'SENDING' }]);
  const db = fakeDatabase(workspace);
  const provider = batchProvider({ registered: [] });

  const result = await dispatchCampaign(db, provider, {
    ...baseDispatch,
    recipients: [{ participantId: 'p1', name: '가', phone: '01011111111' }],
  });

  assert.equal(result.message.deliveries[0].status, 'FAILED');
  assert.match(result.message.deliveries[0].error, /확인하지 못했습니다/);
});

// --- delivery resolution ---------------------------------------------------

function pendingWorkspace(deliveries) {
  return {
    messages: [{
      id: 'msg-1', title: '안내', body: '본문', channel: 'SMS', status: 'SENDING',
      providerGroupId: 'G4V-1', deliveries,
    }],
  };
}

test('a-campaign-becomes-sent-only-when-every-recipient-is-confirmed', async () => {
  const workspace = pendingWorkspace([
    { participantId: 'p1', phone: '01011111111', status: 'SENDING', solapiMessageId: 'M1' },
    { participantId: 'p2', phone: '01022222222', status: 'SENDING', solapiMessageId: 'M2' },
  ]);
  const db = fakeDatabase(workspace);
  const provider = {
    async pollResults() {
      return { ok: true, results: {
        M1: { state: 'DELIVERED', type: 'SMS' },
        M2: { state: 'DELIVERED', type: 'SMS' },
      } };
    },
  };

  const result = await resolveDelivery(db, provider, 'e-1');
  assert.equal(result.resolved, 1);
  const message = workspace.messages[0];
  assert.equal(message.status, 'SENT');
  assert.equal(message.deliveredCount, 2);
  assert.equal(message.deliveryUnconfirmed, false);
  assert.ok(message.deliveries.every((delivery) => delivery.status === 'SENT'));
});

test('a-partially-delivered-campaign-is-partial-not-sent', async () => {
  const workspace = pendingWorkspace([
    { participantId: 'p1', phone: '01011111111', status: 'SENDING', solapiMessageId: 'M1' },
    { participantId: 'p2', phone: '01022222222', status: 'SENDING', solapiMessageId: 'M2' },
  ]);
  const db = fakeDatabase(workspace);
  const provider = {
    async pollResults() {
      return { ok: true, results: {
        M1: { state: 'DELIVERED', type: 'SMS' },
        M2: { state: 'FAILED', reason: '수신번호 오류', statusCode: '3000' },
      } };
    },
  };

  await resolveDelivery(db, provider, 'e-1');
  const message = workspace.messages[0];
  assert.equal(message.status, 'PARTIAL');
  assert.equal(message.deliveredCount, 1);
  assert.equal(message.failedCount, 1);
  const failed = message.deliveries.find((delivery) => delivery.participantId === 'p2');
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error, /수신번호 오류/);
});

test('a-campaign-where-nothing-arrived-is-failed', async () => {
  const workspace = pendingWorkspace([{ participantId: 'p1', phone: '01011111111', status: 'SENDING', solapiMessageId: 'M1' }]);
  const db = fakeDatabase(workspace);
  const provider = { async pollResults() { return { ok: true, results: { M1: { state: 'FAILED', reason: '실패' } } }; } };

  await resolveDelivery(db, provider, 'e-1');
  assert.equal(workspace.messages[0].status, 'FAILED');
});

test('a-campaign-stays-in-flight-while-any-recipient-is-unresolved', async () => {
  // Rounding an unresolved recipient into a result would be a guess.
  const workspace = pendingWorkspace([
    { participantId: 'p1', phone: '01011111111', status: 'SENDING', solapiMessageId: 'M1' },
    { participantId: 'p2', phone: '01022222222', status: 'SENDING', solapiMessageId: 'M2' },
  ]);
  const db = fakeDatabase(workspace);
  const provider = {
    async pollResults() {
      return { ok: true, results: {
        M1: { state: 'DELIVERED', type: 'SMS' },
        M2: { state: 'PENDING' },
      } };
    },
  };

  const result = await resolveDelivery(db, provider, 'e-1');
  assert.equal(result.resolved, 0);
  assert.equal(result.pending, 1);
  assert.equal(workspace.messages[0].status, 'SENDING');
  assert.equal(workspace.messages[0].deliveryUnconfirmed, true);
});

test('a-campaign-with-no-resolvable-ids-is-left-alone', async () => {
  const workspace = pendingWorkspace([{ participantId: 'p1', phone: '01011111111', status: 'SENDING' }]);
  const db = fakeDatabase(workspace);
  const provider = {
    async groupMessages() { return { ok: false, reason: 'TRANSPORT' }; },
    async pollResults() { return { ok: true, results: {} }; },
  };

  const result = await resolveDelivery(db, provider, 'e-1');
  assert.equal(result.resolved, 0);
  assert.equal(workspace.messages[0].status, 'SENDING', 'not falsely resolved');
});

test('missing-message-ids-are-recovered-from-the-group', async () => {
  const workspace = pendingWorkspace([{ participantId: 'p1', status: 'SENDING' }]);
  // Production data keeps the number in the snapshot, not on the delivery.
  workspace.messages[0].recipientSnapshot = [{ id: 'p1', name: '가', phone: '010-1111-1111' }];
  const db = fakeDatabase(workspace);
  const provider = {
    async groupMessages() { return { ok: true, messages: { M9: { messageId: 'M9', to: '01011111111' } } }; },
    async pollResults(ids) {
      assert.deepEqual(ids, ['M9'], 'the recovered id is what gets polled');
      return { ok: true, results: { M9: { state: 'DELIVERED' } } };
    },
  };

  await resolveDelivery(db, provider, 'e-1');
  assert.equal(workspace.messages[0].status, 'SENT');
});

test('an-alimtalk-that-fell-back-to-text-is-marked-on-the-delivery', async () => {
  const workspace = pendingWorkspace([{ participantId: 'p1', phone: '01011111111', status: 'SENDING', solapiMessageId: 'M1' }]);
  const db = fakeDatabase(workspace);
  const provider = {
    async pollResults() {
      return { ok: true, results: { M1: { state: 'DELIVERED', type: 'SMS', replacement: true } } };
    },
  };

  await resolveDelivery(db, provider, 'e-1');
  const delivery = workspace.messages[0].deliveries[0];
  assert.equal(delivery.status, 'SENT');
  assert.equal(delivery.replacedFallback, true);
});

test('resolving-a-workspace-with-nothing-in-flight-does-nothing', async () => {
  const workspace = { messages: [{ id: 'msg-1', status: 'SENT', deliveries: [] }] };
  const db = fakeDatabase(workspace);
  const provider = { async pollResults() { throw new Error('must not be called'); } };
  const result = await resolveDelivery(db, provider, 'e-1');
  assert.deepEqual(result, { resolved: 0, pending: 0 });
  assert.equal(db.writes.length, 0);
});

test('resolution-is-a-no-op-with-a-provider-that-cannot-poll', async () => {
  const db = fakeDatabase(pendingWorkspace([]));
  const result = await resolveDelivery(db, { state: { connected: true } }, 'e-1');
  assert.deepEqual(result, { skipped: true });
});

test('a-campaign-already-resolved-is-not-polled-again', async () => {
  const workspace = {
    messages: [{
      id: 'msg-1', status: 'SENT', providerGroupId: 'G4V-1',
      deliveries: [{ participantId: 'p1', status: 'SENT', solapiMessageId: 'M1' }],
    }],
  };
  const db = fakeDatabase(workspace);
  let called = false;
  const provider = { async pollResults() { called = true; return { ok: true, results: {} }; } };
  await resolveDelivery(db, provider, 'e-1');
  assert.equal(called, false);
});


// --- production-shaped deliveries ------------------------------------------
//
// The fixtures above put a phone on each delivery, which production data does
// not have: the number lives only in recipientSnapshot. That difference hid a
// real bug where every provider message id failed to match, so polling could
// never resolve a campaign. These tests use the shape the product actually
// stores.

test('ids-are-matched-when-the-delivery-has-no-phone-of-its-own', async () => {
  const workspace = workspaceWith([
    { participantId: 'p1', name: '가', status: 'SENDING' },
    { participantId: 'p2', name: '나', status: 'SENDING' },
  ]);
  const db = fakeDatabase(workspace);
  const provider = batchProvider({
    registered: [
      { participantId: 'p1', accepted: true, phone: '01011111111' },
      { participantId: 'p2', accepted: true, phone: '01022222222' },
    ],
  });

  const result = await dispatchCampaign(db, provider, baseDispatch);
  assert.equal(result.message.deliveries[0].solapiMessageId, 'M1', 'matched through the dispatch recipients');
  assert.equal(result.message.deliveries[1].solapiMessageId, 'M2');
});

test('polling-recovers-ids-from-the-snapshot-when-the-delivery-has-none', async () => {
  const workspace = pendingWorkspace([
    { participantId: 'p1', status: 'SENDING' },
    { participantId: 'p2', status: 'SENDING' },
  ]);
  workspace.messages[0].recipientSnapshot = [
    { id: 'p1', name: '가', phone: '010-1111-1111' },
    { id: 'p2', name: '나', phone: '010-2222-2222' },
  ];
  const db = fakeDatabase(workspace);
  const provider = {
    async groupMessages() {
      return { ok: true, messages: {
        M1: { messageId: 'M1', to: '01011111111' },
        M2: { messageId: 'M2', to: '01022222222' },
      } };
    },
    async pollResults(ids) {
      assert.deepEqual(ids.sort(), ['M1', 'M2'], 'both ids recovered from the snapshot');
      return { ok: true, results: { M1: { state: 'DELIVERED' }, M2: { state: 'DELIVERED' } } };
    },
  };

  const result = await resolveDelivery(db, provider, 'e-1');
  assert.equal(result.resolved, 1);
  assert.equal(workspace.messages[0].status, 'SENT', 'a campaign stored the production way still resolves');
});

test('a-phone-formatted-differently-than-the-provider-still-matches', async () => {
  // The snapshot keeps hyphens; Solapi reports digits. Normalising both sides
  // is what makes the match work.
  const workspace = workspaceWith([{ participantId: 'p1', name: '가', status: 'SENDING' }]);
  const db = fakeDatabase(workspace);
  const provider = batchProvider({
    registered: [{ participantId: 'p1', accepted: true, phone: '010-1111-1111' }],
  });
  const result = await dispatchCampaign(db, provider, {
    ...baseDispatch,
    recipients: [{ participantId: 'p1', name: '가', phone: '010-1111-1111' }],
  });
  assert.equal(result.message.deliveries[0].solapiMessageId, 'M1');
});
