'use strict';
// Exercise the HTTP gate as well as the transactional receipt owner.
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers/postgres-api-server.cjs');
const test = h.databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);
const suffix = crypto.randomUUID();
const eventId = `http-grants-${suffix}`;
const actorId = `http-manager-${suffix}`;
const readerId = `http-reader-${suffix}`;
let api, cookie, readerCookie;
const run = (command, payload, commandId, auth = cookie) => h.requestJson(api.baseUrl, `/api/events/${eventId}/commands`, { cookie: auth, method: 'POST', body: { commandId: commandId || crypto.randomUUID(), command, payload } });
const permissions = value => api.database.query('UPDATE memberships SET write_permissions=$3::jsonb WHERE account_id=$1 AND event_id=$2', [actorId, eventId, JSON.stringify(value)]);
const workspace = async () => (await api.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
before(async () => {
  if (!h.databaseUrl) return;
  api = await h.startApiHarness();
  for (const id of [actorId, readerId]) await h.insertAccount(api.database, { orgId: h.LEGACY_ORG, id, role: 'MANAGER', name: '합성 운영자', email: `${id}@example.test` });
  await h.insertEvent(api.database, { orgId: h.LEGACY_ORG, id: eventId, slug: eventId, payload: { id: eventId, slug: eventId, name: '합성 영수증 검증', stage: 'READY', capacity: 100, features: [] }, workspace: { participants: [], desks: [] } });
  await h.insertMembership(api.database, actorId, eventId, ['all']);
  await h.insertMembership(api.database, readerId, eventId, []);
  cookie = await h.sessionCookie(api, actorId); readerCookie = await h.sessionCookie(api, readerId);
});
after(async () => { if (api) await api.close(); });

for (const [command, payload, scope, list] of [
  ['participant.create', { name: '합성 참가자', phone: '01000000000' }, 'participants', 'participants'],
  ['desk.save', { name: '합성 데스크', action: 'IN', mode: 'desk' }, 'onsite', 'desks'],
]) test(`${command}: same HTTP request replays after grant removal while fresh writes stay denied`, async () => {
  await permissions([scope]);
  const id = crypto.randomUUID();
  const first = await run(command, payload, id);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const count = (await workspace())[list].length;
  await permissions([]);
  const replay = await run(command, payload, id);
  assert.equal(replay.status, 200, "the existing replay response remains a confirmed success");
  assert.deepEqual(replay.json, first.json);
  assert.equal((await workspace())[list].length, count, 'a replay cannot append another row');
  assert.equal((await run(command, payload)).status, 403, 'a new identifier still needs its current feature grant');
  assert.equal((await run(command, payload, id, readerCookie)).status, 409, 'another actor cannot reuse the result');
  await api.database.query('DELETE FROM memberships WHERE account_id=$1 AND event_id=$2', [actorId, eventId]);
  try {
    assert.equal((await run(command, payload, id)).status, 403, 'scope removal still blocks the committed receipt');
  } finally { await h.insertMembership(api.database, actorId, eventId, []); }
  assert.equal((await workspace())[list].length, count);
});


test('HTTP write-grant deferral preserves the staff assignment boundary', async () => {
  const staffId = `http-staff-${suffix}`;
  await h.insertAccount(api.database, { orgId: h.LEGACY_ORG, id: staffId, role: 'STAFF', name: '합성 미배정 스태프', email: `${staffId}@example.test` });
  const staffCookie = await h.sessionCookie(api, staffId);
  const response = await h.requestJson(api.baseUrl, `/api/events/${eventId}/commands`, { cookie: staffCookie, method: 'POST', body: {
    commandId: crypto.randomUUID(), command: 'check.scan', assignmentId: 'missing-assignment', payload: { deskId: (await workspace()).desks[0].id, code: 'SYNTHETIC_INVALID_CODE' },
  } });
  assert.equal(response.status, 403);
});
