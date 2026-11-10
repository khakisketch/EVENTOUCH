'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL' }, fn);

test('unrelated legacy data survives participant, content and onsite writes', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID();
    const actor = `preservation-owner-${suffix}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const cookie = await sessionCookie(h, actor);
    for (const [command, payload] of [
      ['participant.create', { name: '합성 참가자', phone: '01011112222' }],
      ['notice.save', { title: '합성 공지', body: '공지 내용' }],
      ['desk.save', { name: '합성 입구', action: 'IN', mode: 'desk' }],
    ]) {
      const eventId = `preservation-${crypto.randomUUID()}`;
      const workspace = emptyWorkspace();
      workspace.rewards = { recovery: '손상된 원본 데이터' };
      workspace.venue = null;
      workspace.boothMap = '손상된 지도';
      delete workspace.branding;
      await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
        payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'READY', features: [], capacity: 100 }, workspace });
      const commandId = crypto.randomUUID();
      const send = () => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId, command, payload } });
      const response = await send();
      assert.ok([200, 201].includes(response.status), `${command}: ${JSON.stringify(response.json)}`);
      const stored = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
      assert.deepEqual(stored.rewards, workspace.rewards, `${command} must not erase unrelated malformed rewards`);
      assert.equal(stored.venue, null, `${command} must not replace an unrelated malformed venue`);
      assert.equal(stored.boothMap, workspace.boothMap, `${command} must not replace an unrelated malformed map`);
      assert.equal(Object.hasOwn(stored, 'branding'), false, `${command} must not insert unrelated absent data`);
      const replay = await send();
      assert.equal(replay.status, 200, `${command} receipt remains replayable`);
      assert.deepEqual(replay.json, response.json);
    }
  } finally { await h.close(); }
});

test('a write does not replace the malformed collection it needs to change', async () => {
  const h = await startApiHarness();
  try {
    const suffix = crypto.randomUUID(), actor = `damaged-owner-${suffix}`;
    await insertAccount(h.database, { id: actor, role: 'AGENCY', name: '합성 운영자', email: `${actor}@example.test`, orgId: LEGACY_ORG });
    const cookie = await sessionCookie(h, actor);
    for (const [command, payload, field] of [
      ['participant.create', { name: '합성 참가자', phone: '01011112222' }, 'participants'],
      ['notice.save', { title: '합성 공지', body: '공지 내용' }, 'notices'],
      ['desk.save', { name: '합성 입구', action: 'IN', mode: 'desk' }, 'desks'],
      ['desk.save', { name: '합성 입구', action: 'IN', mode: 'desk' }, 'audit'],
    ]) {
      const eventId = `damaged-${crypto.randomUUID()}`, workspace = emptyWorkspace();
      workspace[field] = { original: '복구해야 할 원본' };
      await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
        payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'READY', features: [], capacity: 100 }, workspace });
      const id = crypto.randomUUID();
      const result = await requestJson(h.baseUrl, `/api/events/${eventId}/commands`, {
        method: 'POST', cookie, body: { commandId: id, command, payload },
      });
      assert.equal(result.status, 409, `${command}/${field}: ${JSON.stringify(result.json)}`);
      assert.equal(result.json.code, 'WORKSPACE_DATA_UNAVAILABLE');
      const stored = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
      assert.deepEqual(stored, workspace, `${command}/${field} is rolled back entirely`);
      const receipts = await h.database.query('SELECT command_id FROM command_receipts WHERE command_id=$1', [id]);
      assert.equal(receipts.rowCount, 0, 'failed writes do not produce successful receipts');
    }
  } finally { await h.close(); }
});
