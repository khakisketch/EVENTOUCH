'use strict';
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers/postgres-api-server.cjs');
const test = h.databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);
const suffix = crypto.randomUUID(), eventId = `publication-dest-${suffix}`;
let api, manager, reader;
const run = (command, payload, id = crypto.randomUUID(), cookie = manager) => h.requestJson(api.baseUrl, `/api/events/${eventId}/commands`, {
  method: 'POST', cookie, body: { commandId: id, command, payload },
});
const success = result => { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.json)); return result.json; };
const read = async () => (await api.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
const page = async patch => {
  const draft = success(await run('attendee.page.save', { intro: '합성 행사 안내', accent: '#E76D26', showAnnouncements: true, showSchedule: true, showPrograms: true, showVenue: true, ...patch }));
  return success(await run('attendee.page.publish', { expectedDraftVersion: draft.draftVersion }));
};
before(async () => {
  if (!h.databaseUrl) return;
  api = await h.startApiHarness();
  for (const role of ['manager', 'reader']) await h.insertAccount(api.database, { id: `${role}-${suffix}`, orgId: h.LEGACY_ORG, role: 'MANAGER', name: `합성 ${role}`, email: `${role}-${suffix}@example.test` });
  await h.insertEvent(api.database, { orgId: h.LEGACY_ORG, id: eventId, slug: eventId, payload: { id: eventId, slug: eventId, name: '합성 행사', date: '2027-01-16', stage: 'LIVE', features: ['venue', 'screen'] }, workspace: require('../server/state').emptyWorkspace() });
  await h.insertMembership(api.database, `manager-${suffix}`, eventId, ['page', 'programs', 'settings']);
  await h.insertMembership(api.database, `reader-${suffix}`, eventId, []);
  manager = await h.sessionCookie(api, `manager-${suffix}`); reader = await h.sessionCookie(api, `reader-${suffix}`);
});
after(async () => { if (api) await api.close(); });

test('notice reviewed publication rejects changed public visibility and replays the original receipt', async () => {
  const live = success(await run('notice.save', { title: '기존 공지', body: '기존 본문', published: true })).notice;
  const draft = success(await run('notice.save', { id: live.id, title: '새 공지', body: '새 본문', mode: 'draft', expectedVersion: live.version })).notice;
  const original = { id: live.id, published: true, expectedVersion: draft.version, expectedDestinations: { slug: eventId, public: true, home: true, screen: 'available' } };
  await page({ showAnnouncements: false });
  const stale = await run('notice.publish-reviewed', original);
  assert.equal(stale.status, 409); assert.equal(stale.json.field, 'expectedDestinations');
  assert.equal((await read()).notices.find(item => item.id === live.id).title, '기존 공지');
  const updated = { ...original, expectedDestinations: { slug: eventId, public: false, home: false, screen: 'available' } };
  assert.equal((await run('notice.publish-reviewed', updated, undefined, reader)).status, 403);
  const id = crypto.randomUUID(), committed = success(await run('notice.publish-reviewed', updated, id));
  assert.deepEqual(committed.reviewedDestinations, updated.expectedDestinations);
  await page({ showAnnouncements: true });
  assert.deepEqual(success(await run('notice.publish-reviewed', updated, id)).reviewedDestinations, updated.expectedDestinations);
  const freshStale = await run('notice.publish-reviewed', { ...updated, expectedVersion: committed.notice.version });
  assert.equal(freshStale.status, 409); assert.equal(freshStale.json.field, 'expectedDestinations');
});

test('notice reviewed publication detects screen selection and changed home menu independently', async () => {
  const live = success(await run('notice.save', { title: '무대 공지', body: '기존', published: true })).notice;
  const draft = success(await run('notice.save', { id: live.id, title: '무대 공지 수정', body: '변경', mode: 'draft', expectedVersion: live.version })).notice;
  const payload = { id: live.id, published: true, expectedVersion: draft.version, expectedDestinations: { slug: eventId, public: true, home: true, screen: 'available' } };
  success(await run('display.set', { type: 'notice', noticeId: live.id }));
  assert.equal((await run('notice.publish-reviewed', payload)).status, 409);
  await page({ homeMenus: { order: [], hidden: ['notice'], programs: [] } });
  assert.equal((await run('notice.publish-reviewed', { ...payload, expectedDestinations: { slug: eventId, public: true, home: true, screen: 'selected' } })).status, 409);
  const current = { slug: eventId, public: true, home: false, screen: 'selected' };
  assert.deepEqual(success(await run('notice.publish-reviewed', { ...payload, expectedDestinations: current })).reviewedDestinations, current);
});

test('program and venue guard their own destinations without blocking unrelated page changes', async () => {
  const program = success(await run('program.save', { title: '합성 일정', date: '2027-01-16', start: '10:00', end: '11:00', mode: 'draft' })).program;
  const venue = success(await run('venue.save', { name: '합성 장소', mode: 'draft', expectedVersion: 0 })).venue;
  await page({ showPrograms: false, showVenue: false });
  // A later unrelated notice setting changes the page version, but not
  // either destination being reviewed here.
  await page({ showAnnouncements: false, showPrograms: false, showVenue: false });
  for (const [command, payload] of [
    ['program.publish-reviewed', { id: program.id, published: true, expectedVersion: program.version, expectedDestinations: { slug: eventId, public: true } }],
    ['venue.publish-reviewed', { expectedVersion: venue.version, expectedDestinations: { slug: eventId, public: true } }],
  ]) {
    const stale = await run(command, payload); assert.equal(stale.status, 409); assert.equal(stale.json.field, 'expectedDestinations');
    assert.deepEqual(success(await run(command, { ...payload, expectedDestinations: { slug: eventId, public: false } })).reviewedDestinations, { slug: eventId, public: false });
  }
});

test('reviewed commands reject malformed context and legacy publication remains available', async () => {
  const notice = success(await run('notice.save', { title: '호환 공지', body: '본문', mode: 'draft' })).notice;
  for (const expectedDestinations of [undefined, null, {}, { slug: eventId, public: true, home: true, screen: 'selected', extra: true }, { slug: eventId, public: 'true', home: true, screen: 'off' }]) {
    assert.equal((await run('notice.publish-reviewed', { id: notice.id, published: true, expectedVersion: notice.version, expectedDestinations })).status, 400);
  }
  assert.equal(success(await run('notice.publish', { id: notice.id, published: true, expectedVersion: notice.version })).notice.published, true);
});

test('changing the event address invalidates the reviewed destination links', async () => {
  await page({ homeMenus: { order: [], hidden: [], programs: [] } });
  const notice = success(await run('notice.save', { title: '주소 변경 공지', body: '본문', mode: 'draft' })).notice;
  const expectedDestinations = { slug: eventId, public: true, home: true, screen: 'available' };
  const newSlug = `moved-${suffix}`;
  success(await run('event.update', { name: '합성 행사', slug: newSlug, date: '2027-01-16', start: '09:00', end: '18:00', capacity: 200 }));
  const input = { id: notice.id, published: true, expectedVersion: notice.version, expectedDestinations };
  const rejected = await run('notice.publish-reviewed', input);
  assert.equal(rejected.status, 409); assert.equal(rejected.json.field, 'expectedDestinations');
  assert.equal((await read()).notices.find(item => item.id === notice.id).published, false);
  assert.equal(success(await run('notice.publish-reviewed', { ...input, expectedDestinations: { ...expectedDestinations, slug: newSlug } })).notice.published, true);
});

test('simultaneous page and notice publication serializes the reviewed visibility', async () => {
  for (let index = 0; index < 8; index++) {
    await page({ homeMenus: { order: [], hidden: [], programs: [] } });
    const notice = success(await run('notice.save', { title: `동시 검토 ${index}`, body: '합성 본문', mode: 'draft' })).notice;
    const draft = success(await run('attendee.page.save', { intro: '합성 행사 안내', accent: '#E76D26', showAnnouncements: false, showSchedule: true, showPrograms: true, showVenue: true }));
    const expectedDestinations = { slug: `moved-${suffix}`, public: true, home: true, screen: 'available' };
    const publishPage = () => run('attendee.page.publish', { expectedDraftVersion: draft.draftVersion });
    const publishNotice = () => run('notice.publish-reviewed', { id: notice.id, published: true, expectedVersion: notice.version, expectedDestinations });
    const [first, second] = await Promise.all(index % 2 ? [publishNotice(), publishPage()] : [publishPage(), publishNotice()]);
    const [pageResult, noticeResult] = index % 2 ? [second, first] : [first, second];
    assert.equal(pageResult.status, 200);
    assert.ok([200, 409].includes(noticeResult.status));
    const saved = (await read()).notices.find(item => item.id === notice.id);
    if (noticeResult.status === 200) {
      assert.deepEqual(noticeResult.json.reviewedDestinations, expectedDestinations);
      assert.equal(saved.published, true);
    } else {
      assert.equal(noticeResult.json.field, 'expectedDestinations');
      assert.equal(saved.published, false);
    }
  }
});
