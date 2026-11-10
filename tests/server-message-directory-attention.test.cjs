'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL' }, fn);

test('directory counts only reservations with a valid past instant as overdue', async () => {
  const h = await startApiHarness();
  try {
    const id = randomUUID(), actor = `directory-owner-${id}`, eventId = `directory-event-${id}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const workspace = emptyWorkspace();
    workspace.messages = [
      { id: 'due', status: 'SCHEDULED', scheduled: '2020-01-01T00:00:00Z' },
      { id: 'unavailable-zone', status: 'SCHEDULED', scheduled: '2020-01-01T09:00' },
      { id: 'invalid-date', status: 'SCHEDULED', scheduled: '2020-02-30T09:00:00Z' },
      { id: 'future', status: 'SCHEDULED', scheduled: '2999-01-01T00:00:00Z' },
    ];
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [] }, workspace });
    const response = await requestJson(h.baseUrl, '/api/console/directory', { cookie: await sessionCookie(h, actor) });
    assert.equal(response.status, 200);
    assert.equal(response.json.directory.events.find(event => event.id === eventId).manualDue, 1);
  } finally { await h.close(); }
});
