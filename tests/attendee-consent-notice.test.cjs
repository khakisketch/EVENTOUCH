'use strict';

// Synthetic records only. Old consent rows deliberately have no noticeId.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { databaseUrl, startApiHarness, insertEvent, insertAccount, insertMembership, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('a new signup records the exact visible notice without inventing legacy evidence', async () => {
  const harness = await startApiHarness();
  try {
    const id = `consent-notice-${crypto.randomUUID()}`;
    const fields = [{ id: 'name', label: '이름', type: 'text', required: true }, { id: 'phone', label: '연락처', type: 'text', required: true }];
    const text = '이전 공백을 포함한 안내\n두 번째 줄  ';
    const legacy = { id: 'legacy', name: '기존 참가자', phone: '01097860000', status: 'APPROVED', consent: { version: 4, at: '2026-01-01T00:00:00.000Z' } };
    await insertEvent(harness.database, { id, slug: id, orgId: LEGACY_ORG,
      payload: { id, slug: id, name: '합성 동의 행사', date: '2099-01-01', stage: 'READY', capacity: 100 },
      workspace: { participants: [legacy], payments: [], fields, publishedFields: fields, formVersion: 1, publishedVersion: 1,
        consentText: text, consentVersion: 4, registrationOpen: true, approvalRequired: false, price: 0, verificationRequired: false },
    });
    const body = { commandId: crypto.randomUUID(), formVersion: 1, consent: true, name: '새 참가자', phone: '01097860001' };
    const signup = await requestJson(harness.baseUrl, `/api/events/${id}/signup`, { method: 'POST', body });
    assert.equal(signup.status, 201);
    const workspace = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
    const saved = workspace.participants.find(person => person.name === '새 참가자');
    assert.equal(saved.consent.version, 4);
    assert.equal(typeof saved.consent.at, 'string');
    assert.equal(typeof saved.consent.noticeId, 'string');
    assert.equal(workspace.participants.find(person => person.id === 'legacy').consent.noticeId, undefined);
    const notice = workspace.consentNotices.find(item => item.id === saved.consent.noticeId);
    assert.equal(notice.version, 4);
    assert.equal(notice.text, text, 'preserves the same notice as the public application');
    const replay = await requestJson(harness.baseUrl, `/api/events/${id}/signup`, { method: 'POST', body });
    assert.equal(replay.status, 200);
    const afterReplay = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
    assert.equal(afterReplay.consentNotices.length, 1);
    assert.equal(afterReplay.participants.filter(person => person.name === '새 참가자').length, 1);
    const publicEvent = await requestJson(harness.baseUrl, `/api/public/events/${id}`);
    assert.equal(publicEvent.status, 200);
    assert.equal(publicEvent.json.workspace.consentText, text);
    assert.equal(Object.hasOwn(publicEvent.json.workspace, 'consentNotices'), false);
    const publicTicket = await requestJson(harness.baseUrl, `/api/public/events/${id}/ticket`, { bearer: signup.json.participant.ticket });
    assert.equal(publicTicket.status, 200);
    assert.equal(Object.hasOwn(publicTicket.json.workspace, 'consentNotices'), false);
    assert.equal(Object.hasOwn(publicTicket.json.participant.consent, 'noticeId'), false);

    await insertAccount(harness.database, { id: 'consent-manager', role: 'MANAGER', name: '합성 운영자', email: 'consent-manager@example.test', orgId: LEGACY_ORG });
    await insertMembership(harness.database, 'consent-manager', id, ['all']);
    const manager = await sessionCookie(harness, 'consent-manager');
    const bootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: manager });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.json.state.workspaces[id].consentNotices[0].text, text);

    await insertAccount(harness.database, { id: 'consent-staff', role: 'STAFF', name: '합성 스태프', email: 'consent-staff@example.test', orgId: LEGACY_ORG });
    await insertAssignment(harness.database, { id: 'consent-desk', accountId: 'consent-staff', eventId: id, type: 'DESK', targetId: 'desk-one' });
    const staff = await sessionCookie(harness, 'consent-staff');
    const staffBootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: staff });
    assert.equal(staffBootstrap.status, 200);
    assert.equal(Object.hasOwn(staffBootstrap.json.state.workspaces[id], 'consentNotices'), false);
  } finally { await harness.close(); }
});
