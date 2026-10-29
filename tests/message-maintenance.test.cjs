'use strict';

// Message maintenance (opt-in worker) contract, memory-only.
//
// The worker is inert by default: disabled -> DISABLED with zero writes;
// disconnected supplier -> NOT_CONNECTED with zero state change. With the
// worker enabled but auto-send off, due schedules are only REPORTED. With
// auto-send on, due SCHEDULED campaigns go through message.retry's guards
// and are enqueued (commit) then drained (send after commit) in the same
// pass. Concurrent workers never double-send.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  maintenanceConfig,
  runMessageMaintenance,
} = require('../server/message-maintenance');

const BASE_NOW = Date.parse('2026-10-24T00:00:00.000Z');
const NOW_ISO = new Date(BASE_NOW).toISOString();
const PAST_ISO = new Date(BASE_NOW - 60 * 1000).toISOString();
const FUTURE_ISO = new Date(BASE_NOW + 60 * 60 * 1000).toISOString();

function campaign(overrides = {}) {
  return {
    id: overrides.id || 'msg-1',
    title: '안내',
    body: overrides.body === undefined ? '본문입니다.' : overrides.body,
    channel: 'SMS',
    recipientIds: ['p1'],
    recipientSnapshot: [{ id: 'p1', name: '수신자', phone: '010-1111-2222' }],
    status: 'SCHEDULED',
    scheduled: PAST_ISO,
    simulate: false,
    attempts: 0,
    deliveries: [{ participantId: 'p1', name: '수신자', status: 'WAITING', at: NOW_ISO }],
    ...overrides,
  };
}

function workspaceWith(messages) {
  return {
    participants: [{ id: 'p1', name: '수신자', phone: '010-1111-2222' }],
    luckyNumbers: [],
    audit: [],
    messages,
  };
}

// In-memory database emulating the SQL shapes the maintenance worker, the
// drain, and the resolver use. All transactions are serialised through one
// mutex, modelling PostgreSQL row locks strongly enough for the
// concurrent-worker test (a second worker re-reads committed state).
function makeMemoryDb(workspaces) {
  const state = {
    events: new Map(Object.entries(workspaces).map(([id, workspace]) => [id, {
      payload: { id, slug: id, name: '행사', clientId: null, date: '2026-12-01' },
      workspace,
    }])),
    outbox: new Map(),
    locksHeld: 0,
    inTransaction: false,
    writes: 0,
    now: BASE_NOW,
  };
  let mutex = Promise.resolve();
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function messagesOf(workspace) {
    return workspace && Array.isArray(workspace.messages) ? workspace.messages : [];
  }

  async function answer(clientQuery, sql, params = []) {
    const text = String(sql);
    if (/SELECT e\.id FROM events/.test(text)) {
      const status = String(params[0]);
      const limit = Number(params[1]) || 50;
      const ids = [];
      for (const [id, entry] of state.events) {
        if (messagesOf(entry.workspace).some((m) => m && m.status === status)) ids.push(id);
        if (ids.length >= limit) break;
      }
      return { rows: ids.sort().map((id) => ({ id })) };
    }
    if (/FROM events e JOIN event_workspaces/.test(text) && /FOR UPDATE OF e,/.test(text)) {
      const entry = state.events.get(String(params[0]));
      if (!entry) return { rows: [] };
      return { rows: [{
        id: String(params[0]), slug: String(params[0]), client_id: null,
        payload: clone(entry.payload), revision: 1,
        workspace_payload: clone(entry.workspace), workspace_revision: 1,
      }] };
    }
    if (/FROM events e JOIN event_workspaces/.test(text) && /FOR UPDATE OF e(?![\w,])/.test(text)) {
      const entry = state.events.get(String(params[0]));
      if (!entry) return { rows: [] };
      return { rows: [{ id: String(params[0]), event_payload: clone(entry.payload), workspace_payload: clone(entry.workspace) }] };
    }
    if (/UPDATE message_outbox\s+SET status/.test(text)) {
      const limit = Number(params[0]) || 50;
      const due = [...state.outbox.values()]
        .filter((row) => (row.status === 'PENDING' || row.status === 'SENDING') && Date.parse(row.next_attempt_at) <= state.now)
        .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))
        .slice(0, limit);
      for (const row of due) {
        row.attempts += 1;
        row.status = 'SENDING';
        row.next_attempt_at = new Date(state.now + Math.min(row.attempts + 1, 12) * 5 * 60 * 1000).toISOString();
      }
      return { rows: due.map((row) => ({ message_id: row.message_id, event_id: row.event_id })) };
    }
    if (/INSERT INTO message_outbox/.test(text)) {
      const id = String(params[0]);
      state.outbox.set(id, {
        message_id: id, event_id: String(params[1]), status: 'PENDING', attempts: 0,
        next_attempt_at: new Date(state.now).toISOString(),
      });
      return { rowCount: 1 };
    }
    if (/DELETE FROM message_outbox/.test(text)) {
      state.outbox.delete(String(params[0]));
      return { rowCount: 1 };
    }
    if (/SELECT payload FROM event_workspaces/.test(text)) {
      const entry = state.events.get(String(params[0]));
      if (!entry) return { rows: [] };
      return { rows: [{ payload: clone(entry.workspace) }] };
    }
    if (/UPDATE event_workspaces SET payload/.test(text)) {
      const entry = state.events.get(String(params[0]));
      if (!entry) return { rowCount: 0 };
      entry.workspace = JSON.parse(String(params[1]));
      state.writes += 1;
      return { rowCount: 1 };
    }
    throw new Error(`unemulated SQL: ${text.slice(0, 140)}`);
  }

  async function tracked(sql, params) {
    if (/FOR UPDATE/.test(String(sql))) state.locksHeld += 1;
    return answer(tracked, sql, params);
  }

  return {
    state,
    outboxSize: () => state.outbox.size,
    message: (eventId = 'e-1', messageId = 'msg-1') =>
      messagesOf(state.events.get(eventId).workspace).find((m) => m && m.id === messageId),
    async query(sql, params) { return tracked(sql, params); },
    async transaction(fn) {
      const prev = mutex;
      let release;
      mutex = new Promise((resolve) => { release = resolve; });
      await prev;
      const outerTx = state.inTransaction;
      const outerLocks = state.locksHeld;
      state.inTransaction = true;
      try {
        return await fn({ query: (sql, params) => tracked(sql, params) });
      } finally {
        state.inTransaction = outerTx;
        if (!outerTx) state.locksHeld = outerLocks > 0 ? outerLocks : 0;
        release();
      }
    },
  };
}

function batchProvider(db, hooks = {}) {
  const calls = { sendBatch: 0, group: 0, poll: 0 };
  return {
    calls,
    state: { connected: true },
    async groupMessages(groupId) {
      calls.group += 1;
      assert.equal(db.state.locksHeld, 0, 'supplier consult must run with no event lock held');
      if (hooks.groupMessages) return hooks.groupMessages(groupId);
      return { ok: true, messages: {} };
    },
    async sendBatch(recipients) {
      calls.sendBatch += 1;
      if (hooks.sendBatch) return hooks.sendBatch(recipients);
      return {
        accepted: true,
        registered: recipients.map((r) => ({ participantId: r.participantId, accepted: true, type: 'SMS' })),
        rejected: [],
        groupId: 'G-NEW',
        deliveryUnconfirmed: true,
      };
    },
    async pollResults(ids) {
      calls.poll += 1;
      if (hooks.pollResults) return hooks.pollResults(ids);
      return { ok: true, results: Object.fromEntries(ids.map((id) => [id, { state: 'DELIVERED', type: 'SMS' }])) };
    },
  };
}

// --- gating ----------------------------------------------------------------

test('config-defaults-are-off', () => {
  assert.deepEqual(maintenanceConfig({}), { enabled: false, autoSendDue: false });
  assert.deepEqual(maintenanceConfig({ EVENTOUCH_MESSAGE_MAINTENANCE: '1' }), { enabled: true, autoSendDue: false });
  assert.deepEqual(
    maintenanceConfig({ EVENTOUCH_MESSAGE_MAINTENANCE: '1', EVENTOUCH_MESSAGE_AUTO_SEND_DUE: '1' }),
    { enabled: true, autoSendDue: true }
  );
  // Auto-send alone does not enable the worker.
  assert.deepEqual(maintenanceConfig({ EVENTOUCH_MESSAGE_AUTO_SEND_DUE: '1' }), { enabled: false, autoSendDue: true });
});

test('disabled-worker-changes-nothing', async () => {
  const db = makeMemoryDb({ 'e-1': workspaceWith([campaign()]) });
  const provider = batchProvider(db);
  const result = await runMessageMaintenance(db, provider, { enabled: false, now: NOW_ISO });
  assert.deepEqual(result, { skipped: true, reason: 'DISABLED' });
  assert.equal(provider.calls.sendBatch, 0);
  assert.equal(db.state.writes, 0);
  assert.equal(db.message().status, 'SCHEDULED');
});

test('disconnected-supplier-means-no-progress', async () => {
  const db = makeMemoryDb({ 'e-1': workspaceWith([campaign()]) });
  const provider = { ...batchProvider(db), state: { connected: false } };
  const result = await runMessageMaintenance(db, provider, { enabled: true, autoSendDue: true, now: NOW_ISO });
  assert.deepEqual(result, { skipped: true, reason: 'NOT_CONNECTED' });
  assert.equal(provider.calls.sendBatch, 0);
  assert.equal(db.state.writes, 0);
  assert.equal(db.outboxSize(), 0, 'not even an outbox row is queued');
  assert.equal(db.message().status, 'SCHEDULED');
});

// --- reporting vs sending ------------------------------------------------------

test('auto-send-off-only-reports-due-schedules', async () => {
  const db = makeMemoryDb({ 'e-1': workspaceWith([campaign()]) });
  const provider = batchProvider(db);
  const result = await runMessageMaintenance(db, provider, { enabled: true, autoSendDue: false, now: NOW_ISO });
  assert.equal(result.duePending, 1);
  assert.equal(result.enqueued, 0);
  assert.equal(db.message().status, 'SCHEDULED', 'manual reservation meaning is unchanged');
  assert.equal(db.outboxSize(), 0);
  assert.equal(provider.calls.sendBatch, 0);
});

test('future-schedules-are-not-due', async () => {
  const db = makeMemoryDb({ 'e-1': workspaceWith([campaign({ scheduled: FUTURE_ISO })]) });
  const provider = batchProvider(db);
  const result = await runMessageMaintenance(db, provider, { enabled: true, autoSendDue: true, now: NOW_ISO });
  assert.equal(result.duePending, 0);
  assert.equal(result.enqueued, 0);
  assert.equal(db.message().status, 'SCHEDULED');
  assert.equal(provider.calls.sendBatch, 0);
});

// --- full auto-send loop ---------------------------------------------------------

test('auto-send-enqueues-then-drains-then-resolves-in-one-pass', async () => {
  const db = makeMemoryDb({ 'e-1': workspaceWith([campaign({ providerGroupId: 'G-STALE' })]) });
  const provider = batchProvider(db, {
    groupMessages: async (groupId) => {
      // The stale group was never accepted; the fresh acceptance maps its id.
      if (groupId === 'G-STALE') return { ok: false, reason: 'NOT_FOUND' };
      return { ok: true, messages: { M7: { messageId: 'M7', to: '01011112222' } } };
    },
  });
  const result = await runMessageMaintenance(db, provider,
    { enabled: true, autoSendDue: true, now: NOW_ISO, eventIds: ['e-1'] });
  assert.equal(result.enqueued, 1);
  assert.equal(provider.calls.sendBatch, 1, 'the enqueued campaign is sent after commit');
  assert.equal(result.drain.dispatched, 1);
  assert.equal(result.resolved.resolved, 1);
  assert.equal(result.resolved.pending, 0);
  assert.equal(db.message().status, 'SENT');
  assert.equal(db.outboxSize(), 0);
});

// --- guards ----------------------------------------------------------------------

test('cancelled-campaigns-are-never-touched', async () => {
  const db = makeMemoryDb({ 'e-1': workspaceWith([campaign({ status: 'CANCELLED' })]) });
  const provider = batchProvider(db);
  const result = await runMessageMaintenance(db, provider, { enabled: true, autoSendDue: true, now: NOW_ISO });
  assert.equal(result.enqueued, 0);
  assert.equal(result.duePending, 0, 'cancelled is not due');
  assert.equal(provider.calls.sendBatch, 0);
  assert.equal(db.state.writes, 0);
});

test('ticket-link-guards-leave-the-campaign-scheduled', async () => {
  const previous = process.env.EVENTOUCH_PUBLIC_URL;
  delete process.env.EVENTOUCH_PUBLIC_URL;
  try {
    const db = makeMemoryDb({ 'e-1': workspaceWith([campaign({ body: '{{티켓링크}} 안내입니다.' })]) });
    const provider = batchProvider(db);
    const result = await runMessageMaintenance(db, provider, { enabled: true, autoSendDue: true, now: NOW_ISO });
    assert.equal(result.enqueued, 0);
    assert.deepEqual(result.skippedDue, [{ messageId: 'msg-1', reason: 'NO_PUBLIC_ORIGIN' }]);
    assert.equal(db.message().status, 'SCHEDULED', 'no broken text is ever sent');
    assert.equal(provider.calls.sendBatch, 0);
  } finally {
    if (previous === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
    else process.env.EVENTOUCH_PUBLIC_URL = previous;
  }
});

test('missing-lucky-numbers-leave-the-campaign-scheduled', async () => {
  const db = makeMemoryDb({ 'e-1': workspaceWith([campaign({ body: '{{럭키번호}} 안내입니다.' })]) });
  const provider = batchProvider(db);
  const result = await runMessageMaintenance(db, provider, { enabled: true, autoSendDue: true, now: NOW_ISO });
  assert.equal(result.enqueued, 0);
  assert.deepEqual(result.skippedDue, [{ messageId: 'msg-1', reason: 'LUCKY_NUMBER_MISSING' }]);
  assert.equal(db.message().status, 'SCHEDULED');
  assert.equal(provider.calls.sendBatch, 0);
});

// --- unknown supplier answers ------------------------------------------------------

test('unknown-group-verdict-keeps-the-row-queued-on-backoff', async () => {
  const sending = { ...campaign({ providerGroupId: 'G-1' }), status: 'SENDING' };
  const db = makeMemoryDb({ 'e-1': workspaceWith([sending]) });
  db.state.outbox.set('msg-1', {
    message_id: 'msg-1', event_id: 'e-1', status: 'PENDING', attempts: 0,
    next_attempt_at: new Date(BASE_NOW - 1000).toISOString(),
  });
  const provider = batchProvider(db, { groupMessages: async () => ({ ok: false, reason: 'RATE_LIMITED', status: 429 }) });
  const result = await runMessageMaintenance(db, provider, { enabled: true, autoSendDue: true, now: NOW_ISO });
  assert.equal(provider.calls.sendBatch, 0, 'unknown must not send');
  assert.equal(result.drain.deferred, 1);
  assert.equal(db.outboxSize(), 1, 'the row stays queued');
  assert.equal(db.message().status, 'SENDING');
});

// --- concurrency ---------------------------------------------------------------------

test('two-concurrent-workers-send-once', async () => {
  const db = makeMemoryDb({ 'e-1': workspaceWith([campaign()]) });
  const provider = batchProvider(db, {
    groupMessages: async () => ({ ok: true, messages: { M7: { messageId: 'M7', to: '01011112222' } } }),
  });
  const options = { enabled: true, autoSendDue: true, now: NOW_ISO, eventIds: ['e-1'] };
  const [first, second] = await Promise.all([
    runMessageMaintenance(db, provider, options),
    runMessageMaintenance(db, provider, options),
  ]);
  assert.equal(first.enqueued + second.enqueued, 1, 'one worker wins the enqueue');
  assert.equal(provider.calls.sendBatch, 1, 'one send total across both workers');
  assert.equal(db.outboxSize(), 0);
});
