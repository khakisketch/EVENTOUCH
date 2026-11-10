'use strict';

// Synthetic real-API/Next browser audit. A committed response is deliberately
// altered in transit; neither UI may claim success until the same request is
// replayed and its visit/booth identifiers agree.
const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
let stage = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'booth-receipt-identity'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { database } = fixture.harness;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[fixture.eventId])).rows[0].payload;
    const workspace = await read();
    const [staffPerson, guestPerson] = workspace.participants.filter((person) => person.status === 'APPROVED' && person.ticket);
    assert.ok(staffPerson && guestPerson);
    for (const person of [staffPerson, guestPerson]) Object.assign(person, { inside:true, everIn:true, paymentStatus:'FREE', revoked:false,
      ticketExpiresAt:new Date(Date.now()+86400000).toISOString() });
    workspace.stampMode='STAFF';
    workspace.booths=[{id:'audit-booth-a',name:'합성 부스 A',status:'OPEN',capacity:0,limit:3,used:0},
      {id:'audit-booth-b',name:'합성 부스 B',status:'OPEN',capacity:0,limit:3,used:0}];
    workspace.visits=[];
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[fixture.eventId,JSON.stringify(workspace)]);
    const event=(await database.query('SELECT payload FROM events WHERE id=$1',[fixture.eventId])).rows[0].payload;
    event.features=[...new Set([...(event.features||[]),'stamp'])];
    await database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1',[fixture.eventId,JSON.stringify(event)]);
    await fixture.helpers.insertAssignment(database,{id:'booth-receipt-assignment',accountId:fixture.staff.id,eventId:fixture.eventId,type:'BOOTH',targetId:'audit-booth-a'});
    browser=await launchBrowser();
    const staffContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    await staffContext.addCookies([{...cookieForContext(fixture,'staff'),url:fixture.baseUrl}]);
    const staff=await staffContext.newPage();
    const requestUrl=`${fixture.baseUrl}/api/events/${fixture.eventId}/commands`;
    const requests=[];
    staff.on('request',(request)=>{ if(request.url()===requestUrl && request.method()==='POST') { const body=request.postDataJSON(); if(body.command==='booth.visit') requests.push(body); } });
    stage='staff initial';
    await staff.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`,{waitUntil:'networkidle'});
    await staff.getByRole('group',{name:'업무 종류'}).getByRole('button',{name:'부스 인증',exact:true}).click();
    await staff.locator('#staff-booth').selectOption('audit-booth-a');
    const ticket=staff.getByLabel('티켓 코드',{exact:true});
    await ticket.fill(staffPerson.ticket);
    await staff.route(requestUrl,async(route)=>{
      const response=await route.fetch(); const body=await response.json();
      body.boothId='audit-booth-b';
      await route.fulfill({response,json:body});
    },{times:1});
    await staff.locator('button[type="submit"]').and(staff.getByRole('button',{name:'부스 인증',exact:true})).click();
    const unknown=staff.getByRole('region',{name:'스캔 결과 미확인',exact:true});
    await unknown.waitFor();
    assert.equal(requests.length,1);
    assert.equal((await read()).visits.length,1);
    assert.equal(await ticket.count(),0,'unconfirmed ticket input is hidden until the original request resolves');
    assert.equal(await staff.locator('#staff-booth').isDisabled(),true);
    stage='staff status only';
    const panel=unknown.getByRole('group',{name:'현재 요청 서버 확인'});
    await panel.getByRole('button',{name:'서버 처리 확인',exact:true}).click();
    await panel.getByText('서버에 부스 인증 기록이 있습니다. 대상을 확인하려면 같은 요청을 다시 확인하세요.').waitFor();
    assert.equal(requests.length,1,'status lookup is read-only');
    assert.equal(await staff.locator('#staff-booth').isDisabled(),true,'generic receipt status must not unlock the frozen target');
    assert.equal(await panel.getByRole('button',{name:'서버 처리 확인',exact:true}).count(),1,'status-only lookup must retain pointer');
    await staff.evaluate(axeSource);
    for(const width of [320,390,1280]) {
      await staff.setViewportSize({width,height:844});
      assert.equal(await staff.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      const widths = await panel.evaluate((element) => ({ panel: element.getBoundingClientRect().width, parent: element.parentElement.getBoundingClientRect().width }));
      assert.ok(widths.panel >= widths.parent - 2, 'recovery guidance uses the available work width');
      assert.deepEqual(await staff.evaluate(async()=> (await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);
      if(width===390) await staff.screenshot({path:path.join(out,'staff-recovery-390.png'),fullPage:true,mask:[ticket],maskColor:'#e4e6ea'});
    }
    await staff.setViewportSize({width:390,height:844});
    await unknown.getByRole('button',{name:'같은 요청 재확인',exact:true}).focus();
    await staff.keyboard.press('Enter');
    const result=staff.getByRole('region',{name:'스캔 결과 상세',exact:true});
    await result.getByText(staffPerson.name,{exact:false}).waitFor();
    assert.equal(requests.length,2);
    assert.deepEqual(requests[1],requests[0]);
    assert.equal((await read()).visits.length,1,'receipt replay cannot duplicate a visit');

    // An opaque pointer persists across reload, while the original ticket is
    // deliberately not persisted. Status lookup cannot prove its target.
    await result.getByRole('button',{name:'다음 참가자',exact:true}).click();
    await staff.getByLabel('티켓 코드',{exact:true}).fill(guestPerson.ticket);
    await staff.route(requestUrl,async(route)=>{
      const response=await route.fetch(); const body=await response.json(); body.visitId='different-request';
      await route.fulfill({response,json:body});
    },{times:1});
    await staff.locator('button[type="submit"]').and(staff.getByRole('button',{name:'부스 인증',exact:true})).click();
    await unknown.waitFor();
    assert.equal((await read()).visits.length,2);
    const pointerBefore=await staff.evaluate(()=>sessionStorage.getItem('eventouch.receipts.operator')||'');
    assert.ok(pointerBefore && !pointerBefore.includes(guestPerson.ticket));
    staff.once('dialog',(dialog)=>dialog.accept());
    await staff.reload({waitUntil:'networkidle'});
    const reloadedPanel=staff.getByRole('region',{name:'처리 결과 확인'});
    await reloadedPanel.getByRole('button',{name:'서버 처리 확인',exact:true}).click();
    await reloadedPanel.getByText('서버에 부스 인증 기록이 있습니다. 화면에 원래 요청이 남아 있다면 다시 확인하고, 그렇지 않다면 인증 내역을 확인하세요.').waitFor();
    assert.equal(requests.length,3,'reload and status lookup must not resend the command');
    assert.equal(await reloadedPanel.getByRole('button',{name:'서버 처리 확인',exact:true}).count(),1);
    staff.once('dialog',(dialog)=>dialog.accept());
    await reloadedPanel.getByRole('button',{name:'목록에서 지우기',exact:true}).click();
    await staff.getByRole('dialog',{name:'처리 결과 확인에서 지우기'}).getByRole('button',{name:'목록에서 지우기',exact:true}).click();
    await reloadedPanel.getByText('목록에서 지웠습니다. 서버 처리는 취소되지 않았습니다.').waitFor();
    await staffContext.close();

    const changed=await read(); changed.stampMode='SELF';
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[fixture.eventId,JSON.stringify(changed)]);
    const guestContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    await guestContext.addInitScript(({slug,token})=>sessionStorage.setItem(`eventouch.ticket.${slug}`,token),{slug:fixture.slug,token:guestPerson.ticket});
    const guest=await guestContext.newPage();
    const guestRequests=[];
    guest.on('request',(request)=>{ if(request.url()===requestUrl && request.method()==='POST') { const body=request.postDataJSON(); if(body.command==='booth.visit') guestRequests.push(body); } });
    stage='guest initial';
    await guest.goto(`${fixture.baseUrl}/event/${fixture.slug}/home?view=stamp`,{waitUntil:'networkidle'});
    await guest.getByRole('heading',{name:'내 부스 인증'}).waitFor();
    const code=guest.getByLabel('부스 코드');
    const expectedCode=`ET:BOOTH:${fixture.eventId}:audit-booth-b`;
    await code.fill(expectedCode);
    await guest.route(requestUrl,async(route)=>{
      const response=await route.fetch(); const body=await response.json();
      delete body.visitId;
      await route.fulfill({response,json:body});
    },{times:1});
    const guestResponse=guest.waitForResponse(response=>response.url()===requestUrl && response.request().method()==='POST');
    await guest.getByRole('button',{name:'인증하기',exact:true}).click();
    assert.equal((await guestResponse).status(),201);
    await guest.getByRole('heading',{name:'처리 여부를 확인하지 못한 요청',exact:true}).waitFor();
    assert.equal(guestRequests.length,1); assert.equal((await read()).visits.length,3);
    assert.equal(await code.inputValue(),expectedCode); assert.equal(await code.isDisabled(),true);
    stage='guest status only';
    await guest.getByRole('button',{name:'서버 처리 확인',exact:true}).click();
    await guest.getByRole('status').filter({hasText:'어느 부스인지 확인하려면 같은 요청을 다시 확인하세요'}).waitFor();
    assert.equal(guestRequests.length,1); assert.equal(await code.isDisabled(),true);
    await guest.evaluate(axeSource);
    for(const width of [320,390,1280]) {
      await guest.setViewportSize({width,height:844});
      assert.equal(await guest.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      assert.deepEqual(await guest.evaluate(async()=> (await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);
      if(width===390) await guest.screenshot({path:path.join(out,'guest-recovery-390.png'),fullPage:true});
    }
    await guest.setViewportSize({width:390,height:844});
    await guest.getByRole('button',{name:'원래 요청 다시 보내기',exact:true}).focus();
    await guest.keyboard.press('Enter');
    await guest.getByRole('progressbar',{name:'합성 부스 B: 내 인증 1회, 부스당 한도 3회'}).waitFor();
    assert.equal(guestRequests.length,2);
    assert.deepEqual(guestRequests[1],guestRequests[0]);
    const visits=(await read()).visits;
    assert.equal(visits.length,3);
    assert.ok(visits.some(v=>v.participantId===staffPerson.id && v.boothId==='audit-booth-a'));
    assert.ok(visits.some(v=>v.participantId===guestPerson.id && v.boothId==='audit-booth-b'));
    console.log('Booth receipt identity: staff wrong-booth and guest truncated replies remain uncertain; status lookup preserves targets; exact keyboard replay confirms one visit per person.');
    await guestContext.close();
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch(error=>{ console.error('stage:',stage); console.error(String(error?.message||error).split('\n')[0].replace(/https?:\/\/[^\s]+/g,'[url redacted]')); process.exitCode=1; });
