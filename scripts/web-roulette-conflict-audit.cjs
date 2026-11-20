'use strict';
// Two real operator sessions, isolated synthetic data and the normal API.
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
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'roulette-conflict'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser, a;
  try {
    const db = f.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const ws = await read();
    ws.rouletteConfig = {status:'OPEN', startsAt:null, endsAt:null, prizes:[{id:'p1',label:'합성 경품',quantity:5,weight:null}]};
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[f.eventId,JSON.stringify(ws)]);
    const secondId = `manager-${crypto.randomUUID()}`;
    await f.helpers.insertAccount(db,{orgId:f.helpers.LEGACY_ORG,id:secondId,role:'MANAGER',name:'합성 운영자 B',email:`${secondId}@example.test`});
    await f.helpers.insertMembership(db,secondId,f.eventId,['all']);
    const secondCookie = await f.helpers.sessionCookie(f.harness,secondId);
    const cmd=async (name,payload) => f.helpers.requestJson(f.harness.baseUrl,`/api/events/${f.eventId}/commands`,{method:'POST',cookie:f.manager.cookie,body:{commandId:crypto.randomUUID(),command:name,payload}});
    assert.equal((await cmd('event.features',{features:['draw','poll','reward']})).status,200);
    browser=await launchBrowser();
    const ca=await browser.newContext({viewport:{width:1280,height:900},locale:'ko-KR'});
    const cb=await browser.newContext({viewport:{width:1280,height:900},locale:'ko-KR'});
    await ca.addCookies([{...cookieForContext(f,'manager'),url:f.baseUrl}]);
    await cb.addCookies([{name:'etko_session',value:decodeURIComponent(secondCookie.split('=')[1]),url:f.baseUrl}]);
    a=await ca.newPage(); const b=await cb.newPage();
    const setup=async p=>{await p.goto(`${f.baseUrl}/console/events/${f.eventId}/draws`);await selectDrawStage(p, '모바일 룰렛');const d=p.locator('details').filter({hasText:'룰렛 운영 설정'});if(!await d.evaluate(el=>el.open))await d.locator('summary').click()};
    const save=async p=>{const response=p.waitForResponse(r=>r.url().includes('/commands')&&r.request().postDataJSON()?.command==='roulette.config.save-reviewed');await p.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click();return response};
    await setup(a); await setup(b);
    await a.getByLabel('유한 재고 수량',{exact:true}).first().fill('4');
    await b.locator('#roulette-status').selectOption('CLOSED'); assert.equal((await save(b)).status(),200);
    assert.equal((await read()).rouletteConfig.status,'CLOSED');
    assert.equal((await save(a)).status(),409);
    const conflict=a.getByRole('region',{name:'다른 작업에서 룰렛 설정이 변경됐습니다'});
    await conflict.waitFor();
    await a.waitForFunction(()=>document.activeElement?.id==='roulette-conflict-heading');
    await a.keyboard.press('Tab');
    assert.equal(await a.evaluate(()=>document.activeElement?.textContent),'최신 설정 확인');
    assert.equal(await a.getByLabel('유한 재고 수량',{exact:true}).first().inputValue(),'4');
    assert.equal(await a.getByRole('button',{name:'룰렛 설정 저장',exact:true}).isDisabled(),true);
    assert.equal((await read()).rouletteConfig.status,'CLOSED');
    let block='error';
    const route=async r=>{
      if(block==='error')return r.fulfill({status:503,body:'{}'});
      if(block==='partial') {
        const response=await r.fetch(); const body=await response.json();
        delete body.state.workspaces[f.eventId].rouletteConfigVersion;
        return r.fulfill({response,body:JSON.stringify(body)});
      }
      return r.continue();
    };
    await a.route('**/bootstrap',route);
    let refresh = a.waitForResponse(r=>r.url().includes('/bootstrap'));
    await conflict.getByRole('button',{name:'최신 설정 확인',exact:true}).click(); await refresh; await conflict.getByRole('alert').waitFor();
    assert.equal(await a.getByLabel('유한 재고 수량',{exact:true}).first().inputValue(),'4');
    block='partial'; refresh = a.waitForResponse(r=>r.url().includes('/bootstrap'));
    await conflict.getByRole('button',{name:'최신 설정 확인',exact:true}).click(); await refresh; await conflict.getByRole('alert').waitFor();
    assert.equal(await a.getByRole('button',{name:'룰렛 설정 저장',exact:true}).isDisabled(),true);
    block='pass';
    await conflict.getByRole('button',{name:'최신 설정 확인',exact:true}).click();
    await conflict.getByRole('heading',{name:'최신 설정과 내 작성 내용 비교'}).waitFor();
    assert.match(await conflict.innerText(),/마감/);assert.match(await conflict.innerText(),/운영 중/);assert.match(await conflict.innerText(),/합성 경품 · 5개/);assert.match(await conflict.innerText(),/합성 경품 · 4개/);
    await a.screenshot({path:path.join(out,'comparison-1280.png'),fullPage:true});
    await a.evaluate(axeSource);
    for(const width of [320,390,1280]){await a.setViewportSize({width,height:900});await settleLayout(a);/* Reopened 2026-11-20: 미리보기 기기 배율이 갱신된 뒤 측정 */assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(await a.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);if(width===390)await a.screenshot({path:path.join(out,'comparison-390.png'),fullPage:true});}
    await conflict.getByRole('button',{name:'내 작성 내용으로 계속'}).click();
    assert.equal((await read()).rouletteConfig.status,'CLOSED');
    await a.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click();
    await a.getByRole('button',{name:'룰렛 운영 시작',exact:true}).waitFor();
    assert.equal((await read()).rouletteConfig.status,'CLOSED');
    const confirm=a.waitForResponse(r=>r.url().includes('/commands')&&r.request().postDataJSON()?.command==='roulette.config.save-reviewed');
    await a.getByRole('button',{name:'룰렛 운영 시작',exact:true}).click();assert.equal((await confirm).status(),200);
    let saved=await read();assert.equal(saved.rouletteConfig.status,'OPEN');assert.equal(saved.rouletteConfig.prizes[0].quantity,4);
    // A new stale edit can instead discard the draft and adopt the latest settings.
    await b.reload();await selectDrawStage(b, '모바일 룰렛');let d=b.locator('details').filter({hasText:'룰렛 운영 설정'});if(!await d.evaluate(el=>el.open))await d.locator('summary').click();
    await a.getByLabel('유한 재고 수량',{exact:true}).first().fill('3');
    await b.locator('#roulette-status').selectOption('CLOSED');assert.equal((await save(b)).status(),200);
    assert.equal((await save(a)).status(),409);await conflict.getByRole('button',{name:'최신 설정 확인',exact:true}).click();
    await conflict.getByRole('button',{name:'최신 설정 사용',exact:true}).click();
    assert.equal(await a.locator('#roulette-status').inputValue(),'CLOSED');assert.equal(await a.getByLabel('유한 재고 수량',{exact:true}).first().inputValue(),'4');
    assert.equal((await read()).rouletteConfig.status,'CLOSED');
    // A committed save whose response is lost is retried with the original
    // request, not a new version or a second write.
    const priorVersion=(await read()).rouletteConfigVersion;
    const requestIds=[]; let lose=true;
    const lossRoute=async r=>{
      const data=r.request().postDataJSON();
      if(data?.command!=='roulette.config.save-reviewed')return r.continue();
      requestIds.push(data.commandId);
      if(lose){lose=false;await r.fetch();return r.abort('failed');}
      return r.continue();
    };
    await a.route('**/commands',lossRoute);
    await a.getByLabel('유한 재고 수량',{exact:true}).first().fill('3');
    await a.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click();
    const recovery=a.getByRole('region',{name:'추첨·투표 처리 확인 필요'});
    await recovery.waitFor();
    assert.equal((await read()).rouletteConfigVersion,priorVersion+1);
    await recovery.getByRole('button',{name:'같은 요청 다시 시도'}).click();
    await recovery.waitFor({state:'detached'});
    saved=await read();assert.equal(saved.rouletteConfigVersion,priorVersion+1);assert.equal(saved.rouletteConfig.prizes[0].quantity,3);
    assert.equal(requestIds.length,2);assert.equal(requestIds[0],requestIds[1]);
    await a.unroute('**/commands',lossRoute);
    // A previous server that does not know the guarded command must not
    // silently fall back to an unsafe unguarded save.
    const oldServer=async r=>r.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'지원하지 않는 행사 작업입니다'})});
    await a.route('**/commands',oldServer);
    await a.getByLabel('유한 재고 수량',{exact:true}).first().fill('2');
    await a.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click();
    await a.getByText('현재 서버에서 변경 검토를 지원하지 않습니다. 서버를 갱신한 뒤 다시 확인하세요.').waitFor();
    assert.equal((await read()).rouletteConfig.prizes[0].quantity,3);
    assert.equal(await a.getByLabel('유한 재고 수량',{exact:true}).first().inputValue(),'2');
    await a.unroute('**/commands',oldServer);
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({synthetic:true,twoManagers:true,responseFailureAndPartial:true,explicitChoiceAndReopenConfirm:true,latestChoice:true,lostResponseSameRequest:true,oldServerRejection:true,keyboardFocus:true,responsive:[320,390,1280],physicalDevices:false},null,2),{mode:0o600});
    console.log('PASS: concurrent close, conflict, failed/incomplete read, both choices, explicit reopen and lost-response retry');
  } finally {await browser?.close();await f.close()}
}
main().catch(e=>{console.error(String(e?.stack||e).replace(/https?:\/\/[^\s]+/g,'[url redacted]'));process.exitCode=1});
