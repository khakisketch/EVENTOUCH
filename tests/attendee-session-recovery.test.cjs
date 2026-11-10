'use strict';

// An authenticated ticket recovery must extend, not replace, an existing
// browser session. All people, events, and delivered codes are synthetic.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { databaseUrl, startApiHarness, insertEvent, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { mockOutbox, clearMockOutbox } = require('../server/verification-transport');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
const cookieOf = response => (response.headers.get('set-cookie') || '').split(';')[0];
const cmd = () => `cmd-${crypto.randomUUID()}`;

test('recovering a ticket preserves other events and selects the newly verified attendee', async () => {
  const previousMock = process.env.EVENTOUCH_SMS_MOCK;
  process.env.EVENTOUCH_SMS_MOCK = '1';
  const harness = await startApiHarness();
  try {
    const fields = [
      { id: 'name', label: '이름', type: 'text', required: true, options: [] },
      { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
    ];
    for (const slug of ['session-recovery-first', 'session-recovery-second']) {
      await insertEvent(harness.database, { id: slug, slug, orgId: LEGACY_ORG,
        payload: { id: slug, slug, name: slug, date: '2099-01-01', stage: 'READY', capacity: 20 },
        workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
          formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '동의', consentVersion: 1,
          price: 0, verificationRequired: false },
      });
    }
    const call = (url, opts = {}) => requestJson(harness.baseUrl, url, opts);
    const signup = (slug, name, phone, cookie) => call(`/api/events/${slug}/signup`, {
      method: 'POST', cookie, body: { commandId: cmd(), formVersion: 1, consent: true, name, phone },
    });
    const ticket = (slug, cookie) => call(`/api/public/events/${slug}/ticket`, { cookie });
    const first = await signup('session-recovery-first', '행사 A 참가자', '01089000001');
    assert.equal(first.status, 201);
    let cookie = cookieOf(first);
    assert.match(cookie, /^etko_attendee_[a-f0-9]{24}=/);
    const second = await signup('session-recovery-second', '행사 B 첫 참가자', '01089000002', cookie);
    assert.equal(second.status, 201);
    const firstCookie = cookie;
    cookie = `${firstCookie}; ${cookieOf(second)}`;
    const other = await signup('session-recovery-second', '행사 B 둘째 참가자', '01089000003');
    assert.equal(other.status, 201);
    const recover = async (slug, phone, incoming) => {
      clearMockOutbox();
      const request = await call(`/api/public/events/${slug}/verification/request`, {
        method: 'POST', body: { phone, purpose: 'RECOVER' },
      });
      assert.equal(request.status, 200);
      const code = mockOutbox.findLast(entry => entry.to === phone)?.code;
      assert.ok(code);
      return call(`/api/public/events/${slug}/verification/confirm`, {
        method: 'POST', cookie: incoming, body: { phone, code },
      });
    };
    const recovered = await recover('session-recovery-second', '01089000003', cookie);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get('cache-control'), 'no-store');
    assert.equal(typeof recovered.json.ticket, 'string');
    const after = `${firstCookie}; ${cookieOf(recovered)}`;
    const a = await ticket('session-recovery-first', after);
    const b = await ticket('session-recovery-second', after);
    assert.equal(a.status, 200, 'recovering a different event must retain the previous event');
    assert.equal(a.json.participant.name, '행사 A 참가자');
    assert.equal(b.status, 200);
    assert.equal(b.json.participant.name, '행사 B 둘째 참가자', 'the newest verification must select this event attendee');
    const recoveredPair = cookieOf(recovered);
    const token = decodeURIComponent(recoveredPair.slice(recoveredPair.indexOf('=') + 1));
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = (await harness.database.query('SELECT grants FROM attendee_sessions WHERE token_hash=$1', [hash])).rows[0];
    assert.equal(row.grants.filter(grant => grant.eventId === 'session-recovery-second').length, 1);
    const fallback = (phone, session = after) => call('/api/public/events/session-recovery-second/verification/session', {
      method: 'POST', cookie: session, body: { phone },
    });
    assert.equal((await fallback('01089000002')).status, 404, 'another verified number must not expose this session ticket');
    assert.equal((await fallback('01089000003', '')).status, 404, 'a number alone never authorizes recovery');
    const match = await fallback('01089000003');
    assert.equal(match.status, 200);
    assert.equal(match.headers.get('cache-control'), 'no-store');
    assert.equal(match.json.ticket, recovered.json.ticket);

    const changed = await recover('session-recovery-second', '01089000002', after);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.json.ticket, recovered.json.ticket, 'each verification response names its own attendee');
    const originalBearer = await call('/api/public/events/session-recovery-second/ticket', { bearer: recovered.json.ticket });
    assert.equal(originalBearer.json.participant.name, '행사 B 둘째 참가자', 'a later verification cannot change the earlier response');
    assert.equal((await fallback('01089000003')).status, 404, 'the newer session cannot be mistaken for the earlier attendee');
    const current = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', ['session-recovery-second'])).rows[0].payload;
    const person = current.participants.find(item => item.phone === '01089000002');
    person.phone = '01089000004';
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', ['session-recovery-second', JSON.stringify(current)]);
    assert.equal((await fallback('01089000002')).status, 404, 'changed contact invalidates the existing grant');
    person.phone = '01089000002';
    person.status = 'CANCELLED';
    person.revoked = true;
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', ['session-recovery-second', JSON.stringify(current)]);
    assert.equal((await fallback('01089000002')).status, 404, 'cancelled tickets cannot be recovered from the session');
    person.status = 'APPROVED';
    person.revoked = false;
    person.ticketExpiresAt = new Date(Date.now() - 60_000).toISOString();
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', ['session-recovery-second', JSON.stringify(current)]);
    assert.equal((await fallback('01089000002')).status, 404, 'expired tickets cannot be recovered from the session');
    person.ticket = `ET:session-recovery-second:T-${crypto.randomBytes(32).toString('base64url')}`;
    person.ticketExpiresAt = new Date(Date.now() + 60_000).toISOString();
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', ['session-recovery-second', JSON.stringify(current)]);
    const reissued = await fallback('01089000002');
    assert.equal(reissued.status, 200);
    assert.equal(reissued.json.ticket, person.ticket, 'only the current reissued ticket is returned');
  } finally {
    clearMockOutbox();
    await harness.close();
    if (previousMock === undefined) delete process.env.EVENTOUCH_SMS_MOCK;
    else process.env.EVENTOUCH_SMS_MOCK = previousMock;
  }
});
