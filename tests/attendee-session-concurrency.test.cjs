'use strict';

// Real PostgreSQL checks for attendee sessions shared by several event tabs.
// The barrier exposes the former read/modify/write race without using any
// external service or non-synthetic user data.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const { databaseUrl, startApiHarness } = require('./helpers/postgres-api-server.cjs');
const { createAttendeeAccess } = require('../server/attendees');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('concurrent event grants preserve every event in the same attendee session', async () => {
  const harness = await startApiHarness();
  try {
    let reads = 0;
    let release;
    const bothRead = new Promise(resolve => { release = resolve; });
    const database = {
      async query(sql, params) {
        const result = await harness.database.query(sql, params);
        if (/SELECT grants, expires_at FROM attendee_sessions/.test(sql)) {
          reads += 1;
          if (reads === 2) release();
          await bothRead;
        }
        return result;
      },
    };
    const service = createAttendeeAccess(database);
    const session = await service.grantAccess({ event: { id: 'event-first', payload: { date: '2099-01-01' } },
      participantId: 'person-first', phone: '01000000001' });
    const cookieHeader = `etko_attendee=${encodeURIComponent(session.token)}`;
    await Promise.all([
      service.mergeGrant({ cookieHeader, event: { id: 'event-a', payload: { date: '2026-11-01' } },
        participantId: 'person-a', phone: '01000000002' }),
      service.mergeGrant({ cookieHeader, event: { id: 'event-b', payload: { date: '2026-11-01' } },
        participantId: 'person-b', phone: '01000000003' }),
    ]);
    const resolved = await createAttendeeAccess(harness.database).resolveSession(cookieHeader);
    assert.deepEqual(resolved.grants.map(grant => grant.eventId).sort(), ['event-a', 'event-b', 'event-first']);
    assert.ok(new Date(resolved.expiresAt).getTime() >= Date.parse(session.expiresAt), 'another event must not shorten the existing session');
  } finally {
    await harness.close();
  }
});
