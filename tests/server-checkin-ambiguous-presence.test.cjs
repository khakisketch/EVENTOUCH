'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('ambiguous attendance never silently becomes an entry or exit', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `check-guard-${suffix}`, manager = `manager-${suffix}`, staff = `staff-${suffix}`;
    const participant = { id: 'person', name: '합성 참가자', company: '합성 회사', phone: '01055556666', status: 'APPROVED',
      inside: false, everIn: false, revoked: false, ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString(), paymentStatus: 'FREE' };
    const workspace = emptyWorkspace(); workspace.participants = [participant]; workspace.allowReentry = false;
    workspace.desks = [{ id: 'in', name: '입장', action: 'IN', mode: 'desk', open: true }, { id: 'out', name: '퇴장', action: 'OUT', mode: 'desk', open: true }];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertAccount(h.database, { id: staff, role: 'STAFF', name: '합성 스태프', email: `${staff}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace });
    await insertMembership(h.database, manager, eventId, ['all']);
    await insertAssignment(h.database, { id: 'assignment-in', accountId: staff, eventId, type: 'DESK', targetId: 'in' });
    await insertAssignment(h.database, { id: 'assignment-out', accountId: staff, eventId, type: 'DESK', targetId: 'out' });
    const managerCookie = await sessionCookie(h, manager), staffCookie = await sessionCookie(h, staff);
    const send = (cookie, assignmentId, deskId, action, id = crypto.randomUUID(), manual = false) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie, body: { commandId: id, command: 'check.scan', ...(assignmentId ? { assignmentId } : {}), payload: { deskId, ...(manual ? { participantId: participant.id, expectedIdentity: { name: participant.name, company: participant.company } } : { ticket: participant.ticket }), expectedAction: action } },
    });
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    for (const [inside, everIn, action] of [[null, false, 'IN'], [false, null, 'IN'], [true, false, 'OUT'], [true, null, 'OUT'], [null, true, 'OUT']]) {
      const current = await read(); Object.assign(current.participants[0], { inside, everIn });
      await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(current)]);
      for (const [cookie, assignment] of [[managerCookie, null], [staffCookie, action === 'IN' ? 'assignment-in' : 'assignment-out']]) {
        for (const manual of [false, true]) {
          const reply = await send(cookie, assignment, action === 'IN' ? 'in' : 'out', action, crypto.randomUUID(), manual);
          assert.equal(reply.status, 409, `${inside}/${everIn}/${action}: ${JSON.stringify(reply.json)}`);
          assert.equal(reply.json.code, 'CHECK_ATTENDANCE_REVIEW_REQUIRED');
          assert.deepEqual(await read(), current, 'a denied scan changes no state');
        }
      }
    }
    const legacy = await read(); delete legacy.participants[0].inside; delete legacy.participants[0].everIn;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(legacy)]);
    const entryId = crypto.randomUUID();
    const entry = await send(staffCookie, 'assignment-in', 'in', 'IN', entryId);
    assert.equal(entry.status, 200);
    let corrupted = await read(); corrupted.participants[0].inside = null;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(corrupted)]);
    const replay = await send(staffCookie, 'assignment-in', 'in', 'IN', entryId);
    assert.equal(replay.status, 200, 'same request replays');
    assert.equal(replay.json.recordStatus, 'UNAVAILABLE', 'a receipt does not imply the current presence is still known');
    assert.equal((await read()).checks.length, 1);
    corrupted.participants[0].inside = false; corrupted.allowReentry = true;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(corrupted)]);
    const duplicate = await send(staffCookie, 'assignment-in', 'in', 'IN');
    assert.equal(duplicate.status, 409, 'a last entry that conflicts with the presence flag cannot become a second entry');
    assert.equal(duplicate.json.code, 'CHECK_ATTENDANCE_REVIEW_REQUIRED');
    for (const cookie of [managerCookie, staffCookie]) {
      const bootstrap = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie });
      assert.equal(bootstrap.json.state.workspaces[eventId].participants[0].attendanceReview, true, 'both roles can identify the contradiction');
    }
    const report = await requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie: managerCookie,
      body: { commandId: crypto.randomUUID(), command: 'report.create', payload: { title: '합성 확인 보고서' } } });
    assert.equal(report.status, 201);
    assert.equal(report.json.report.snapshot.metrics.attendanceReview, 1);
    assert.equal(report.json.report.snapshot.metrics.attendanceReviewVersion, 2);
    corrupted = await read();
    const contradictoryReplay = await send(staffCookie, 'assignment-in', 'in', 'IN', entryId);
    assert.equal(contradictoryReplay.json.recordStatus, 'UNAVAILABLE', 'a last entry inconsistent with current presence is also uncertain');
    corrupted.participants[0].inside = true; corrupted.allowReentry = false;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(corrupted)]);
    assert.equal((await send(staffCookie, 'assignment-out', 'out', 'OUT')).status, 200);
    assert.equal((await send(staffCookie, 'assignment-in', 'in', 'IN')).status, 409, 're-entry policy remains effective');
  } finally { await h.close(); }
});
