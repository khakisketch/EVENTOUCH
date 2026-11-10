'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { emptyWorkspace } = require('../server/state');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);

test('schedule status reports this server configuration without exposing another organization or inventing a worker', async () => {
  const env = { EVENTOUCH_MESSAGE_MAINTENANCE: '1', EVENTOUCH_MESSAGE_AUTO_SEND_DUE: '1' };
  const harness = await startApiHarness({ env });
  try {
    const db = harness.database;
    await db.query("INSERT INTO organizations (id, name) VALUES ('other-schedule-org', '다른 운영사')");
    for (const [id, role, orgId] of [['owner', 'AGENCY', LEGACY_ORG], ['staff', 'STAFF', LEGACY_ORG], ['other', 'AGENCY', 'other-schedule-org']]) {
      await insertAccount(db, { id, role, orgId, name: id, email: `${id}@example.test` });
    }
    const workspace = emptyWorkspace();
    workspace.desks = [{ id: 'desk', name: '검증 데스크', action: 'IN', mode: 'desk', open: true }];
    workspace.messages = [
      { id: 'blocked', status: 'SCHEDULED', body: '{{럭키번호}}', scheduled: '2020-01-01T00:00:00Z', recipientIds: ['p1'], simulate: false },
      { id: 'future', status: 'SCHEDULED', body: '{{럭키번호}}', scheduled: '2999-01-01T00:00:00Z', recipientIds: ['p1'], simulate: false },
      { id: 'simulation', status: 'SCHEDULED', body: '{{럭키번호}}', scheduled: '2020-01-01T00:00:00Z', recipientIds: ['p1'], simulate: true },
    ];
    for (const [id, orgId] of [['schedule-a', LEGACY_ORG], ['schedule-b', 'other-schedule-org']]) {
      await insertEvent(db, { id, slug: id, orgId, workspace, payload: { id, slug: id, name: id, stage: 'LIVE', features: [] } });
    }
    await insertAssignment(db, { id: 'assignment', accountId: 'staff', eventId: 'schedule-a', type: 'DESK', targetId: 'desk' });
    const owner = await sessionCookie(harness, 'owner');
    const staff = await sessionCookie(harness, 'staff');
    const other = await sessionCookie(harness, 'other');
    const get = (event, cookie) => requestJson(harness.baseUrl, `/api/events/${event}/bootstrap`, { cookie });
    assert.equal((await get('schedule-a')).status, 401);
    assert.equal((await get('schedule-a', other)).status, 404);
    const a = await get('schedule-a', owner);
    assert.equal(a.status, 200);
    assert.ok(Number.isFinite(Date.parse(a.json.state.messageSchedule.observedAt)));
    const { observedAt: _observedA, ...scheduleA } = a.json.state.messageSchedule;
    assert.deepEqual(scheduleA, { autoConfigured: true, eligibleForAuto: true, workerStarted: false, lastAttemptAt: null, lastResult: 'never', blocked: [{ id: 'blocked', reason: 'LUCKY_NUMBER_MISSING', missing: 1 }] });
    assert.match(a.headers.get('cache-control'), /no-store/);
    const b = await get('schedule-b', other);
    const { observedAt: _observedB, ...scheduleB } = b.json.state.messageSchedule;
    assert.deepEqual(scheduleB, { autoConfigured: false, eligibleForAuto: false, workerStarted: false, lastAttemptAt: null, lastResult: 'never', blocked: [{ id: 'blocked', reason: 'LUCKY_NUMBER_MISSING', missing: 1 }] });
    const staffView = await get('schedule-a', staff);
    assert.equal(staffView.status, 200);
    assert.equal('messageSchedule' in staffView.json.state, false);
    env.EVENTOUCH_MESSAGE_AUTO_SEND_DUE = '0';
    assert.equal((await get('schedule-a', owner)).json.state.messageSchedule.autoConfigured, true);
  } finally {
    await harness.close();
  }
});
