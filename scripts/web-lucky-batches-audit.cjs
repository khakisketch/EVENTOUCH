'use strict';
// Synthetic 5001-person fixture; each request uses the actual command path.
const assert=require('node:assert/strict');
const { selectDrawStage, settleLayout } = require('./ui-journey-helpers.cjs');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {source:axeSource}=require('axe-core');
const {startAuditFixture,cookieForContext}=require('./audit-fixture.cjs');
const {launchBrowser}=require('./audit-browser.cjs');
const {prepareCaptureDir,ensureRunTmpDir}=require('./capture-dir.cjs');

async function main(){
 if(!process.env.EVENTOUCH_CAPTURE_ROOT)throw new Error('Set a private capture root');
 const out=prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT,'lucky-batches'));process.env.TMPDIR=ensureRunTmpDir(out);
 const f=await startAuditFixture();let browser,page;
 try{
  const db=f.harness.database;
  const read=async()=> (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload;
  const write=async ws=>db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[f.eventId,JSON.stringify(ws)]);
  const initial=await read(), seed=initial.participants.find(p=>p.status==='APPROVED');assert.ok(seed);
  const people=Array.from({length:5001},(_,i)=>({...seed,id:`batch-person-${i}`,name:`합성 참가자 ${i+1}`,phone:`010${String(i).padStart(8,'0')}`,ticket:`ET:${f.eventId}:T-${crypto.randomBytes(32).toString('base64url')}`}));
  const conflicted={...people[0],id:'batch-excluded',name:'확인 필요한 합성 참가자',cancelled:true};
  const reset=async()=>{const ws=await read();ws.participants=[...people,conflicted];ws.luckyConfig={min:1,max:5001};ws.luckyNumbers=[];await write(ws)};
  const cmd=async(command,payload)=>f.helpers.requestJson(f.harness.baseUrl,`/api/events/${f.eventId}/commands`,{method:'POST',cookie:f.manager.cookie,body:{commandId:crypto.randomUUID(),command,payload}});
  await reset();assert.equal((await cmd('event.features',{features:['draw']})).status,200);
  const denied=await cmd('lucky.preassign-range-reviewed',{participantIds:[conflicted.id],expectedRange:{min:1,max:5001}});assert.equal(denied.status,409);assert.equal(denied.json.code,'LUCKY_TARGET_CHANGED');
  browser=await launchBrowser();const ctx=await browser.newContext({viewport:{width:1280,height:900},locale:'ko-KR'});await ctx.addCookies([{...cookieForContext(f,'manager'),url:f.baseUrl}]);page=await ctx.newPage();
  page.on('dialog',dialog=>dialog.accept());
  const open=async()=>{await page.goto(`${f.baseUrl}/console/events/${f.eventId}/draws`);await selectDrawStage(page, '럭키번호');const d=page.locator('details').filter({hasText:'럭키번호 범위 설정'});if(!await d.evaluate(el=>el.open))await d.locator('summary').click();};
  const begin=async()=>{await page.getByRole('checkbox',{name:/승인 참가자 전체 5001명 선택/}).check();await page.getByRole('button',{name:'5001명 번호 일괄 배정',exact:true}).click();await page.getByText(/최대 5,000명씩 순차 처리/).last().waitFor();await page.getByRole('button',{name:'번호 배정',exact:true}).click();};
  await open();await page.getByText(/기록 1건은 배정에서 제외/).waitFor();await page.getByText(/최대 5,000명씩 순차 처리/).waitFor();
  await page.screenshot({path:path.join(out,'ready-1280.png'),fullPage:true});
  // A second operator changes the range after the first has opened the review.
  await page.getByRole('checkbox',{name:/승인 참가자 전체 5001명 선택/}).check();
  await page.getByRole('button',{name:'5001명 번호 일괄 배정',exact:true}).click();
  await page.getByText(/5001명에게 1–5001 범위의 럭키번호/).waitFor();
  await page.screenshot({path:path.join(out,'range-confirm-1280.png'),fullPage:true});
  assert.equal((await cmd('lucky.config.save',{min:1,max:6000})).status,200);
  await page.getByRole('button',{name:'번호 배정',exact:true}).click();
  await page.getByText(/0명 처리 후 배정이 멈췄습니다. 번호 범위가 변경됐습니다/).waitFor();
  assert.equal((await read()).luckyNumbers.length,0);
  assert.equal(await page.getByLabel('최대 번호').inputValue(),'6000');
  await page.screenshot({path:path.join(out,'range-conflict-1280.png'),fullPage:true});
  await page.evaluate(axeSource);
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});await settleLayout(page);/* Reopened 2026-11-20: 미리보기 기기 배율이 갱신된 뒤 측정 */assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(await page.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);if(width===390)await page.screenshot({path:path.join(out,'range-conflict-390.png'),fullPage:true});}
  await page.locator('summary').filter({hasText:'럭키번호 범위 설정'}).focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.id),'lucky-min');
  // A separately edited range remains a draft when the saved range changes.
  await reset();await open();await page.getByLabel('최대 번호').fill('5500');
  await page.getByRole('checkbox',{name:/승인 참가자 전체 5001명 선택/}).check();
  await page.getByRole('button',{name:'5001명 번호 일괄 배정',exact:true}).click();
  await page.getByText(/5001명에게 1–5001 범위의 럭키번호/).waitFor();
  assert.equal((await cmd('lucky.config.save',{min:1,max:6000})).status,200);
  await page.getByRole('button',{name:'번호 배정',exact:true}).click();
  await page.getByText(/0명 처리 후 배정이 멈췄습니다. 번호 범위가 변경됐습니다/).waitFor();
  assert.equal(await page.getByLabel('최대 번호').inputValue(),'5500');
  await page.getByText('입력한 범위는 아직 저장되지 않았습니다. 현재 저장된 범위는 1–6000입니다.').waitFor();
  await page.screenshot({path:path.join(out,'range-draft-preserved-1280.png'),fullPage:true});
  await reset();await open();
  let requests=[];let loseSecond=true;
  const loss=async r=>{const body=r.request().postDataJSON();if(body?.command!=='lucky.preassign-range-reviewed')return r.continue();requests.push({id:body.commandId,size:body.payload.participantIds.length});if(requests.length===2&&loseSecond){loseSecond=false;await r.fetch();return r.abort('failed')}return r.continue();};
  await page.route('**/commands',loss);await begin();
  let recovery=page.getByRole('region',{name:'추첨·투표 처리 확인 필요'});await recovery.waitFor();
  await page.getByText(/확인된 대상 5000 \/ 5001명 · 현재 요청 확인 필요/).waitFor();
  await page.getByText('배정 현황은 현재 요청을 확인한 뒤 새로 표시됩니다.').waitFor();
  assert.equal(await page.getByText(/발급 0명 · 미발급 승인 참가자/).count(),0);
  await page.screenshot({path:path.join(out,'unconfirmed-1280.png'),fullPage:true});
  let ws=await read();assert.equal(ws.luckyNumbers.length,5001);assert.equal(new Set(ws.luckyNumbers.map(x=>x.number)).size,5001);
  assert.deepEqual(requests.map(x=>x.size),[5000,1]);
  await recovery.getByRole('button',{name:'같은 요청 다시 시도'}).click();await recovery.waitFor({state:'detached'});
  await page.getByText('5001명의 번호 배정을 확인했습니다. 기존 번호는 유지됩니다.').waitFor();
  assert.deepEqual(requests.map(x=>x.size),[5000,1,1]);assert.equal(requests[1].id,requests[2].id);assert.equal((await read()).luckyNumbers.length,5001);
  await page.unroute('**/commands',loss);await page.screenshot({path:path.join(out,'completed-1280.png'),fullPage:true});
  await page.evaluate(axeSource);for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});await settleLayout(page);/* Reopened 2026-11-20: 미리보기 기기 배율이 갱신된 뒤 측정 */assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(await page.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);if(width===390)await page.screenshot({path:path.join(out,'completed-390.png'),fullPage:true});}
  // Stop after a committed first batch, while its response is still in flight.
  await reset();await open();requests=[];let release,started;const held=new Promise(resolve=>{release=resolve}),startedPromise=new Promise(resolve=>{started=resolve});
  const hold=async r=>{const body=r.request().postDataJSON();if(body?.command!=='lucky.preassign-range-reviewed')return r.continue();requests.push(body.commandId);const response=await r.fetch();started();await held;return r.fulfill({response});};
  await page.route('**/commands',hold);await begin();await startedPromise;
  await page.getByRole('button',{name:'남은 배정 중단'}).click();await page.getByText(/현재 요청 확인 후 중단/).waitFor();release();
  await page.getByText('5000명 처리 후 남은 배정을 중단했습니다. 이미 배정된 번호는 유지됩니다.').waitFor();
  assert.equal((await read()).luckyNumbers.length,5000);assert.equal(requests.length,1);await page.unroute('**/commands',hold);
  // Change a participant after the first batch; the second batch must stop.
  await reset();await open();requests=[];let changeOnce=true;
  const change=async r=>{const body=r.request().postDataJSON();if(body?.command!=='lucky.preassign-range-reviewed')return r.continue();requests.push(body.commandId);if(changeOnce){changeOnce=false;const response=await r.fetch();const changed=await cmd('participant.status',{id:people[5000].id,status:'PENDING'});assert.equal(changed.status,200,JSON.stringify(changed.json));return r.fulfill({response});}return r.continue();};
  await page.route('**/commands',change);await begin();await page.getByText(/5000명 처리 후 배정이 멈췄습니다/).waitFor();
  ws=await read();assert.equal(ws.luckyNumbers.length,5000);assert.equal(ws.participants.find(x=>x.id===people[5000].id).status,'PENDING');assert.equal(requests.length,2);await page.unroute('**/commands',change);
  // A range change between batches must retain the first batch and stop the second.
  await reset();await open();requests=[];let changeRangeOnce=true;
  const changeRange=async r=>{const body=r.request().postDataJSON();if(body?.command!=='lucky.preassign-range-reviewed')return r.continue();requests.push(body);if(changeRangeOnce){changeRangeOnce=false;const response=await r.fetch();assert.equal((await cmd('lucky.config.save',{min:1,max:6000})).status,200);return r.fulfill({response});}return r.continue();};
  await page.route('**/commands',changeRange);await begin();await page.getByText(/5000명 처리 후 배정이 멈췄습니다. 번호 범위가 변경됐습니다/).waitFor();
  ws=await read();assert.equal(ws.luckyNumbers.length,5000);assert.equal(ws.luckyConfig.max,6000);assert.equal(requests.length,2);assert.deepEqual(requests.map(x=>x.payload.expectedRange),[{min:1,max:5001},{min:1,max:5001}]);await page.unroute('**/commands',changeRange);
  // A committed but unconfirmed batch keeps its receipt after the range changes.
  await reset();await open();requests=[];let loseFirst=true;
  const lossThenRange=async r=>{const body=r.request().postDataJSON();if(body?.command!=='lucky.preassign-range-reviewed')return r.continue();requests.push(body);if(loseFirst){loseFirst=false;await r.fetch();return r.abort('failed');}return r.continue();};
  await page.route('**/commands',lossThenRange);await begin();recovery=page.getByRole('region',{name:'추첨·투표 처리 확인 필요'});await recovery.waitFor();
  assert.equal((await read()).luckyNumbers.length,5000);assert.equal((await cmd('lucky.config.save',{min:1,max:6000})).status,200);
  await recovery.getByRole('button',{name:'같은 요청 다시 시도'}).click();await recovery.waitFor({state:'detached'});
  await page.getByText(/5000명 처리 후 배정이 멈췄습니다. 번호 범위가 변경됐습니다/).waitFor();
  ws=await read();assert.equal(ws.luckyNumbers.length,5000);assert.equal(requests.length,3);assert.equal(requests[0].commandId,requests[1].commandId);assert.notEqual(requests[1].commandId,requests[2].commandId);await page.unroute('**/commands',lossThenRange);
  // After a reload during an uncertain first batch, confirm its receipt and
  // explicitly restart only the remaining participant; no saved IDs are needed.
  await reset();await open();requests=[];let firstLoss=true;
  const reloadLoss=async r=>{const body=r.request().postDataJSON();if(body?.command!=='lucky.preassign-range-reviewed')return r.continue();requests.push({id:body.commandId,size:body.payload.participantIds.length});if(firstLoss){firstLoss=false;await r.fetch();return r.abort('failed')}return r.continue();};
  await page.route('**/commands',reloadLoss);await begin();recovery=page.getByRole('region',{name:'추첨·투표 처리 확인 필요'});await recovery.waitFor();assert.equal((await read()).luckyNumbers.length,5000);
  await page.reload();await selectDrawStage(page, '럭키번호');const shared=page.getByRole('region',{name:'처리 결과 확인'});await shared.getByText('럭키번호 배정',{exact:true}).waitFor();
  await shared.getByRole('button',{name:'서버 처리 확인'}).click();
  await page.getByRole('checkbox',{name:/승인 참가자 전체 5001명 선택/}).check();await page.getByRole('button',{name:'1명 번호 일괄 배정',exact:true}).click();await page.getByRole('button',{name:'번호 배정',exact:true}).click();
  await page.getByText('1명의 번호 배정을 확인했습니다. 기존 번호는 유지됩니다.').waitFor();
  ws=await read();assert.equal(ws.luckyNumbers.length,5001);assert.equal(new Set(ws.luckyNumbers.map(x=>x.number)).size,5001);assert.deepEqual(requests.map(x=>x.size),[5000,1]);
  await page.unroute('**/commands',reloadLoss);
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({synthetic:true,participants:5001,batches:[5000,1],rangeChangeBeforeAndDuring:true,lostResponseRetry:true,stopAtBoundary:true,eligibilityChangeStops:true,reloadReceiptAndResume:true,axeAndOverflowWidths:[320,390,1280],physicalDevices:false},null,2),{mode:0o600});
  console.log('PASS: 5001 auto batches, range and eligibility changes, uncertain retry, stop and reload receipt recovery');
 }catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
 finally{await browser?.close();await f.close()}
}
main().catch(e=>{console.error(String(e?.stack||e).replace(/https?:\/\/[^\s]+/g,'[url redacted]'));process.exitCode=1});
