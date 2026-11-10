'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL' }, fn);

test('report retains and guards cancellation conflicts without reclassifying participants', async () => {
  const h = await startApiHarness();
  try {
    const actor = `report-conflict-owner-${crypto.randomUUID()}`, eventId = `report-conflict-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const workspace = emptyWorkspace();
    workspace.participants = [
      { id: 'conflict', status: 'APPROVED', cancelled: true, inside: false, everIn: false, group: '일반' },
      { id: 'valid', status: 'APPROVED', cancelled: false, inside: false, everIn: false, group: '일반' },
      { id: 'cancelled', status: 'CANCELLED', cancelled: true, inside: false, everIn: false, group: '일반' },
      { id: 'legacy-cancelled', status: 'cancelled', cancelled: true, inside: false, everIn: false, group: '일반' },
    ];
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'ENDED', features: [], capacity: 100 }, workspace });
    const cookie = await sessionCookie(h, actor);
    const id = crypto.randomUUID();
    const send = (command, payload, commandId = crypto.randomUUID()) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie, body: { commandId, command, payload },
    });
    const expected = { total: 2, approved: 2, checked: 0, inside: 0, attendanceReview: 0, cancellationReview: 0 };
    for (const payload of [{ title: '이전 호출자' }, { title: '이전 검토', expectedAttendance: { total: 2, approved: 2, checked: 0, inside: 0 } }]) {
      const unsupported = await send('report.create', payload);
      assert.equal(unsupported.status, 409);
      assert.equal(unsupported.json.code, 'REPORT_CANCELLATION_REVIEW_REQUIRED');
    }
    const stale = await send('report.create', { title: '검토 보고서', expectedAttendance: expected }, id);
    assert.equal(stale.status, 409, JSON.stringify(stale.json));
    assert.equal(stale.json.field, 'expectedAttendance');
    const untouched = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    assert.deepEqual(untouched, workspace, 'rejected stale review does not change records');
    const input = { title: '검토 보고서', expectedAttendance: { ...expected, cancellationReview: 1 } };
    const created = await send('report.create', input, id);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.report.snapshot.metrics.total, 2, 'the existing status-based definition remains explicit');
    assert.equal(created.json.report.snapshot.metrics.approved, 2);
    assert.equal(created.json.report.snapshot.metrics.cancellationReview, 1);
    assert.equal((await send('report.create', input, id)).status, 200, 'same command replays the frozen receipt');
    assert.equal((await send('report.publish', { id: created.json.report.id })).status, 200);
    const repaired = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    repaired.participants.find(person => person.id === 'conflict').cancelled = false;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(repaired)]);
    const staleSuccessor = await send('report.successor', { id: created.json.report.id, source: 'current', expectedAttendance: input.expectedAttendance });
    assert.equal(staleSuccessor.status, 409); assert.equal(staleSuccessor.json.field, 'expectedAttendance');
    const copy = await send('report.successor', { id: created.json.report.id, source: 'snapshot' });
    assert.equal(copy.status, 201); assert.equal(copy.json.report.snapshot.metrics.cancellationReview, 1);
    const current = await send('report.successor', { id: created.json.report.id, source: 'current', expectedAttendance: expected });
    assert.equal(current.status, 201); assert.equal(current.json.report.snapshot.metrics.cancellationReview, 0);
    const legacy = await send('report.create', { title: '기존 호출자' });
    assert.equal(legacy.status, 201); assert.equal(legacy.json.report.snapshot.metrics.cancellationReview, 0);
  } finally { await h.close(); }
});

test('a reviewed pending count cannot silently change while other totals remain equal', async () => {
  const h = await startApiHarness();
  try {
    const actor = `report-pending-owner-${crypto.randomUUID()}`, eventId = `report-pending-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const workspace = emptyWorkspace();
    workspace.participants = [{ id: 'pending', status: 'WAITLIST', inside: false, everIn: false }];
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'READY', features: [], capacity: 100 }, workspace });
    const cookie = await sessionCookie(h, actor);
    const send = pending => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie,
      body: { commandId: crypto.randomUUID(), command: 'report.create', payload: { title: '승인 검토',
        expectedAttendance: { total: 1, pending, approved: 0, checked: 0, inside: 0, attendanceReview: 0, cancellationReview: 0 } } } });
    const stale = await send(1);
    assert.equal(stale.status, 409); assert.equal(stale.json.field, 'expectedAttendance');
    const current = await send(0);
    assert.equal(current.status, 201); assert.equal(current.json.report.snapshot.metrics.pending, 0);
  } finally { await h.close(); }
});
