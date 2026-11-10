'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { emptyWorkspace } = require('../server/state');
let h, cookie;
const id = 'home-menu-fixture';
const idempotency = () => `menu-${randomUUID()}`;
const pageFields = { intro: '합성 행사 소개', showAnnouncements: true, showSchedule: true, showVenue: true, showPrograms: true, accent: '#E76D26' };
const command = (name, payload) => requestJson(h.baseUrl, `/api/events/${id}/commands`, { method: 'POST', cookie, body: { commandId: idempotency(), command: name, payload } });
before(async () => {
  h = await startApiHarness();
  await insertAccount(h.database, { id: 'menu-owner', role: 'AGENCY', name: '검증', email: 'menu@fixture.invalid', orgId: LEGACY_ORG });
  const workspace = emptyWorkspace();
  workspace.modules = [
    { id: 'public-module', type: 'qa', title: '공개 질문', status: 'OPEN', published: true },
    { id: 'private-module', type: 'qa', title: '비공개 질문', status: 'DRAFT', published: false },
    { id: 'disabled-module', type: 'survey', title: '꺼진 기능', status: 'OPEN', published: true },
  ];
  workspace.pageExperience = { draft: { ...pageFields, homeStyle: { backgroundColor: '#B9DEF0' } }, published: { ...pageFields }, draftVersion: 2, publishedVersion: 1 };
  await insertEvent(h.database, { id, slug: id, orgId: LEGACY_ORG, payload: { id, slug: id, name: '검증 행사', date: '2027-01-16', stage: 'LIVE', features: ['qa'] }, workspace });
  cookie = await sessionCookie(h, 'menu-owner');
});
after(async () => { if (h) await h.close(); });

test('menu settings are draft-only until publication and expose published enabled program IDs only', async () => {
  const menu = { order: ['lucky', 'notice', 'stamp', 'vote', 'roulette'], hidden: ['vote'], programs: ['public-module', 'private-module', 'disabled-module'] };
  const saved = await command('attendee.page.save', { ...pageFields, homeMenus: menu, expectedDraftVersion: 2 });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.draft.homeMenus, menu);
  let publicRead = await requestJson(h.baseUrl, `/api/public/events/${id}`);
  assert.deepEqual(publicRead.json.workspace.pageExperience.published.homeMenus.hidden, [], 'draft changes do not change the published home');
  assert.equal((await command('attendee.page.publish', { expectedDraftVersion: 2 })).status, 409);
  assert.equal((await command('attendee.page.publish', { expectedDraftVersion: 3 })).status, 200);
  publicRead = await requestJson(h.baseUrl, `/api/public/events/${id}`);
  assert.deepEqual(publicRead.json.workspace.pageExperience.published.homeMenus.programs, ['public-module']);
  assert.deepEqual(publicRead.json.workspace.pageExperience.published.homeMenus.hidden, ['vote']);
  assert.equal(JSON.stringify(publicRead.json).includes('private-module'), false, 'unpublished program ids never project');
  const legacy = await command('attendee.page.save', { ...pageFields, expectedDraftVersion: 3 });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.json.draft.homeMenus, menu, 'older clients that omit the field preserve it');
  assert.equal(legacy.json.draft.homeStyle.backgroundColor, '#B9DEF0', 'existing style is preserved');
});

test('invalid or duplicate menu IDs cannot hide ticket or application entries', async () => {
  for (const bad of [
    { order: ['notice', 'notice'], hidden: [], programs: [] },
    { order: ['notice'], hidden: ['qr'], programs: [] },
    { order: ['notice'], hidden: [], programs: ['https://outside.invalid'] },
  ]) assert.equal((await command('attendee.page.save', { ...pageFields, homeMenus: bad, expectedDraftVersion: 4 })).status, 400);
});
