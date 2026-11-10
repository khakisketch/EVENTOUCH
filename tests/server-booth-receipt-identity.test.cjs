'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertAssignment,
  insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name,
  { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('booth visit receipts identify the original participant, booth and assignment', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID();
    const staffId = `booth-staff-${suffix}`, managerId = `booth-manager-${suffix}`;
    const person = (id, ticket) => ({ id, ticket, name: `합성 ${id}`, status: 'APPROVED', inside: true,
      paymentStatus: 'FREE', ticketExpiresAt: '2999-01-01T00:00:00Z' });
    const a = person('person-a', `synthetic-ticket-a-${suffix}`);
    const b = person('person-b', `synthetic-ticket-b-${suffix}`);
    const makeEvent = async (id, mode) => {
      const ws = emptyWorkspace();
      ws.stampMode = mode;
      ws.booths = [{ id:'a', name:'부스 A', status:'OPEN', used:0, capacity:0, limit:20 },
        { id:'b', name:'부스 B', status:'OPEN', used:0, capacity:0, limit:20 }];
      ws.participants = [a, b];
      await insertEvent(h.database, { orgId: LEGACY_ORG, id, slug:id,
        payload:{ id, slug:id, name:'합성 행사', stage:'LIVE', features:['stamp'] }, workspace:ws });
    };
    await insertAccount(h.database, { id:staffId, role:'STAFF', name:'합성 스태프', email:`${staffId}@example.test`, orgId:LEGACY_ORG });
    await insertAccount(h.database, { id:managerId, role:'MANAGER', name:'합성 운영자', email:`${managerId}@example.test`, orgId:LEGACY_ORG });
    const staffEvent = `booth-staff-event-${suffix}`, selfEvent = `booth-self-event-${suffix}`;
    await makeEvent(staffEvent,'STAFF'); await makeEvent(selfEvent,'SELF');
    await insertAssignment(h.database, { id:`assignment-a-${suffix}`, accountId:staffId, eventId:staffEvent, type:'BOOTH', targetId:'a' });
    await insertAssignment(h.database, { id:`assignment-b-${suffix}`, accountId:staffId, eventId:staffEvent, type:'BOOTH', targetId:'b' });
    await insertMembership(h.database, managerId, staffEvent, ['all']);
    const staff = await sessionCookie(h, staffId), manager = await sessionCookie(h, managerId);
    const command = (eventId, commandId, payload, { cookie, bearer, assignmentId } = {}) => requestJson(h.baseUrl,
      `/api/events/${eventId}/commands`, { method:'POST', cookie, bearer,
        body:{ command:'booth.visit', commandId, assignmentId, payload } });
    const read = async (id) => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[id])).rows[0].payload;
    const receipt = async (id) => (await h.database.query('SELECT result FROM command_receipts WHERE command_id=$1',[id])).rows[0].result;
    const legacy = async (id) => h.database.query(
      `UPDATE command_receipts SET result = (result - 'boothRequest') || jsonb_build_object('response', (result->'response') - 'visitId' - 'boothId' - 'participantId') WHERE command_id=$1`, [id]);
    const assignmentA = `assignment-a-${suffix}`, assignmentB = `assignment-b-${suffix}`;
    const firstId = crypto.randomUUID(), firstPayload = { boothId:'a', ticket:a.ticket };
    const first = await command(staffEvent, firstId, firstPayload, {cookie:staff, assignmentId:assignmentA});
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.deepEqual({visitId:first.json.visitId, boothId:first.json.boothId, participantId:first.json.participantId},
      {visitId:firstId, boothId:'a', participantId:a.id});
    assert.deepEqual((await command(staffEvent, firstId, firstPayload, {cookie:staff, assignmentId:assignmentA})).json, first.json);
    for (const [payload, assignmentId] of [
      [{boothId:'a', ticket:b.ticket}, assignmentA],
      [{boothId:'b', ticket:a.ticket}, assignmentB],
    ]) {
      const mismatch = await command(staffEvent, firstId, payload, {cookie:staff, assignmentId});
      assert.equal(mismatch.status, 409, JSON.stringify(mismatch.json));
      assert.equal(mismatch.json.code,'BOOTH_RECEIPT_MISMATCH');
    }
    assert.equal((await read(staffEvent)).visits.length,1);
    const saved = await receipt(firstId);
    assert.equal(saved.boothRequest.boothId,'a');
    assert.equal(saved.boothRequest.assignmentId,assignmentA);
    assert.match(saved.boothRequest.ticketHash,/^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(saved).includes(a.ticket),false, 'receipt must not store a ticket bearer');

    // Competing retries with one id serialize under the command lock.
    const raceId=crypto.randomUUID();
    const raced = await Promise.all([
      command(staffEvent,raceId,{boothId:'a',ticket:a.ticket},{cookie:staff,assignmentId:assignmentA}),
      command(staffEvent,raceId,{boothId:'b',ticket:b.ticket},{cookie:staff,assignmentId:assignmentB}),
    ]);
    assert.deepEqual(raced.map((r)=>r.status).sort(),[201,409]);
    assert.equal((await read(staffEvent)).visits.length,2);

    const exactRaceId=crypto.randomUUID();
    const exactRace = await Promise.all([
      command(staffEvent,exactRaceId,firstPayload,{cookie:staff,assignmentId:assignmentA}),
      command(staffEvent,exactRaceId,firstPayload,{cookie:staff,assignmentId:assignmentA}),
    ]);
    assert.deepEqual(exactRace.map((r)=>r.status).sort(),[200,201]);
    assert.deepEqual(exactRace[0].json,exactRace[1].json);
    assert.equal((await read(staffEvent)).visits.length,3);

    const selfId=crypto.randomUUID();
    const selfPayload={code:`ET:BOOTH:${selfEvent}:a`};
    const selfFirst=await command(selfEvent,selfId,selfPayload,{bearer:a.ticket});
    assert.equal(selfFirst.status,201,JSON.stringify(selfFirst.json));
    assert.deepEqual((await command(selfEvent,selfId,selfPayload,{bearer:a.ticket})).json,selfFirst.json);
    const selfOther = await command(selfEvent,selfId,{code:`ET:BOOTH:${selfEvent}:b`},{bearer:a.ticket});
    assert.equal(selfOther.status,409); assert.equal(selfOther.json.code,'BOOTH_RECEIPT_MISMATCH');
    assert.equal((await command(selfEvent,selfId,selfPayload,{bearer:b.ticket})).status,409);
    assert.equal((await read(selfEvent)).visits.length,1);

    // Lost committed response remains replayable after the feature/booth
    // was closed: receipt comparison precedes the mutable event guards.
    const current=await read(staffEvent); current.booths[0].status='CLOSED';
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[staffEvent,JSON.stringify(current)]);
    const replayAfterClose=await command(staffEvent,firstId,firstPayload,{cookie:staff,assignmentId:assignmentA});
    assert.equal(replayAfterClose.status,200); assert.deepEqual(replayAfterClose.json,first.json);

    // Legacy SELF receipts can be proved from the row and the bound guest
    // token; old STAFF receipts did not retain which assignment was used.
    await legacy(selfId);
    const legacySelf=await command(selfEvent,selfId,selfPayload,{bearer:a.ticket});
    assert.equal(legacySelf.status,200);
    assert.deepEqual(legacySelf.json,selfFirst.json, 'proven legacy receipt must expose verified visit identifiers');
    assert.equal((await command(selfEvent,selfId,{code:`ET:BOOTH:${selfEvent}:b`},{bearer:a.ticket})).status,409);
    await legacy(firstId);
    assert.equal((await command(staffEvent,firstId,firstPayload,{cookie:staff,assignmentId:assignmentA})).status,409);

    // A legacy operator request without an assignment can be confirmed only
    // while its stored visit identifies the same person, booth and actor.
    const managerWs=await read(staffEvent); managerWs.booths[0].status='OPEN';
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[staffEvent,JSON.stringify(managerWs)]);
    const managerCommand=crypto.randomUUID();
    const managerResult=await command(staffEvent,managerCommand,firstPayload,{cookie:manager});
    assert.equal(managerResult.status,201,JSON.stringify(managerResult.json));
    await h.database.query("UPDATE memberships SET write_permissions='[]'::jsonb WHERE account_id=$1 AND event_id=$2",[managerId,staffEvent]);
    const managerReplay=await command(staffEvent,managerCommand,firstPayload,{cookie:manager});
    assert.equal(managerReplay.status,200,JSON.stringify(managerReplay.json));
    assert.deepEqual(managerReplay.json,managerResult.json);
    await legacy(managerCommand);
    const legacyManager=await command(staffEvent,managerCommand,firstPayload,{cookie:manager});
    assert.equal(legacyManager.status,200);
    assert.deepEqual(legacyManager.json,managerResult.json);
    assert.equal((await command(staffEvent,managerCommand,{boothId:'a',ticket:b.ticket},{cookie:manager})).status,409);
    const missingVisit=await read(staffEvent); missingVisit.visits=missingVisit.visits.filter((v)=>v.id!==managerCommand);
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[staffEvent,JSON.stringify(missingVisit)]);
    assert.equal((await command(staffEvent,managerCommand,firstPayload,{cookie:manager})).status,409);
  } finally { await h.close(); }
});
