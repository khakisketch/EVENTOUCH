'use strict';
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { floorplanPng } = require('./helpers/floorplan-image.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, {skip:'isolated PostgreSQL required'}, fn);
let h, cookie, staffCookie, managerCookie, storageDir;
const png = floorplanPng();
before(async () => {
  if (!databaseUrl) return;
  storageDir = fs.mkdtempSync('/tmp/opencode/eventouch-files-');
  h = await startApiHarness({ storageDir });
  for (const [id, role] of [['agency','AGENCY'], ['staff','STAFF'], ['manager','MANAGER']])
    await insertAccount(h.database, {orgId: LEGACY_ORG, id, role, name:id, email:`${id}@example.test`});
  for (const id of ['event-a','event-b']) await insertEvent(h.database, {orgId: LEGACY_ORG,
    id, slug:id, payload:{id, slug:id, stage:'LIVE', features:['stamp']}, workspace:{}
  });
  await insertMembership(h.database, 'manager', 'event-a');
  cookie = await sessionCookie(h, 'agency'); staffCookie = await sessionCookie(h, 'staff');
  managerCookie = await sessionCookie(h, 'manager');
});
after(async () => { if (h) await h.close(); if (storageDir) fs.rmSync(storageDir,{recursive:true,force:true}); });
async function upload({eventId='event-a', name='floorplan.png', bytes=png, type='image/png', actor=cookie, commandId=crypto.randomUUID()} = {}) {
  const res = await fetch(`${h.baseUrl}/api/events/${eventId}/files?name=${encodeURIComponent(name)}&commandId=${encodeURIComponent(commandId)}`, {
    method:'POST', headers:{'content-type':type, ...(actor ? {cookie:actor}: {})}, body:bytes
  });
  return {status:res.status, json:await res.json()};
}
test('map image upload is event-scoped PostgreSQL metadata with server dimensions', async () => {
  const up = await upload(); assert.equal(up.status,201);
  assert.deepEqual(up.json.file, {fileId:up.json.file.fileId,name:'floorplan.png',type:'image/png',size:png.length,width:320,height:200});
  const row = await h.database.query('SELECT * FROM stored_files WHERE id=$1',[up.json.file.fileId]);
  assert.equal(row.rows[0].event_id,'event-a'); assert.equal(row.rows[0].width_px,320);
  const res = await fetch(`${h.baseUrl}/api/events/event-a/files/${up.json.file.fileId}`,{headers:{cookie}});
  assert.equal(res.status,200); assert.equal(res.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()),png);
  const other = await requestJson(h.baseUrl,`/api/events/event-b/files/${up.json.file.fileId}`,{cookie});
  assert.equal(other.status,404);
});
test('unreferenced and draft-only files cannot be read publicly or across events', async () => {
  const up = await upload(); assert.equal(up.status,201);
  await h.database.query("UPDATE event_workspaces SET payload=$1::jsonb WHERE event_id='event-a'",[JSON.stringify({boothMap:{draft:{image:up.json.file}}})]);
  for (const slug of ['event-a','event-b']) {
    const read = await requestJson(h.baseUrl,`/api/public/events/${slug}/files/${up.json.file.fileId}`);
    assert.equal(read.status,404);
  }
});
test('public reads allow only actual published content and stop after unpublication', async () => {
  const up = await upload(); assert.equal(up.status,201);
  await h.database.query("UPDATE event_workspaces SET payload=$1::jsonb WHERE event_id='event-a'",[JSON.stringify({pageExperience:{published:{logo:up.json.file}}})]);
  const read = await fetch(`${h.baseUrl}/api/public/events/event-a/files/${up.json.file.fileId}`);
  assert.equal(read.status,200); assert.deepEqual(Buffer.from(await read.arrayBuffer()),png);
  await h.database.query("UPDATE event_workspaces SET payload='{}'::jsonb WHERE event_id='event-a'");
  assert.equal((await requestJson(h.baseUrl,`/api/public/events/event-a/files/${up.json.file.fileId}`)).status,404);
});
test('staff and unauthenticated file writes/reads are denied and managers are event-bound', async () => {
  assert.equal((await upload({actor:staffCookie})).status,403);
  assert.equal((await upload({actor:''})).status,401);
  assert.equal((await upload({actor:managerCookie,eventId:'event-b'})).status,403);
  const up = await upload({actor:managerCookie}); assert.equal(up.status,201);
  for (const [actor,want] of [[staffCookie,403],['',401]])
    assert.equal((await requestJson(h.baseUrl,`/api/events/event-a/files/${up.json.file.fileId}`,{cookie:actor})).status,want);
});
test('same upload command replays once and rejects changed content, event or actor', async () => {
  const commandId = crypto.randomUUID();
  const [a,b] = await Promise.all([upload({commandId}),upload({commandId})]);
  assert.deepEqual([a.status,b.status].sort(),[200,201]); assert.deepEqual(a.json,b.json);
  const count = await h.database.query('SELECT count(*)::int AS n FROM stored_files WHERE id=$1',[a.json.file.fileId]);
  assert.equal(count.rows[0].n,1);
  for (const changed of [{name:'different.png'},{eventId:'event-b'},{actor:managerCookie},{bytes:floorplanPng(10,10)}])
    assert.equal((await upload({...changed,commandId})).status,409);
});
test('malformed uploads create no metadata or leftover bytes', async () => {
  const beforeRows = (await h.database.query('SELECT count(*)::int AS n FROM stored_files')).rows[0].n;
  const beforeFiles = fs.readdirSync(storageDir).sort();
  for (const [input,want] of [
    [{name:'../../evil.png'},400], [{bytes:Buffer.from('not a png')},400],
    [{bytes:png,type:'image/jpeg'},400], [{bytes:Buffer.alloc(9*1024*1024)},413],
    [{commandId:''},400], [{eventId:'missing-event'},404]
  ]) assert.equal((await upload(input)).status,want);
  assert.equal((await h.database.query('SELECT count(*)::int AS n FROM stored_files')).rows[0].n,beforeRows);
  assert.deepEqual(fs.readdirSync(storageDir).sort(),beforeFiles);
});

// ---- attendee (ticket) uploads ----
const GUEST_TICKET = `ET:photo-event:T-${'g'.repeat(40)}`;
const guestWorkspace = () => ({ participants: [{
  id:'photo-person', name:'사진 참가자', status:'APPROVED', revoked:false, inside:true, everIn:true,
  ticket: GUEST_TICKET, ticketExpiresAt:new Date(Date.now()+30*86400000).toISOString(), paymentStatus:'FREE', createdAt:new Date().toISOString(),
}] });
async function guestUpload({slug='photo-event', ticket=GUEST_TICKET, name='photo.png', bytes=png, type='image/png', commandId=crypto.randomUUID()}={}) {
  const res = await fetch(`${h.baseUrl}/api/public/events/${slug}/files?name=${encodeURIComponent(name)}&commandId=${encodeURIComponent(commandId)}`, {
    method:'POST', headers:{'content-type':type, ...(ticket?{authorization:`Bearer ${ticket}`}:{})}, body:bytes
  });
  return {status:res.status, json:await res.json()};
}
test('attendee photo upload is ticket- and feature-scoped', async () => {
  await insertEvent(h.database, {orgId: LEGACY_ORG,  id:'photo-event', slug:'photo-event',
    payload:{ id:'photo-event', slug:'photo-event', name:'사진 행사', date:'2026-11-20', stage:'LIVE', features:['photo'] },
    workspace: guestWorkspace() });
  await insertEvent(h.database, {orgId: LEGACY_ORG,  id:'plain-event', slug:'plain-event',
    payload:{ id:'plain-event', slug:'plain-event', name:'일반 행사', date:'2026-11-20', stage:'LIVE', features:['stamp'] },
    workspace: guestWorkspace() });
  const commandId = crypto.randomUUID();
  const up = await guestUpload({commandId}); assert.equal(up.status,201);
  assert.deepEqual(up.json.file, {fileId:up.json.file.fileId,name:'photo.png',type:'image/png',size:png.length,width:320,height:200});
  const row = await h.database.query('SELECT * FROM stored_files WHERE id=$1',[up.json.file.fileId]);
  assert.equal(row.rows[0].event_id,'photo-event');
  assert.equal(row.rows[0].created_by,null);
  const receipt = await h.database.query('SELECT result FROM command_receipts WHERE command_id=$1',[commandId]);
  assert.equal(receipt.rows[0].result.participantId,'photo-person');
  assert.equal((await guestUpload({ticket:''})).status,401);
  assert.equal((await guestUpload({ticket:`ET:photo-event:T-${'x'.repeat(40)}`})).status,401);
  assert.equal((await guestUpload({slug:'plain-event'})).status,403);
  assert.equal((await guestUpload({type:'application/pdf',bytes:Buffer.from('%PDF-1.4 tiny')})).status,400);
  assert.equal((await guestUpload({bytes:Buffer.alloc(600001)})).status,413);
});
test('guest upload command replays once and rejects changed content', async () => {
  const commandId = crypto.randomUUID();
  const [a,b] = await Promise.all([guestUpload({commandId}),guestUpload({commandId})]);
  assert.deepEqual([a.status,b.status].sort(),[200,201]); assert.deepEqual(a.json,b.json);
  assert.equal((await guestUpload({commandId,bytes:floorplanPng(10,10)})).status,409);
});
test('attendee photo submission stores the uploaded reference and publishes on approval', async () => {
  const uploadResult = await guestUpload(); assert.equal(uploadResult.status,201);
  const ref = uploadResult.json.file;
  const submitted = await requestJson(h.baseUrl,'/api/events/photo-event/commands',{
    bearer:GUEST_TICKET, method:'POST',
    body:{ commandId:crypto.randomUUID(), command:'photo.submit', payload:{ image:ref, caption:'검증 사진' } },
  });
  assert.equal(submitted.status,201);
  assert.equal(submitted.json.photo.image.fileId,ref.fileId);
  assert.equal(submitted.json.photo.status,'PENDING');
  assert.equal((await requestJson(h.baseUrl,`/api/public/events/photo-event/files/${ref.fileId}`)).status,404);
  const moderated = await requestJson(h.baseUrl,'/api/events/photo-event/commands',{
    cookie, method:'POST',
    body:{ commandId:crypto.randomUUID(), command:'photo.moderate', payload:{ id:submitted.json.photo.id, status:'APPROVED' } },
  });
  assert.equal(moderated.status,200);
  const read = await fetch(`${h.baseUrl}/api/public/events/photo-event/files/${ref.fileId}`);
  assert.equal(read.status,200); assert.deepEqual(Buffer.from(await read.arrayBuffer()),png);
});
