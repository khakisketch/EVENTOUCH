'use strict';

// Synthetic PostgreSQL races around cancellation, verified recovery and
// signup receipts. Barriers hold the real query inside its transaction.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { databaseUrl, startApiHarness, insertEvent, insertAccount, insertMembership,
  sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { mockOutbox, clearMockOutbox } = require('../server/verification-transport');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);
const commandId = () => crypto.randomUUID();
const cookieOf = response => (response.headers.get('set-cookie') || '').split(';')[0];

async function fixture() {
  process.env.EVENTOUCH_SMS_MOCK = '1';
  const h = await startApiHarness();
  const fields = [{ id: 'name', label: '이름', type: 'text', required: true, options: [] },
    { id: 'phone', label: '연락처', type: 'text', required: true, options: [] }];
  for (const slug of ['race-event-a', 'race-event-b']) {
    await insertEvent(h.database, { id: slug, slug, orgId: LEGACY_ORG,
      payload: { id: slug, slug, name: slug, date: '2099-01-01', stage: 'READY', capacity: 50 },
      workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
        formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '동의',
        consentVersion: 1, price: 0, verificationRequired: false },
    });
  }
  await insertAccount(h.database, { id: 'race-manager', role: 'MANAGER', name: '합성 운영자',
    email: 'race-manager@example.test', orgId: LEGACY_ORG });
  for (const slug of ['race-event-a', 'race-event-b']) await insertMembership(h.database, 'race-manager', slug, ['all']);
  const manager = await sessionCookie(h, 'race-manager');
  const call = (url, options = {}) => requestJson(h.baseUrl, url, options);
  const signup = (slug, name, phone, cookie, id = commandId()) => call(`/api/events/${slug}/signup`, {
    method: 'POST', cookie, body: { commandId: id, formVersion: 1, consent: true, name, phone },
  });
  const status = (slug, ids, target, id = commandId()) => call(`/api/events/${slug}/commands`, {
    method: 'POST', cookie: manager, body: { commandId: id, command: 'participant.status', payload: { ids, status: target } },
  });
  const ticket = (slug, cookie) => call(`/api/public/events/${slug}/ticket`, { cookie });
  const code = async (slug, phone) => {
    clearMockOutbox();
    const sent = await call(`/api/public/events/${slug}/verification/request`, { method: 'POST', body: { phone, purpose: 'RECOVER' } });
    assert.equal(sent.status, 200);
    const value = mockOutbox.findLast(item => item.to === phone)?.code;
    assert.ok(value, 'the synthetic provider accepted a verification code');
    return value;
  };
  const confirm = (slug, phone, value, cookie) => call(`/api/public/events/${slug}/verification/confirm`, {
    method: 'POST', cookie, body: { phone, code: value },
  });
  return { h, call, signup, status, ticket, code, confirm, manager };
}

// Intercept either legacy database.query or a transactional client.query.
// The new implementation holds its actual event row lock during the pause.
function barrier(database, predicate) {
  const originalTx = database.transaction.bind(database);
  const originalQuery = database.query.bind(database);
  let notify, resume;
  const entered = new Promise(resolve => { notify = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  let armed = true;
  async function maybe(sql) {
    if (armed && typeof sql === 'string' && predicate(sql)) { armed = false; notify(); await released; }
  }
  database.query = async (sql, args) => { await maybe(sql); return originalQuery(sql, args); };
  database.transaction = fn => originalTx(async client => {
    const original = client.query;
    client.query = async function(sql, ...args) { await maybe(sql); return original.call(this, sql, ...args); };
    try { return await fn(client); } finally { client.query = original; }
  });
  return { entered, resume, restore() { database.transaction = originalTx; database.query = originalQuery; } };
}
async function waitEntered(value) {
  let timer;
  try { await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('query barrier not reached')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function isPending(promise) {
  let timer;
  try { return await Promise.race([promise.then(() => false), new Promise(resolve => { timer = setTimeout(() => resolve(true), 200); })]); }
  finally { clearTimeout(timer); }
}

test('a delayed cancellation cannot remove a newer reauthentication', async () => {
  const f = await fixture(); let gate;
  try {
    const phone = '01097001001';
    const a = await f.signup('race-event-a', '첫 행사 참가자', phone);
    assert.equal(a.status, 201);
    const originalCookie = cookieOf(a);
    const b = await f.signup('race-event-b', '다른 행사 참가자', phone, originalCookie);
    assert.equal(b.status, 201);
    const sharedCookie = `${originalCookie}; ${cookieOf(b)}`;
    const oldCode = await f.code('race-event-a', phone);
    gate = barrier(f.h.database, sql => sql.startsWith('UPDATE attendee_sessions SET grants = (') ||
      sql.includes('SELECT token_hash FROM attendee_sessions'));
    const cancelId = commandId();
    const cancelled = f.status('race-event-a', [a.json.participant.id], 'CANCELLED', cancelId);
    await waitEntered(gate.entered);
    const approved = f.status('race-event-a', [a.json.participant.id], 'APPROVED');
    assert.equal(await isPending(approved), true, 'reapproval must wait until old session revocation commits');
    gate.resume();
    assert.equal((await cancelled).status, 200);
    assert.equal((await approved).status, 200);
    gate.restore(); gate = null;
    assert.equal((await f.ticket('race-event-b', sharedCookie)).status, 200, 'other event remains connected');
    assert.equal((await f.confirm('race-event-a', phone, oldCode, sharedCookie)).status, 401, 'pre-cancellation code is invalid');
    const freshCode = await f.code('race-event-a', phone);
    const fresh = await f.confirm('race-event-a', phone, freshCode, sharedCookie);
    assert.equal(fresh.status, 200);
    const freshCookie = `${cookieOf(fresh)}; ${cookieOf(b)}`;
    assert.equal((await f.ticket('race-event-a', freshCookie)).status, 200);
    assert.equal((await f.ticket('race-event-b', freshCookie)).status, 200);
    // Reapproval replaces the old ticket, so the original cancellation
    // receipt is superseded; it must not revoke the new session again.
    assert.equal((await f.status('race-event-a', [a.json.participant.id], 'CANCELLED', cancelId)).status, 409);
    assert.equal((await f.ticket('race-event-a', freshCookie)).status, 200);
  } finally { gate?.resume(); gate?.restore(); clearMockOutbox(); await f.h.close(); }
});

test('recovery confirmation and session creation serialize before cancellation', async () => {
  const f = await fixture(); let gate;
  try {
    const phone = '01097001002';
    const a = await f.signup('race-event-a', '인증 참가자', phone);
    assert.equal(a.status, 201);
    const cookie = cookieOf(a);
    const value = await f.code('race-event-a', phone);
    gate = barrier(f.h.database, sql => sql.startsWith('UPDATE attendee_sessions SET\n'));
    const confirming = f.confirm('race-event-a', phone, value, cookie);
    await waitEntered(gate.entered);
    const cancelling = f.status('race-event-a', [a.json.participant.id], 'CANCELLED');
    assert.equal(await isPending(cancelling), true, 'cancellation waits for in-flight verified session transaction');
    gate.resume();
    const confirmed = await confirming;
    assert.equal(confirmed.status, 200);
    assert.equal((await cancelling).status, 200);
    gate.restore(); gate = null;
    assert.equal((await f.ticket('race-event-a', cookie)).status, 404);
    assert.equal((await f.status('race-event-a', [a.json.participant.id], 'APPROVED')).status, 200);
    const oldBearer = await f.call('/api/public/events/race-event-a/ticket', { bearer: confirmed.json.ticket });
    assert.equal(oldBearer.status, 404, 'old verified bearer cannot become the reissued ticket');
    assert.equal((await f.ticket('race-event-a', cookie)).status, 404, 'the old session does not resurrect');
  } finally { gate?.resume(); gate?.restore(); clearMockOutbox(); await f.h.close(); }
});

test('signup session write failure preserves the participant receipt and can recover on replay', async () => {
  const f = await fixture();
  const transaction = f.h.database.transaction.bind(f.h.database);
  let injected = false;
  try {
    f.h.database.transaction = fn => transaction(async client => {
      const original = client.query;
      client.query = async function(sql, ...args) {
        if (!injected && typeof sql === 'string' && sql.includes('INSERT INTO attendee_sessions')) {
          injected = true;
          return original.call(this, 'SELECT 1 / 0');
        }
        return original.call(this, sql, ...args);
      };
      try { return await fn(client); } finally { client.query = original; }
    });
    const id = commandId();
    const first = await f.signup('race-event-a', '저장된 참가자', '01097001003', undefined, id);
    assert.equal(first.status, 201);
    assert.equal(cookieOf(first), '');
    assert.ok(first.json.participant.ticket);
    const replay = await f.signup('race-event-a', '저장된 참가자', '01097001003', undefined, id);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.participant.id, first.json.participant.id);
    assert.ok(replay.json.participant.ticket === first.json.participant.ticket);
    assert.match(cookieOf(replay), /^etko_attendee_[a-f0-9]{24}=/);
    assert.equal((await f.ticket('race-event-a', cookieOf(replay))).status, 200);
    const state = (await f.h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', ['race-event-a'])).rows[0].payload;
    assert.equal(state.participants.length, 1);
  } finally { f.h.database.transaction = transaction; clearMockOutbox(); await f.h.close(); }
});

test('changing the phone away and back never revives the old browser grant or code', async () => {
  const f = await fixture();
  try {
    const phone = '01097001004'; const changed = '01097001005';
    const a = await f.signup('race-event-a', '연락처 변경 참가자', phone);
    assert.equal(a.status, 201);
    const cookie = cookieOf(a);
    const oldCode = await f.code('race-event-a', phone);
    const updateId = commandId();
    const update = (number, id = commandId()) => f.call('/api/events/race-event-a/commands', {
      method: 'POST', cookie: f.manager, body: { commandId: id, command: 'participant.update', payload: { id: a.json.participant.id, phone: number } },
    });
    assert.equal((await update(changed, updateId)).status, 200);
    assert.equal((await f.ticket('race-event-a', cookie)).status, 404);
    assert.equal((await update(phone)).status, 200);
    assert.equal((await f.ticket('race-event-a', cookie)).status, 404);
    assert.equal((await f.confirm('race-event-a', phone, oldCode, cookie)).status, 401);
    const fresh = await f.confirm('race-event-a', phone, await f.code('race-event-a', phone), cookie);
    assert.equal(fresh.status, 200);
    const freshCookie = cookieOf(fresh);
    assert.equal((await f.ticket('race-event-a', freshCookie)).status, 200);
    await update(changed, updateId); // receipt replay, not a fresh phone change
    assert.equal((await f.ticket('race-event-a', freshCookie)).status, 200);
  } finally { clearMockOutbox(); await f.h.close(); }
});

test('two events cancel shared sessions in a common lock order without deadlock', async () => {
  const f = await fixture();
  const transaction = f.h.database.transaction.bind(f.h.database);
  let release, notify; let arrivals = 0;
  const both = new Promise(resolve => { notify = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  try {
    const people = [];
    for (const [name, phone] of [['첫 참가자', '01097001006'], ['둘째 참가자', '01097001007']]) {
      const a = await f.signup('race-event-a', name, phone);
      const b = await f.signup('race-event-b', name, phone, cookieOf(a));
      assert.equal(a.status, 201); assert.equal(b.status, 201);
      people.push({ a: a.json.participant.id, b: b.json.participant.id, cookie: cookieOf(b) });
    }
    f.h.database.transaction = fn => transaction(async client => {
      const original = client.query;
      client.query = async function(sql, ...args) {
        if (typeof sql === 'string' && sql.includes('SELECT token_hash FROM attendee_sessions')) {
          arrivals += 1; if (arrivals === 2) notify(); await released;
        }
        return original.call(this, sql, ...args);
      };
      try { return await fn(client); } finally { client.query = original; }
    });
    const first = f.status('race-event-a', people.map(p => p.a), 'CANCELLED');
    const second = f.status('race-event-b', people.map(p => p.b), 'CANCELLED');
    await waitEntered(both);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    for (const person of people) {
      assert.equal((await f.ticket('race-event-a', person.cookie)).status, 404);
      assert.equal((await f.ticket('race-event-b', person.cookie)).status, 404);
    }
  } finally { if (release) release(); f.h.database.transaction = transaction; clearMockOutbox(); await f.h.close(); }
});

test('a session revocation error rolls back cancellation and its receipt', async () => {
  const f = await fixture();
  const transaction = f.h.database.transaction.bind(f.h.database);
  let injected = false;
  try {
    const a = await f.signup('race-event-a', '롤백 참가자', '01097001008');
    assert.equal(a.status, 201);
    const cookie = cookieOf(a);
    f.h.database.transaction = fn => transaction(async client => {
      const original = client.query;
      client.query = async function(sql, ...args) {
        if (!injected && typeof sql === 'string' && sql.includes('SELECT token_hash FROM attendee_sessions')) {
          injected = true; return original.call(this, 'SELECT 1 / 0');
        }
        return original.call(this, sql, ...args);
      };
      try { return await fn(client); } finally { client.query = original; }
    });
    const id = commandId();
    assert.equal((await f.status('race-event-a', [a.json.participant.id], 'CANCELLED', id)).status, 500);
    assert.equal((await f.ticket('race-event-a', cookie)).status, 200);
    const row = (await f.h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', ['race-event-a'])).rows[0];
    assert.equal(row.payload.participants[0].status, 'APPROVED');
    const receipt = await f.h.database.query('SELECT command_id FROM command_receipts WHERE command_id=$1', [id]);
    assert.equal(receipt.rowCount, 0);
    assert.equal((await f.status('race-event-a', [a.json.participant.id], 'CANCELLED', id)).status, 200);
    assert.equal((await f.ticket('race-event-a', cookie)).status, 404);
  } finally { f.h.database.transaction = transaction; clearMockOutbox(); await f.h.close(); }
});

test('a verified number never returns a ticket from an archived event', async () => {
  const f = await fixture();
  try {
    const phone = '01097001009';
    assert.equal((await f.signup('race-event-a', '보관 행사 참가자', phone)).status, 201);
    const value = await f.code('race-event-a', phone);
    await f.h.database.query("UPDATE events SET payload = jsonb_set(payload, '{stage}', '\"ARCHIVED\"') WHERE id = $1", ['race-event-a']);
    const result = await f.confirm('race-event-a', phone, value);
    assert.notEqual(result.status, 200);
    assert.equal(typeof result.json?.ticket, 'undefined');
    assert.equal(cookieOf(result), '');
  } finally { clearMockOutbox(); await f.h.close(); }
});
