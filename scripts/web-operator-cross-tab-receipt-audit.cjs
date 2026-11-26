'use strict';
// Synthetic accounts and data only; each run owns an isolated PostgreSQL schema.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {prepareCaptureDir,ensureRunTmpDir}=require('./capture-dir.cjs');
const {startAuditFixture,cookieForContext}=require('./audit-fixture.cjs');
const {launchBrowser}=require('./audit-browser.cjs');
const {settleLayout}=require('./ui-journey-helpers.cjs');
const axeSource=require('axe-core').source;
async function main(){
 if(!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
 const out=path.join(process.env.EVENTOUCH_CAPTURE_ROOT,'cross-tab-receipts');
 prepareCaptureDir(out); process.env.TMPDIR=ensureRunTmpDir(out);
 const f=await startAuditFixture(); let browser;
 try {
  browser=await launchBrowser(); const ctx=await browser.newContext({viewport:{width:1280,height:900}});
  await ctx.addCookies([{...cookieForContext(f,'manager'),url:f.baseUrl}]);
  const a=await ctx.newPage(), b=await ctx.newPage();
  const url=`${f.baseUrl}/console/events/${f.eventId}/participants`;
  await Promise.all([a.goto(url,{waitUntil:'networkidle'}),b.goto(url,{waitUntil:'networkidle'})]);
  await Promise.all([a.getByRole('checkbox',{name:'감사 참가자 1 선택'}).waitFor(),b.getByRole('checkbox',{name:'감사 참가자 2 선택'}).waitFor()]);
  let commit; const committed=new Promise(resolve=>{commit=resolve});
  let release; const hold=new Promise(resolve=>{release=resolve});
  await a.route('**/api/events/*/commands',async route=>{
   const request=route.request(); if(request.method()!=='POST'||request.postDataJSON()?.command!=='participant.bulk-cancel')return route.continue();
   const response=await route.fetch(); assert.equal(response.status(),200); commit(); await hold; await route.abort('failed');
  });
  await a.getByRole('checkbox',{name:'감사 참가자 1 선택'}).check();
  await a.getByRole('button',{name:'신청 취소',exact:true}).click();
  const cancel=a.getByRole('dialog',{name:'선택한 신청 취소'}); await cancel.getByText('취소 대상 1명',{exact:false}).waitFor();
  await cancel.getByRole('button',{name:'신청 취소',exact:true}).click(); await committed;
  let panel=b.getByRole('region',{name:'처리 결과 확인'});
  await panel.getByText('신청 일괄 취소',{exact:false}).waitFor();
  await b.getByRole('checkbox',{name:'감사 참가자 2 선택'}).check();
  assert.equal(await b.getByRole('button',{name:'신청 취소',exact:true}).isDisabled(),true);
  assert.ok((await b.evaluate(()=>JSON.stringify(localStorage))).includes('participant.bulk-cancel'));
  assert.ok(!(await b.evaluate(()=>JSON.stringify(localStorage))).includes('감사 참가자'));
  const c=await ctx.newPage(); await c.goto(url,{waitUntil:'networkidle'});
  await c.getByRole('region',{name:'처리 결과 확인'}).getByText('신청 일괄 취소',{exact:false}).waitFor();
  await b.setViewportSize({width:390,height:844});
  await panel.getByRole('button',{name:'목록에서 지우기'}).click();
  const confirm=b.getByRole('dialog',{name:'처리 결과 확인에서 지우기'}); await confirm.waitFor();
  await confirm.getByText('다른 창에서 처리 중이거나 이미 반영됐을 수 있습니다.',{exact:false}).waitFor();
  await b.addScriptTag({content:axeSource});
  for (const width of [320,390,1280]) {
   await b.setViewportSize({width,height:width===1280?900:844});
   assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
   await b.keyboard.press('Tab');
   assert.equal(await b.evaluate(()=>Boolean(document.activeElement?.closest('[role="dialog"]'))),true);
   // The dialog fades in; colours sampled mid-transition are not what anyone reads. Measure at rest.
   await settleLayout(b);
   const blocking=await b.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target.join(' '),html:n.html.slice(0,200),why:n.failureSummary}))})));
   assert.deepEqual(blocking.map(v=>v.id),[],`${width}px: ${JSON.stringify(blocking)}`);
   await b.screenshot({path:path.join(out,`remove-review-${width}.png`)});
  }
  await confirm.getByRole('button',{name:'목록에서 지우기'}).click();
  await panel.getByText('목록에서 지웠습니다.',{exact:false}).waitFor();
  // If the original response is lost, its owner publishes the uncertainty again.
  release(); await cancel.getByRole('region',{name:'신청 취소 처리 확인 필요'}).waitFor();
  await panel.getByText('신청 일괄 취소',{exact:false}).waitFor();
  assert.equal(await b.getByRole('button',{name:'신청 취소',exact:true}).isDisabled(),true);
  await b.reload({waitUntil:'networkidle'});
  panel=b.getByRole('region',{name:'처리 결과 확인'}); await panel.getByText('신청 일괄 취소',{exact:false}).waitFor();
  await b.setViewportSize({width:1280,height:900});
  await b.screenshot({path:path.join(out,'shared-recovery-1280.png')});
  // Shared records from other users/orgs must never render in this session.
  await b.evaluate(({eventId})=>{
   const base={userId:'different-user',organizationId:'different-org',eventId,commandId:'isolation-test-01',command:'message.create'};
   localStorage.setItem('eventouch.receipt.operator.v2.'+base.commandId,JSON.stringify({pointer:base}));
   window.dispatchEvent(new StorageEvent('storage',{key:'eventouch.receipt.operator.v2.'+base.commandId}));
  },{eventId:f.eventId});
  assert.equal(await panel.getByText('발송 요청',{exact:false}).count(),0);
  // Closing one tab must not erase the other tab's unresolved work.
  await c.close(); await b.reload({waitUntil:'networkidle'});
  await b.getByRole('region',{name:'처리 결과 확인'}).getByText('신청 일괄 취소',{exact:false}).waitFor();
  const stored=await b.evaluate(()=>JSON.stringify(localStorage));
  assert.ok(!stored.includes('감사 참가자'));
  const sharedValues=await b.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('eventouch.receipt.operator.v2.')).map(([,value])=>JSON.parse(value)).filter(value=>value.pointer).map(value=>Object.keys(value.pointer).sort()));
  for(const keys of sharedValues) assert.deepEqual(keys,['command','commandId','eventId','organizationId','userId']);
  const blocked=await browser.newContext({viewport:{width:390,height:844}});
  await blocked.addCookies([{...cookieForContext(f,'manager'),url:f.baseUrl}]);
  await blocked.addInitScript(()=>Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('blocked','SecurityError')}}));
  const offlineShare=await blocked.newPage(); await offlineShare.goto(url,{waitUntil:'networkidle'});
  await offlineShare.getByRole('alert').getByText('다른 창과 처리 결과를 공유할 수 없습니다.',{exact:false}).waitFor();
  await offlineShare.screenshot({path:path.join(out,'sharing-unavailable-390.png')});
  await blocked.close();
  await b.locator('.sidebar-bottom button[aria-controls="operator-menu"]').click();
  await b.getByRole('button',{name:'로그아웃',exact:true}).click();
  await b.waitForURL(/\/login/);
  const afterLogout=await b.evaluate(()=>JSON.stringify(localStorage));
  assert.ok(afterLogout.includes('participant.bulk-cancel')&&afterLogout.includes('isolation-test-01'));
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({passed:true,realApi:true,sameSessionIndependentTabs:true,sharedWhileInFlight:true,blocksOtherTab:true,thirdTabAndReload:true,explicitRemovalRecovery:true,otherIdentityHidden:true,closingTabKeepsPointer:true,logoutKeepsOtherPointers:true,storageDeniedWarning:true,keyboardAndWidths:[320,390,1280],noPayloadStored:true},null,2),{mode:0o600});
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
