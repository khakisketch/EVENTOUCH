'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL' }, fn);

test('report creation refuses damaged sources without changing data and can safely retry', async () => {
  const h = await startApiHarness();
  try {
    const actor = `report-owner-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const cookie = await sessionCookie(h, actor);
    for (const [field, damaged, source = field] of [
      ['participants', { original: true }], ['checks', null], ['responses', 'unavailable'],
      ['modules', [null]], ['groups', {}], ['booths', { original: true }],
      ['questions', [null]], ['photos', { original: true }], ['venue', null],
      ['booths', [{ name: '부스', used: 'broken', capacity: 10 }]],
      ['modules', [{ id: 'draw', type: 'draw', drawHistory: [{ winners: null }] }], 'draw'],
      ['responses', [{ moduleId: 'survey', ratings: { 만족도: 'broken' } }], 'survey'],
    ]) {
      const eventId = `report-source-${crypto.randomUUID()}`;
      const workspace = emptyWorkspace();
      workspace.modules = [{ id: 'survey', type: 'survey', title: '만족도', questions: ['만족도'] }];
      workspace[field] = damaged;
      await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
        payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'READY', features: [], capacity: 100 }, workspace });
      const bootstrap = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie });
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.json.state.workspaces[eventId].reportSourceAvailability[source], false, `${field}: unsafe source is visible to the operator`);
      const commandId = crypto.randomUUID();
      const send = () => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie,
        body: { commandId, command: 'report.create', payload: { title: '합성 보고서' } } });
      const result = await send();
      assert.equal(result.status, 409, `${field}: ${JSON.stringify(result.json)}`);
      assert.equal(result.json.code, 'REPORT_SOURCE_UNAVAILABLE', field);
      const stored = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
      assert.deepEqual(stored, workspace, `${field}: original is preserved`);
      assert.equal((await h.database.query('SELECT command_id FROM command_receipts WHERE command_id=$1', [commandId])).rowCount, 0);
      stored[field] = emptyWorkspace()[field];
      await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(stored)]);
      const repaired = await send();
      assert.equal(repaired.status, 201, `${field}: ${JSON.stringify(repaired.json)}`);
      const after = await requestJson(h.baseUrl, `/api/events/${eventId}/bootstrap`, { cookie });
      assert.equal(Object.values(after.json.state.workspaces[eventId].reportSourceAvailability).every(Boolean), true);
      const replay = await send();
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.json, repaired.json, 'same command returns its original receipt');
    }
  } finally { await h.close(); }
});

test('absent legacy collections remain empty and a frozen published snapshot remains copyable', async () => {
  const h = await startApiHarness();
  try {
    const actor = `report-legacy-${crypto.randomUUID()}`, eventId = `report-legacy-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const workspace = emptyWorkspace();
    for (const field of ['participants', 'checks', 'responses', 'modules', 'groups', 'booths', 'questions', 'photos']) delete workspace[field];
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'READY', features: [], capacity: 100 }, workspace });
    const cookie = await sessionCookie(h, actor);
    const send = (command, payload) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie,
      body: { commandId: crypto.randomUUID(), command, payload } });
    const created = await send('report.create', { title: '기존 형식 보고서' });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.report.snapshot.metrics.total, 0);
    const report = created.json.report;
    assert.equal((await send('report.publish', { id: report.id })).status, 200);
    const stored = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    stored.photos = { original: true };
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(stored)]);
    const current = await send('report.successor', { id: report.id, source: 'current' });
    assert.equal(current.status, 409);
    assert.equal(current.json.code, 'REPORT_SOURCE_UNAVAILABLE');
    const copy = await send('report.successor', { id: report.id, source: 'snapshot' });
    assert.equal(copy.status, 201, JSON.stringify(copy.json));
    assert.deepEqual(copy.json.report.snapshot, report.snapshot);
  } finally { await h.close(); }
});
