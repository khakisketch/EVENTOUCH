'use strict';
// Real command transactions, old workspace rows, and scheduled snapshots.
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers/postgres-api-server.cjs');
const test = h.databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);
const suffix = crypto.randomUUID();
const eventId = `template-event-${suffix}`;
const actorId = `template-manager-${suffix}`;
const readerId = `template-reader-${suffix}`;
let api, cookie, readerCookie;
const run = (command, payload, id = `template-${crypto.randomUUID()}`, auth = cookie, event = eventId) =>
  h.requestJson(api.baseUrl, `/api/events/${event}/commands`, { cookie: auth, method: 'POST', body: { commandId: id, command, payload } });
const workspace = async () => (await api.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
const create = async () => {
  const result = await run('template.save', { name: '합성 안내', channel: 'ALIMTALK', body: '행사 안내입니다.', solapiTemplateId: 'SYNTHETIC_APPROVED_ID' });
  assert.equal(result.status, 200, JSON.stringify(result.json)); return result.json.template;
};
before(async () => {
  if (!h.databaseUrl) return;
  api = await h.startApiHarness();
  for (const id of [actorId, readerId]) await h.insertAccount(api.database, { orgId: h.LEGACY_ORG, id, role: 'MANAGER', name: '합성 운영자', email: `${id}@example.test` });
  await h.insertEvent(api.database, { orgId: h.LEGACY_ORG, id: eventId, slug: eventId,
    payload: { id: eventId, slug: eventId, name: '합성 템플릿 행사', stage: 'LIVE', features: [] },
    workspace: { participants: [{ id: 'synthetic-person', name: '합성 참가자', phone: '01000000000', status: 'APPROVED', paymentStatus: 'FREE' }], templates: [], messages: [] } });
  await h.insertMembership(api.database, actorId, eventId, ['messages']);
  await h.insertMembership(api.database, readerId, eventId, []);
  cookie = await h.sessionCookie(api, actorId); readerCookie = await h.sessionCookie(api, readerId);
});
after(async () => { if (api) await api.close(); });

test('legacy templates without lifecycle fields remain active and can be restored after archive', async () => {
  const legacy = { id: 'legacy-template', name: '이전 문자', body: '이전 문구' };
  await api.database.query("UPDATE event_workspaces SET payload=jsonb_set(payload,'{templates}',(payload->'templates') || $2::jsonb) WHERE event_id=$1", [eventId, JSON.stringify([legacy])]);
  const archived = await run('template.archive', { id: legacy.id, archived: true, expectedVersion: 0 });
  assert.equal(archived.status, 200, JSON.stringify(archived.json));
  assert.equal(archived.json.template.archived, true); assert.equal(archived.json.template.version, 1);
  const restored = await run('template.archive', { id: legacy.id, archived: false, expectedVersion: 1 });
  assert.equal(restored.status, 200); assert.equal(restored.json.template.body, legacy.body);
  assert.equal(restored.json.template.archived, false); assert.equal(restored.json.template.version, 2);
});
test('archive requires messages permission, valid version and a template in this event', async () => {
  const template = await create();
  const payload = { id: template.id, archived: true, expectedVersion: template.version };
  assert.equal((await run('template.archive', payload, undefined, readerCookie)).status, 403);
  assert.equal((await run('template.archive', { ...payload, id: 'other-event-template' })).status, 404);
  for (const patch of [{ archived: 'true' }, { expectedVersion: -1 }, { expectedVersion: '1' }]) {
    assert.equal((await run('template.archive', { ...payload, ...patch })).status, 400);
  }
  assert.equal((await workspace()).templates.find(t => t.id === template.id).archived, false);
});
test('a concurrent content edit invalidates the previous archive confirmation', async () => {
  const template = await create();
  const edited = await run('template.save', { ...template, body: '다른 운영자가 수정한 문구' });
  assert.equal(edited.status, 200); assert.equal(edited.json.template.version, template.version + 1);
  const stale = await run('template.archive', { id: template.id, archived: true, expectedVersion: template.version });
  assert.equal(stale.status, 409);
  const staleEdit = await run('template.save', { ...template, body: '덮어쓰면 안 되는 오래된 수정', expectedVersion: template.version });
  assert.equal(staleEdit.status, 409);
  const stored = (await workspace()).templates.find(t => t.id === template.id);
  assert.equal(stored.body, edited.json.template.body); assert.equal(stored.archived, false);
});
test('same archive receipt replays after permission change without changing the version twice', async () => {
  const template = await create(); const id = `receipt-${crypto.randomUUID()}`;
  const payload = { id: template.id, archived: true, expectedVersion: template.version };
  const first = await run('template.archive', payload, id); assert.equal(first.status, 200);
  await api.database.query("UPDATE memberships SET write_permissions='[]'::jsonb WHERE account_id=$1 AND event_id=$2", [actorId, eventId]);
  try {
    const replay = await run('template.archive', payload, id);
    assert.equal(replay.status, 200); assert.deepEqual(replay.json, first.json);
    assert.equal((await workspace()).templates.find(t => t.id === template.id).version, template.version + 1);
    assert.equal((await run('template.archive', { ...payload, archived: false, expectedVersion: template.version + 1 })).status, 403);
    assert.equal((await run('template.archive', payload, id, readerCookie)).status, 409, 'a different actor cannot reuse the receipt');
  } finally { await api.database.query("UPDATE memberships SET write_permissions='[\"messages\"]'::jsonb WHERE account_id=$1 AND event_id=$2", [actorId, eventId]); }
});
test('archiving blocks new use and editing while preserving a registered simulated reservation', async () => {
  const template = await create();
  const message = (await run('message.create', { ids: ['synthetic-person'], title: '합성 예약', channel: 'ALIMTALK', body: template.body, templateId: template.id, simulate: true, scheduled: new Date(Date.now() + 3600000).toISOString() })).json.message;
  assert.ok(message && message.status === 'SCHEDULED');
  assert.equal((await run('template.archive', { id: template.id, archived: true, expectedVersion: template.version })).status, 200);
  assert.equal((await run('template.save', { ...template, body: '보관 중 수정' })).status, 409);
  assert.equal((await run('message.create', { ids: ['synthetic-person'], title: '차단할 새 요청', channel: 'SMS', body: '문구', templateId: template.id, simulate: true })).status, 409);
  const stored = (await workspace()).messages.find(m => m.id === message.id);
  assert.deepEqual(stored, message);
  await api.database.query("UPDATE event_workspaces SET payload=jsonb_set(payload,'{messages}',(SELECT jsonb_agg(CASE WHEN m->>'id'=$2 THEN jsonb_set(m,'{scheduled}',to_jsonb($3::text)) ELSE m END) FROM jsonb_array_elements(payload->'messages') m)) WHERE event_id=$1", [eventId, message.id, new Date(Date.now() - 1000).toISOString()]);
  const executed = await run('message.retry', { id: message.id });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  assert.equal(executed.json.message.status, 'SIMULATED'); assert.equal(executed.json.message.solapiTemplateId, template.solapiTemplateId);
  assert.equal(executed.json.message.body, template.body);
});
test('archived events reject template lifecycle changes', async () => {
  const template = await create();
  await api.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}','\"ARCHIVED\"'::jsonb) WHERE id=$1", [eventId]);
  try { assert.equal((await run('template.archive', { id: template.id, archived: true, expectedVersion: template.version })).status, 409); }
  finally { await api.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}','\"LIVE\"'::jsonb) WHERE id=$1", [eventId]); }
});
