'use strict';
// Synthetic, isolated browser + API journey; no real participant or prizes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'roulette-schedule'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const db = fixture.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const write = async ws => db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(ws)]);
    const ws = await read();
    const person = ws.participants.find(p => p.status === 'APPROVED' && p.ticket);
    assert.ok(person);
    ws.rouletteConfig = { status: 'OPEN', startsAt: 'not-a-date', endsAt: null, prizes: [{ id: 'synthetic-prize', label: '합성 기념품', quantity: 3, weight: null }] };
    await write(ws);
    const url = `${fixture.baseUrl}/api/events/${fixture.eventId}/commands`;
    const feature = await fetch(url, { method: 'POST', headers: { cookie: fixture.manager.cookie, 'content-type': 'application/json' }, body: JSON.stringify({commandId:crypto.randomUUID(),command:'event.features',payload:{features:['draw']}}) });
    assert.ok(feature.ok, await feature.text());
    browser = await launchBrowser();
    const operator = await browser.newContext({viewport:{width:1280,height:900},timezoneId:'Asia/Seoul'});
    await operator.addCookies([{...cookieForContext(fixture,'manager'),url:fixture.baseUrl}]);
    const page = await operator.newPage();
    const openSetup = async p => {
      await p.getByRole('tab',{name:'모바일 룰렛',exact:true}).click();
      const details = p.locator('details').filter({hasText:'룰렛 운영 설정'});
      if (!await details.evaluate(el=>el.open)) await details.locator('summary').click();
    };
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/draws`);
    await openSetup(page);
    assert.match(await page.locator('summary').filter({hasText:'룰렛 운영 설정'}).textContent(), /시간 확인 필요 · 참여 보류/);
    await page.getByText(/저장된 시작 시간 확인 필요: not-a-date/).waitFor();
    await page.screenshot({path:path.join(out,'operator-review-1280.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(out,'operator-review-390.png'),fullPage:true});
    await page.evaluate(axeSource);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(await page.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click();
    await page.getByText('저장된 운영 시간을 확인하고 새 시간을 입력하거나 제한을 해제하세요.').waitFor();
    assert.equal((await read()).rouletteConfig.startsAt,'not-a-date');
    const attendee = await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Seoul'});
    await attendee.addInitScript(({slug,ticket})=>sessionStorage.setItem(`eventouch.ticket.${slug}`,ticket),{slug:fixture.slug,ticket:person.ticket});
    const guest = await attendee.newPage();
    await guest.goto(`${fixture.baseUrl}/event/${fixture.slug}/home?view=roulette`);
    await guest.getByText('룰렛 운영 시간을 확인하고 있습니다. 현장 운영자에게 문의하세요.').waitFor();
    assert.equal(await guest.getByRole('button',{name:/^START/}).count(),0);
    await guest.screenshot({path:path.join(out,'attendee-review-390.png'),fullPage:true});
    await page.locator('#roulette-starts').fill('2020-01-01T09:00');
    await page.locator('#roulette-ends').fill('2099-12-31T17:00');
    const commandResponse = page.waitForResponse(r=>r.url().includes('/commands') && r.request().postDataJSON()?.command==='roulette.config.save-reviewed');
    await page.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click();
    assert.equal((await commandResponse).status(),200);
    await page.getByText('룰렛 경품과 운영 상태를 저장했습니다.').waitFor();
    let saved = await read();
    assert.equal(saved.rouletteConfig.startsAt,'2020-01-01T09:00:00+09:00');
    assert.equal(saved.rouletteConfig.endsAt,'2099-12-31T17:00:00+09:00');
    await guest.getByRole('button',{name:/^START/}).waitFor({timeout:15000});
    const spin = guest.waitForResponse(r=>r.url().includes('/commands') && r.request().postDataJSON()?.command==='roulette.spin');
    await guest.getByRole('button',{name:/^START/}).click();
    assert.equal((await spin).status(),200);
    await guest.getByText('내 당첨 경품').waitFor({timeout:15000});
    saved = await read(); assert.equal(saved.rouletteResults.length,1);
    // Same absolute time, seconds and original offset survive untouched saves
    // from browsers whose own time zones are different.
    saved.rouletteConfig.startsAt='2020-01-01T00:00:12.345Z';
    await write(saved);
    for (const timezoneId of ['UTC','America/Los_Angeles']) {
      const context = await browser.newContext({viewport:{width:1280,height:900},timezoneId});
      await context.addCookies([{...cookieForContext(fixture,'manager'),url:fixture.baseUrl}]);
      const p=await context.newPage(); await p.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/draws`); await openSetup(p);
      assert.equal(await p.locator('#roulette-starts').inputValue(),'2020-01-01T09:00');
      const response=p.waitForResponse(r=>r.url().includes('/commands') && r.request().postDataJSON()?.command==='roulette.config.save-reviewed');
      await p.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click(); assert.equal((await response).status(),200);
      assert.equal((await read()).rouletteConfig.startsAt,'2020-01-01T00:00:12.345Z');
      await context.close();
    }
    await page.reload(); await openSetup(page);
    await page.locator('#roulette-starts').fill('');
    await page.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click();
    await page.getByText('날짜와 시간을 모두 입력하거나 시간 제한 해제 버튼을 선택하세요.').waitFor();
    assert.equal((await read()).rouletteConfig.startsAt,'2020-01-01T00:00:12.345Z');
    await page.getByRole('button',{name:'시작 시간 제한 해제',exact:true}).click();
    await page.getByText('저장하면 시작 시간 제한을 해제합니다.').waitFor();
    const clear=page.waitForResponse(r=>r.url().includes('/commands') && r.request().postDataJSON()?.command==='roulette.config.save-reviewed');
    await page.getByRole('button',{name:'룰렛 설정 저장',exact:true}).click(); assert.equal((await clear).status(),200);
    assert.equal((await read()).rouletteConfig.startsAt,null);
    for (const p of [page,guest]) {
      await p.evaluate(axeSource);
      for (const width of [320,390,1280]) {
        await p.setViewportSize({width,height:900});
        assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1),`overflow ${width}`);
        assert.deepEqual(await p.evaluate(async()=>(await window.axe.run()).violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)),[]);
      }
    }
    console.log('PASS: invalid schedule, explicit repair, participant spin, UTC/LA, preserved seconds, deliberate removal and responsive axe');
    await attendee.close(); await operator.close();
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch(error=>{console.error(String(error?.stack||error).replace(/https?:\/\/[^\s]+/g,'[url redacted]'));process.exitCode=1});
