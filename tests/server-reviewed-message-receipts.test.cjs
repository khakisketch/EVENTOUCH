'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { COMMANDS } = require('../server/commands/domain');
const { recipientReviewVersion } = require('../server/commands/content-results');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

test('reviewed message receipt binds recipient and content and fails closed on old routing', async () => {
  const h = await startApiHarness();
  try {
    const id=`msg-review-${crypto.randomUUID()}`, manager=`manager-${crypto.randomUUID()}`, reader=`reader-${crypto.randomUUID()}`;
    const w=emptyWorkspace();
    w.participants=['a','b'].map((person,index)=>({ id:person, name:`합성 ${person}`, phone:`0100000000${index}`, status:'APPROVED',
      ticket:crypto.randomBytes(32).toString('base64url'), ticketExpiresAt:'2099-01-01T00:00:00Z', revoked:false, paymentStatus:'FREE' }));
    for (const account of [manager,reader]) await insertAccount(h.database,{id:account,role:'MANAGER',name:'합성 운영자',email:`${account}@example.test`,orgId:LEGACY_ORG});
    await insertEvent(h.database,{id,slug:id,orgId:LEGACY_ORG,payload:{id,slug:id,name:'합성 행사',date:'2027-10-01',start:'09:00',end:'17:00',capacity:100,stage:'READY',features:[]},workspace:w});
    await insertMembership(h.database,manager,id,['all']); await insertMembership(h.database,reader,id,[]);
    const cookie=await sessionCookie(h,manager), readCookie=await sessionCookie(h,reader);
    const send=(command,payload,commandId=crypto.randomUUID(),auth=cookie)=>requestJson(h.baseUrl,`/api/events/${id}/commands`,{method:'POST',cookie:auth,body:{commandId,command,payload}});
    const payload={ids:['a'],expectedRecipientVersions:[recipientReviewVersion(w.participants[0])],channel:'SMS',title:'합성 안내',body:'합성 본문',simulate:true};
    const commandId=crypto.randomUUID();
    assert.ok(COMMANDS.has('message.create-reviewed'));
    COMMANDS.delete('message.create-reviewed');
    const old=await send('message.create-reviewed',payload,commandId);
    assert.equal(old.status,400); assert.equal(old.json.field,'command');
    const read=async()=> (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[id])).rows[0].payload;
    assert.equal((await read()).messages.length,0,'old router must not create a campaign');
    COMMANDS.add('message.create-reviewed');
    assert.equal((await send('message.create-reviewed',payload,crypto.randomUUID(),readCookie)).status,403);
    const missing=await send('message.create-reviewed',{...payload,expectedRecipientVersions:undefined});
    assert.equal(missing.status,400); assert.equal(missing.json.field,'expectedRecipientVersions');
    const saved=await send('message.create-reviewed',payload,commandId);
    assert.equal(saved.status,201,JSON.stringify(saved.json)); assert.equal(saved.json.messageRequestVersion,1);
    assert.deepEqual(saved.json.message.recipientIds,['a']);
    COMMANDS.delete('message.create-reviewed');
    assert.equal((await send('message.create-reviewed',payload,commandId)).status,400,'a retry can reach a stale instance without proving the earlier result');
    COMMANDS.add('message.create-reviewed');
    assert.deepEqual((await send('message.create-reviewed',payload,commandId)).json,saved.json,'the original request replays its receipt');
    for (const changed of [{...payload,body:'다른 본문'}, {...payload,title:'다른 제목'}, {...payload,ids:['b'],expectedRecipientVersions:[recipientReviewVersion(w.participants[1])]}]) {
      const response=await send('message.create-reviewed',changed,commandId);
      assert.equal(response.status,409); assert.equal(response.json.code,'MESSAGE_RECEIPT_MISMATCH');
    }
    assert.equal((await read()).messages.length,1);
    const legacy=await send('message.create',{ids:['b'],channel:'SMS',title:'기존 클라이언트',body:'이전 형식',simulate:true});
    assert.equal(legacy.status,201,'old clients without recipient versions continue to work on the new server');
    const pending=await read();
    pending.messages.unshift({id:'http-pending',status:'SENDING',genericTransport:true,genericAttemptActive:false,
      providerSubmission:{id:'submission-1',kind:'HTTP'}, deliveries:[{participantId:'a',status:'SENDING'},{participantId:'b',status:'SENDING'}]});
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[id,JSON.stringify(pending)]);
    const review={id:'http-pending',participantId:'a',outcome:'NOT_ACCEPTED',expectedSubmissionId:'submission-1'}, reviewId=crypto.randomUUID();
    const checked=await send('message.record-provider-check',review,reviewId);
    assert.equal(checked.status,200,JSON.stringify(checked.json)); assert.deepEqual(checked.json.providerCheck,review);
    const repeated=await send('message.record-provider-check',review,reviewId);
    assert.deepEqual(repeated.json,checked.json,'the same operator review replays even after state changes');
    for(const changed of [{...review,participantId:'b'},{...review,outcome:'ACCEPTED'},{...review,expectedSubmissionId:null}]) {
      const response=await send('message.record-provider-check',changed,reviewId);
      assert.equal(response.status,409); assert.equal(response.json.code,'MESSAGE_RECEIPT_MISMATCH');
    }
    const reviewState=(await read()).messages.find(message=>message.id==='http-pending');
    assert.equal(reviewState.deliveries[0].status,'FAILED'); assert.equal(reviewState.deliveries[1].status,'SENDING');
  } finally { COMMANDS.add('message.create-reviewed'); await h.close(); }
});
