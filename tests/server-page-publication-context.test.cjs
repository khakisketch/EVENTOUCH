'use strict';
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers/postgres-api-server.cjs');
const test = h.databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);
const suffix = crypto.randomUUID(), eventId = `page-context-${suffix}`;
let api, manager, reader;
const run = (id, command, payload, commandId = crypto.randomUUID(), cookie = manager) => h.requestJson(api.baseUrl, `/api/events/${id}/commands`, {
  method: 'POST', cookie, body: { commandId, command, payload },
});
const ok = result => { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.json)); return result.json; };
const workspace = async id => (await api.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
const save = (id, intro, version) => run(id, 'attendee.page.save', {
  intro, accent: '#E76D26', showAnnouncements: true, showSchedule: true, showVenue: true, showPrograms: true, expectedDraftVersion: version,
});
const seed = async (id, stage = 'DRAFT') => {
  await h.insertEvent(api.database, { id, slug: id, orgId: h.LEGACY_ORG,
    payload: { id, slug: id, name: '합성 기획 행사', stage, date: '2027-02-01', start: '09:00', end: '17:00', capacity: 100, features: ['venue'] },
    workspace: require('../server/state').emptyWorkspace() });
  await h.insertMembership(api.database, `manager-${suffix}`, id, ['page', 'settings']);
  await h.insertMembership(api.database, `reader-${suffix}`, id, []);
};
before(async () => {
  if (!h.databaseUrl) return;
  api = await h.startApiHarness();
  for (const role of ['manager', 'reader']) await h.insertAccount(api.database, { id: `${role}-${suffix}`, orgId: h.LEGACY_ORG, role: 'MANAGER', name: `합성 ${role}`, email: `${role}-${suffix}@example.test` });
  manager = await h.sessionCookie(api, `manager-${suffix}`);
  reader = await h.sessionCookie(api, `reader-${suffix}`);
  await seed(eventId);
});
after(async () => { if (api) await api.close(); });

test('page publication binds reviewed public access and replays the original receipt after the event opens', async () => {
  const draft = ok(await save(eventId, '첫 번째 합성 안내', 0));
  const reviewed = { expectedDraftVersion: draft.draftVersion, expectedDestinations: { slug: eventId, public: false } };
  const id = crypto.randomUUID();
  const first = ok(await run(eventId, 'attendee.page.publish-reviewed', reviewed, id));
  assert.deepEqual(first.reviewedDestinations, reviewed.expectedDestinations);
  assert.equal((await h.requestJson(api.baseUrl, `/api/public/events/${eventId}`)).status, 404);
  ok(await run(eventId, 'event.stage', { stage: 'READY' }));
  assert.deepEqual(ok(await run(eventId, 'attendee.page.publish-reviewed', reviewed, id)), first, 'receipt lookup precedes the new context guard');
  const next = ok(await save(eventId, '두 번째 합성 안내', draft.draftVersion));
  const stale = await run(eventId, 'attendee.page.publish-reviewed', { ...reviewed, expectedDraftVersion: next.draftVersion });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PAGE_PUBLICATION_CONTEXT_CHANGED');
  assert.equal((await workspace(eventId)).pageExperience.published.intro, '첫 번째 합성 안내');
  const fresh = { expectedDraftVersion: next.draftVersion, expectedDestinations: { slug: eventId, public: true } };
  assert.equal(ok(await run(eventId, 'attendee.page.publish-reviewed', fresh)).published.intro, '두 번째 합성 안내');
});

test('page publication rejects changed slug, malformed review, and unauthorized managers; legacy stays available', async () => {
  const version = (await workspace(eventId)).pageExperience.draftVersion;
  const draft = ok(await save(eventId, '주소를 바꾼 합성 안내', version));
  const slug = `page-moved-${suffix}`;
  ok(await run(eventId, 'event.update', { name: '합성 기획 행사', slug, date: '2027-02-01', start: '09:00', end: '17:00', capacity: 100 }));
  const input = { expectedDraftVersion: draft.draftVersion, expectedDestinations: { slug: eventId, public: true } };
  const stale = await run(eventId, 'attendee.page.publish-reviewed', input);
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PAGE_PUBLICATION_CONTEXT_CHANGED');
  assert.equal((await workspace(eventId)).pageExperience.published.intro, '두 번째 합성 안내');
  for (const expectedDestinations of [undefined, null, {}, { slug, public: 'true' }, { slug, public: true, extra: 1 }]) {
    assert.equal((await run(eventId, 'attendee.page.publish-reviewed', { expectedDraftVersion: draft.draftVersion, expectedDestinations })).status, 400);
  }
  for (const expectedDraftVersion of [undefined, -1, '2']) {
    assert.equal((await run(eventId, 'attendee.page.publish-reviewed', { expectedDraftVersion, expectedDestinations: { slug, public: true } })).status, 400);
  }
  assert.equal((await run(eventId, 'attendee.page.publish-reviewed', { expectedDraftVersion: draft.draftVersion, expectedDestinations: { slug, public: true } }, undefined, reader)).status, 403);
  assert.equal(ok(await run(eventId, 'attendee.page.publish', { expectedDraftVersion: draft.draftVersion })).published.intro, '주소를 바꾼 합성 안내');
});

test('a committed receipt remains the original result after the public address changes', async () => {
  const id = `page-receipt-${suffix}`;
  await seed(id);
  const draft = ok(await save(id, '주소 변경 전 합성 안내', 0));
  const reviewed = { expectedDraftVersion: draft.draftVersion, expectedDestinations: { slug: id, public: false } };
  const commandId = crypto.randomUUID();
  const committed = ok(await run(id, 'attendee.page.publish-reviewed', reviewed, commandId));
  const newSlug = `page-rm-${suffix}`;
  ok(await run(id, 'event.update', { name: '합성 기획 행사', slug: newSlug, date: '2027-02-01', start: '09:00', end: '17:00', capacity: 100 }));
  assert.deepEqual(ok(await run(id, 'attendee.page.publish-reviewed', reviewed, commandId)), committed);
  const rejected = await run(id, 'attendee.page.publish-reviewed', reviewed);
  assert.equal(rejected.status, 409); assert.equal(rejected.json.code, 'PAGE_PUBLICATION_CONTEXT_CHANGED');
});

test('opening an event and publishing a reviewed page serialize on the same event lock', async () => {
  for (let index = 0; index < 6; index++) {
    const id = `page-race-${index}-${suffix}`;
    await seed(id);
    const draft = ok(await save(id, '동시성 합성 안내', 0));
    const input = { expectedDraftVersion: draft.draftVersion, expectedDestinations: { slug: id, public: false } };
    const commandId = crypto.randomUUID();
    const opening = () => run(id, 'event.stage', { stage: 'READY' });
    const publishing = () => run(id, 'attendee.page.publish-reviewed', input, commandId);
    const [first, second] = await Promise.all(index % 2 ? [opening(), publishing()] : [publishing(), opening()]);
    const [opened, result] = index % 2 ? [first, second] : [second, first];
    assert.equal(opened.status, 200);
    assert.ok([200, 409].includes(result.status));
    const page = (await workspace(id)).pageExperience;
    if (result.status === 200) {
      assert.deepEqual(result.json.reviewedDestinations, input.expectedDestinations);
      assert.deepEqual(ok(await run(id, 'attendee.page.publish-reviewed', input, commandId)), result.json);
      assert.equal(page.published.intro, '동시성 합성 안내');
    } else {
      assert.equal(result.json.code, 'PAGE_PUBLICATION_CONTEXT_CHANGED');
      assert.equal(page.publishedAt, null);
    }
  }
});

test('reviewed public availability matches the public API for every event stage', async () => {
  for (const [index, stage] of ['DRAFT', 'READY', 'LIVE', 'ENDED', 'ARCHIVED'].entries()) {
    const id = `parity-${index}-${suffix}`;
    await seed(id, stage);
    const publicResult = await h.requestJson(api.baseUrl, `/api/public/events/${id}`);
    assert.equal(publicResult.status, ['READY', 'LIVE', 'ENDED'].includes(stage) ? 200 : 404);
    if (stage === 'ARCHIVED') {
      assert.equal((await save(id, '보관 행사', 0)).status, 409);
      continue;
    }
    const draft = ok(await save(id, '공개 상태 합성 안내', 0));
    const expectedDestinations = { slug: id, public: publicResult.status === 200 };
    const published = ok(await run(id, 'attendee.page.publish-reviewed', { expectedDraftVersion: draft.draftVersion, expectedDestinations }));
    assert.deepEqual(published.reviewedDestinations, expectedDestinations);
  }
});
