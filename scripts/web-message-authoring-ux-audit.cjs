'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { messageStep, chooseRadio, openMessageMore, openMessagePanel, openTemplatePicker } = require('./ui-journey-helpers.cjs');
const axe = require('axe-core').source;
let phase = 'setup';
(async () => {
 const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-authoring'); prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
 const f = await startAuditFixture(); let browser, page;
 const checks = [], errors = [], messages = [], accessibility = [];
 try {
  const command = async(command,payload) => { const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {cookie:f.manager.cookie,method:'POST',body:{commandId:crypto.randomUUID(),command,payload}});assert.ok(r.status>=200&&r.status<300,JSON.stringify(r.json));return r.json; };
  const templates=[];
  const seedTemplates = async () => {
  for(const t of [{name:'합성 짧은 문자',channel:'SMS',body:'짧은 안내입니다.'},{name:'합성 이전 장문',channel:'LMS',body:'{{이름}}님, 행사 안내를 확인해 주세요. '.repeat(6)},{name:'합성 이전 사진 문구',channel:'MMS',body:'사진 없이도 사용할 수 있는 문구'},{name:'합성 알림톡',channel:'ALIMTALK',body:'{{이름}}님, {{행사명}} 안내입니다.',solapiTemplateId:'KAFIXTURE_ONLY'}]) {const r=await command('template.save',t);templates.push(r.template);}
  };
  const workspace=async()=> (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload;
  const person=(await workspace()).participants.find(p=>p.status==='APPROVED');assert.ok(person);
  browser=await launchBrowser();const context=await browser.newContext({viewport:{width:1280,height:900},locale:'ko-KR',timezoneId:'Asia/Seoul',reducedMotion:'reduce'});await context.addCookies([{...cookieForContext(f,'manager'),url:f.baseUrl}]);page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  await page.route('**/api/events/*/commands',async route=>{if(route.request().method()==='POST'){const b=route.request().postDataJSON();if(['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(b.command)){assert.equal(b.payload.simulate,true,'audit permits synthetic messages only');messages.push(b);}}await route.continue();});
  const base=`${f.baseUrl}/console/events/${f.eventId}/messages`;
  const check=(name,ok)=>{assert.ok(ok,name);checks.push({name,passed:true});};
  const capture=async(name)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);await page.screenshot({path:path.join(out,name+'.png')});};
  const audit=async(name)=>{await page.evaluate(axe);const violations=await page.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['moderate','serious','critical'].includes(v.impact)).map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})));accessibility.push({name,violations});assert.deepEqual(violations,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));};
  const begin=async(title)=>{await page.goto(base+'?to='+encodeURIComponent(person.id),{waitUntil:'networkidle'});await messageStep(page,2);await openMessageMore(page);await page.locator('#campaign-title').fill(title);};
  const submit=async()=>{await messageStep(page,3);const mock=page.getByRole('checkbox',{name:/^모의 발송으로 기록/});if(!await mock.isChecked())await mock.check();await page.locator('#campaign-submit').click();await page.getByRole('group',{name:'실행 확인',exact:true}).getByRole('button',{name:'모의 발송 기록',exact:true}).click();await page.locator('#message-compose-open').waitFor({state:'visible'});};
  phase='first template and full-width empty editor';await page.goto(base,{waitUntil:'networkidle'});await page.getByRole('tab',{name:'템플릿 관리',exact:true}).click();await page.locator('#template-name').waitFor({state:'visible'});
  check('first template editor uses a readable width',await page.locator('#template-name').evaluate(el=>el.getBoundingClientRect().width>=600));await capture('template-empty-1280');await audit('first template editor');
  await seedTemplates();
  phase='automatic text and safe template replacement';await begin('합성 자동 문자');
  const body=page.locator('#campaign-body');
  await body.fill('앞 뒤');await body.evaluate(el=>el.setSelectionRange(2,2));
  await page.getByRole('button',{name:'이름 넣기',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='campaign-body');
  check('personalization inserts at the existing caret',await body.inputValue()==='앞 {{이름}}뒤'&&await body.evaluate(el=>el.selectionStart===8&&el.selectionEnd===8));
  await body.evaluate(el=>el.setSelectionRange(2,8));await page.getByRole('button',{name:'티켓 링크 넣기',exact:true}).click();
  check('personalization replaces only selected text',await body.inputValue()==='앞 {{티켓링크}}뒤');
  check('personalization retains title and recipients',await page.locator('#campaign-title').inputValue()==='합성 자동 문자'&&(await page.locator('#recipient-summary').textContent()).includes('선택 1명'));
  await body.fill('가'.repeat(2000));await body.evaluate(el=>el.setSelectionRange(2000,2000));await page.getByRole('button',{name:'이름 넣기',exact:true}).click();
  await page.locator('#campaign-body-error').waitFor();check('insertion never truncates a full message',await body.inputValue()==='가'.repeat(2000));
  await body.fill('보존할 작성 내용');check('template management retains a 44px action',await page.getByRole('button',{name:'템플릿 관리',exact:true}).evaluate(el=>el.getBoundingClientRect().height>=44));check('only text and Alimtalk choices',await page.locator('#campaign-channel input[type=radio]').count()===2);await (await openTemplatePicker(page)).selectOption(templates[1].id);await page.getByRole('button',{name:'현재 내용 유지',exact:true}).click();check('cancel template replacement retains text',await page.locator('#campaign-body').inputValue()==='보존할 작성 내용');await (await openTemplatePicker(page)).selectOption(templates[1].id);await page.getByRole('button',{name:'템플릿 적용',exact:true}).click();check('legacy LMS template uses automatic text request',await page.locator('#campaign-channel input[value=SMS]').isChecked());await page.getByRole('button',{name:'템플릿 관리',exact:true}).click();await page.waitForFunction(()=>document.getElementById('templates-heading-tab')?.getAttribute('aria-selected')==='true');await page.locator('#template-name').waitFor({state:'visible'});check('manager and compose are separated',!await page.locator('#campaign-body').isVisible()&&await page.locator('#template-name').isVisible());await capture('template-manager-1280');await audit('persistent template manager');await page.locator('#template-details').getByRole('button',{name:'사용',exact:true}).first().click();await page.getByRole('button',{name:'현재 내용 유지',exact:true}).click();await page.locator('#message-compose-close').click();await page.locator('#message-compose-open').waitFor({state:'visible'});check('template use returns to the history task',!await page.locator('#template-name').isVisible());await page.locator('#message-compose-open').click();await messageStep(page,2);check('return retains original composed body',await page.locator('#campaign-body').inputValue()===templates[1].body);await (await openTemplatePicker(page)).selectOption(templates[0].id);await page.getByRole('button',{name:'템플릿 적용',exact:true}).waitFor();await submit();check('saved request stays SMS for server auto classification',messages.at(-1).payload.channel==='SMS');await page.locator('#message-compose-open').click();check('a fresh draft does not filter by the consumed selection',!await page.locator('#recipient-selected-only').isChecked());await page.locator('#message-compose-close').click();
  phase='photo attachment, preview, removal and no-photo request';await begin('합성 사진 해제');check('a proven send clears stale template replacement',await page.getByRole('button',{name:'템플릿 적용',exact:true}).count()===0);await page.locator('#campaign-body').fill('사진 첨부와 해제를 확인합니다.');
  // Use a decodable, synthetic image so local and CI runs need no external photo.
  const encodedPhoto = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#e3ebf2';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#af4d29';
    context.fillRect(24, 24, 112, 48);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  const jpeg = Buffer.from(encodedPhoto, 'base64');
  await page.locator('#campaign-image').setInputFiles({name:'합성-사진.jpg',mimeType:'image/jpeg',buffer:jpeg});await page.getByRole('button',{name:'사진 첨부 해제',exact:true}).waitFor();const photo=page.getByRole('img',{name:'첨부 사진: 합성-사진.jpg',exact:true});await photo.waitFor();await page.waitForFunction(()=>document.querySelector('[alt="첨부 사진: 합성-사진.jpg"]')?.naturalWidth>0);check('photo changes preview to MMS',(await page.locator('aside[aria-labelledby="message-preview-heading"]').textContent()).includes('MMS · 사진 첨부'));await capture('photo-preview-1280');await page.getByRole('button',{name:'사진 첨부 해제',exact:true}).click();check('removing photo restores ordinary text',await page.getByRole('img',{name:'첨부 사진: 합성-사진.jpg',exact:true}).count()===0);await submit();check('no unused MMS charge channel after removal',messages.at(-1).payload.channel==='SMS'&&!messages.at(-1).payload.imageFileId);
  phase='photo message preserves stored file id';await begin('합성 사진 문자');await page.locator('#campaign-body').fill('사진을 첨부한 가상 안내');await page.locator('#campaign-image').setInputFiles({name:'합성-사진.jpg',mimeType:'image/jpeg',buffer:jpeg});await page.getByRole('button',{name:'사진 첨부 해제',exact:true}).waitFor();await submit();check('attached photo requests MMS with server file reference',messages.at(-1).payload.channel==='MMS'&&Boolean(messages.at(-1).payload.imageFileId));const saved=(await workspace()).messages.find(m=>m.title==='합성 사진 문자');check('MMS reference and mock status persist in server',saved?.image?.fileId===messages.at(-1).payload.imageFileId&&saved.status==='SIMULATED');
  phase='Alimtalk example, narrow authoring and keyboard tabs';await begin('합성 알림톡 미리보기');await (await openTemplatePicker(page)).selectOption(templates[3].id);await page.getByText('카카오 알림톡 도착 예시',{exact:true}).waitFor();check('approved template selects Alimtalk',await page.locator('#campaign-channel input[value=ALIMTALK]').isChecked());await capture('alimtalk-1280');await audit('Alimtalk illustration');await page.setViewportSize({width:390,height:844});await capture('alimtalk-390');await audit('narrow Alimtalk authoring');await page.setViewportSize({width:320,height:740});await audit('short narrow authoring');await openMessagePanel(page,'how');await page.getByRole('button',{name:'템플릿 관리',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.id==='templates-heading');await page.getByRole('tab',{name:'템플릿 관리',exact:true}).focus();await page.keyboard.press('Home');await page.waitForFunction(()=>document.getElementById('history-heading-tab')?.getAttribute('aria-selected')==='true');check('keyboard switches tasks and retains draft',await page.locator('#campaign-body').inputValue()===templates[3].body);await audit('narrow message history');
  check('all recorded requests are synthetic',messages.length===3&&messages.every(m=>m.payload.simulate===true));assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({ok:true,buildId:fs.readFileSync('apps/web/.next/BUILD_ID','utf8').trim(),checks,accessibility,errors,synthetic:true,messageRequests:messages.map(m=>({channel:m.payload.channel,simulate:m.payload.simulate,hasPhoto:Boolean(m.payload.imageFileId)}))},null,2));console.log('Message authoring UX:',checks.length,'checks passed');
 }catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error('Failed phase:',phase);throw error;}finally{if(browser)await browser.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
