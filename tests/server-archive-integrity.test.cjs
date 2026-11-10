'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL' }, fn);

test('archive cannot mistake unreadable intake or program state for a closed event', async () => {
  const h = await startApiHarness();
  try {
    const actor = `archive-owner-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const cookie = await sessionCookie(h, actor);
    for (const [field, value] of [['participants', null], ['participants', [null]], ['modules', { original: '확인 필요' }], ['modules', null],
      ['modules', [null]], ['modules', [{ id: 'q', status: null }]], ['modules', [{ id: 'q', status: 'UNKNOWN' }]],
      ['registrationOpen', null], ['registrationOpen', 'false']]) {
      const eventId = `archive-guard-${crypto.randomUUID()}`, workspace = emptyWorkspace(); workspace[field] = value;
      await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
        payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'ENDED', features: [], capacity: 100 }, workspace });
      const id = crypto.randomUUID();
      const send = () => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie,
        body: { commandId: id, command: 'event.stage', payload: { stage: 'ARCHIVED' } } });
      const res = await send();
      assert.equal(res.status, 409, `${field}/${JSON.stringify(value)}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.code, 'ARCHIVE_PRECONDITIONS_UNAVAILABLE');
      const stored = (await h.database.query('SELECT e.payload AS event, w.payload AS workspace FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1', [eventId])).rows[0];
      assert.equal(stored.event.stage, 'ENDED'); assert.deepEqual(stored.workspace, workspace);
      assert.equal((await h.database.query('SELECT command_id FROM command_receipts WHERE command_id=$1', [id])).rowCount, 0);
      stored.workspace[field] = emptyWorkspace()[field];
      await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(stored.workspace)]);
      const allowed = await send(); assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
      const replay = await send(); assert.equal(replay.status, 200); assert.deepEqual(replay.json, allowed.json);
    }
  } finally { await h.close(); }
});

test('legacy absence remains closed, while lowercase open remains open', async () => {
  const h = await startApiHarness();
  try {
    const actor = `archive-legacy-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const cookie = await sessionCookie(h, actor);
    for (const [modules, expected] of [[undefined, 200], [[{ id: 'poll', status: 'closed' }], 200], [[{ id: 'poll', status: 'open' }], 409]]) {
      const eventId = `archive-legacy-${crypto.randomUUID()}`, workspace = emptyWorkspace();
      if (modules === undefined) { delete workspace.modules; delete workspace.registrationOpen; } else workspace.modules = modules;
      await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
        payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'ENDED', features: [], capacity: 100 }, workspace });
      const response = await requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie,
        body: { commandId: crypto.randomUUID(), command: 'event.stage', payload: { stage: 'ARCHIVED' } } });
      assert.equal(response.status, expected, JSON.stringify(response.json));
      if (expected === 409) assert.match(response.json.error, /접수와 참여 콘텐츠를 닫은 뒤/);
    }
  } finally { await h.close(); }
});

test('staff can distinguish unreadable checks without receiving operator archive data', async () => {
  const h = await startApiHarness();
  try {
    const actor = `archive-staff-${crypto.randomUUID()}`, eventId = `archive-staff-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: actor, role: 'STAFF', name: '합성 스태프', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const workspace = emptyWorkspace(); workspace.checks = { original: '복구할 출입 기록' };
    workspace.desks = [{ id: 'desk', name: '합성 데스크', action: 'IN', open: true }];
    workspace.participants = [{ id: 'person', name: '합성 참가자', phone: '01011112222', status: 'APPROVED' }];
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: [], capacity: 100 }, workspace });
    await insertAssignment(h.database, { id: `assignment-${crypto.randomUUID()}`, accountId: actor, eventId, type: 'DESK', targetId: 'desk' });
    const cookie = await sessionCookie(h, actor);
    for (const path of ['/api/bootstrap', `/api/events/${eventId}/bootstrap`]) {
      const response = await requestJson(h.baseUrl, path, { cookie });
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const projection = response.json.state.workspaces[eventId];
      assert.equal(projection.checksAvailable, false);
      assert.equal(projection.participantsAvailable, true);
      assert.equal(Object.hasOwn(projection, 'archivePreconditions'), false);
      assert.equal(Object.hasOwn(projection.participants[0], 'phone'), false);
    }
  } finally { await h.close(); }
});
