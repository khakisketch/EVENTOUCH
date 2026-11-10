'use strict';

// A ticket link explicitly names a credential. A different participant's
// same-browser session must never silently substitute for a rejected link.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { databaseUrl, startApiHarness, insertEvent, insertAccount, insertMembership,
  sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);

test('an explicit rejected ticket never falls back to another session participant', async () => {
  const h = await startApiHarness();
  try {
    const fields = [
      { id: 'name', label: '이름', type: 'text', required: true, options: [] },
      { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
    ];
    for (const slug of ['credential-event', 'credential-other']) {
      await insertEvent(h.database, { id: slug, slug, orgId: LEGACY_ORG,
        payload: { id: slug, slug, name: slug, date: '2099-01-01', stage: 'READY', capacity: 30 },
        workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
          formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '동의',
          consentVersion: 1, price: 0, verificationRequired: false },
      });
    }
    await insertAccount(h.database, { id: 'credential-manager', name: '합성 운영자',
      email: 'credential-manager@example.test', role: 'MANAGER', orgId: LEGACY_ORG });
    await insertMembership(h.database, 'credential-manager', 'credential-event', ['all']);
    const operator = await sessionCookie(h, 'credential-manager');
    const signup = (event, name, phone) => requestJson(h.baseUrl, `/api/events/${event}/signup`, {
      method: 'POST', body: { commandId: crypto.randomUUID(), formVersion: 1, consent: true, name, phone },
    });
    const a = await signup('credential-event', '첫 번째 참가자', '01089002001');
    const b = await signup('credential-event', '두 번째 참가자', '01089002002');
    const c = await signup('credential-event', '만료 참가자', '01089002003');
    const foreign = await signup('credential-other', '다른 행사 참가자', '01089002004');
    for (const person of [a, b, c, foreign]) assert.equal(person.status, 201);
    const cookie = (b.headers.get('set-cookie') || '').split(';')[0];
    const read = opts => requestJson(h.baseUrl, '/api/public/events/credential-event/ticket', { cookie, ...opts });
    let answer = await read({ bearer: a.json.participant.ticket });
    assert.equal(answer.status, 200);
    assert.equal(answer.json.participant.id, a.json.participant.id, 'valid explicit ticket wins over other session');
    answer = await read({});
    assert.equal(answer.status, 200);
    assert.equal(answer.json.participant.id, b.json.participant.id, 'session-only recovery remains available');

    const cancelled = await requestJson(h.baseUrl, '/api/events/credential-event/commands', {
      method: 'POST', cookie: operator, body: { commandId: crypto.randomUUID(), command: 'participant.status',
        payload: { id: a.json.participant.id, status: 'CANCELLED' } },
    });
    assert.equal(cancelled.status, 200);
    answer = await read({ bearer: a.json.participant.ticket });
    assert.equal(answer.status, 404, 'cancelled ticket must not select the session participant');

    const row = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', ['credential-event'])).rows[0].payload;
    row.participants.find(person => person.id === c.json.participant.id).ticketExpiresAt = '2020-01-01T00:00:00.000Z';
    await h.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', ['credential-event', JSON.stringify(row)]);
    for (const bearer of [c.json.participant.ticket, foreign.json.participant.ticket, 'not-a-ticket']) {
      answer = await read({ bearer });
      assert.equal(answer.status, 404, 'expired, foreign and invalid tickets do not select the session participant');
    }
    for (const authorization of ['Basic Zm9vOmJhcg==', 'Bearer', '']) {
      answer = await read({ headers: { authorization } });
      assert.equal(answer.status, 404, 'a malformed explicit authorization never selects the session participant');
    }
    answer = await read({});
    assert.equal(answer.status, 200);
    assert.equal(answer.json.participant.id, b.json.participant.id);
  } finally { await h.close(); }
});
