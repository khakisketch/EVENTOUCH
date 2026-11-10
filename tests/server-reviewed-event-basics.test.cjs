'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { COMMANDS } = require('../server/commands/domain');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

test('reviewed event basics fails closed on old routing and binds retries to the reviewed request', async () => {
  const h = await startApiHarness();
  try {
    const id = `basics-${crypto.randomUUID()}`, manager = `manager-${crypto.randomUUID()}`, reader = `reader-${crypto.randomUUID()}`;
    const date = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const beforeExpiry = new Date(Date.now() + 100 * 86400000).toISOString();
    const w = emptyWorkspace();
    w.participants = [{ id: 'p', name: '합성 참가자', phone: '01000000001', status: 'APPROVED', paymentStatus: 'FREE',
      ticket: crypto.randomBytes(32).toString('base64url'), ticketRevision: 0, revoked: false, ticketExpiresAt: beforeExpiry }];
    const base = { name: '합성 행사', slug: id, clientId: '', date: date(1), start: '09:00', end: '17:00', capacity: 100,
      price: 0, format: '', approvalRequired: false, allowReentry: true, verificationRequired: false };
    for (const account of [manager, reader]) {
      await insertAccount(h.database, { id: account, role: 'MANAGER', name: '합성 운영자', email: `${account}@example.test`, orgId: LEGACY_ORG });
    }
    await insertEvent(h.database, { id, slug: id, orgId: LEGACY_ORG, payload: { id, ...base, stage: 'READY', features: [] }, workspace: w });
    await insertMembership(h.database, manager, id, ['all']);
    await insertMembership(h.database, reader, id, []);
    const cookie = await sessionCookie(h, manager), readCookie = await sessionCookie(h, reader);
    const send = (command, payload, commandId = crypto.randomUUID(), auth = cookie) => requestJson(h.baseUrl, `/api/events/${id}/commands`,
      { method: 'POST', cookie: auth, body: { commandId, command, payload } });
    const read = async () => (await h.database.query('SELECT e.payload AS event, w.payload AS workspace FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1', [id])).rows[0];
    const payload = { ...base, date: date(180), expectedBasics: base };
    const sameId = crypto.randomUUID();
    assert.ok(COMMANDS.has('event.basics.save'));
    COMMANDS.delete('event.basics.save'); // Model an old router in a mixed deployment.
    const oldResponse = await send('event.basics.save', payload, sameId);
    assert.equal(oldResponse.status, 400); assert.equal(oldResponse.json.field, 'command');
    let state = await read(); assert.equal(state.event.date, base.date); assert.equal(state.workspace.participants[0].ticketExpiresAt, beforeExpiry);
    COMMANDS.add('event.basics.save');
    assert.equal((await send('event.basics.save', payload, crypto.randomUUID(), readCookie)).status, 403);
    const missing = await send('event.basics.save', { ...base, expectedBasics: undefined });
    assert.equal(missing.status, 400); assert.equal(missing.json.field, 'expectedBasics');
    const saved = await send('event.basics.save', payload, sameId);
    assert.equal(saved.status, 200, JSON.stringify(saved.json)); assert.equal(saved.json.ticketPolicyVersion, 1);
    assert.deepEqual(saved.json.ticketImpact, { extended: 1, review: 0 });
    state = await read(); assert.equal(state.event.date, payload.date); assert.ok(Date.parse(state.workspace.participants[0].ticketExpiresAt) > Date.parse(`${payload.date}T09:00:00+09:00`));
    const stale = await send('event.basics.save', { ...payload, name: '오래된 값' });
    assert.equal(stale.status, 409); assert.equal(stale.json.code, 'EVENT_BASICS_CHANGED');
    COMMANDS.delete('event.basics.save'); // A later retry can hit a stale API instance.
    assert.equal((await send('event.basics.save', payload, sameId)).status, 400);
    COMMANDS.add('event.basics.save');
    const retry = await send('event.basics.save', payload, sameId);
    assert.equal(retry.status, 200); assert.deepEqual(retry.json, saved.json);
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    reordered.expectedBasics = Object.fromEntries(Object.entries(payload.expectedBasics).reverse());
    assert.deepEqual((await send('event.basics.save', reordered, sameId)).json, saved.json, 'JSON key order does not change the same request');
    await h.database.query('UPDATE memberships SET write_permissions=$3::jsonb WHERE account_id=$1 AND event_id=$2', [manager, id, JSON.stringify([])]);
    const afterGrantRevoked = await send('event.basics.save', payload, sameId);
    assert.equal(afterGrantRevoked.status, 200, 'receipt replay precedes a revoked write grant');
    assert.deepEqual(afterGrantRevoked.json, saved.json);
    assert.equal((await send('event.basics.save', payload)).status, 403, 'a new write still requires settings permission');
    await h.database.query('UPDATE memberships SET write_permissions=$3::jsonb WHERE account_id=$1 AND event_id=$2', [manager, id, JSON.stringify(['all'])]);
    const changed = await send('event.basics.save', { ...payload, approvalRequired: true }, sameId);
    assert.equal(changed.status, 409); assert.equal(changed.json.code, 'EVENT_BASICS_RECEIPT_MISMATCH');
    const legacy = await send('event.update', { ...base, date: payload.date, name: '이전 클라이언트' });
    assert.equal(legacy.status, 200); assert.equal((await read()).event.name, '이전 클라이언트');
  } finally { COMMANDS.add('event.basics.save'); await h.close(); }
});
