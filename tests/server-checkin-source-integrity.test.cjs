'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('attendance writes require readable participant and check sources, while committed receipts remain replayable', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `source-${suffix}`, manager = `manager-${suffix}`, staff = `staff-${suffix}`;
    const participant = { id: 'person', name: '합성 참가자', company: '합성 회사', phone: '01055556666', status: 'APPROVED',
      inside: false, everIn: false, revoked: false, ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString(), paymentStatus: 'FREE' };
    const workspace = emptyWorkspace(); workspace.participants = [participant];
    workspace.desks = [{ id: 'in', name: '입장', action: 'IN', mode: 'desk', open: true }];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertAccount(h.database, { id: staff, role: 'STAFF', name: '합성 스태프', email: `${staff}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace });
    await insertMembership(h.database, manager, eventId, ['all']);
    await insertAssignment(h.database, { id: 'assignment-in', accountId: staff, eventId, type: 'DESK', targetId: 'in' });
    const cookie = await sessionCookie(h, staff), managerCookie = await sessionCookie(h, manager);
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const save = current => h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(current)]);
    const commandId = crypto.randomUUID();
    const send = (id = commandId) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie, body: { commandId: id, command: 'check.scan', assignmentId: 'assignment-in',
        payload: { deskId: 'in', ticket: participant.ticket, expectedAction: 'IN' } },
    });
    for (const [field, value] of [['checks', [null]], ['checks', [{}]], ['checks', { original: '확인 불가' }], ['participants', [participant, null]], ['participants', [participant, {}]], ['participants', null]]) {
      const damaged = structuredClone(workspace); damaged[field] = value; await save(damaged);
      const reply = await send();
      assert.equal(reply.status, 409, `${field}: an unavailable source must reject a new check-in`);
      assert.equal(reply.json.code, 'CHECK_SOURCE_UNAVAILABLE');
      assert.deepEqual(await read(), damaged, 'denied requests leave all sources intact');
      assert.equal((await h.database.query('SELECT command_id FROM command_receipts WHERE command_id=$1', [commandId])).rowCount, 0);
      for (const endpoint of ['/api/bootstrap', `/api/events/${eventId}/bootstrap`]) {
        const response = await requestJson(h.baseUrl, endpoint, { cookie });
        assert.equal(response.status, 200, `staff can read a safe projection of ${field}`);
        const projection = response.json.state.workspaces[eventId];
        assert.equal(projection[`${field}Available`], false);
        assert.deepEqual(projection[field], []);
      }
      for (const command of ['check.correct', 'check.reviewed-exit', 'check.reconcile']) {
        const blocked = await requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
          method: 'POST', cookie: managerCookie, body: { commandId: crypto.randomUUID(), command, payload: {} },
        });
        assert.equal(blocked.status, 409, command);
        assert.equal(blocked.json.code, 'CHECK_SOURCE_UNAVAILABLE');
      }
    }
    await save(workspace);
    assert.equal((await send()).status, 200, 'the same request succeeds after repair');
    const committed = await read(); assert.equal(committed.checks.length, 1);
    committed.checks.push(null); await save(committed);
    const replay = await send();
    assert.equal(replay.status, 200, 'a committed request still replays');
    assert.equal(replay.json.recordStatus, 'UNAVAILABLE', 'receipt does not assert current attendance is known');
    assert.deepEqual(await read(), committed, 'replay never changes the damaged source');
  } finally { await h.close(); }
});
