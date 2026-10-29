'use strict';
const {test:nodeTest,before,after} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {databaseUrl,startApiHarness,insertAccount,insertEvent,sessionCookie,requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const {floorplanPng} = require('./helpers/floorplan-image.cjs');
const test = databaseUrl ? nodeTest : (name,fn) => nodeTest(name,{skip:'isolated PostgreSQL required'},fn);
let h,cookie,staff,manager,dir,file,secondFile,foreignFile;
const points = [{boothId:'a',x:0,y:1},{boothId:'b',x:0.5,y:0.25}];
before(async () => {
  if (!databaseUrl) return;
  dir = fs.mkdtempSync('/tmp/opencode/eventouch-map-'); h = await startApiHarness({storageDir:dir});
  for (const [id,role] of [['agency','AGENCY'],['staff','STAFF'],['manager','MANAGER']])
    await insertAccount(h.database,{orgId: LEGACY_ORG, id,role,name:id,email:`${id}@example.test`});
  cookie = await sessionCookie(h,'agency'); staff = await sessionCookie(h,'staff'); manager = await sessionCookie(h,'manager');
  for (const id of ['map-event','foreign-event']) await insertEvent(h.database,{orgId: LEGACY_ORG, id,slug:id,
    payload:{id,slug:id,stage:'LIVE',features:['stamp']},
    workspace:{booths:[{id:'a',name:'Same'},{id:'b',name:'Same'}],visits:[{id:'visit-old',boothId:'a',participantId:'me',at:'2026-10-07'}]}});
  async function upload(eventId,name) {
    const r = await fetch(`${h.baseUrl}/api/events/${eventId}/files?name=${name}&commandId=${crypto.randomUUID()}`,
      {method:'POST',headers:{cookie,'content-type':'image/png'},body:floorplanPng()});
    assert.equal(r.status,201); return (await r.json()).file;
  }
  file = await upload('map-event','map.png'); secondFile = await upload('map-event','new.png'); foreignFile = await upload('foreign-event','foreign.png');
});
after(async () => {if(h) await h.close(); if(dir) fs.rmSync(dir,{recursive:true,force:true});});
function command(name,payload,actor=cookie,id=crypto.randomUUID()) {
  return requestJson(h.baseUrl,'/api/events/map-event/commands',{method:'POST',cookie:actor,body:{command:`booth.map.${name}`,commandId:id,payload}});
}
const publicRead = () => requestJson(h.baseUrl,'/api/public/events/map-event');
async function mapState() {return (await h.database.query("SELECT payload FROM event_workspaces WHERE event_id='map-event'")).rows[0].payload.boothMap;}
test('draft is private; publication is an immutable versioned snapshot', async () => {
  const save = await command('save',{fileId:file.fileId,points,expectedDraftVersion:0});
  assert.equal(save.status,200); assert.equal(save.json.boothMap.draft.version,1);
  assert.equal(save.json.boothMap.draft.image.width,320);
  assert.equal((await publicRead()).json.workspace.boothMap.published,null);
  assert.equal((await requestJson(h.baseUrl,`/api/public/events/map-event/files/${file.fileId}`)).status,404);
  assert.equal((await command('publish',{expectedDraftVersion:1})).status,200);
  assert.equal((await requestJson(h.baseUrl,`/api/public/events/map-event/files/${file.fileId}`)).status,200);
  const edit = await command('save',{fileId:file.fileId,points:[{boothId:'a',x:1,y:0}],expectedDraftVersion:1});
  assert.equal(edit.status,200);
  const read = (await publicRead()).json.workspace.boothMap;
  assert.equal(Object.hasOwn(read,'draft'),false); assert.equal(read.published.version,1);
  assert.deepEqual(read.published.points,points);
  assert.equal((await command('publish',{expectedDraftVersion:1})).status,409);
});
test('replacement rejects old coordinates, clears pins and retains previous publication', async () => {
  assert.equal((await command('save',{fileId:secondFile.fileId,points,expectedDraftVersion:2})).status,409);
  const save = await command('save',{fileId:secondFile.fileId,points:[],expectedDraftVersion:2});
  assert.equal(save.status,200); assert.deepEqual(save.json.boothMap.draft.points,[]);
  assert.equal(save.json.boothMap.published.image.fileId,file.fileId);
  assert.equal((await requestJson(h.baseUrl,`/api/public/events/map-event/files/${secondFile.fileId}`)).status,404);
});
test('invalid points, versions and foreign files leave workspace and receipts unchanged', async () => {
  const before = await mapState();
  for (const invalidPoints of [[{boothId:'a',x:-0.1,y:0}], [{boothId:'a',x:0,y:1.1}],
    [{boothId:'a',x:'0.5',y:0}], [{boothId:'not-here',x:0,y:0}], [points[0],points[0]], 'not-an-array']) {
    const id = crypto.randomUUID();
    assert.equal((await command('save',{fileId:secondFile.fileId,points:invalidPoints,expectedDraftVersion:3},cookie,id)).status,400);
    assert.equal((await h.database.query('SELECT 1 FROM command_receipts WHERE command_id=$1',[id])).rowCount,0);
  }
  assert.equal((await command('save',{fileId:foreignFile.fileId,points:[],expectedDraftVersion:3})).status,404);
  assert.equal((await command('save',{fileId:secondFile.fileId,points:[],expectedDraftVersion:'3'})).status,400);
  assert.deepEqual(await mapState(),before);
});
test('guest, staff, foreign manager, archived and feature-disabled map changes are denied', async () => {
  for (const [actor,want] of [['',401],[staff,403],[manager,403]])
    assert.equal((await command('publish',{expectedDraftVersion:3},actor)).status,want);
  await h.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}','\"ARCHIVED\"') WHERE id='map-event'");
  assert.equal((await command('publish',{expectedDraftVersion:3})).status,409);
  await h.database.query("UPDATE events SET payload=jsonb_set(jsonb_set(payload,'{stage}','\"LIVE\"'),'{features}','[]') WHERE id='map-event'");
  assert.equal((await command('publish',{expectedDraftVersion:3})).status,409);
  assert.equal(Object.hasOwn((await publicRead()).json.workspace,'boothMap'),false);
  assert.equal((await requestJson(h.baseUrl,`/api/public/events/map-event/files/${file.fileId}`)).status,404);
  await h.database.query("UPDATE events SET payload=jsonb_set(payload,'{features}','[\"stamp\"]') WHERE id='map-event'");
});
test('retry returns the same draft without advancing version; concurrent stale writes conflict', async () => {
  const id = crypto.randomUUID(); const input = {fileId:secondFile.fileId,points,expectedDraftVersion:3};
  const a = await command('save',input,cookie,id), b = await command('save',input,cookie,id);
  assert.equal(a.status,200); assert.deepEqual(a.json,b.json); assert.equal((await mapState()).draft.version,4);
  const results = await Promise.all([command('save',{...input,expectedDraftVersion:4}),command('save',{...input,expectedDraftVersion:4})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
});
test('orphan pins are hidden, invalid draft cannot publish, unpublish preserves visit history', async () => {
  await h.database.query("UPDATE event_workspaces SET payload=jsonb_set(payload,'{booths}','[{\"id\":\"a\",\"name\":\"Same\"}]') WHERE event_id='map-event'");
  assert.deepEqual((await publicRead()).json.workspace.boothMap.published.points,[points[0]]);
  assert.equal((await command('publish',{expectedDraftVersion:5})).status,400);
  assert.equal((await command('unpublish',{expectedPublishedVersion:2})).status,409);
  assert.equal((await command('unpublish',{expectedPublishedVersion:1})).status,200);
  assert.equal((await command('unpublish',{expectedPublishedVersion:1})).status,200);
  assert.equal((await publicRead()).json.workspace.boothMap.published,null);
  assert.equal((await requestJson(h.baseUrl,`/api/public/events/map-event/files/${file.fileId}`)).status,404);
  const ws = (await h.database.query("SELECT payload FROM event_workspaces WHERE event_id='map-event'")).rows[0].payload;
  assert.deepEqual(ws.visits,[{id:'visit-old',boothId:'a',participantId:'me',at:'2026-10-07'}]);
});
