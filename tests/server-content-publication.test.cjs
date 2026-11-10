'use strict';

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { floorplanPng } = require('./helpers/floorplan-image.cjs');
const h = require('./helpers/postgres-api-server.cjs');
const test = h.databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);
const suffix = crypto.randomUUID();
const eventId = `content-event-${suffix}`, actorId = `content-manager-${suffix}`, readerId = `content-reader-${suffix}`;
let api, cookie, readerCookie;
const run = (command, payload, id = crypto.randomUUID(), auth = cookie, event = eventId) =>
  h.requestJson(api.baseUrl, `/api/events/${event}/commands`, { cookie: auth, method: 'POST', body: { commandId: id, command, payload } });
const read = async () => (await api.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
const publicRead = async () => (await h.requestJson(api.baseUrl, `/api/public/events/${eventId}`)).json;
const venueText = { name: '합성 행사장', address: '합성로 12', directions: '동문 입장', contact: '02-0000-0000', description: '합성 안내' };
const programText = { title: '기존 일정', date: '2027-01-16', start: '10:00', end: '11:00', place: 'A홀', description: '기존 설명' };
const success = result => { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.json)); return result.json; };

before(async () => {
  if (!h.databaseUrl) return;
  api = await h.startApiHarness();
  for (const id of [actorId, readerId]) await h.insertAccount(api.database, { orgId: h.LEGACY_ORG, id, role: 'MANAGER', name: '합성 운영자', email: `${id}@example.test` });
  await h.insertEvent(api.database, { orgId: h.LEGACY_ORG, id: eventId, slug: eventId,
    payload: { id: eventId, slug: eventId, name: '합성 게시 검토 행사', date: '2027-01-16', stage: 'LIVE', features: ['venue', 'screen'] },
    workspace: { notices: [], program: [], venue: venueText } });
  await h.insertMembership(api.database, actorId, eventId, ['page', 'programs']);
  await h.insertMembership(api.database, readerId, eventId, []);
  cookie = await h.sessionCookie(api, actorId); readerCookie = await h.sessionCookie(api, readerId);
});
after(async () => { if (api) await api.close(); });

test('draft saves preserve published notices and display output until explicit reviewed publication', async () => {
  const live = success(await run('notice.save', { title: '기존 공지', body: '기존 내용', published: true, pinned: false })).notice;
  const draft = success(await run('notice.save', { id: live.id, title: '검토할 공지', body: '비공개 초안 내용', pinned: true, mode: 'draft', expectedVersion: live.version })).notice;
  assert.equal(draft.title, live.title); assert.equal(draft.draft.title, '검토할 공지'); assert.equal(draft.published, true);
  const before = await publicRead();
  assert.equal(before.workspace.notices.find(n => n.id === live.id).body, '기존 내용');
  assert.ok(!JSON.stringify(before).includes('비공개 초안 내용'));
  const published = success(await run('notice.publish', { id: live.id, published: true, expectedVersion: draft.version })).notice;
  assert.equal(published.title, '검토할 공지'); assert.equal(published.version, draft.version + 1);
  assert.equal((await publicRead()).workspace.notices.find(n => n.id === live.id).body, '비공개 초안 내용');
  success(await run('notice.publish', { id: live.id, published: false, expectedVersion: published.version }));
  assert.ok(!(await publicRead()).workspace.notices.some(n => n.id === live.id));
  assert.equal((await read()).notices.find(n => n.id === live.id).draft.body, '비공개 초안 내용');
});

test('new drafts are private, legacy records without metadata start at revision zero, old immediate writers still work', async () => {
  const draft = success(await run('notice.save', { title: '초안 전용 제목', body: '새 비공개 내용', mode: 'draft', expectedVersion: 0 })).notice;
  assert.equal(draft.published, false); assert.ok(!(await publicRead()).workspace.notices.some(n => n.id === draft.id));
  const old = { id: 'old-without-version', title: '이전 저장 형식', body: '이전 본문', published: true, pinned: false, at: '2026-01-01' };
  await api.database.query("UPDATE event_workspaces SET payload=jsonb_set(payload,'{notices}',(payload->'notices') || $2::jsonb) WHERE event_id=$1", [eventId, JSON.stringify([old])]);
  const saved = success(await run('notice.save', { ...old, title: '신규 초안', mode: 'draft', expectedVersion: 0 })).notice;
  assert.equal(saved.version, 1); assert.equal(saved.title, old.title);
  const legacy = success(await run('notice.save', { ...old, title: '기존 클라이언트 즉시 저장' })).notice;
  assert.equal(legacy.title, legacy.draft.title); assert.equal(legacy.published, true);
  assert.equal((await publicRead()).workspace.notices.find(n => n.id === old.id).title, legacy.title);
});

test('reviewed revisions prevent stale edits and stale publish; permissions and event ownership remain authoritative', async () => {
  const initial = success(await run('program.save', { ...programText, published: true })).program;
  const payload = { ...programText, id: initial.id, title: '첫 번째 운영자 수정', mode: 'draft', expectedVersion: initial.version };
  const winner = success(await run('program.save', payload)).program;
  assert.equal((await run('program.save', { ...payload, title: '뒤늦은 덮어쓰기' })).status, 409);
  assert.equal((await run('program.publish', { id: initial.id, published: true, expectedVersion: initial.version })).status, 409);
  assert.equal((await run('program.publish', { id: initial.id, published: true, expectedVersion: winner.version }, undefined, readerCookie)).status, 403);
  assert.equal((await run('program.publish', { id: 'foreign-item', published: true, expectedVersion: 0 })).status, 404);
  for (const patch of [{ expectedVersion: -1 }, { expectedVersion: '1' }, { expectedVersion: undefined }, { published: 'true' }]) {
    assert.equal((await run('program.publish', { id: initial.id, published: true, expectedVersion: winner.version, ...patch })).status, 400);
  }
  const published = success(await run('program.publish', { id: initial.id, published: true, expectedVersion: winner.version })).program;
  assert.equal(published.title, '첫 번째 운영자 수정');
});

test('venue drafts preserve live text, map omission semantics and optional map guards until publication', async () => {
  const saved = success(await run('venue.save', { ...venueText, name: '검토 중 장소', mode: 'draft', expectedVersion: 0 })).venue;
  assert.equal(saved.name, venueText.name); assert.equal(saved.draft.name, '검토 중 장소');
  assert.equal((await publicRead()).workspace.venue.name, venueText.name);
  const published = success(await run('venue.publish', { expectedVersion: saved.version })).venue;
  assert.equal(published.name, '검토 중 장소'); assert.equal((await publicRead()).workspace.venue.name, '검토 중 장소');
  assert.equal((await run('venue.publish', { expectedVersion: saved.version })).status, 409);
  assert.equal((await run('venue.save', { ...venueText, mode: 'unsupported' })).status, 400);
});

test('lost publish receipts replay after grant removal without publishing a newer draft', async () => {
  const draft = success(await run('notice.save', { title: '재시도 검사', body: '첫 내용', mode: 'draft' })).notice;
  const id = crypto.randomUUID(), payload = { id: draft.id, expectedVersion: draft.version, published: true };
  const committed = await run('notice.publish', payload, id); success(committed);
  await api.database.query('UPDATE memberships SET write_permissions=$1::jsonb WHERE event_id=$2 AND account_id=$3', [JSON.stringify([]), eventId, actorId]);
  const replay = await run('notice.publish', payload, id); assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.notice.version, committed.json.notice.version);
  assert.equal((await run('notice.publish', { ...payload, expectedVersion: committed.json.notice.version })).status, 403);
  assert.equal((await run('notice.publish', payload, id, readerCookie)).status, 409);
  await api.database.query('UPDATE memberships SET write_permissions=$1::jsonb WHERE event_id=$2 AND account_id=$3', [JSON.stringify(['page', 'programs']), eventId, actorId]);
});

test('draft PDF and venue map stay private while the live files remain available; publishing swaps the public allowlist', async () => {
  const upload = async (name, contentType, bytes, event = eventId) => {
    const response = await fetch(`${api.baseUrl}/api/events/${event}/files?name=${name}&commandId=${crypto.randomUUID()}`, {
      method: 'POST', headers: { cookie, 'content-type': contentType }, body: bytes,
    });
    assert.equal(response.status, 201); return (await response.json()).file;
  };
  const publicFileStatus = async file => (await fetch(`${api.baseUrl}/api/public/events/${eventId}/files/${file.fileId}`)).status;
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const livePdf = await upload('live.pdf', 'application/pdf', pdf);
  const draftPdf = await upload('draft.pdf', 'application/pdf', pdf);
  const original = success(await run('program.save', { ...programText, published: true, attachment: livePdf })).program;
  const changed = success(await run('program.save', { ...programText, id: original.id, mode: 'draft', expectedVersion: original.version, attachment: draftPdf })).program;
  assert.equal(await publicFileStatus(livePdf), 200); assert.equal(await publicFileStatus(draftPdf), 404);
  const published = success(await run('program.publish', { id: original.id, expectedVersion: changed.version, published: true })).program;
  assert.equal(await publicFileStatus(draftPdf), 200); assert.equal(await publicFileStatus(livePdf), 404);
  const removed = success(await run('program.save', { ...programText, id: original.id, mode: 'draft', expectedVersion: published.version, attachment: null })).program;
  assert.equal(await publicFileStatus(draftPdf), 200);
  success(await run('program.publish', { id: original.id, expectedVersion: removed.version, published: true }));
  assert.equal(await publicFileStatus(draftPdf), 404);
  const liveMap = await upload('live.png', 'image/png', floorplanPng());
  const draftMap = await upload('draft.png', 'image/png', floorplanPng());
  const venue = success(await run('venue.save', { ...venueText, map: { image: liveMap, alt: '현재 안내도' } })).venue;
  const venueDraft = success(await run('venue.save', { ...venueText, mode: 'draft', expectedVersion: venue.version,
    map: { image: draftMap, alt: '새 안내도' }, expectedMap: { fileId: liveMap.fileId, alt: '현재 안내도' } })).venue;
  assert.equal(await publicFileStatus(liveMap), 200); assert.equal(await publicFileStatus(draftMap), 404);
  assert.equal((await run('venue.save', { ...venueText, mode: 'draft', expectedVersion: venueDraft.version,
    map: null, expectedMap: { fileId: liveMap.fileId, alt: '현재 안내도' } })).status, 409);
  const textOnly = success(await run('venue.save', { ...venueText, mode: 'draft', expectedVersion: venueDraft.version })).venue;
  assert.equal(textOnly.draft.map.image.fileId, draftMap.fileId);
  success(await run('venue.publish', { expectedVersion: textOnly.version }));
  assert.equal(await publicFileStatus(liveMap), 404); assert.equal(await publicFileStatus(draftMap), 200);
  const publicValue = await publicRead();
  assert.ok(!JSON.stringify(publicValue).includes('"draft"'));
  assert.equal(publicValue.workspace.venue.map.image.fileId, draftMap.fileId);
});

test('an archived event rejects new draft and publish commands', async () => {
  const id = `archived-content-${suffix}`;
  await h.insertEvent(api.database, { orgId: h.LEGACY_ORG, id, slug: id, payload: { id, slug: id, name: '합성 보관 행사', stage: 'ARCHIVED', features: ['venue'] }, workspace: { notices: [], program: [], venue: venueText } });
  await h.insertMembership(api.database, actorId, id, ['all']);
  for (const [command, payload] of [['notice.save', { title: '보관 초안', body: '차단', mode: 'draft' }], ['notice.publish', { id: 'none', published: true, expectedVersion: 0 }], ['venue.publish', { expectedVersion: 0 }]]) {
    assert.equal((await run(command, payload, undefined, cookie, id)).status, 409);
  }
});

test('event duplication strips draft assets and publication revisions as well as live file references', async () => {
  const ownerId = `content-owner-${suffix}`;
  await h.insertAccount(api.database, { orgId: h.LEGACY_ORG, id: ownerId, role: 'AGENCY', name: '합성 조직 운영자', email: `${ownerId}@example.test` });
  const owner = await h.sessionCookie(api, ownerId);
  const source = await read();
  const file = (await api.database.query('SELECT id FROM stored_files WHERE event_id=$1 LIMIT 1', [eventId])).rows[0];
  assert.ok(file);
  source.program[0].draft.attachment = { fileId: file.id, name: '복제하지 않을 초안 파일.pdf' };
  source.program[0].publishedAt = '2026-01-01';
  await api.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(source)]);
  const duplicated = await h.requestJson(api.baseUrl, `/api/events/${eventId}/duplicate`, { cookie: owner, method: 'POST',
    body: { commandId: crypto.randomUUID(), name: '합성 복제 게시 검토', slug: `copy-${suffix}`, date: '2027-01-16', start: '09:00', end: '17:00', capacity: 100 } });
  assert.equal(duplicated.status, 201, JSON.stringify(duplicated.json));
  const target = (await api.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [duplicated.json.event.id])).rows[0].payload;
  for (const record of [...target.notices, ...target.program, target.venue]) {
    assert.equal(record.version, undefined); assert.equal(record.publishedAt, undefined);
  }
  assert.ok(target.notices.every(n => n.published === false));
  assert.ok(target.program.every(p => p.published === false && p.attachment == null && p.draft?.attachment == null));
  assert.equal(target.venue.map, undefined); assert.equal(target.venue.draft.map, undefined);
  assert.ok(!JSON.stringify(target).includes('"fileId"'));
  assert.equal(target.program[0].draft.title, source.program[0].draft.title);
});
