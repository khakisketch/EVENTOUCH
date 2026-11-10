'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('a confirmed history-based reconciliation preserves the record and binds the receipt', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `reconcile-${suffix}`;
    const manager = `manager-${suffix}`, restricted = `restricted-${suffix}`, staff = `staff-${suffix}`;
    const person = { id: 'person-a', name: '합성 참가자', company: '합성 회사', phone: '01055556666', status: 'APPROVED',
      inside: false, everIn: true, revoked: false, ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString(), paymentStatus: 'FREE' };
    const entry = { id: 'entry-a', participantId: person.id, name: person.name, action: 'IN', deskId: 'in', actor: manager,
      at: '2026-11-07T01:00:00.000Z', corrected: false, before: { inside: false, everIn: false } };
    const workspace = emptyWorkspace(); workspace.participants = [person]; workspace.checks = [entry]; workspace.allowReentry = false;
    workspace.reports = [{ id: 'frozen-report', title: '기존 보고서', status: 'PUBLISHED', snapshot: { metrics: { checked: 0, inside: 0 } } }];
    workspace.rewards = [{ id: 'reward', participantId: person.id, name: '합성 경품', status: 'READY', method: 'ONSITE' }];
    workspace.desks = [{ id: 'in', name: '입장 데스크', action: 'IN', mode: 'desk', open: true }, { id: 'out', name: '퇴장 데스크', action: 'OUT', mode: 'desk', open: true }];
    for (const [id, role] of [[manager, 'MANAGER'], [restricted, 'MANAGER'], [staff, 'STAFF']]) await insertAccount(h.database, { id, role, name: '합성 사용자', email: `${id}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace });
    await insertMembership(h.database, manager, eventId, ['onsite']); await insertMembership(h.database, restricted, eventId, ['participants']);
    await insertAssignment(h.database, { id: 'desk-assignment', accountId: staff, eventId, type: 'DESK', targetId: 'in' });
    const managerCookie = await sessionCookie(h, manager), limitedCookie = await sessionCookie(h, restricted), staffCookie = await sessionCookie(h, staff);
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const write = async value => h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(value)]);
    const bootstrap = async () => (await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie: managerCookie })).json.state.workspaces[eventId].participants[0];
    const send = (payload, id = crypto.randomUUID(), cookie = managerCookie, assignmentId) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie, body: { commandId: id, command: 'check.reconcile', payload, ...(assignmentId ? { assignmentId } : {}) },
    });
    const candidate = (await bootstrap()).attendanceReconciliation;
    assert.ok(candidate?.fingerprint, 'the operator can review a verifiable most-recent check');
    assert.equal(candidate.checkId, entry.id); assert.equal(candidate.action, 'IN');
    const staffView = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie: staffCookie });
    assert.equal(Object.hasOwn(staffView.json.state.workspaces[eventId].participants[0], 'attendanceReconciliation'), false);
    const publicView = await requestJson(h.baseUrl, `/api/public/events/${eventId}`);
    assert.equal(JSON.stringify(publicView.json).includes('attendanceReconciliation'), false);
    const payload = { participantId: person.id, checkId: entry.id, action: 'IN', fingerprint: candidate.fingerprint, reason: '현장 책임자가 참가자의 현재 위치와 입장 기록을 대조함', confirmed: true };
    for (const input of [{ ...payload, confirmed: false }, { ...payload, reason: '' }, { ...payload, reason: '가'.repeat(301) }]) assert.equal((await send(input)).status, 400);
    assert.equal((await send(payload, crypto.randomUUID(), limitedCookie)).status, 403);
    assert.equal((await send(payload, crypto.randomUUID(), staffCookie, 'desk-assignment')).status, 403);
    const badAudit = await read(); badAudit.audit = { preserved: '합성 손상 내역' }; await write(badAudit);
    assert.equal((await bootstrap()).attendanceReconciliation, null, 'a malformed audit log cannot be silently reset');
    assert.equal((await send(payload)).status, 409);
    assert.deepEqual((await read()).audit, badAudit.audit);
    badAudit.audit = []; await write(badAudit);
    const changed = await read(); changed.participants[0].company = '변경된 소속'; await write(changed);
    assert.equal((await send(payload)).status, 409, 'identity changed after review');
    changed.participants[0].company = person.company; changed.participants[0].revoked = 'unknown'; await write(changed);
    assert.equal((await bootstrap()).attendanceReconciliation, null, 'malformed ticket revocation cannot be reviewed as safe');
    assert.equal((await send(payload)).status, 409);
    changed.participants[0].revoked = false;
    changed.participants[0].company = person.company; changed.desks[0].name = '변경된 데스크'; await write(changed);
    assert.equal((await send(payload)).status, 409, 'displayed check location changed after review');
    changed.desks[0].name = '입장 데스크'; changed.participants.push({ ...person, id: 'duplicate', phone: '01012346666' }); await write(changed);
    assert.equal((await send(payload)).status, 409, 'indistinguishable participant cannot be reconciled');
    changed.participants.pop(); await write(changed);
    const badHistory = await read(); badHistory.checks.unshift({ ...entry, id: 'newer', at: '2026-11-07T02:00:00.000Z', action: 'OUT' }); await write(badHistory);
    assert.equal((await send(payload)).status, 409, 'a newer check invalidates the reviewed evidence');
    badHistory.checks.shift(); await write(badHistory);
    const id = crypto.randomUUID(), saved = await send(payload, id);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.reconciliation, { id, participantId: person.id, checkId: entry.id, action: 'IN', inside: true, everIn: true });
    const result = await read();
    assert.equal(result.participants[0].inside, true); assert.equal(result.participants[0].everIn, true);
    assert.deepEqual(result.checks, [entry], 'no fictional scan and no alteration of the source record');
    assert.deepEqual(result.reports, workspace.reports, 'previously frozen reports remain unchanged');
    assert.deepEqual(result.rewards, workspace.rewards, 'reconciliation does not change entitlements');
    assert.equal(result.participants[0].ticket, person.ticket); assert.equal(result.participants[0].status, person.status);
    assert.equal(result.audit[0].type, 'check.reconcile'); assert.equal(result.audit[0].detail, payload.reason);
    assert.equal(result.audit[0].reconciliation.participantId, person.id);
    assert.equal(result.audit[0].reconciliation.participantName, person.name);
    assert.equal(result.audit[0].reconciliation.before.inside.value, false);
    const replay = await send(payload, id); assert.deepEqual(replay.json, saved.json);
    assert.equal((await send({ ...payload, reason: '변경된 사유' }, id)).status, 409, 'same id cannot confirm another request');
    assert.equal((await read()).audit.filter(item => item.id === id).length, 1);
    const exit = await requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie: managerCookie,
      body: { commandId: crypto.randomUUID(), command: 'check.scan', payload: { deskId: 'out', expectedAction: 'OUT', ticket: person.ticket } } });
    assert.equal(exit.status, 200, JSON.stringify(exit.json));
    const again = await requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie: managerCookie,
      body: { commandId: crypto.randomUUID(), command: 'check.scan', payload: { deskId: 'in', expectedAction: 'IN', ticket: person.ticket } } });
    assert.equal(again.status, 409, 're-entry prohibition is preserved');
    const damaged = await read(); damaged.participants[0].inside = null; damaged.participants[0].everIn = false;
    damaged.rewards = { preserved: '합성 손상 경품 데이터' }; damaged.venue = null; damaged.boothMap = '합성 손상 지도'; await write(damaged);
    const outCandidate = (await bootstrap()).attendanceReconciliation;
    assert.equal(outCandidate.action, 'OUT');
    const outPayload = { ...payload, action: 'OUT', checkId: outCandidate.checkId, fingerprint: outCandidate.fingerprint, reason: '실제 퇴장과 마지막 기록을 대조' };
    const tied = await read(); tied.checks.push({ ...tied.checks[0], id: 'ambiguous-time' }); await write(tied);
    assert.equal((await bootstrap()).attendanceReconciliation, null, 'indistinguishable chronology cannot be guessed');
    assert.equal((await send(outPayload)).status, 409);
    tied.checks.pop(); const actualTime = tied.checks[0].at;
    for (const at of ['2026-02-31T12:00:00Z', '2026-11-07T12:00:00']) {
      tied.checks[0].at = at; await write(tied);
      assert.equal((await bootstrap()).attendanceReconciliation, null, 'invalid or timezone-free times are not reliable evidence');
    }
    tied.checks[0].at = actualTime; await write(tied);
    const simultaneous = await Promise.all([send(outPayload), send(outPayload)]);
    assert.deepEqual(simultaneous.map(reply => reply.status).sort(), [200, 409], 'only one conflicting review can commit');
    const final = await read();
    assert.equal(final.participants[0].inside, false); assert.equal(final.participants[0].everIn, true);
    assert.equal(final.checks.length, 2, 'reconciliation does not add entry or exit events');
    assert.equal(final.audit[0].reconciliation.before.inside.value, null);
    assert.deepEqual(final.rewards, damaged.rewards, 'unrelated malformed data is preserved byte-for-byte');
    assert.equal(final.venue, null); assert.equal(final.boothMap, damaged.boothMap);
  } finally { await h.close(); }
});
