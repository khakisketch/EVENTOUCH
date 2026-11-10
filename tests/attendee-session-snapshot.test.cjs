'use strict';

// Reads must resolve the session grant and participant from one snapshot.
// All identities and tickets below exist only in a disposable schema.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { databaseUrl, startApiHarness, insertEvent, insertAccount, insertMembership,
  sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);

for (const mode of ['ticket', 'verification-session']) {
  test(`${mode} cannot combine an old session with a newly reissued ticket`, async () => {
    const h = await startApiHarness();
    let release;
    try {
      const slug = `session-snapshot-${mode}`;
      const phone = '01089003001';
      const fields = [
        { id: 'name', label: '이름', type: 'text', required: true, options: [] },
        { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
      ];
      await insertEvent(h.database, { id: slug, slug, orgId: LEGACY_ORG,
        payload: { id: slug, slug, name: '합성 행사', date: '2099-01-01', stage: 'READY', capacity: 20 },
        workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
          formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '동의',
          consentVersion: 1, price: 0, verificationRequired: false },
      });
      await insertAccount(h.database, { id: 'snapshot-manager', name: '합성 운영자',
        email: 'snapshot-manager@example.test', role: 'MANAGER', orgId: LEGACY_ORG });
      await insertMembership(h.database, 'snapshot-manager', slug, ['all']);
      const operator = await sessionCookie(h, 'snapshot-manager');
      const call = (url, options) => requestJson(h.baseUrl, url, options);
      const signup = await call(`/api/events/${slug}/signup`, { method: 'POST',
        body: { commandId: crypto.randomUUID(), formVersion: 1, consent: true, name: '합성 참가자', phone } });
      assert.equal(signup.status, 201);
      const originalTicket = signup.json.participant.ticket;
      const cookie = (signup.headers.get('set-cookie') || '').split(';')[0];
      const command = status => call(`/api/events/${slug}/commands`, { method: 'POST', cookie: operator,
        body: { commandId: crypto.randomUUID(), command: 'participant.status', payload: { id: signup.json.participant.id, status } } });

      let markRead;
      const readComplete = new Promise(resolve => { markRead = resolve; });
      const resume = new Promise(resolve => { release = resolve; });
      const original = h.database.query.bind(h.database);
      let intercepted = false;
      h.database.query = async (sql, args) => {
        const text = typeof sql === 'string' ? sql : '';
        const isSnapshot = text.includes('attendee_sessions') && /^\s*SELECT\b/i.test(text) &&
          (text.includes('grants, expires_at') || text.includes('workspace_payload'));
        const result = await original(sql, args);
        if (!intercepted && isSnapshot) { intercepted = true; markRead(); await resume; }
        return result;
      };
      const ticketPath = `/api/public/events/${slug}/ticket`;
      const sessionPath = `/api/public/events/${slug}/verification/session`;
      const pending = mode === 'ticket'
        ? call(ticketPath, { cookie })
        : call(sessionPath, { method: 'POST', cookie, body: { phone } });
      await Promise.race([readComplete, new Promise((_, reject) => setTimeout(() => reject(new Error('session snapshot not reached')), 5000))]);
      assert.equal((await command('CANCELLED')).status, 200);
      assert.equal((await command('APPROVED')).status, 200);
      const fresh = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [slug])).rows[0].payload;
      const currentTicket = fresh.participants.find(person => person.id === signup.json.participant.id).ticket;
      assert.ok(currentTicket !== originalTicket, 'reapproval issues a new ticket');
      release();
      const response = await pending;
      const returnedTicket = mode === 'ticket' ? response.json?.participant?.ticket : response.json?.ticket;
      assert.ok(response.status === 404 || (response.status === 200 && returnedTicket === originalTicket),
        'a read started before cancellation must never return the newly issued ticket');
      assert.equal((await call(ticketPath, { cookie })).status, 404, 'the old session remains revoked');
    } finally { if (release) release(); await h.close(); }
  });
}

test('the session snapshot checks phone, cancellation, deletion, expiry and event scope', async () => {
  const h = await startApiHarness();
  try {
    const fields = [
      { id: 'name', label: '이름', type: 'text', required: true, options: [] },
      { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
    ];
    for (const slug of ['snapshot-current', 'snapshot-unrelated']) {
      await insertEvent(h.database, { id: slug, slug, orgId: LEGACY_ORG,
        payload: { id: slug, slug, name: '합성 행사', date: '2099-01-01', stage: 'READY', capacity: 20 },
        workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
          formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '동의',
          consentVersion: 1, price: 0, verificationRequired: false },
      });
    }
    const phone = '01089003002';
    const signup = await requestJson(h.baseUrl, '/api/events/snapshot-current/signup', { method: 'POST',
      body: { commandId: crypto.randomUUID(), formVersion: 1, consent: true, name: '합성 참가자', phone } });
    assert.equal(signup.status, 201);
    const cookie = (signup.headers.get('set-cookie') || '').split(';')[0];
    const path = '/api/public/events/snapshot-current/ticket';
    const read = () => requestJson(h.baseUrl, path, { cookie });
    const check = number => requestJson(h.baseUrl, '/api/public/events/snapshot-current/verification/session', {
      method: 'POST', cookie, body: { phone: number },
    });
    assert.equal((await read()).status, 200);
    assert.equal((await check(phone)).status, 200);
    assert.equal((await check('01089003003')).status, 404, 'recovery uses the submitted phone');
    assert.equal((await requestJson(h.baseUrl, '/api/public/events/snapshot-unrelated/ticket', { cookie })).status, 404);

    const row = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', ['snapshot-current'])).rows[0].payload;
    const originalPerson = structuredClone(row.participants[0]);
    row.participants[0].status = 'CANCELLED'; row.participants[0].revoked = true;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', ['snapshot-current', JSON.stringify(row)]);
    const canceled = await read();
    assert.equal(canceled.status, 200, 'a retained legacy session may see status-only data');
    assert.equal(canceled.json.participant.status, 'CANCELLED');
    assert.equal(Object.hasOwn(canceled.json.participant, 'ticket'), false);
    assert.equal((await check(phone)).status, 404, 'cancelled data cannot issue a bearer');
    row.participants = [];
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', ['snapshot-current', JSON.stringify(row)]);
    assert.equal((await read()).status, 404, 'a removed participant cannot be resolved');

    row.participants = [originalPerson];
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', ['snapshot-current', JSON.stringify(row)]);
    assert.equal((await read()).status, 200);
    const hash = crypto.createHash('sha256').update(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))).digest('hex');
    await h.database.query("UPDATE attendee_sessions SET expires_at = now() - interval '1 day' WHERE token_hash=$1", [hash]);
    assert.equal((await read()).status, 404);
  } finally { await h.close(); }
});
