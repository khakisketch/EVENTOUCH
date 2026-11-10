'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL' }, fn);

test('operator export projection identifies malformed published fields and preserves legacy rows', async () => {
  const h = await startApiHarness();
  try {
    const id = `roster-integrity-${crypto.randomUUID()}`;
    const actor = `roster-actor-${crypto.randomUUID()}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const workspace = emptyWorkspace();
    workspace.participants = [{ id: 'legacy-person', name: '합성 참가자', status: 'PENDING' }];
    workspace.publishedFields = { invalid: true };
    await insertEvent(h.database, { id, slug: id, orgId: LEGACY_ORG,
      payload: { id, slug: id, name: '합성 행사', stage: 'READY', features: [], capacity: 100 }, workspace });
    const cookie = await sessionCookie(h, actor);
    const read = async url => {
      const response = await requestJson(h.baseUrl, url, { cookie });
      assert.equal(response.status, 200);
      return response.json.state.workspaces[id];
    };
    for (const url of ['/api/bootstrap', `/api/events/${id}/bootstrap`]) {
      const projection = await read(url);
      assert.equal(projection.rosterExportFieldsAvailable, false);
      assert.equal(projection.rosterExportFieldCount, null);
      assert.equal(projection.rosterExportParticipantCount, 1);
      assert.deepEqual(projection.publishedFields, [], 'normalized empty array is flagged as untrustworthy');
      assert.deepEqual(projection.participants[0].answers, {});
      assert.deepEqual(projection.participants[0].rosterExportAnswerKeys, []);
      assert.equal(projection.participants[0].phone, '');
    }
    let stored = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
    assert.deepEqual(stored, workspace, 'read did not repair or modify existing data');
    delete stored.publishedFields;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [id, JSON.stringify(stored)]);
    assert.equal((await read(`/api/events/${id}/bootstrap`)).rosterExportFieldsAvailable, true, 'legacy absence means an empty field list');
    stored.publishedFields = [];
    stored.participants[0].answers = null;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [id, JSON.stringify(stored)]);
    assert.equal((await read(`/api/events/${id}/bootstrap`)).participants[0].answers, null, 'explicit malformed answers stay distinguishable');
    stored.publishedFields = [{ id: 'name', label: '이름', type: 'text' }, { id: 'answer', label: '답변', type: 'text' }];
    stored.participants[0].answers = { answer: '000123' };
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [id, JSON.stringify(stored)]);
    const complete = await read(`/api/events/${id}/bootstrap`);
    assert.equal(complete.rosterExportFieldCount, 2);
    assert.deepEqual(complete.participants[0].rosterExportAnswerKeys, ['answer']);
    assert.equal(complete.participants[0].answers.answer, '000123');
  } finally { await h.close(); }
});
