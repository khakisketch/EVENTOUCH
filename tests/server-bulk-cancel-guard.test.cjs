'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('reviewed bulk cancellation is atomic across attendee, presence and paid-record changes', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), eventId = `bulk-cancel-${suffix}`;
    const managerId = `manager-${suffix}`, readonlyId = `readonly-${suffix}`, staffId = `staff-${suffix}`;
    for (const [id, role] of [[managerId, 'MANAGER'], [readonlyId, 'MANAGER'], [staffId, 'STAFF']]) {
      await insertAccount(h.database, { id, role, name: '합성 운영자', email: `${id}@example.test`, orgId: LEGACY_ORG });
    }
    const person = (id, status, inside) => ({ id, name: `합성 ${id}`, phone: `0100000000${id === 'a' ? 1 : 2}`,
      status, ...(inside === undefined ? {} : { inside }), revoked: false, ticket: crypto.randomBytes(32).toString('base64url'),
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString(), paymentStatus: 'FREE', answers: {} });
    const workspace = emptyWorkspace(); workspace.participants = [person('a', 'PENDING', undefined), person('b', 'APPROVED', false)];
    workspace.payments = [{ id: 'paid-b', participantId: 'b', status: 'PAID', amount: 1000 }];
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'READY', features: [], capacity: 100 }, workspace });
    await insertMembership(h.database, managerId, eventId, ['participants']);
    await insertMembership(h.database, readonlyId, eventId, []);
    const cookies = { manager: await sessionCookie(h, managerId), readonly: await sessionCookie(h, readonlyId), staff: await sessionCookie(h, staffId) };
    const send = (command, payload, commandId = crypto.randomUUID(), cookie = cookies.manager) => requestJson(h.baseUrl,
      `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId, command, payload } });
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const write = async (value) => h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(value)]);
    const base = [{ id: 'a', status: 'PENDING', inside: false, paidPaymentIds: [] }, { id: 'b', status: 'APPROVED', inside: false, paidPaymentIds: ['paid-b'] }];
    const payload = { ids: ['a', 'b'], status: 'CANCELLED', expectedCancellations: base, requireRosterRefresh: true };

    // Legacy absence is projected as false, without updating the stored JSON.
    const bootstrap = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie: cookies.manager });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.json.state.workspaces[eventId].participants.find((p) => p.id === 'a').inside, false);
    assert.equal(Object.hasOwn((await read()).participants[0], 'inside'), false);
    for (const cookie of [cookies.readonly, cookies.staff]) assert.ok([403, 404].includes((await send('participant.bulk-cancel', payload, crypto.randomUUID(), cookie)).status));
    for (const bad of [undefined, [], [{ ...base[0] }], [base[0], base[0]], [{ ...base[0], inside: 'false' }, base[1]], [{ ...base[0], paidPaymentIds: [''] }, base[1]]]) {
      const result = await send('participant.bulk-cancel', { ...payload, expectedCancellations: bad });
      assert.equal(result.status, 400, JSON.stringify(result.json));
    }

    const approve = await send('participant.status', { id: 'a', status: 'APPROVED', expectedStatus: 'PENDING' });
    assert.equal(approve.status, 200);
    const conflict = await send('participant.bulk-cancel', payload);
    assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'CANCELLATION_REVIEW_CHANGED');
    assert.deepEqual((await read()).participants.map((p) => p.status), ['APPROVED', 'APPROVED']);
    assert.equal((await read()).payments[0].status, 'PAID');
    const latest = [{ ...base[0], status: 'APPROVED' }, base[1]];

    let current = await read(); current.payments.push({ id: 'new-paid-a', participantId: 'a', status: 'PAID', amount: 2000 }); await write(current);
    const paymentConflict = await send('participant.bulk-cancel', { ...payload, expectedCancellations: latest });
    assert.equal(paymentConflict.status, 409); assert.equal(paymentConflict.json.code, 'CANCELLATION_REVIEW_CHANGED');
    current = await read(); assert.deepEqual(current.payments.map((p) => p.status), ['PAID', 'PAID']);
    const paidLatest = [{ ...latest[0], paidPaymentIds: ['new-paid-a'] }, latest[1]];
    current.participants[0].inside = true; await write(current);
    assert.equal((await send('participant.bulk-cancel', { ...payload, expectedCancellations: paidLatest })).json.code, 'CANCELLATION_REVIEW_CHANGED');
    const insideSnapshot = [{ ...paidLatest[0], inside: true }, paidLatest[1]];
    const inside = await send('participant.bulk-cancel', { ...payload, expectedCancellations: insideSnapshot });
    assert.equal(inside.status, 409); assert.match(inside.json.error, /입장 중/);
    for (const malformedInside of ['true', null]) {
      current = await read(); current.participants[0].inside = malformedInside; await write(current);
      const malformedView = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie: cookies.manager });
      assert.equal(malformedView.json.state.workspaces[eventId].participants.find((p) => p.id === 'a').inside, null);
      assert.equal((await send('participant.bulk-cancel', { ...payload, expectedCancellations: paidLatest })).json.code, 'CANCELLATION_REVIEW_UNAVAILABLE');
      assert.equal((await read()).participants[0].inside, malformedInside);
    }
    current = await read(); current.participants[0].inside = false; await write(current);

    // An old row without payments means empty. An explicit damaged value is
    // different: neither projection nor a forged zero snapshot may hide it.
    const savedPayments = current.payments;
    delete current.payments; await write(current);
    const missingPayments = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie: cookies.manager });
    assert.equal(missingPayments.json.state.workspaces[eventId].paymentReviewAvailable, true);
    assert.deepEqual(missingPayments.json.state.workspaces[eventId].payments, []);
    assert.equal(Object.hasOwn(await read(), 'payments'), false);
    const withoutPayments = await send('participant.bulk-cancel', { ids: ['a'], status: 'CANCELLED', expectedCancellations: [{ ...latest[0], paidPaymentIds: [] }] });
    assert.equal(withoutPayments.status, 200, JSON.stringify(withoutPayments.json));
    assert.equal((await read()).participants[0].status, 'CANCELLED');
    // Restore only synthetic fixture data for the independent corruption case.
    current.payments = { damaged: true }; await write(current);
    const damagedPayments = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie: cookies.manager });
    assert.equal(damagedPayments.json.state.workspaces[eventId].paymentReviewAvailable, false);
    const damaged = await send('participant.bulk-cancel', { ...payload, expectedCancellations: latest });
    assert.equal(damaged.status, 409); assert.equal(damaged.json.code, 'CANCELLATION_REVIEW_UNAVAILABLE');
    assert.deepEqual((await read()).payments, { damaged: true });
    assert.deepEqual((await read()).participants.map((p) => p.status), ['APPROVED', 'APPROVED']);
    current.payments = savedPayments; await write(current);

    const commandId = crypto.randomUUID();
    const finalPayload = { ...payload, expectedCancellations: paidLatest };
    const result = await send('participant.bulk-cancel', finalPayload, commandId);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.deepEqual(result.json.cancellationReview, { status: 'CANCELLED', targets: paidLatest });
    current = await read();
    assert.deepEqual(current.participants.map((p) => p.status), ['CANCELLED', 'CANCELLED']);
    assert.deepEqual(current.participants.map((p) => p.revoked), [true, true]);
    assert.deepEqual(current.payments.map((p) => p.status), ['REFUND_REQUESTED', 'REFUND_REQUESTED']);
    const replay = await send('participant.bulk-cancel', finalPayload, commandId);
    assert.equal(replay.status, 200); assert.deepEqual(replay.json, result.json);
    for (const altered of [
      { ...finalPayload, ids: ['a'], expectedCancellations: [paidLatest[0]] },
      { ...finalPayload, expectedCancellations: [{ ...paidLatest[0], inside: true }, paidLatest[1]] },
      { ...finalPayload, expectedCancellations: [{ ...paidLatest[0], paidPaymentIds: [] }, paidLatest[1]] },
    ]) {
      const mismatch = await send('participant.bulk-cancel', altered, commandId);
      assert.equal(mismatch.status, 409); assert.equal(mismatch.json.code, 'CANCELLATION_RECEIPT_MISMATCH');
      assert.equal(mismatch.json.cancellationReview, undefined);
    }
    const statusOnly = await requestJson(h.baseUrl, `/api/events/${eventId}/command-receipts/${commandId}`, { cookie: cookies.manager });
    assert.deepEqual(statusOnly.json, { status: 'APPLIED', command: 'participant.bulk-cancel' });
    assert.equal((await read()).audit.filter((entry) => entry.id === commandId).length <= 1, true);
    // Existing status command does not require the new review payload.
    assert.equal((await send('participant.status', { id: 'a', status: 'APPROVED' })).status, 200);
  } finally { await h.close(); }
});
