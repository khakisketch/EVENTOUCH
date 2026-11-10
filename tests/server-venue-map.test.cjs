'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { floorplanPng } = require('./helpers/floorplan-image.cjs');
const { emptyWorkspace } = require('../server/state');
let harness, cookie, image, foreign, large;
const id = 'venue-map-event';
const otherId = 'venue-map-other';
const commandId = () => `venue-${randomUUID()}`;
const eventPayload = (eventId) => ({ id: eventId, slug: eventId, name: '합성 안내도 행사', date: '2027-01-16', stage: 'LIVE', features: ['venue'] });
const details = { name: '검증장', address: '합성 주소', directions: '동문', contact: '', description: '1층' };
const command = (payload, key = commandId()) => requestJson(harness.baseUrl, `/api/events/${id}/commands`, { method: 'POST', cookie, body: { commandId: key, command: 'venue.save', payload } });
async function upload(eventId, bytes) {
  const response = await fetch(`${harness.baseUrl}/api/events/${eventId}/files?name=venue.png&commandId=${commandId()}`, { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: bytes });
  assert.equal(response.status, 201);
  return (await response.json()).file;
}
before(async () => {
  harness = await startApiHarness();
  await insertAccount(harness.database, { id: 'venue-map-owner', role: 'AGENCY', name: '운영자', email: 'venue-map@fixture.invalid', orgId: LEGACY_ORG });
  await insertEvent(harness.database, { id, slug: id, orgId: LEGACY_ORG, payload: eventPayload(id), workspace: emptyWorkspace() });
  await insertEvent(harness.database, { id: otherId, slug: otherId, orgId: LEGACY_ORG, payload: eventPayload(otherId), workspace: emptyWorkspace() });
  cookie = await sessionCookie(harness, 'venue-map-owner');
  const png = floorplanPng();
  image = await upload(id, png);
  foreign = await upload(otherId, png);
  large = await upload(id, Buffer.concat([png, Buffer.alloc(500000 - png.length)]));
});
after(async () => { if (harness) await harness.close(); });

test('venue map saves once, publishes only through permitted public projection, and old clients preserve it', async () => {
  const key = commandId();
  const payload = { ...details, map: { image: { fileId: image.fileId }, alt: '동문에서 접수대까지의 동선' }, expectedMap: { fileId: '', alt: '' } };
  const saved = await command(payload, key);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.venue.map.image.fileId, image.fileId);
  assert.equal((await command(payload, key)).status, 200, 'same idempotency key replays after commit');
  const publicRead = await requestJson(harness.baseUrl, `/api/public/events/${id}`);
  assert.deepEqual(publicRead.json.workspace.venue.map, { image: { fileId: image.fileId }, alt: '동문에서 접수대까지의 동선' });
  assert.equal((await fetch(`${harness.baseUrl}/api/public/events/${id}/files/${image.fileId}`)).status, 200);
  const legacy = await command({ ...details, description: '이전 클라이언트 변경' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.venue.map.image.fileId, image.fileId, 'omitting map does not delete a newer client field');
  const duplicate = await requestJson(harness.baseUrl, `/api/events/${id}/duplicate`, { method: 'POST', cookie, body: { commandId: commandId(), name: '복제 합성 행사', slug: 'venue-map-copy' } });
  assert.equal(duplicate.status, 201, JSON.stringify(duplicate.json));
  const copied = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [duplicate.json.event.id])).rows[0].payload;
  assert.equal(copied.venue.map, undefined, 'copy never reuses another event\'s file');
});

test('map validation rejects stale, foreign, oversized and missing descriptions', async () => {
  const current = { fileId: image.fileId, alt: '동문에서 접수대까지의 동선' };
  assert.equal((await command({ ...details, map: { image: { fileId: image.fileId }, alt: '변경' }, expectedMap: { fileId: '', alt: '' } })).status, 409);
  assert.equal((await command({ ...details, map: { image: { fileId: foreign.fileId }, alt: '다른 행사 파일' }, expectedMap: current })).status, 404);
  assert.equal((await command({ ...details, map: { image: { fileId: large.fileId }, alt: '크기 제한' }, expectedMap: current })).status, 400);
  assert.equal((await command({ ...details, map: { image: { fileId: image.fileId }, alt: ' ' }, expectedMap: current })).status, 400);
  const workspace = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
  assert.equal(workspace.venue.map.image.fileId, image.fileId);
});

test('page-hidden map and disabled venue stay private and re-enabling restores the publication', async () => {
  const row = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0];
  row.payload.pageExperience = { published: { showVenue: false } };
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [id, JSON.stringify(row.payload)]);
  let read = await requestJson(harness.baseUrl, `/api/public/events/${id}`);
  assert.equal(read.json.workspace.venue.name, details.name, 'page visibility does not change the separately operated screen text');
  assert.equal(read.json.workspace.venue.map, undefined);
  assert.equal((await fetch(`${harness.baseUrl}/api/public/events/${id}/files/${image.fileId}`)).status, 404);
  row.payload.pageExperience.published.showVenue = true;
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [id, JSON.stringify(row.payload)]);
  const event = (await harness.database.query('SELECT payload FROM events WHERE id=$1', [id])).rows[0].payload;
  event.features = [];
  await harness.database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [id, JSON.stringify(event)]);
  read = await requestJson(harness.baseUrl, `/api/public/events/${id}`);
  assert.deepEqual(read.json.workspace.venue, { name: '', address: '', directions: '', contact: '', description: '' });
  assert.equal((await fetch(`${harness.baseUrl}/api/public/events/${id}/files/${image.fileId}`)).status, 404);
  const unchanged = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
  assert.equal(unchanged.venue.name, details.name);
  assert.equal(unchanged.venue.map.image.fileId, image.fileId);
  event.features = ['venue'];
  await harness.database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [id, JSON.stringify(event)]);
  read = await requestJson(harness.baseUrl, `/api/public/events/${id}`);
  assert.equal(read.json.workspace.venue.name, details.name);
  assert.equal(read.json.workspace.venue.map.image.fileId, image.fileId);
  assert.equal((await fetch(`${harness.baseUrl}/api/public/events/${id}/files/${image.fileId}`)).status, 200);
});
