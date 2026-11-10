'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL' }, fn);

test('booth mode changes require reliable visit evidence and the reviewed prior mode', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `mode-${suffix}`, manager = `manager-${suffix}`, restricted = `restricted-${suffix}`;
    for (const id of [manager, restricted]) await insertAccount(h.database, { id, role: 'MANAGER', name: '합성 운영자', email: `${id}@example.test`, orgId: LEGACY_ORG });
    const workspace = emptyWorkspace(); workspace.visits = { preserved: '불명확한 기록' };
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: ['stamp'], capacity: 100 }, workspace });
    await insertMembership(h.database, manager, eventId, ['booth']);
    await insertMembership(h.database, restricted, eventId, ['onsite']);
    const cookie = await sessionCookie(h, manager), restrictedCookie = await sessionCookie(h, restricted);
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const write = async value => h.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [eventId, JSON.stringify(value)]);
    const send = (command, payload, id = crypto.randomUUID(), as = cookie) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie: as, body: { commandId: id, command, payload },
    });
    const boot = async () => (await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie })).json.state.workspaces[eventId];

    const legacy = await send('booth.mode', { mode: 'SELF', acknowledge: true });
    assert.equal(legacy.status, 409, 'unknown evidence cannot become an empty visit list');
    assert.equal(legacy.json.code, 'BOOTH_VISITS_UNAVAILABLE');
    assert.deepEqual(await read(), workspace);
    assert.equal((await boot()).boothVisitsAvailable, false);

    const repaired = await read(); repaired.visits = []; await write(repaired);
    assert.equal((await boot()).boothVisitsAvailable, true);
    const input = { expectedMode: 'STAFF', mode: 'SELF', acknowledge: true };
    assert.equal((await send('booth.mode-reviewed', input, crypto.randomUUID(), restrictedCookie)).status, 403);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const outcomes = await Promise.all(ids.map(id => send('booth.mode-reviewed', input, id)));
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409], 'a stale second review cannot overwrite the first');
    const first = outcomes[0].status === 200 ? outcomes[0] : outcomes[1];
    const firstId = ids[outcomes.findIndex(result => result.status === 200)];
    const replay = await send('booth.mode-reviewed', input, firstId);
    assert.deepEqual(replay.json, first.json);
    assert.equal((await send('booth.mode-reviewed', { ...input, expectedMode: 'SELF', mode: 'STAFF' }, firstId)).status, 409, 'receipt cannot certify another choice');
    const changed = await read(); assert.equal(changed.stampMode, 'SELF');
    changed.visits = [{ id: 'existing-visit', participantId: 'person', boothId: 'booth' }]; await write(changed);
    assert.deepEqual((await send('booth.mode-reviewed', input, firstId)).json, first.json, 'committed receipt replays after visits appear');
    const visitBlocked = await send('booth.mode-reviewed', { expectedMode: 'SELF', mode: 'STAFF', acknowledge: true });
    assert.equal(visitBlocked.status, 409); assert.equal((await read()).stampMode, 'SELF');
    const malformed = await read(); malformed.visits = []; malformed.stampMode = null; await write(malformed);
    assert.equal((await send('booth.mode', { mode: 'STAFF', acknowledge: true })).status, 409, 'unknown current mode cannot be guessed');
    assert.equal((await boot()).stampMode, null);
    delete malformed.visits; delete malformed.stampMode; await write(malformed);
    assert.equal((await boot()).boothVisitsAvailable, true, 'legacy absent visits retain empty-list semantics');
    assert.equal((await send('booth.mode-reviewed', input)).status, 200, 'legacy absent mode retains the STAFF default');
  } finally { await h.close(); }
});
