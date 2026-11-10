'use strict';

// Isolated public signup: a stale consent notice cannot be recorded as a
// newer notice, even after an ambiguous response. All people are synthetic.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const axe = require('axe-core').source;
(async () => {
  const out = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`consent-change-recovery-${runStamp()}`));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const publish = async consentText => {const v=(await read()).formVersion; const r=await f.helpers.requestJson(f.harness.baseUrl,`/api/events/${f.eventId}/commands`,{method:'POST',cookie:f.manager.cookie,body:{commandId:crypto.randomUUID(),command:'form.publish',payload:{consentText,expectedFormVersion:v}}});assert.equal(r.status,200);return read()};
    const cmd=async(command,payload)=>{const r=await f.helpers.requestJson(f.harness.baseUrl,`/api/events/${f.eventId}/commands`,{method:'POST',cookie:f.manager.cookie,body:{commandId:crypto.randomUUID(),command,payload}});assert.equal(r.status,200);return read()};
    let shape=await read();shape=await cmd('field.save',{id:'meal',label:'식사',type:'select',options:['기존 선택','다른 선택'],expectedFormVersion:shape.formVersion});shape=await cmd('field.save',{id:'extra',label:'삭제 예정',type:'text',expectedFormVersion:shape.formVersion});
    await publish('합성 동의 안내 A'); browser = await launchBrowser(); const ctx = await browser.newContext({viewport:{width:390,height:844},locale:'ko-KR'});
    const prepare = async (name,phone,notice) => {const p=await ctx.newPage();await p.goto(`${f.baseUrl}/event/${f.slug}/register`);await p.getByText(notice,{exact:true}).waitFor();await p.locator('#field-name').fill(name);await p.locator('#field-phone').fill(phone);await p.locator('#consent').check();return p};
    const a=await prepare('합성 참가자 가','01099001231','합성 동의 안내 A'); const old=await read(); const b=await publish('합성 동의 안내 B');assert.ok(b.formVersion>old.formVersion);assert.equal(await a.getByText('합성 동의 안내 A',{exact:true}).isVisible(),true);
    const [reject]=await Promise.all([a.waitForResponse(r=>r.url().includes('/signup')&&r.request().method()==='POST'),a.getByRole('button',{name:'신청하기',exact:true}).click()]);assert.equal(reject.status(),409);assert.equal((await reject.json()).code,'SIGNUP_FORM_CHANGED');
    await a.getByRole('button',{name:'최신 신청 양식 불러오기'}).waitFor();await a.waitForFunction(()=>document.activeElement?.id==='signup-form-changed');assert.equal(await a.getByRole('button',{name:'신청하기',exact:true}).isDisabled(),true);assert.equal((await read()).participants.some(x=>x.name==='합성 참가자 가'),false);
    await a.screenshot({path:path.join(out,'conflict-390.png'),fullPage:true,mask:[a.locator('#field-phone')]});
    let releaseRefresh; let markRefresh; const refreshSeen = new Promise(resolve => { markRefresh=resolve }); const refreshGate = new Promise(resolve => { releaseRefresh=resolve });
    await a.route('**/api/public/events/*', async route => { if (route.request().method() === 'GET') { markRefresh(); await refreshGate; } return route.continue(); });
    await a.getByRole('button',{name:'최신 신청 양식 불러오기'}).click();
    await Promise.race([refreshSeen,new Promise((_,reject)=>setTimeout(()=>reject(new Error('refresh request not observed')),10000))]);
    assert.equal(await a.getByRole('button',{name:'신청하기',exact:true}).isDisabled(),true);
    assert.equal(await a.getByRole('button',{name:'최신 신청 양식 불러오기'}).isEnabled(),true);
    assert.equal(await a.getByText('최신 내용을 확인하고 있습니다. 연결이 늦으면 다시 눌러 주세요.').isVisible(),true);
    releaseRefresh();await a.getByText('합성 동의 안내 B',{exact:true}).waitFor();await a.unroute('**/api/public/events/*');await a.waitForFunction(()=>document.activeElement?.id==='consent');assert.equal(await a.getByRole('button',{name:'신청하기',exact:true}).isEnabled(),true);
    assert.equal(await a.locator('#field-name').inputValue(),'합성 참가자 가');assert.ok(await a.locator('#field-phone').inputValue()==='01099001231','the synthetic phone is preserved');assert.equal(await a.locator('#consent').isChecked(),false);
    assert.equal(await a.getByText(`동의 버전 ${b.consentVersion}`,{exact:false}).count(),1);await a.locator('#consent').check();await a.getByRole('button',{name:'신청하기',exact:true}).click();await a.getByText('합성 참가자 가',{exact:true}).first().waitFor();assert.equal((await read()).participants.find(x=>x.name==='합성 참가자 가').consent.version,b.consentVersion);
    const c=await prepare('합성 참가자 나','01099001232','합성 동의 안내 B');await c.locator('#field-meal').selectOption({label:'기존 선택'});await c.locator('#field-extra').fill('숨은 값');const stalePublic=(await f.helpers.requestJson(f.harness.baseUrl,`/api/public/events/${f.slug}`)).json;let firstBody,lastBody;let count=0;await c.route('**/api/events/*/signup',async route=>{count++;if(count===1){firstBody=route.request().postData();return route.abort('failed')} if(count===2)assert.ok(route.request().postData()===firstBody,'replay keeps same original request');else lastBody=route.request().postDataJSON();return route.continue()});
    await c.getByRole('button',{name:'신청하기',exact:true}).click();await c.getByRole('button',{name:'신청 결과 다시 확인'}).waitFor();
    shape=await read();shape=await cmd('field.delete',{id:'extra',expectedFormVersion:shape.formVersion});shape=await cmd('field.save',{id:'meal',label:'식사',type:'select',options:['다른 선택','새 선택'],expectedFormVersion:shape.formVersion});shape=await cmd('field.save',{id:'room',label:'새 필수 항목',type:'text',required:true,expectedFormVersion:shape.formVersion});await publish('합성 동의 안내 C');
    const [conflict]=await Promise.all([c.waitForResponse(r=>r.url().includes('/signup')&&r.request().method()==='POST'),c.getByRole('button',{name:'신청 결과 다시 확인'}).click()]);assert.equal(conflict.status(),409);assert.equal((await conflict.json()).code,'SIGNUP_FORM_CHANGED');
    await c.getByRole('button',{name:'최신 신청 양식 불러오기'}).waitFor();assert.equal(await c.getByText('신청 결과를 확인하지 못했습니다',{exact:false}).count(),0);
    let refreshTries=0;await c.route('**/api/public/events/*',async route=>{if(route.request().method()!=='GET')return route.continue();refreshTries++;if(refreshTries===1)return route.abort('failed');if(refreshTries===2)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(stalePublic)});return route.continue()});
    await c.getByRole('button',{name:'최신 신청 양식 불러오기'}).click();await c.getByText('최신 양식을 불러오지 못했습니다.',{exact:false}).waitFor();assert.equal(await c.locator('#field-name').inputValue(),'합성 참가자 나');assert.equal(await c.getByRole('button',{name:'신청하기',exact:true}).isDisabled(),true);
    await c.getByRole('button',{name:'최신 신청 양식 불러오기'}).click();await c.getByText('최신 변경 사항을 아직 확인하지 못했습니다.',{exact:false}).waitFor();assert.equal(await c.getByRole('button',{name:'신청하기',exact:true}).isDisabled(),true);
    await c.getByRole('button',{name:'최신 신청 양식 불러오기'}).click();await c.getByText('합성 동의 안내 C',{exact:true}).waitFor();await c.unroute('**/api/public/events/*');assert.equal(await c.locator('#field-name').inputValue(),'합성 참가자 나');assert.equal(await c.locator('#consent').isChecked(),false);assert.equal(await c.locator('#field-extra').count(),0);assert.equal(await c.locator('#field-meal').inputValue(),'');assert.equal(await c.locator('#field-room').inputValue(),'');
    await c.evaluate(axe);for (const width of [320,390,768,1280]) {await c.setViewportSize({width,height:900});assert.equal(await c.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(await c.evaluate(async()=> (await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[])}await c.setViewportSize({width:390,height:844});await c.screenshot({path:path.join(out,'refreshed-390.png'),fullPage:true,mask:[c.locator('#field-phone')]});await c.locator('#field-meal').selectOption({label:'새 선택'});await c.locator('#field-room').fill('합성 답변');await c.locator('#consent').check();await c.getByRole('button',{name:'신청하기',exact:true}).click();await c.getByText('합성 참가자 나',{exact:true}).first().waitFor();assert.ok(lastBody && !Object.hasOwn(lastBody,'extra'),'deleted answer is never submitted');assert.equal(lastBody.meal,'새 선택');assert.equal(lastBody.room,'합성 답변');
    const report={staleConsentRejected:true,sameRequestAfterLostResponseRejected:true,inputsPreserved:true,consentReset:true,versionShown:b.consentVersion,registrationCount:(await read()).participants.filter(p=>/^합성 참가자/.test(p.name)).length,failedRefreshRetained:true,oldResponseRetained:true,removedAnswerNotSubmitted:true,actualProvider:false}; fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
  }finally{await browser?.close();await f.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
