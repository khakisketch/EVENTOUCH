'use strict';
// Synthetic 900-person roster, real isolated API and PostgreSQL, no sends.
const assert = require('node:assert/strict');
const { selectDrawStage, settleLayout } = require('./ui-journey-helpers.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out=prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT,'lucky-capacity'));
  process.env.TMPDIR=ensureRunTmpDir(out);
  const f=await startAuditFixture(); let browser;
  try {
    const db=f.harness.database;
    const read=async()=> (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload;
    const write=async ws=>db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[f.eventId,JSON.stringify(ws)]);
    const ws=await read(), seed=ws.participants.find(p=>p.status==='APPROVED');assert.ok(seed);
    const makePerson=i=>({...seed,id:`lucky-person-${i}`,name:`합성 참가자 ${i}`,phone:`010${String(i).padStart(8,'0')}`,ticket:`ET:${f.eventId}:T-${crypto.randomBytes(32).toString('base64url')}`});
    ws.participants=Array.from({length:900},(_,i)=>makePerson(i+1));ws.luckyConfig={min:1,max:900};ws.luckyNumbers=[];await write(ws);
    const command=async (command,payload,cookie=f.manager.cookie)=>f.helpers.requestJson(f.harness.baseUrl,`/api/events/${f.eventId}/commands`,{method:'POST',cookie,body:{commandId:crypto.randomUUID(),command,payload}});
    assert.equal((await command('event.features',{features:['draw']})).status,200);
    browser=await launchBrowser();const context=await browser.newContext({viewport:{width:1280,height:900},locale:'ko-KR'});
    await context.addCookies([{...cookieForContext(f,'manager'),url:f.baseUrl}]);const page=await context.newPage();
    const open=async()=>{await page.goto(`${f.baseUrl}/console/events/${f.eventId}/draws`);await selectDrawStage(page, '럭키번호');const d=page.locator('details').filter({hasText:'럭키번호 범위 설정'});if(!await d.evaluate(el=>el.open))await d.locator('summary').click();};
    await open();await page.getByText(/범위 1–900 · 발급 0명 · 미발급 승인 참가자 900명 · 남은 고유 번호 900개/).waitFor();
    await page.screenshot({path:path.join(out,'ready-1280.png'),fullPage:true});
    await page.getByRole('checkbox',{name:/승인 참가자 전체 900명 선택/}).check();
    const requests=[];let lose=true;
    const lossRoute=async r=>{const data=r.request().postDataJSON();if(data?.command!=='lucky.preassign-range-reviewed')return r.continue();requests.push(data.commandId);if(lose){lose=false;await r.fetch();return r.abort('failed')}return r.continue();};
    await page.route('**/commands',lossRoute);
    await page.getByRole('button',{name:'900명 번호 일괄 배정',exact:true}).click();
    await page.getByRole('button',{name:'번호 배정',exact:true}).click();
    const recovery=page.getByRole('region',{name:'추첨·투표 처리 확인 필요'});await recovery.waitFor();
    let saved=await read();assert.equal(saved.luckyNumbers.length,900);assert.equal(new Set(saved.luckyNumbers.map(x=>x.number)).size,900);
    await recovery.getByRole('button',{name:'같은 요청 다시 시도'}).click();await recovery.waitFor({state:'detached'});
    saved=await read();assert.equal(saved.luckyNumbers.length,900);assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
    await page.unroute('**/commands',lossRoute);
    await page.getByText(/발급 900명 · 미발급 승인 참가자 0명 · 남은 고유 번호 0개/).waitFor();
    await page.getByText('승인 참가자에게 번호가 모두 배정되었습니다.').waitFor();
    assert.equal(await page.getByRole('button',{name:'번호 배정 완료',exact:true}).isDisabled(),true);
    await page.screenshot({path:path.join(out,'completed-1280.png'),fullPage:true});
    await page.evaluate(axeSource);
    for(const width of [320,390,1280]) {await page.setViewportSize({width,height:900});await settleLayout(page);/* Reopened 2026-11-20: 미리보기 기기 배율이 갱신된 뒤 측정 */assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(await page.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);if(width===390)await page.screenshot({path:path.join(out,'completed-390.png'),fullPage:true});}
    saved.participants.push(makePerson(901));await write(saved);await open();
    await page.getByRole('checkbox',{name:/승인 참가자 전체 901명 선택/}).check();
    await page.getByText('전체 배정에 번호가 1개 부족합니다. 범위를 먼저 넓히세요.').waitFor();
    assert.equal(await page.getByRole('button',{name:'1명 번호 일괄 배정',exact:true}).isDisabled(),true);
    const full=await command('lucky.preassign',{participantIds:[saved.participants[900].id]});assert.equal(full.status,409);assert.equal((await read()).luckyNumbers.length,900);
    // Legacy unconfigured range is 1–10000, exactly as the server uses.
    saved=await read();saved.participants=saved.participants.slice(0,3);saved.luckyConfig=null;saved.luckyNumbers=[{participantId:saved.participants[0].id,number:9999,at:new Date().toISOString()}];await write(saved);await open();
    await page.getByText(/범위 1–10000 · 발급 1명 · 미발급 승인 참가자 2명 · 남은 고유 번호 9999개/).waitFor();
    await page.screenshot({path:path.join(out,'legacy-1280.png'),fullPage:true});
    const legacy=await command('lucky.preassign',{participantIds:[saved.participants[1].id]});assert.equal(legacy.status,200);assert.deepEqual(legacy.json.range,{min:1,max:10000});
    // Older out-of-range numbers are preserved and do not occupy an in-range slot.
    saved=await read();saved.luckyConfig={min:1,max:3};saved.luckyNumbers=[{participantId:saved.participants[0].id,number:100,at:new Date().toISOString()},{participantId:saved.participants[1].id,number:1,at:new Date().toISOString()}];await write(saved);await open();
    await page.getByText(/범위 1–3 · 발급 2명 · 미발급 승인 참가자 1명 · 남은 고유 번호 2개/).waitFor();
    await page.getByText('현재 범위 밖에 발급된 번호 1건은 유지되며 남은 번호를 차지하지 않습니다. 번호 범위를 확인하세요.').waitFor();
    await page.screenshot({path:path.join(out,'out-of-range-1280.png'),fullPage:true});
    const partial=await command('lucky.preassign',{participantIds:[saved.participants[2].id]});assert.equal(partial.status,200);assert.ok([2,3].includes(partial.json.assigned[0].number));
    saved=await read();assert.equal(saved.luckyNumbers.find(x=>x.participantId===saved.participants[0].id).number,100);
    const limitedId=`onsite-${crypto.randomUUID()}`;await f.helpers.insertAccount(db,{orgId:f.helpers.LEGACY_ORG,id:limitedId,role:'MANAGER',name:'합성 현장 담당',email:`${limitedId}@example.test`});await f.helpers.insertMembership(db,limitedId,f.eventId,['onsite']);const limited=await f.helpers.sessionCookie(f.harness,limitedId);
    assert.equal((await command('lucky.preassign',{participantIds:[saved.participants[2].id]},limited)).status,403);
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({synthetic:true,batch:900,lostResponseSameId:true,exhaustion:true,legacyRange:true,outOfRangePreserved:true,permissions:true,viewport:[320,390,1280],realDelivery:false},null,2),{mode:0o600});
    console.log('PASS: 900-person batch, same-request recovery, exhaustion, legacy range, out-of-range preservation and read-only denial');
    await context.close();
  } finally {await browser?.close();await f.close();}
}
main().catch(e=>{console.error(String(e?.stack||e).replace(/https?:\/\/[^\s]+/g,'[url redacted]'));process.exitCode=1});
