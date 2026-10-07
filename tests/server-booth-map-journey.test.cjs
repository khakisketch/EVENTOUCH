'use strict';
const {test:nodeTest,before,after} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {databaseUrl,startApiHarness,insertAccount,insertEvent,insertAssignment,sessionCookie,requestJson} = require('./helpers/postgres-api-server.cjs');
const {floorplanPng} = require('./helpers/floorplan-image.cjs');
const test = databaseUrl ? nodeTest : (name,fn) => nodeTest(name,{skip:'isolated PostgreSQL required'},fn);
let h,dir,cookie,staff;
before(async()=>{
 if(!databaseUrl)return;
 dir=fs.mkdtempSync('/tmp/opencode/eventouch-map-journey-');h=await startApiHarness({storageDir:dir});
 for(const [id,role] of [['agency','AGENCY'],['staff','STAFF']])await insertAccount(h.database,{id,role,name:id,email:`${id}@example.test`});
 cookie=await sessionCookie(h,'agency');staff=await sessionCookie(h,'staff');
 for(const [id,mode] of [['self-event','SELF'],['staff-event','STAFF']]){
  await insertEvent(h.database,{id,slug:id,payload:{id,slug:id,name:id,stage:'LIVE',features:['stamp'],capacity:20},workspace:{
   registrationOpen:true,publishedVersion:1,consentVersion:1,approvalRequired:false,price:0,stampMode:mode,
   publishedFields:[{id:'name',label:'이름',type:'text',required:true},{id:'phone',label:'연락처',type:'text',required:true}],
   booths:[{id:'booth-a',name:'같은 부스',status:'OPEN',used:0,capacity:0,limit:2},
     {id:'booth-b',name:'같은 부스',status:'CLOSED',used:0,capacity:0,limit:1}],
   desks:[{id:'desk',name:'입장',action:'IN',open:true}]}});
  await insertAssignment(h.database,{id:`desk-${id}`,accountId:'staff',eventId:id,type:'DESK',targetId:'desk'});
  await insertAssignment(h.database,{id:`booth-${id}`,accountId:'staff',eventId:id,type:'BOOTH',targetId:'booth-a'});
 }
});
after(async()=>{if(h)await h.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});});
function command(eventId,name,payload,{actor=cookie,bearer,id=crypto.randomUUID(),assignmentId}={}){
 return requestJson(h.baseUrl,`/api/events/${eventId}/commands`,{method:'POST',cookie:actor,bearer,body:{command:name,payload,commandId:id,assignmentId}});
}
async function signup(id,phone){
 const res=await requestJson(h.baseUrl,`/api/events/${id}/signup`,{method:'POST',body:{name:'가상 참가자',phone,consent:true,formVersion:1,consentVersion:1,commandId:crypto.randomUUID()}});
 assert.equal(res.status,201,JSON.stringify(res.json));return res.json.participant;
}
test('upload publication, anonymous signup, assigned check-in and confirmed SELF stamps survive HTTP restart',async()=>{
 const bytes=floorplanPng();
 const up=await fetch(`${h.baseUrl}/api/events/self-event/files?name=map.png&commandId=${crypto.randomUUID()}`,{method:'POST',headers:{cookie,'content-type':'image/png'},body:bytes});
 assert.equal(up.status,201);const file=(await up.json()).file;
 assert.equal((await command('self-event','booth.map.save',{fileId:file.fileId,points:[{boothId:'booth-a',x:0.25,y:0.75}],expectedDraftVersion:0})).status,200);
 assert.equal((await command('self-event','booth.map.publish',{expectedDraftVersion:1})).status,200);
 const guest=await requestJson(h.baseUrl,'/api/public/events/self-event');
 assert.equal(guest.json.workspace.boothMap.published.version,1);
 assert.deepEqual(guest.json.workspace.participants,[]);assert.deepEqual(guest.json.workspace.visits,[]);
 const person=await signup('self-event','01011112222');
 const code='ET:BOOTH:self-event:booth-a';
 const denied=await command('self-event','booth.visit',{code},{actor:'',bearer:person.ticket});
 assert.equal(denied.status,409);
 const checked=await command('self-event','check.scan',{deskId:'desk',ticket:person.ticket},{actor:staff,assignmentId:'desk-self-event'});
 assert.equal(checked.status,200,JSON.stringify(checked.json));
 const id=crypto.randomUUID();
 assert.equal((await command('self-event','booth.visit',{code},{actor:'',bearer:person.ticket,id})).status,201);
 assert.equal((await command('self-event','booth.visit',{code},{actor:'',bearer:person.ticket,id})).status,200);
 assert.equal((await command('self-event','booth.visit',{code:'ET:BOOTH:self-event:booth-b'},{actor:'',bearer:person.ticket})).status,409);
 const own=await requestJson(h.baseUrl,'/api/public/events/self-event/ticket',{bearer:person.ticket});
 assert.equal(own.json.workspace.visits.length,1);assert.equal(own.json.workspace.visits[0].boothId,'booth-a');
 assert.equal(typeof h.restartHttp,'function','fixture must restart HTTP without replacing database/schema/files');
 await h.restartHttp();
 const after=await requestJson(h.baseUrl,'/api/public/events/self-event/ticket',{bearer:person.ticket});
 assert.equal(after.status,200);assert.equal(after.json.workspace.visits.length,1);
 assert.equal(after.json.workspace.boothMap.published.version,1);assert.equal(after.json.participant.inside,true);
 const image=await fetch(`${h.baseUrl}/api/public/events/self-event/files/${file.fileId}`);
 assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);
 assert.equal((await requestJson(h.baseUrl,'/api/bootstrap',{cookie})).status,200);
 assert.deepEqual((await requestJson(h.baseUrl,'/api/public/events/self-event')).json.workspace.visits,[]);
});
test('STAFF certification updates only the owner ticket and wrong assignments cannot certify',async()=>{
 const person=await signup('staff-event','01033334444');
 assert.equal((await command('staff-event','check.scan',{deskId:'desk',ticket:person.ticket},{actor:staff,assignmentId:'desk-staff-event'})).status,200);
 assert.equal((await command('staff-event','booth.visit',{code:'ET:BOOTH:staff-event:booth-a'},{actor:'',bearer:person.ticket})).status,409);
 assert.equal((await command('staff-event','booth.visit',{boothId:'booth-a',ticket:person.ticket},{actor:staff,assignmentId:'desk-staff-event'})).status,403);
 const before=await requestJson(h.baseUrl,'/api/public/events/staff-event/ticket',{bearer:person.ticket});assert.deepEqual(before.json.workspace.visits,[]);
 const id=crypto.randomUUID();const payload={boothId:'booth-a',ticket:person.ticket};
 assert.equal((await command('staff-event','booth.visit',payload,{actor:staff,assignmentId:'booth-staff-event',id})).status,201);
 assert.equal((await command('staff-event','booth.visit',payload,{actor:staff,assignmentId:'booth-staff-event',id})).status,200);
 const after=await requestJson(h.baseUrl,'/api/public/events/staff-event/ticket',{bearer:person.ticket});assert.equal(after.json.workspace.visits.length,1);
 assert.equal(after.json.workspace.visits[0].participantId,person.id);
 assert.deepEqual((await requestJson(h.baseUrl,'/api/public/events/staff-event')).json.workspace.visits,[]);
});
