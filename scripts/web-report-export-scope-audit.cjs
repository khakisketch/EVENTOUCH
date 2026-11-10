'use strict';
// Synthetic source data only. The real API creates the frozen report;
// browser download and print verify what each output actually contains.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { floorplanPng } = require('../tests/helpers/floorplan-image.cjs');
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'report-export-scope');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const api = `${f.harness.baseUrl}/api/events/${f.eventId}`;
    const command = async (name, payload, bearer) => {
      const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method:'POST', ...(bearer ? { bearer } : { cookie:f.manager.cookie }), body:{commandId:crypto.randomUUID(),command:name,payload},
      });
      assert.ok(response.status === 200 || response.status === 201, `${name} must succeed`);
      return response.json;
    };
    const upload = await fetch(`${api}/files?name=synthetic.png&commandId=${crypto.randomUUID()}`, {method:'POST',headers:{cookie:f.manager.cookie,'content-type':'image/png'},body:floorplanPng()});
    assert.equal(upload.status,201); const {file}=await upload.json();
    const workspace=(await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload;
    const person=workspace.participants.find((item)=>item.status==='APPROVED'&&!item.revoked);
    await command('event.features',{features:['photo']});
    const caption='합성 비표시 사진 설명';
    const {photo}=await command('photo.submit',{image:file,caption},person.ticket);
    await command('photo.moderate',{id:photo.id,status:'APPROVED'});
    const {report}=await command('report.create',{title:'합성 요약 보고서',sections:['overview']});
    assert.equal(report.snapshot.photos[0].caption,caption);
    browser=await launchBrowser(); const ctx=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true,reducedMotion:'reduce'});
    await ctx.addCookies([{...cookieForContext(f,'manager'),url:f.baseUrl}]);
    const page=await ctx.newPage();const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
    await page.addInitScript(()=>{window.__printText='';window.print=()=>{window.__printText=document.getElementById('eventouch-report-print')?.textContent||'';};});
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports#report-${report.id}`);
    const article=page.locator('article');await article.getByRole('heading',{name:'합성 요약 보고서',exact:true}).waitFor();
    assert.equal(await article.getByText(caption).count(),0,'unselected photo is absent from the viewed report');
    const original=page.getByRole('button',{name:/원본.*JSON/});
    const [download]=await Promise.all([page.waitForEvent('download'),original.click()]);
    const raw=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
    assert.equal(raw.snapshot.photos[0].caption,caption,'original JSON retains the unselected photo metadata');
    await page.getByRole('button',{name:'인쇄하기',exact:true}).click();
    await page.waitForFunction(()=>window.__printText.length>0);
    assert.equal((await page.evaluate(()=>window.__printText)).includes(caption),false,'print omits the unselected section');
    const pdf = await page.pdf({ path:path.join(out,'selected-sections.pdf'), format:'A4', printBackground:true });
    assert.ok(pdf.length > 1000 && pdf.subarray(0,4).toString() === '%PDF', 'browser produced a PDF from the print view');
    await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
    if(process.argv.includes('--before')){
      await page.screenshot({path:path.join(out,'before-1280.png'),fullPage:true});
      assert.equal(await page.getByText(/JSON 원본에는 화면에서 제외한 항목/).isVisible(),true,'scope must be explained before sharing');
      return;
    }
    const hint=page.getByText(/JSON 원본에는 화면에서 제외한 항목/);
    await hint.waitFor();
    assert.equal(await original.getAttribute('aria-describedby'),'report-export-scope-help');
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);
      if(width!==320) await page.screenshot({path:path.join(out,`scope-${width}.png`),fullPage:true});
    }
    await page.getByRole('tab',{name:'보고서',exact:true}).click();
    await page.getByRole('button',{name:'보고서 만들기',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'결과 보고서 만들기'});
    await dialog.getByText(/선택하지 않은 항목도 JSON 원본에 포함/).waitFor();
    assert.deepEqual(errors,[]);
    console.log('Report export scope audit passed');
  } finally {if(browser)await browser.close();await f.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1});
