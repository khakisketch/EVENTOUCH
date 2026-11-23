'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { startAuditFixture } = require('./audit-fixture.cjs');
const { extendFixtureSeed } = require('./web-console-audit.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { messageStep, chooseScheduleDate, openRecipientList, openMessageMore } = require('./ui-journey-helpers.cjs');
let stage = 'setup';
(async () => {
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'taskflow-redesign');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser, page;
  try {
    const ext = await extendFixtureSeed(f);
    browser = await launchBrowser();
    const owner = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await owner.addCookies([{ name:'etko_session', value:decodeURIComponent(ext.ownerCookie.split('=')[1]), url:f.baseUrl }]);
    page = await owner.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let accept = false; page.on('dialog', d => accept ? d.accept() : d.dismiss());
    const base = `${f.baseUrl}/console/events/${f.eventId}`;
    const shot = async name => page.screenshot({path:path.join(out, name)});
    const a11y = async () => {
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250); // Let token color/focus transitions settle before contrast measurement.
      await page.evaluate(axe);
      assert.deepEqual(await page.evaluate(async()=> (await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>({id:v.id,target:v.nodes.map(n=>n.target)}))), []);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 2), 'no document overflow');
    };
    stage = 'overview';
    await page.goto(base); await page.getByRole('heading',{name:'운영 현황',exact:true}).waitFor();
    await page.locator('#event-metrics-heading').waitFor();
    assert.equal(await page.getByRole('navigation',{name:'주요 메뉴'}).getByRole('link',{name:'명단 가져오기',exact:true}).count(),0);
    const analysisOrder = await page.evaluate(()=> {
      // 기간 분석은 전용 화면이 맡고, 운영 현황에는 최근 입퇴장 뒤에 링크 한 줄만 둔다.
      const recent=document.querySelector('#event-recent-heading');
      const link=[...document.querySelectorAll('a')].find(n=>n.textContent.includes('기간 분석 보기'));
      return !!recent && !!link && Boolean(recent.compareDocumentPosition(link)&Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(analysisOrder,true);
    await shot('overview-1280.png'); await a11y();
    stage = 'roster direct actions and filter retention';
    await page.goto(base+'/participants');
    await page.getByRole('checkbox',{name:'감사 참가자 1 선택',exact:true}).check();
    await page.getByRole('button',{name:'그룹 변경',exact:true}).waitFor();
    assert.equal(await page.locator('summary').filter({hasText:'선택 작업'}).count(),0);
    await page.getByRole('button',{name:'신청 취소',exact:true}).waitFor();
    await page.getByPlaceholder('이름·소속·연락처 검색').fill('감사 참가자 1');
    await shot('roster-actions-1280.png'); await a11y();
    stage = 'modal file drop and guarded close';
    await page.getByRole('button',{name:'명단 가져오기',exact:true}).click();
    const modal = page.getByRole('dialog',{name:'명단 가져오기',exact:true});
    await modal.locator('input[type=file]').waitFor({state:'attached'});
    await shot('import-file-1280.png');
    const transfer = await page.evaluateHandle(()=> {
      const dt=new DataTransfer(); dt.items.add(new File(['이름,연락처,소속\n합성 드래그,01000007777,합성 기관'], 'people.csv',{type:'text/csv'})); return dt;
    });
    await modal.locator('[data-import-dropzone]').dispatchEvent('drop',{dataTransfer:transfer});
    await modal.getByRole('region',{name:'가져올 명단 확인'}).waitFor({state:'attached'});
    await shot('import-columns-1280.png');
    await modal.getByRole('status').filter({hasText:/등록할 수 있어요/}).waitFor();
    await modal.getByRole('button',{name:'닫기',exact:true}).click();
    await modal.getByRole('button',{name:'계속 작성하기',exact:true}).click();
    assert.equal(await modal.isVisible(),true,'canceling dismissal retains the file and mapping');
    await page.setViewportSize({width:390,height:844});
    await shot('import-modal-390.png'); await a11y();
    await page.setViewportSize({width:1280,height:900});
    await shot('import-modal-1280.png'); await a11y();
    accept=true;
    await modal.getByRole('button',{name:'닫기',exact:true}).click();
    await modal.getByRole('button',{name:'가져오기 닫기',exact:true}).click();
    await modal.waitFor({state:'hidden'});
    assert.equal(await page.getByRole('button',{name:'명단 가져오기',exact:true}).evaluate(el=>el===document.activeElement),true,'modal dismissal restores the trigger focus');
    assert.equal(await page.getByPlaceholder('이름·소속·연락처 검색').inputValue(),'감사 참가자 1');
    assert.equal(await page.getByRole('checkbox',{name:'감사 참가자 1 선택',exact:true}).isChecked(),true);
    stage = 'import commit response loss and status lookup';
    await page.getByRole('button',{name:'명단 가져오기',exact:true}).click();
    await modal.locator('input[type=file]').setInputFiles({name:'people.csv',mimeType:'text/csv',buffer:Buffer.from('이름,연락처,소속\n합성 반영,01000008888,합성 기관')});
    await modal.getByRole('status').filter({hasText:/등록할 수 있어요/}).waitFor();
    const imports=[]; let lose=true;
    await page.route('**/api/events/*/commands',async route=>{
      const body=route.request().postDataJSON();
      if(body.command!=='participant.import') return route.continue();
      imports.push(body);
      if(lose) {lose=false; const res=await route.fetch(); assert.ok(res.status()<300); return route.abort('failed');}
      return route.continue();
    });
    await modal.getByRole('button',{name:/^1명 등록$/}).click();
    await modal.getByRole('button',{name:'서버 처리 확인',exact:true}).waitFor();
    await modal.getByRole('button',{name:'서버 처리 확인',exact:true}).click();
    await modal.getByText(/^1명을 반영했습니다\./).waitFor();
    assert.equal(imports.length,1,'status lookup never reimports');
    await modal.getByRole('button',{name:'닫기',exact:true}).click();
    const read = async()=> (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload;
    assert.equal((await read()).participants.filter(p=>p.name==='합성 반영').length,1);
    stage = 'message step navigation';
    // Reopened 2026-11-24 (owner: 시안 A): one sentence with three pills opening folded panels. Panels
    // neither hide nor gate each other, and 발송 검토 keeps every validation.
    await page.goto(base+'/messages'); await page.locator('#message-compose-open').click();
    await page.waitForFunction(()=>document.activeElement?.id==='campaign-who-pill');
    assert.match(await page.locator('#recipient-summary').innerText(),/선택 0명/);
    assert.equal(await page.locator('#campaign-submit').isDisabled(),true,'empty recipients keep review disabled');
    assert.match(await page.locator('#campaign-submit-warning').innerText(),/수신자를 먼저 고르세요/);
    await openRecipientList(page);
    await page.getByRole('checkbox',{name:/감사 참가자 1 감사 업체 1/}).check();
    await messageStep(page,2);
    assert.equal(await page.locator('#campaign-title').evaluate(el=>el.tabIndex),0,'checklist navigation preserves normal Tab order');
    await openMessageMore(page);
    await page.locator('#campaign-title').fill('합성 단계 안내');
    await page.locator('#campaign-body').fill('{{이름}}님 안내입니다.');
    assert.match(await page.locator('#campaign-who-pill').innerText(),/1명/,'the recipient count stays on screen in the sentence while writing');
    await shot('message-step2-1280.png'); await a11y();
    await messageStep(page,1);
    assert.match(await page.locator('#recipient-summary').innerText(),/선택 1명/);
    await messageStep(page,2);
    assert.equal(await page.locator('#campaign-body').inputValue(),'{{이름}}님 안내입니다.');
    await messageStep(page,3);
    await page.getByRole('heading',{name:'발송 전 검토',exact:true}).waitFor();
    assert.equal(await page.locator('#campaign-body').inputValue(),'{{이름}}님 안내입니다.','moving to the review zone keeps the draft');
    await page.getByLabel('모의 발송으로 기록',{exact:false}).check();
    await (await chooseScheduleDate(page)).fill('2027-01-10T10:00');
    await shot('message-step3-1280.png'); await a11y();
    await messageStep(page,2);
    await page.locator('#campaign-body').fill('');
    await page.locator('#campaign-submit').click();
    await page.getByText('메시지 내용을 입력하세요.',{exact:true}).waitFor();
    assert.equal(await page.locator('#campaign-body').isVisible(),true);
    await page.locator('#campaign-body').fill('보존할 원문');
    stage = 'narrow layouts';
    for(const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      await page.locator('#campaign-body').scrollIntoViewIfNeeded();
      await shot(`message-step2-${width}.png`); await a11y();
    }
    stage = 'simulated message committed response loss';
    await messageStep(page,3);
    // Repeated navigation and draft edits must not submit anything.
    const sends=[];
    await page.route('**/api/events/*/commands', async route=>{
      const body=route.request().postDataJSON();
      if(!['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(body.command)) return route.continue();
      assert.equal(body.payload.simulate,true);
      sends.push(body);
      if(sends.length===1) {const res=await route.fetch();assert.ok(res.status()<300);return route.abort('failed');}
      return route.continue();
    });
    await page.locator('#campaign-submit').click();
    await page.getByRole('group',{name:'실행 확인'}).getByRole('button',{name:'예약 등록한다',exact:true}).click();
    const recovery=page.getByRole('region',{name:'발송 요청 확인 필요'});
    await recovery.waitFor();
    assert.equal(await page.locator('#campaign-title').isDisabled(),true);
    assert.equal((await read()).messages.filter(m=>m.title==='합성 단계 안내').length,1);
    await recovery.getByRole('button',{name:'같은 요청 다시 시도',exact:true}).click();
    await recovery.waitFor({state:'hidden'});
    assert.equal(sends.length,2);
    assert.deepEqual(sends[0],sends[1]);
    assert.equal((await read()).messages.filter(m=>m.title==='합성 단계 안내').length,1);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({outcome:'passed',buildId:fs.readFileSync(path.join(__dirname,'../apps/web/.next/BUILD_ID'),'utf8').trim(),synthetic:true,overview:true,directActions:true,modalDrop:true,modalGuard:true,filterAndSelectionRetained:true,importCommittedResponseLoss:true,statusOnly:true,messageSteps:true,simulatedReservationCommittedResponseLoss:true,sameRequestRetry:true,oneMessageStored:true,backRetainsDraft:true,validationRevealsStep:true,widths:[1280,390,320],axeSeriousCritical:0},null,2),{mode:0o600});
    console.log('Task flows: overview, direct actions, guarded import/drop/recovery and message steps passed');
  }catch(e){if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw e;}
  finally {if(browser)await browser.close();await f.close();}
})().catch(e=>{console.error('Failed phase:',stage,e);process.exitCode=1;});
