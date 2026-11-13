'use strict';
const {test:nodeTest}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createDatabase}=require('../server/db');
const {databaseUrl,startApiHarness,insertAccount,insertEvent,sessionCookie,LEGACY_ORG}=require('./helpers/postgres-api-server.cjs');
const {floorplanPng}=require('./helpers/floorplan-image.cjs');
const test=databaseUrl?nodeTest:(name,fn)=>nodeTest(name,{skip:'isolated PostgreSQL required'},fn);

test('explicit application schema migrates without falling back to public',async()=>{
  const admin=createDatabase({connectionString:databaseUrl,env:{}});
  const schema='managed_'+crypto.randomUUID().replace(/-/g,'');
  const db=createDatabase({connectionString:databaseUrl,env:{DATABASE_SCHEMA:schema,PGPOOL_MAX:'2'}});
  try {
    await assert.rejects(db.migrate());
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await db.migrate();
    assert.equal((await db.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n>0,true);
    assert.equal((await admin.query('SELECT to_regclass($1) AS table_name',[schema+'.accounts'])).rows[0].table_name,schema+'.accounts');
    const names=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname=$1",[schema])).rows.map(row=>row.tablename);
    const {countsQuery}=require('../scripts/backup-lib.cjs');
    assert.ok((await db.query(countsQuery(names))).rows.length>=16);
  } finally {await db.close();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.close();}
});

test('mounted storage serves real authorized and published bytes and fails readiness when detached',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'eventouch-mounted-api-'));
  const marker=path.join(root,'.eventouch-storage-id');fs.writeFileSync(marker,'synthetic-nas\n');
  let h;
  try {
    h=await startApiHarness({storageDir:root,env:{EVENTOUCH_STORAGE_MODE:'mounted',EVENTOUCH_STORAGE_ID:'synthetic-nas'}});
    await insertAccount(h.database,{orgId:LEGACY_ORG,id:'mounted-owner',role:'AGENCY',name:'Synthetic',email:'mounted@example.test'});
    await insertEvent(h.database,{orgId:LEGACY_ORG,id:'mounted-event',slug:'mounted-event',payload:{id:'mounted-event',slug:'mounted-event',stage:'LIVE',features:[]},workspace:{}});
    const cookie=await sessionCookie(h,'mounted-owner');const bytes=floorplanPng();
    const upload=await fetch(`${h.baseUrl}/api/events/mounted-event/files?name=test.png&commandId=${crypto.randomUUID()}`,{method:'POST',headers:{cookie,'content-type':'image/png'},body:bytes});
    assert.equal(upload.status,201);const {file}=await upload.json();
    const privateUrl=`${h.baseUrl}/api/events/mounted-event/files/${file.fileId}`;
    assert.equal((await fetch(privateUrl)).status,401);
    assert.deepEqual(Buffer.from(await (await fetch(privateUrl,{headers:{cookie}})).arrayBuffer()),bytes);
    const publicUrl=`${h.baseUrl}/api/public/events/mounted-event/files/${file.fileId}`;
    assert.equal((await fetch(publicUrl)).status,404);
    await h.database.query("UPDATE event_workspaces SET payload=$1::jsonb WHERE event_id='mounted-event'",[JSON.stringify({pageExperience:{published:{logo:file}}})]);
    assert.deepEqual(Buffer.from(await (await fetch(publicUrl)).arrayBuffer()),bytes);
    assert.equal((await fetch(h.baseUrl+'/api/readyz')).status,200);
    fs.unlinkSync(marker);
    const readiness=await fetch(h.baseUrl+'/api/readyz');assert.equal(readiness.status,503);
    assert.deepEqual(await readiness.json(),{ok:false,db:true,storage:false});
    assert.equal((await fetch(privateUrl,{headers:{cookie}})).status,503);
    assert.equal((await fetch(publicUrl)).status,503);
    fs.writeFileSync(marker,'synthetic-nas');
    assert.equal((await fetch(h.baseUrl+'/api/readyz')).status,200);
  } finally {await h?.close();fs.rmSync(root,{recursive:true,force:true});}
});
