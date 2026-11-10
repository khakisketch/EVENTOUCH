'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertAssignment, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip:'set EVENTOUCH_TEST_DATABASE_URL' }, fn);

test('reward receipts are bound to the original person, prize, verification and assignment', async () => {
  const h=await startApiHarness();
  try {
    const suffix=crypto.randomUUID(), staff=`staff-${suffix}`, manager=`manager-${suffix}`, event=`event-${suffix}`;
    const aId=`a-${suffix}`, bId=`b-${suffix}`, deskA=`desk-a-${suffix}`, deskB=`desk-b-${suffix}`;
    const person=(id)=>({id,ticket:`synthetic-${id}`,name:`합성 ${id}`,status:'APPROVED',paymentStatus:'FREE',inside:false,ticketExpiresAt:'2999-01-01T00:00:00Z'});
    const a=person(aId),b=person(bId),workspace=emptyWorkspace();
    workspace.participants=[a,b]; workspace.desks=[{id:'a',name:'출구 A',action:'OUT',open:true},{id:'b',name:'출구 B',action:'OUT',open:true}];
    workspace.rewards=[{id:'gift-a',participantId:a.id,name:'합성 경품 A',method:'ONSITE',status:'READY'}, {id:'gift-b',participantId:b.id,name:'합성 경품 B',method:'ONSITE',status:'READY'}];
    for(const [id,role] of [[staff,'STAFF'],[manager,'MANAGER']]) await insertAccount(h.database,{id,role,name:'합성 운영자',email:`${id}@example.test`,orgId:LEGACY_ORG});
    await insertEvent(h.database,{orgId:LEGACY_ORG,id:event,slug:event,payload:{id:event,slug:event,name:'합성 행사',stage:'LIVE',features:['reward']},workspace});
    for(const [id,targetId] of [[deskA,'a'],[deskB,'b']]) await insertAssignment(h.database,{id,accountId:staff,eventId:event,type:'DESK',targetId});
    await insertMembership(h.database,manager,event,['all']);
    const staffCookie=await sessionCookie(h,staff),managerCookie=await sessionCookie(h,manager);
    const send=(command,commandId,payload,assignmentId=deskA,cookie=staffCookie)=>requestJson(h.baseUrl,`/api/events/${event}/commands`,{method:'POST',cookie,body:{commandId,command,...(assignmentId ? {assignmentId} : {}),payload}});
    const get=async()=> (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[event])).rows[0].payload;
    const saved=async(id)=>(await h.database.query('SELECT result FROM command_receipts WHERE command_id=$1',[id])).rows[0].result;
    const strip=async(id)=>h.database.query("UPDATE command_receipts SET result=result-'rewardRequest' WHERE command_id=$1",[id]);
    const id=crypto.randomUUID(),payload={ticket:a.ticket};
    const first=await send('reward.lookup',id,payload);
    assert.equal(first.status,200,JSON.stringify(first.json)); assert.equal(first.json.participant.id,a.id); assert.equal(first.json.rewardRequestVersion,1);
    assert.deepEqual((await send('reward.lookup',id,payload)).json,first.json);
    for(const [changed,assignment] of [[{ticket:b.ticket},deskA],[payload,deskB],[{participantId:a.id,verificationId:id},deskA]]) {
      const mismatch=await send('reward.lookup',id,changed,assignment);
      assert.equal(mismatch.status,409,JSON.stringify(mismatch.json)); assert.equal(mismatch.json.code,'REWARD_RECEIPT_MISMATCH');
    }
    assert.equal(JSON.stringify(await saved(id)).includes(a.ticket),false);
    const collectId=crypto.randomUUID(), collect={id:'gift-a',verificationId:id,expectedParticipantId:a.id};
    const collected=await send('reward.collect',collectId,collect);
    assert.equal(collected.status,200,JSON.stringify(collected.json)); assert.equal(collected.json.reward.participantId,a.id);
    for(const [changed,assignment] of [[{...collect,id:'gift-b'},deskA],[{...collect,verificationId:crypto.randomUUID()},deskA],[collect,deskB],[{...collect,expectedParticipantId:b.id},deskA]]) {
      const mismatch=await send('reward.collect',collectId,changed,assignment);
      assert.equal(mismatch.status,409,JSON.stringify(mismatch.json)); assert.equal(mismatch.json.code,'REWARD_RECEIPT_MISMATCH');
    }
    assert.deepEqual((await send('reward.collect',collectId,collect)).json,collected.json);
    assert.equal((await get()).rewards.find(r=>r.id==='gift-b').status,'READY');
    // An old lookup cannot prove how its target was selected; an old staffed
    // collection cannot prove its original verification or assignment.
    await strip(id); assert.equal((await send('reward.lookup',id,payload)).status,409);
    assert.equal((await send('reward.lookup',id,{ticket:b.ticket})).status,409);
    await strip(collectId); assert.equal((await send('reward.collect',collectId,collect)).status,409);
    const managerId=crypto.randomUUID();
    const managerLookup=await send('reward.lookup',managerId,{ticket:b.ticket},null,managerCookie);
    assert.equal(managerLookup.status,200); await strip(managerId);
    assert.equal((await send('reward.lookup',managerId,{ticket:b.ticket},null,managerCookie)).status,409);
    assert.equal((await send('reward.lookup',managerId,{ticket:a.ticket},null,managerCookie)).status,409);
    const wrong=await send('reward.collect',crypto.randomUUID(),{id:'gift-b',verificationId:id,expectedParticipantId:a.id});
    assert.equal(wrong.status,409); assert.equal(wrong.json.code,'REWARD_VERIFICATION_CHANGED');
    const raceId=crypto.randomUUID();
    const race=await Promise.all([a,b].map((person)=>send('reward.lookup',raceId,{ticket:person.ticket})));
    assert.deepEqual(race.map(item=>item.status).sort(),[200,409]);
    const unassigned=crypto.randomUUID(), managerPayload={id:'gift-b',expectedParticipantId:b.id};
    const managerCollect=await send('reward.collect',unassigned,managerPayload,null,managerCookie);
    assert.equal(managerCollect.status,200); await strip(unassigned);
    assert.equal((await send('reward.collect',unassigned,managerPayload,null,managerCookie)).status,200);
    assert.equal((await send('reward.collect',unassigned,{...managerPayload,expectedParticipantId:a.id},null,managerCookie)).status,409);
  } finally { await h.close(); }
});
