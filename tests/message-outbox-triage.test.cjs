'use strict';

// Drain tri-state (defect A) + lock discipline (defect D), memory-only.
//
// The supplier consult for a SENDING campaign with a providerGroupId has
// exactly three outcomes:
//   EXISTS  (ok:true, even with an empty page) -> reconcile, never re-send.
//   ABSENT  (explicit NOT_FOUND / HTTP 404)     -> re-send.
//   UNKNOWN (rate limit, timeout, transport, any other rejection, or a
//           thrown error)                       -> send nothing, settle
//           nothing; the row stays queued on its backoff.
//
// And the consult must run with no event row lock held: a slow provider must
// never pin the event, and the decision re-checks the campaign under a fresh
// lock so a cancel landing mid-consult cannot be resent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { drainMessageOutbox, classifyGroupLookup } = require('../server/message-outbox');

const BASE_NOW = Date.parse('2026-10-24T00:00:00.000Z');

function workspaceWith(message) {
  return {
    participants: [{ id: 'p1', name: '수신자', phone: '010-1111-2222' }],
    luckyNumbers: [],
    audit: [],
    messages: [message],
  };
}

function sentCampaign({ groupId } = {}) {
  return {
    id: 'msg-1',
    title: '안내',
    body: '본문입니다.',
    channel: 'SMS',
    recipientIds: ['p1'],
    recipientSnapshot: [{ id: 'p1', name: '수신자', phone: '010-1111-2222' }],
    status: 'SENDING',
    attempts: 1,
    ...(groupId ? { providerGroupId: groupId, deliveryUnconfirmed: true } : {}),
    deliveries: [{ participantId: 'p1', name: '수신자', status: 'SENDING', at: new Date(BASE_NOW).toISOString() }],
  };
}

// Minimal in-memory stand-in for the database handle. It emulates just the
// SQL shapes message-outbox + messaging(batch) use, and models row locks:
// any query containing FOR UPDATE increments locksHeld until its
// transaction commits, so a provider consult running inside a lock fails the
// assertion the mock providers carry.
function makeMemoryDb({ workspace, outbox = [] }) {
  const state = {
    eventPayload: { id: 'e-1', slug: 'e-1', name: '행사', clientId: null, date: '2026-12-01' },
    workspace,
    outbox: new Map(outbox.map((row) => [row.message_id, { ...row }])),
    locksHeld: 0,
    inTransaction: false,
    writes: 0,
    now: BASE_NOW,
  };

  async function answer(sql, params = []) {
    const text = String(sql);
    if (/UPDATE message_outbox\s+SET status/.test(text)) {
      const limit = Number(params[0]) || 20;
      const due = [...state.outbox.values()]
        .filter((row) => (row.status === 'PENDING' || row.status === 'SENDING')
          && Date.parse(row.next_attempt_at) <= state.now)
        .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))
        .slice(0, limit);
      for (const row of due) {
        row.attempts += 1;
        row.status = 'SENDING';
        row.next_attempt_at = new Date(state.now + Math.min(row.attempts + 1, 12) * 5 * 60 * 1000).toISOString();
      }
      return { rows: due.map((row) => ({ message_id: row.message_id, event_id: row.event_id })) };
    }
    if (/FROM events e JOIN event_workspaces/.test(text)) {
      return { rows: [{
        id: 'e-1', slug: 'e-1', client_id: null, payload: state.eventPayload, revision: 1,
        workspace_payload: JSON.parse(JSON.stringify(state.workspace)), workspace_revision: 1,
      }] };
    }
    if (/DELETE FROM message_outbox/.test(text)) {
      state.outbox.delete(String(params[0]));
      return { rowCount: 1 };
    }
    if (/INSERT INTO message_outbox/.test(text)) {
      const id = String(params[0]);
      state.outbox.set(id, {
        message_id: id, event_id: String(params[1]), status: 'PENDING', attempts: 0,
        next_attempt_at: new Date(state.now).toISOString(),
      });
      return { rowCount: 1 };
    }
    if (/SELECT payload FROM event_workspaces/.test(text)) {
      return { rows: [{ payload: JSON.parse(JSON.stringify(state.workspace)) }] };
    }
    if (/UPDATE event_workspaces SET payload/.test(text)) {
      state.workspace = JSON.parse(String(params[1]));
      state.writes += 1;
      return { rowCount: 1 };
    }
    throw new Error(`unemulated SQL: ${text.slice(0, 120)}`);
  }

  async function tracked(sql, params) {
    const holds = /FOR UPDATE/.test(String(sql));
    if (holds) state.locksHeld += 1;
    try {
      return await answer(sql, params);
    } finally {
      // Locks release at commit, modelled by transaction() below.
    }
  }

  return {
    state,
    async query(sql, params) { return tracked(sql, params); },
    async transaction(fn) {
      const outer = state.inTransaction;
      const outerLocks = state.locksHeld;
      state.inTransaction = true;
      try {
        return await fn({ query: (sql, params) => tracked(sql, params) });
      } finally {
        state.inTransaction = outer;
        // Commit releases the locks this transaction took.
        if (!outer) state.locksHeld = outerLocks > 0 ? outerLocks : 0;
      }
    },
  };
}

function batchProvider(db, { groupResult, groupError, onSend } = {}) {
  return {
    state: { connected: true },
    async groupMessages(groupId) {
      assert.equal(db.state.locksHeld, 0, 'supplier consult must run with no event lock held');
      assert.equal(db.state.inTransaction, false, 'supplier consult must run outside any transaction');
      if (groupError) throw groupError;
      return groupResult;
    },
    async sendBatch(recipients) {
      if (onSend) await onSend(recipients);
      return {
        accepted: true,
        registered: recipients.map((r) => ({ participantId: r.participantId, accepted: true, type: 'SMS' })),
        rejected: [],
        groupId: 'G-NEW',
        deliveryUnconfirmed: true,
      };
    },
  };
}

function singleBatchProvider(db, { groupResult, groupError } = {}) {
  let sends = 0;
  const provider = batchProvider(db, { groupResult, groupError, onSend: async () => { sends += 1; } });
  return { provider, sends: () => sends };
}

// --- classifier unit contract ----------------------------------------------

test('classifier: ok-true-with-named-messages-is-exists', () => {
  assert.equal(classifyGroupLookup({ ok: true, messages: { M1: {} } }), 'EXISTS');
});

test('classifier: ok-true-but-empty-is-unknown-not-held', () => {
  // An accepted group always carries its messages, so an empty listing
  // proves nothing either way. Until the supplier's unknown-group response
  // is verified live, emptiness holds the row instead of settling it.
  assert.equal(classifyGroupLookup({ ok: true, messages: {} }), 'UNKNOWN');
  assert.equal(classifyGroupLookup({ ok: true }), 'UNKNOWN');
});

test('classifier: only-an-explicit-not-found-is-absent', () => {
  assert.equal(classifyGroupLookup({ ok: false, reason: 'NOT_FOUND' }), 'ABSENT');
  assert.equal(classifyGroupLookup({ ok: false, reason: 'PROVIDER_REJECTED', status: 404 }), 'ABSENT');
});

test('classifier: everything-else-is-unknown', () => {
  assert.equal(classifyGroupLookup({ ok: false, reason: 'RATE_LIMITED', status: 429 }), 'UNKNOWN');
  assert.equal(classifyGroupLookup({ ok: false, reason: 'TIMEOUT' }), 'UNKNOWN');
  assert.equal(classifyGroupLookup({ ok: false, reason: 'TRANSPORT' }), 'UNKNOWN');
  assert.equal(classifyGroupLookup({ ok: false, reason: 'PROVIDER_REJECTED', status: 500 }), 'UNKNOWN');
  assert.equal(classifyGroupLookup(null), 'UNKNOWN');
  assert.equal(classifyGroupLookup(undefined), 'UNKNOWN');
});

// --- drain tri-state ---------------------------------------------------------

function setupDb(message) {
  return makeMemoryDb({
    workspace: workspaceWith(message),
    outbox: [{ message_id: message.id, event_id: 'e-1', status: 'PENDING', attempts: 0,
      next_attempt_at: new Date(BASE_NOW - 1000).toISOString() }],
  });
}

test('normal-lookup-reconciles-without-sending', async () => {
  const db = setupDb(sentCampaign({ groupId: 'G-1' }));
  const { provider, sends } = singleBatchProvider(db, { groupResult: { ok: true, messages: { M1: { messageId: 'M1' } } } });
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(sends(), 0, 'a held group must never be re-sent');
  assert.equal(result.reconciled, 1);
  assert.equal(result.dispatched, 0);
  assert.equal(db.state.outbox.size, 0);
  assert.equal(db.state.workspace.messages[0].status, 'SENDING', 'campaign stays in flight for the resolver');
});

test('empty-ok-page-holds-instead-of-settling-unverified-absence', async () => {
  // The old contract treated any ok:true as "held". An empty listing is not
  // evidence of holding, so the row is kept on its backoff — not settled
  // (which would strand the campaign) and not re-sent (which could double).
  const db = setupDb(sentCampaign({ groupId: 'G-1' }));
  const { provider, sends } = singleBatchProvider(db, { groupResult: { ok: true, messages: {} } });
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(sends(), 0);
  assert.equal(result.dispatched, 0);
  assert.equal(result.settled, 0);
  assert.equal(result.deferred, 1);
  assert.equal(db.state.outbox.size, 1, 'the row stays queued');
  assert.equal(db.state.workspace.messages[0].status, 'SENDING');

  // The hold loses nothing: once the listing actually names the acceptance,
  // a later drain reconciles without sending.
  const later = singleBatchProvider(db, { groupResult: { ok: true, messages: { M1: { messageId: 'M1' } } } });
  db.state.outbox.get('msg-1').next_attempt_at = new Date(BASE_NOW - 1000).toISOString();
  const second = await drainMessageOutbox(db, later.provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(later.sends(), 0);
  assert.equal(second.reconciled, 1);
  assert.equal(db.state.outbox.size, 0);
});

test('truncated-but-non-empty-listing-reconciles-without-sending', async () => {
  // A truncated listing still names real acceptances, so the no-resend side
  // holds — while the truncated flag keeps every caller from treating the
  // collection as complete (see the resolve side in messaging-dispatch).
  const db = setupDb(sentCampaign({ groupId: 'G-1' }));
  const { provider, sends } = singleBatchProvider(db, {
    groupResult: { ok: true, messages: { M1: { messageId: 'M1' } }, truncated: true, pages: 20 },
  });
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(sends(), 0);
  assert.equal(result.reconciled, 1);
  assert.equal(db.state.outbox.size, 0);
});

test('explicit-not-found-resends', async () => {
  const db = setupDb(sentCampaign({ groupId: 'G-STALE' }));
  const { provider, sends } = singleBatchProvider(db, { groupResult: { ok: false, reason: 'NOT_FOUND' } });
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(sends(), 1, 'a group the supplier never saw must be re-sent, not dropped');
  assert.equal(result.dispatched, 1);
  assert.equal(db.state.outbox.size, 0);
});

test('http-404-resends', async () => {
  const db = setupDb(sentCampaign({ groupId: 'G-STALE' }));
  const { provider, sends } = singleBatchProvider(db, {
    groupResult: { ok: false, reason: 'PROVIDER_REJECTED', status: 404 },
  });
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(sends(), 1);
  assert.equal(result.dispatched, 1);
});

test('rate-limit-holds-the-row-on-backoff-without-sending', async () => {
  const db = setupDb(sentCampaign({ groupId: 'G-1' }));
  const { provider, sends } = singleBatchProvider(db, {
    groupResult: { ok: false, reason: 'RATE_LIMITED', status: 429 },
  });
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(sends(), 0, 'an unknown lookup must not send');
  assert.equal(result.dispatched, 0);
  assert.equal(result.settled, 0);
  assert.equal(result.deferred, 1);
  assert.equal(db.state.outbox.size, 1, 'the row stays queued');
  const row = db.state.outbox.get('msg-1');
  assert.equal(row.attempts, 1);
  assert.ok(Date.parse(row.next_attempt_at) > BASE_NOW, 'the claim already pushed the next attempt into the future');
  assert.equal(db.state.workspace.messages[0].status, 'SENDING', 'campaign untouched');
});

test('transport-failure-and-thrown-errors-hold-the-row', async () => {
  for (const failure of [
    { groupResult: { ok: false, reason: 'TRANSPORT' } },
    { groupResult: { ok: false, reason: 'TIMEOUT' } },
    { groupResult: { ok: false, reason: 'PROVIDER_REJECTED', status: 500 } },
    { groupError: new Error('socket hang up') },
  ]) {
    const db = setupDb(sentCampaign({ groupId: 'G-1' }));
    const { provider, sends } = singleBatchProvider(db, failure);
    const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
    assert.equal(sends(), 0, JSON.stringify(failure));
    assert.equal(result.deferred, 1, JSON.stringify(failure));
    assert.equal(db.state.outbox.size, 1, JSON.stringify(failure));
  }
});

test('campaign-without-a-group-id-dispatches-without-consult', async () => {
  const db = setupDb(sentCampaign());
  const consulted = [];
  const base = batchProvider(db, { groupResult: { ok: true, messages: {} } });
  const provider = { ...base, groupMessages: async (groupId) => { consulted.push(groupId); return { ok: true, messages: {} }; } };
  let sends = 0;
  provider.sendBatch = async (recipients) => {
    sends += 1;
    return base.sendBatch(recipients);
  };
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  // The only group read is the post-send id mapping for the NEW acceptance
  // (G-NEW); no pre-send consult ran because there was nothing to consult.
  assert.deepEqual(consulted, ['G-NEW']);
  assert.equal(sends, 1);
  assert.equal(result.dispatched, 1);
});

test('cancel-landing-mid-consult-is-not-resent', async () => {
  const db = setupDb(sentCampaign({ groupId: 'G-1' }));
  const provider = batchProvider(db, { groupResult: { ok: true, messages: { M1: { messageId: 'M1' } } } });
  let sends = 0;
  const innerConsult = provider.groupMessages;
  provider.groupMessages = async (groupId) => {
    // The operator cancels while the supplier consult is in flight.
    db.state.workspace.messages[0].status = 'CANCELLED';
    return innerConsult(groupId);
  };
  provider.sendBatch = async () => { sends += 1; throw new Error('must not send a cancelled campaign'); };
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(sends, 0);
  assert.equal(result.dispatched, 0);
  assert.equal(db.state.outbox.size, 0, 'the recorded outcome settles the row');
});

test('already-resolved-campaign-settles-without-sending', async () => {
  const message = { ...sentCampaign({ groupId: 'G-1' }), status: 'FAILED' };
  const db = setupDb(message);
  const { provider, sends } = singleBatchProvider(db, { groupResult: { ok: true, messages: {} } });
  const result = await drainMessageOutbox(db, provider, { now: new Date(BASE_NOW).toISOString() });
  assert.equal(sends(), 0);
  assert.equal(result.settled, 1);
  assert.equal(db.state.outbox.size, 0);
});
