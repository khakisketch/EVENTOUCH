'use strict';
// Real API/Postgres and staff session, synthetic people. No physical camera.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { startStalledResponseProxy } = require('./stalled-response-fixture.cjs');
let stage = 'setup';

async function confirmInitialDesk(page) {
  const panel = page.getByRole('region', { name: '데스크 업무 방향을 확인해 주세요' });
  await panel.getByText('시작하기 전에 업무 방향을 확인해 주세요.', { exact: false }).waitFor();
  const button = panel.getByRole('button', { name: /^(입장|퇴장) 업무 확인$/ });
  await button.click();
  await panel.waitFor({ state: 'hidden' });
}

// Forward the actual committed command, but keep the first successful
// collection body unfinished after its headers. This exercises the browser's
// real AbortSignal on a streaming network response, not a mocked Promise.
async function startRewardStallProxy(baseUrl) {
  const upstreamOrigin = new URL(baseUrl);
  let stall = true, opened = false, closed = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let command = '';
      try { command = JSON.parse(body.toString()).command; } catch {}
      const upstream = http.request(baseUrl + req.url, { method:req.method, headers:{...req.headers, host:upstreamOrigin.host} }, result => {
        if (!(stall && command === 'reward.collect' && result.statusCode === 200)) {
          res.writeHead(result.statusCode, result.headers); result.pipe(res); return;
        }
        stall = false; opened = true;
        const headers = {...result.headers};
        delete headers['content-length']; delete headers['content-encoding']; delete headers['transfer-encoding'];
        res.once('close', () => { closed = true; });
        res.writeHead(result.statusCode, headers); res.write('{"reward":'); result.resume();
      });
      res.on('close', () => upstream.destroy());
      upstream.on('error', () => res.destroy());
      upstream.end(body);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin:`http://127.0.0.1:${server.address().port}`, opened:()=>opened, closed:()=>closed,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function checkRewardBodyTimeout(browser, fixture, out) {
  const proxy = await startRewardStallProxy(fixture.baseUrl);
  const context = await browser.newContext({viewport:{width:390,height:844}, reducedMotion:'reduce'});
  const page = await context.newPage();
  const commands = [];
  try {
    const { database } = fixture.harness;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[fixture.eventId])).rows[0].payload;
    const workspace = await read();
    // Set up an actual entry rather than forcing the aggregate to "inside"
    // while retaining a contradictory last exit from an earlier scenario.
    const person = { ...workspace.participants[0], id: `stream-person-${crypto.randomUUID()}`,
      name: '합성 응답 지연 참가자', phone: '01077778888', status: 'APPROVED', revoked: false,
      inside: false, everIn: false, paymentStatus: 'FREE',
      ticket: `ET:${fixture.eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() };
    workspace.participants.push(person);
    workspace.desks.find(item => item.id === fixture.deskId).action = 'IN';
    const rewardId = `stream-reward-${crypto.randomUUID()}`;
    workspace.rewards.push({id:rewardId,participantId:person.id,name:'합성 응답 지연 경품',method:'ONSITE',status:'READY'});
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[fixture.eventId,JSON.stringify(workspace)]);
    const entry = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie,
      body: { commandId: crypto.randomUUID(), command: 'check.scan', payload: { deskId: fixture.deskId, ticket: person.ticket, expectedAction: 'IN' } },
    });
    assert.equal(entry.status, 200, JSON.stringify(entry.json));
    const entered = await read(); entered.desks.find(item => item.id === fixture.deskId).action = 'OUT';
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',[fixture.eventId,JSON.stringify(entered)]);
    await context.addCookies([{...cookieForContext(fixture,'staff'),url:proxy.origin}]);
    page.on('dialog', dialog => dialog.accept());
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/commands')) { const data=req.postDataJSON(); if(data?.command==='reward.collect') commands.push(data.commandId); } });
    await page.goto(`${proxy.origin}/staff/events/${fixture.eventId}`,{waitUntil:'networkidle'});
    await confirmInitialDesk(page);
    await page.locator('#staff-ticket').fill(person.ticket);
    await page.getByRole('button',{name:'퇴장 처리',exact:true}).click();
    const section = page.getByRole('region',{name:'경품 확인 및 수령',exact:true});
    const row = section.locator('li').filter({has:page.getByText('합성 응답 지연 경품',{exact:true})});
    await row.getByRole('button',{name:'수령 확인',exact:true}).click();
    await section.getByRole('alert').filter({hasText:'경품 응답을 확인하지 못했습니다'}).waitFor({timeout:22000});
    assert.equal(proxy.opened(),true,'committed response headers and partial body reached the browser');
    assert.equal((await read()).rewards.find(item=>item.id===rewardId).status,'RECEIVED');
    assert.equal(await row.getByText('수령 완료',{exact:true}).count(),0,'a stalled body never confirms handout');
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('eventouch.receipts.operator') || '[]').some(item => item.command === 'reward.collect'));
    await page.waitForTimeout(100);
    assert.equal(proxy.closed(),true,'the browser abort closes the actual stalled HTTP stream');
    await page.screenshot({path:path.join(out,'reward-body-timeout-390.png'),fullPage:true,mask:[page.locator('#reward-lookup-ticket')],maskColor:'#E6E8EC'});
    await row.getByRole('button',{name:'같은 요청으로 다시 확인',exact:true}).click();
    await section.getByText('합성 응답 지연 경품 · 수령 완료',{exact:true}).waitFor();
    assert.equal(commands.length,2); assert.equal(commands[0],commands[1]);
    assert.equal((await read()).rewards.filter(item=>item.id===rewardId && item.status==='RECEIVED').length,1);
  } finally { await context.close(); await proxy.close(); }
}

async function checkStaffReadRecovery(browser, fixture, participant, out) {
  const proxy = await startStalledResponseProxy(fixture.baseUrl, '/api/bootstrap');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const workUrl = `${proxy.origin}/staff/events/${fixture.eventId}`;
  const headers = () => page.waitForResponse(response => response.url() === proxy.origin + '/api/bootstrap' && response.status() === 200);
  const retry = page.getByRole('button', { name: '다시 불러오기', exact: true });
  const delayed = page.getByText('업무 정보 응답이 지연되고 있습니다. 다시 시도하세요.');
  const result = page.getByRole('region', { name: '스캔 결과 상세', exact: true });
  let scans = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/commands') && request.postDataJSON()?.command === 'check.scan') scans += 1;
  });
  try {
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: proxy.origin }]);
    proxy.setStalled(true);
    await Promise.all([headers(), page.goto(proxy.origin + '/staff', { waitUntil: 'domcontentloaded' })]);
    await retry.waitFor({ timeout: 11000 });
    await proxy.waitForClosed(0);
    await delayed.waitFor();
    await page.screenshot({ path: path.join(out, 'staff-hub-load-timeout-390.png') });
    proxy.setStalled(false);
    await retry.click();
    await page.waitForURL(workUrl);
    await page.locator('#staff-desk').waitFor();

    proxy.setStalled(true);
    await Promise.all([headers(), page.reload({ waitUntil: 'domcontentloaded' })]);
    await retry.waitFor({ timeout: 11000 });
    await proxy.waitForClosed(1);
    await delayed.waitFor();
    proxy.setStalled(false);
    await retry.click();
    await confirmInitialDesk(page);
    await page.locator('#staff-ticket').fill(participant.ticket);

    proxy.setStalled(true);
    const [scan] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/commands')),
      page.getByRole('button', { name: '입장 처리', exact: true }).click(),
    ]);
    assert.equal(scan.status(), 200);
    await result.waitFor({ timeout: 11000 });
    await proxy.waitForClosed(2);
    await delayed.waitFor();
    assert.ok((await result.innerText()).includes(participant.name), 'a failed refresh keeps the confirmed scan result');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(out, 'staff-confirmed-refresh-timeout-390.png') });
    proxy.setStalled(false);
    await retry.click();
    await delayed.waitFor({ state: 'hidden' });
    assert.ok(await result.isVisible(), 'refreshing leaves the last scan result on screen');
    await page.getByRole('button', { name: '다음 참가자', exact: true }).click();
    await page.locator('#staff-ticket').waitFor();
    assert.equal(scans, 1, 'assignment recovery never repeats the scan');
    console.log('Staff: stalled hub and work reads recover; confirmed scan survives a stalled refresh and retry');
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'staff-read-recovery-failure-390.png') }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    await proxy.close();
  }
}

async function checkDeskDirectionRecovery(browser, fixture, participant, readWorkspace, managerCommand, out) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const entry = page.getByRole('button', { name: '입장 처리', exact: true });
  const ticket = page.locator('#staff-ticket');
  const refresh = page.getByRole('button', { name: '데스크 상태 다시 확인', exact: true });
  const setOpen = (open) => managerCommand('desk.set-open', { id: fixture.deskId, open });
  const checksBefore = (await readWorkspace()).checks.length;
  try {
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    await setOpen(false);
    await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await page.getByText('현재 데스크는 가동 중지 상태입니다.', { exact: false }).waitFor();
    await ticket.fill(participant.ticket);
    assert.equal(await entry.isDisabled(), true, 'a stopped desk cannot start a scan');
    assert.equal(await page.getByRole('button', { name: '카메라로 스캔' }).isDisabled(), true);
    await setOpen(true);
    await refresh.click();
    await confirmInitialDesk(page);
    await page.getByText('이 데스크는 입장 처리합니다.', { exact: true }).waitFor();
    assert.equal(await ticket.inputValue(), participant.ticket);
    assert.equal(await entry.isEnabled(), true);

    await managerCommand('desk.save', { id: fixture.deskId, name: '합성 퇴장 데스크', action: 'OUT', mode: 'desk', confirmDirectionChange: true });
    await setOpen(true);
    const [stale] = await Promise.all([
      page.waitForResponse(reply => reply.request().method() === 'POST' && reply.url().endsWith('/commands')),
      entry.click(),
    ]);
    assert.equal(stale.status(), 409);
    assert.equal((await stale.json()).code, 'DESK_ACTION_CHANGED');
    await refresh.waitFor();
    assert.equal(await entry.isDisabled(), true);
    const stillInside = await readWorkspace();
    assert.equal(stillInside.checks.length, checksBefore);
    assert.equal(stillInside.participants.find(person => person.id === participant.id).inside, true);
    await page.screenshot({ path: path.join(out, 'desk-direction-changed-390.png'), mask: [ticket] });

    await refresh.click();
    const exit = page.getByRole('button', { name: '퇴장 처리', exact: true });
    await exit.waitFor();
    assert.equal(await ticket.inputValue(), participant.ticket);
    assert.equal((await readWorkspace()).checks.length, checksBefore, 'refresh does not submit the exit');
    assert.equal(await exit.isDisabled(), true, 'a changed direction stays locked until staff confirm it');
    await page.getByRole('button', { name: '퇴장 업무 확인', exact: true }).click();
    await page.getByRole('button', { name: '퇴장 업무 확인', exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await readWorkspace()).checks.length, checksBefore, 'direction confirmation never submits the exit');
    await exit.click();
    await page.getByRole('region', { name: '스캔 결과 상세' }).getByText(participant.name, { exact: false }).waitFor();
    const done = await readWorkspace();
    assert.equal(done.checks.length, checksBefore + 1);
    assert.equal(done.checks[0].action, 'OUT');
    assert.equal(done.participants.find(person => person.id === participant.id).inside, false);
    console.log('Staff: stopped desk blocks scanning; stale entry writes nothing; refreshed exit succeeds explicitly');
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'desk-direction-recovery-failure-390.png'), mask: [ticket] }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

async function checkCorrectionConflict(browser, fixture, participant, readWorkspace, managerCommand, out) {
  await managerCommand('desk.save', { id: fixture.deskId, name: '합성 입장 데스크', action: 'IN', mode: 'desk', confirmDirectionChange: true });
  await managerCommand('desk.set-open', { id: fixture.deskId, open: true });
  const { desk: exitDesk } = await managerCommand('desk.save', { name: '합성 퇴장 데스크', action: 'OUT', mode: 'desk', open: true });
  const exitAccount = `audit-exit-${fixture.suffix}`;
  await fixture.helpers.insertAccount(fixture.harness.database, {
    orgId: fixture.helpers.LEGACY_ORG, id: exitAccount, role: 'STAFF', name: '퇴장 감사 스태프', email: `${exitAccount}@example.test`,
  });
  await managerCommand('staff.assign', { accountId: exitAccount, type: 'DESK', targetId: exitDesk.id });
  const exitCookie = await fixture.helpers.sessionCookie(fixture.harness, exitAccount);
  const mobile = { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' };
  const entryContext = await browser.newContext(mobile);
  const exitContext = await browser.newContext(mobile);
  try {
    await entryContext.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    await exitContext.addCookies([{
      name: 'etko_session', value: decodeURIComponent(exitCookie.slice('etko_session='.length)),
      url: fixture.baseUrl, httpOnly: true, sameSite: 'Lax',
    }]);
    const entry = await entryContext.newPage();
    const exit = await exitContext.newPage();
    const scan = async (page, label) => {
      await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
      await confirmInitialDesk(page);
      await page.locator('#staff-ticket').fill(participant.ticket);
      await page.getByRole('button', { name: `${label} 처리`, exact: true }).click();
      await page.getByRole('region', { name: '스캔 결과 상세', exact: true }).getByText(`${participant.name} · ${label}`, { exact: true }).waitFor();
    };
    await scan(entry, '입장');
    await entry.getByLabel('정정 사유', { exact: true }).fill('다른 참가자의 티켓을 스캔했습니다');
    await scan(exit, '퇴장');
    const before = (await readWorkspace()).checks.filter(check => check.participantId === participant.id);
    assert.deepEqual(before.map(check => [check.action, check.corrected]), [['OUT', false], ['IN', false]]);
    await entry.screenshot({ path: path.join(out, 'correction-before-submit-390.png'), mask: [entry.locator('[data-ticket-full-code]')] });
    const commandPath = `/api/events/${fixture.eventId}/commands`;
    const [rejected] = await Promise.all([
      entry.waitForResponse(response => new URL(response.url()).pathname === commandPath && response.request().method() === 'POST'),
      entry.getByRole('button', { name: '최신 기록 정정', exact: true }).click(),
    ]);
    assert.equal(rejected.status(), 409);
    assert.equal((await rejected.json()).code, 'CHECK_CORRECTION_STALE');
    assert.equal(rejected.request().postDataJSON().payload.id, before[1].id);
    const verdict = entry.getByRole('alert').filter({ hasText: '출입 기록이 바뀌어 이 요청은 중단했습니다' });
    await verdict.waitFor();
    await entry.waitForFunction(() => document.activeElement?.textContent?.includes('이 요청은 중단했습니다'));
    assert.equal(await entry.getByRole('region', { name: '기록 정정', exact: true }).count(), 0);
    assert.equal(await entry.getByRole('button', { name: '네임택 인쇄', exact: true }).count(), 0);
    assert.deepEqual((await readWorkspace()).checks.filter(check => check.participantId === participant.id), before);
    await entry.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await entry.setViewportSize({ width, height: 844 });
      assert.ok(await entry.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await entry.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
      if (width === 390) {
        await verdict.scrollIntoViewIfNeeded();
        await entry.screenshot({ path: path.join(out, 'correction-conflict-390.png'), mask: [entry.locator('[data-ticket-full-code]')] });
      }
    }
    await entry.getByRole('button', { name: '다음 참가자', exact: true }).click();
    assert.equal(await entry.locator('#staff-ticket').inputValue(), '');
    await exit.getByLabel('정정 사유', { exact: true }).fill('퇴장 처리 위치를 잘못 확인했습니다');
    await exit.getByRole('button', { name: '최신 기록 정정', exact: true }).click();
    await exit.getByRole('status').filter({ hasText: '기록을 정정했습니다' }).waitFor();
    const after = await readWorkspace();
    assert.deepEqual(after.checks.filter(check => check.participantId === participant.id).map(check => [check.action, check.corrected]), [['OUT', true], ['IN', false]]);
    assert.equal(after.participants.find(person => person.id === participant.id).inside, true);
    console.log('Staff: two desks preserve the newer record and the authorized latest correction still succeeds');
  } finally {
    await exitContext.close();
    await entryContext.close();
  }
}

// Unlike an upstream 403, these two executor verdicts can only be returned
// after the event lock and receipt lookup. A prior committed scan is replayed
// first, so the same request's rejection proves that it did not check in.
async function checkUncertainDeskConflict(browser, fixture, people, readWorkspace, managerCommand, out) {
  for (const [index, verdict] of ['DESK_CLOSED', 'DESK_ACTION_CHANGED'].entries()) {
    await managerCommand('desk.save', { id: fixture.deskId, name: '합성 입장 데스크', action: 'IN', mode: 'desk', confirmDirectionChange: true });
    await managerCommand('desk.set-open', { id: fixture.deskId, open: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    try {
      await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
      const page = await context.newPage();
      const commandUrl = `${fixture.baseUrl}/api/events/${fixture.eventId}/commands`;
      const scans = [];
      await page.route(commandUrl, async (route) => {
        const body = route.request().postDataJSON();
        if (body.command === 'check.scan') {
          scans.push(body);
          // The network fails before the request reaches the server.
          if (scans.length === 1) return route.abort('failed');
        }
        return route.continue();
      });
      await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
      await confirmInitialDesk(page);
      const ticket = page.locator('#staff-ticket');
      await ticket.fill(people[index].ticket);
      await page.getByRole('button', { name: '입장 처리', exact: true }).click();
      const unknown = page.getByRole('region', { name: '스캔 결과 미확인', exact: true });
      await unknown.waitFor();
      if (verdict === 'DESK_CLOSED') {
        await managerCommand('desk.set-open', { id: fixture.deskId, open: false });
      } else {
        await managerCommand('desk.save', { id: fixture.deskId, name: '합성 퇴장 데스크', action: 'OUT', mode: 'desk', confirmDirectionChange: true });
        await managerCommand('desk.set-open', { id: fixture.deskId, open: true });
      }
      const [response] = await Promise.all([
        page.waitForResponse(reply => reply.request().method() === 'POST' && reply.url() === commandUrl),
        unknown.getByRole('button', { name: '같은 요청 재확인', exact: true }).click(),
      ]);
      assert.equal(response.status(), 409);
      assert.equal((await response.json()).code, verdict);
      assert.deepEqual(scans[1], scans[0], 'the exact frozen request must be retried');
      const failure = page.getByRole('region', { name: '스캔 실패', exact: true });
      const refresh = failure.getByRole('button', { name: '데스크 상태 다시 확인', exact: true });
      await refresh.waitFor();
      assert.equal(await unknown.count(), 0, 'a definite desk verdict settles the unknown state');
      assert.equal(await ticket.inputValue(), people[index].ticket, 'recovery preserves the scanned ticket');
      const before = await readWorkspace();
      assert.equal(before.checks.filter(check => check.id === scans[0].commandId).length, 0);
      const receipts = await fixture.harness.database.query('SELECT count(*)::int AS count FROM command_receipts WHERE command_id=$1', [scans[0].commandId]);
      assert.equal(receipts.rows[0].count, 0);
      await page.evaluate(axeSource);
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, `uncertain-${verdict.toLowerCase()}-390.png`), mask: [ticket, page.locator('[data-ticket-full-code]')], fullPage: true });
      await refresh.click();
      assert.equal((await readWorkspace()).checks.length, before.checks.length, 'refreshing must not process a scan');
      assert.equal(await ticket.inputValue(), people[index].ticket);
      if (verdict === 'DESK_CLOSED') {
        await page.getByText('가동 중지된 데스크입니다.', { exact: false }).waitFor();
        await managerCommand('desk.set-open', { id: fixture.deskId, open: true });
        await page.getByRole('button', { name: '데스크 상태 다시 확인', exact: true }).click();
        await page.getByText('이 데스크는 입장 처리합니다.', { exact: true }).waitFor();
        await page.getByRole('button', { name: '입장 처리', exact: true }).click();
      } else {
        await page.getByRole('button', { name: '퇴장 업무 확인', exact: true }).click();
        await page.getByText('이 데스크는 퇴장 처리합니다.', { exact: true }).waitFor();
        // This person enters at another desk before the now-OUT desk can
        // explicitly handle their exit; refresh itself performs no write.
        const { desk } = await managerCommand('desk.save', { name: '두 번째 합성 입장 데스크', action: 'IN', mode: 'desk', open: true });
        await managerCommand('check.scan', { deskId: desk.id, expectedAction: 'IN', ticket: people[index].ticket });
        await page.getByRole('button', { name: '퇴장 처리', exact: true }).click();
      }
      await page.getByRole('region', { name: '스캔 결과 상세', exact: true }).getByText(people[index].name, { exact: false }).waitFor();
      const after = await readWorkspace();
      assert.equal(after.checks.length, before.checks.length + (verdict === 'DESK_CLOSED' ? 1 : 2));
      assert.notEqual(scans[2].commandId, scans[0].commandId, 'a new explicit scan gets a new command id');
    } finally {
      await context.close();
    }
  }
  console.log('Staff: uncertain scan + definite desk conflict preserves ticket, refreshes and permits one explicit new scan');
}

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'staff-recovery');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const { database } = fixture.harness;
    const readWorkspace = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const persons = (await readWorkspace()).participants.slice(0, 4);
    const assignment = (await database.query('SELECT id FROM staff_assignments WHERE event_id=$1 AND account_id=$2 AND active=true', [fixture.eventId, fixture.staff.id])).rows[0].id;
    const managerCommand = async (command, payload) => {
      const result = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        cookie: fixture.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.json)); return result.json;
    };
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let scanMode = 'lost', correctionMode = 'malformed', rewardMode = 'malformed';
    const scans = [], corrections = [], rewards = [];
    let acceptDialogs = true; const dialogMessages = [];
    page.on('dialog', dialog => { dialogMessages.push(dialog.message()); return acceptDialogs ? dialog.accept() : dialog.dismiss(); });
    await page.route('**/api/events/*/commands', async route => {
      let body; try { body = route.request().postDataJSON(); } catch { return route.continue(); }
      if (body.command === 'check.scan') {
        scans.push(body.commandId);
        if (scanMode === 'lost') { scanMode = 'rejected'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
        if (scanMode === 'rejected') { scanMode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"배정을 확인하세요"}' }); }
        if (scanMode === 'revoke') {
          scanMode = 'pass'; const response = await route.fetch(); assert.equal(response.status(), 200);
          await database.query('UPDATE staff_assignments SET active=false WHERE id=$1', [assignment]);
          return route.fulfill({ response });
        }
      }
      if (body.command === 'check.correct') {
        corrections.push(body.commandId);
        if (correctionMode === 'malformed') { correctionMode = 'rejected'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' }); }
        if (correctionMode === 'rejected') { correctionMode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"배정을 확인하세요"}' }); }
      }
      if (body.command === 'reward.collect') {
        rewards.push(body.commandId);
        if (rewardMode === 'malformed') { rewardMode = 'rejected'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' }); }
        if (rewardMode === 'rejected') { rewardMode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"배정을 확인하세요"}' }); }
        if (rewardMode === 'lost-new') { rewardMode = 'pass'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
        if (rewardMode === 'wrong-person') { rewardMode = 'pass'; const response = await route.fetch(); const result = await response.json(); result.reward.participantId = 'synthetic-unrelated'; return route.fulfill({ response, json: result }); }
      }
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`, { waitUntil: 'networkidle' });
    await page.locator('#staff-desk').waitFor();
    await confirmInitialDesk(page);
    stage = 'scan lost response and later rejection';
    await page.locator('#staff-ticket').fill(persons[0].ticket);
    await page.getByRole('button', { name: '입장 처리', exact: true }).click();
    const unknown = page.getByRole('region', { name: '스캔 결과 미확인', exact: true });
    await unknown.waitFor();
    assert.equal((await readWorkspace()).checks.length, 1);
    const inlineScanReceipt = unknown.getByRole('group', { name: '현재 요청 서버 확인' });
    await inlineScanReceipt.getByRole('button', { name: '서버 처리 확인', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: '처리 결과 확인', exact: true }).count(), 0, 'the current scan must not also appear in the shared panel');
    const peer = await context.newPage();
    await peer.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await peer.getByRole('region', { name: '처리 결과 확인', exact: true }).getByRole('button', { name: '서버 처리 확인', exact: true }).waitFor();
    assert.equal(await peer.locator('#staff-ticket').isDisabled(), true, 'another tab retains the shared receipt and locks a new scan');
    await peer.close();
    await page.screenshot({ path: path.join(out, 'scan-unconfirmed-390.png'), fullPage: true });
    await unknown.getByRole('button', { name: '같은 요청 재확인', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '처리 응답을 확인하지 못했습니다' }).waitFor();
    assert.equal(await unknown.isVisible(), true, 'a later 403 does not discard the unresolved scan');
    assert.equal(await page.locator('#staff-desk').isDisabled(), true);
    await unknown.getByRole('button', { name: '같은 요청 재확인', exact: true }).click();
    await page.getByRole('region', { name: '스캔 결과 상세', exact: true }).getByText(persons[0].name, { exact: false }).waitFor();
    assert.equal(scans[0], scans[1]); assert.equal(scans[1], scans[2]);
    assert.equal((await readWorkspace()).checks.length, 1, 'retry never creates another check-in');
    stage = 'correction response validation';
    await page.locator('#correct-reason').fill('합성 검증 정정');
    acceptDialogs = false;
    await page.getByRole('link', { name: '← 내 업무' }).click();
    assert.ok(dialogMessages.some((message) => message.includes('입력 중인 내용이 있습니다')));
    assert.equal(await page.locator('#correct-reason').inputValue(), '합성 검증 정정');
    acceptDialogs = true;
    await page.getByRole('button', { name: '최신 기록 정정', exact: true }).click();
    const correction = page.getByRole('region', { name: '기록 정정', exact: true });
    await correction.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).waitFor();
    assert.equal(await page.locator('#correct-reason').isDisabled(), true);
    assert.equal((await readWorkspace()).checks[0].corrected, true);
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('eventouch.receipts.operator') || '[]').some(item => item.command === 'check.correct'));
    const correctionPointer = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.equal(correctionPointer.includes('합성 검증 정정'), false, 'correction text is never persisted');
    assert.equal(correctionPointer.includes(persons[0].ticket), false, 'ticket is never persisted with the pointer');
    await correction.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).click();
    await correction.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).waitFor();
    await correction.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).click();
    await page.getByText('기록을 정정했습니다. 현재 입장 상태에 반영되었습니다.').waitFor();
    assert.equal(corrections[0], corrections[1]); assert.equal(corrections[1], corrections[2]);
    assert.equal((await readWorkspace()).checks.length, 1, 'correction replay keeps one record');
    stage = 'assignment removed during successful scan';
    scanMode = 'revoke';
    await page.locator('#staff-ticket').fill(persons[1].ticket);
    await page.getByRole('button', { name: '입장 처리', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '업무 배정을 확인할 수 없습니다' }).waitFor();
    assert.match(await page.getByRole('region', { name: '스캔 결과 상세', exact: true }).innerText(), new RegExp(persons[1].name));
    assert.equal(await page.getByRole('button', { name: '다음 참가자', exact: true }).isDisabled(), true);
    await page.screenshot({ path: path.join(out, 'assignment-removed-390.png'), fullPage: true });
    await managerCommand('staff.assign', { accountId: fixture.staff.id, type: 'DESK', targetId: fixture.deskId });
    await page.getByRole('button', { name: '배정 다시 확인', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '업무 배정을 확인할 수 없습니다' }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '다음 참가자', exact: true }).isEnabled(), true);
    assert.match(await page.getByRole('region', { name: '스캔 결과 상세', exact: true }).innerText(), new RegExp(persons[1].name));
    stage = 'reward receipt ambiguity';
    const extraReward = async (name, method = 'ONSITE') => (await managerCommand('reward.create', {
      participantId: persons[1].id, name, method,
    })).reward;
    const otherDeskReward = await extraReward('다른 데스크 수령');
    const cancelledReward = await extraReward('운영자 취소 경품');
    const refreshReward = await extraReward('최신 상태 확인 경품');
    const identityReward = await extraReward('현장 신원 확인 경품');
    const wrongPersonReward = await extraReward('다른 대상 응답 확인 경품');
    const abandonedReward = await extraReward('내역 확인 필요한 경품');
    const gift = await extraReward('합성 모의 기프티콘', 'GIFT');
    const updated = await readWorkspace();
    updated.desks.find(item => item.id === fixture.deskId).action = 'OUT';
    updated.rewards.push({ id: 'synthetic-reward', participantId: persons[1].id, name: '합성 경품', method: 'ONSITE', status: 'READY', at: '2026-10-01T00:00:00Z' });
    updated.rewards.push({ id: 'synthetic-reward-two', participantId: persons[1].id, name: '두 번째 합성 경품', method: 'ONSITE', status: 'READY', at: '2026-10-01T00:00:00Z' });
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(updated)]);
    await page.reload({ waitUntil: 'networkidle' });
    await confirmInitialDesk(page);
    await page.locator('#staff-ticket').fill(persons[1].ticket);
    await page.getByRole('button', { name: '퇴장 처리', exact: true }).click();
    const rewardSection = page.getByRole('region', { name: '경품 확인 및 수령', exact: true });
    await page.locator('#correct-reason').fill('유지할 합성 정정 사유');
    const firstReward = rewardSection.locator('li').filter({ has: page.getByText('합성 경품', { exact: true }) });
    await firstReward.getByRole('button', { name: '수령 확인', exact: true }).click();
    await rewardSection.getByRole('alert').filter({ hasText: '수령 결과를 확인하지 못했습니다' }).waitFor();
    assert.equal(await page.locator('#staff-desk').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '다음 참가자', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '최신 기록 정정', exact: true }).isDisabled(), true);
    const secondReward = rewardSection.locator('li').filter({ has: page.getByText('두 번째 합성 경품', { exact: true }) });
    assert.equal(await secondReward.getByRole('button', { name: '수령 확인', exact: true }).isDisabled(), true);
    assert.equal((await readWorkspace()).rewards.find(item => item.id === 'synthetic-reward').status, 'RECEIVED');
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('eventouch.receipts.operator') || '[]').some(item => item.command === 'reward.collect'));
    await rewardSection.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true }).click();
    await rewardSection.getByRole('alert').filter({ hasText: '이전 경품 요청의 처리 여부' }).waitFor();
    await rewardSection.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true }).click();
    await rewardSection.getByText('합성 경품 · 수령 완료', { exact: true }).waitFor();
    assert.equal(rewards[0], rewards[1]); assert.equal(rewards[1], rewards[2]);
    stage = 'status-only reward check retains the original handout until its target is confirmed';
    rewardMode = 'lost-new';
    await secondReward.getByRole('button', { name: '수령 확인', exact: true }).click();
    await page.getByText('경품 수령 결과를 확인할 때까지 다른 현장 업무를 잠급니다.', { exact: false }).waitFor();
    await rewardSection.getByText('같은 요청을 다시 확인하거나 위에서 서버 처리를 확인하세요.', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(out, 'reward-uncertain-390.png'), fullPage: true });
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    const beforeStatus = rewards.length;
    let receiptPanel = page.getByRole('region', { name: '처리 결과 확인' });
    await receiptPanel.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await page.getByText('경품 대상을 확인하려면 아래에서 같은 요청을 다시 확인하세요.', { exact: true }).waitFor();
    assert.equal(await page.locator('#staff-desk').isDisabled(), true);
    assert.equal(rewards.length, beforeStatus, 'status check never repeats the collection');
    assert.equal(await receiptPanel.getByRole('button', { name: '서버 처리 확인', exact: true }).count(), 1, 'status alone must retain the target pointer');
    assert.equal((await readWorkspace()).rewards.find(item => item.id === 'synthetic-reward-two').status, 'RECEIVED');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
      if (width === 390) await page.screenshot({ path: path.join(out, 'reward-status-recovery-390.png'), fullPage: true, mask: [page.locator('#reward-lookup-ticket')], maskColor: '#E6E8EC' });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await secondReward.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true }).focus();
    await page.keyboard.press('Enter');
    await rewardSection.getByText('두 번째 합성 경품 · 수령 완료', { exact: true }).waitFor();
    assert.equal(rewards.length, beforeStatus + 1, 'only an explicit replay checks the frozen target');
    assert.equal(rewards[rewards.length - 1], rewards[rewards.length - 2], 'replay uses the original command id');
    await page.waitForFunction(() => !document.querySelector('#staff-desk')?.disabled);
    stage = 'stale reward lists reconcile without another handout';
    const rewardRow = (name) => rewardSection.locator('li').filter({ has: page.getByText(name, { exact: true }) });
    const otherRow = rewardRow(otherDeskReward.name);
    await otherRow.getByText('수령 대기', { exact: true }).waitFor();
    const priorHandout = (await managerCommand('reward.fulfill', { id: otherDeskReward.id })).reward;
    await otherRow.getByRole('button', { name: '수령 확인', exact: true }).click();
    await otherRow.getByRole('alert').filter({ hasText: '이미 수령 완료된 경품입니다.' }).waitFor();
    await otherRow.getByText('수령 완료', { exact: true }).waitFor();
    assert.equal(await otherRow.getByRole('button', { name: '수령 확인', exact: true }).count(), 0);
    await otherRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'reward-other-desk-390.png'), mask: [page.locator('#reward-lookup-ticket')], maskColor: '#E6E8EC' });
    assert.deepEqual((await readWorkspace()).rewards.find(item => item.id === otherDeskReward.id).claim, priorHandout.claim);
    assert.ok(dialogMessages.some(message => message.includes('수령 완료를 확인한 뒤 경품을 전달하세요')));
    const cancelledRow = rewardRow(cancelledReward.name);
    await cancelledRow.getByText('수령 대기', { exact: true }).waitFor();
    await managerCommand('reward.cancel', { id: cancelledReward.id });
    await cancelledRow.getByRole('button', { name: '수령 확인', exact: true }).click();
    await cancelledRow.getByText('취소', { exact: true }).waitFor();
    await cancelledRow.getByRole('alert').filter({ hasText: '취소된 경품입니다.' }).waitFor();
    assert.equal(await cancelledRow.getByRole('button', { name: '수령 확인', exact: true }).count(), 0);
    const giftRow = rewardRow(gift.name);
    await giftRow.getByText('기프티콘 · 운영자 확인', { exact: true }).waitFor();
    assert.equal(await giftRow.getByRole('button').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await giftRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'reward-reconciled-390.png'), mask: [page.locator('#reward-lookup-ticket')], maskColor: '#E6E8EC' });

    stage = 'reward refresh locks handout and reads current state after a lost reply';
    const refreshRow = rewardRow(refreshReward.name);
    const refreshCollect = refreshRow.getByRole('button', { name: '수령 확인', exact: true });
    const refreshRewards = rewardSection.getByRole('button', { name: '경품 다시 확인', exact: true });
    let finishLookup, holdLookup;
    const snapshotReady = new Promise(resolve => { holdLookup = resolve; });
    const lookupReleased = new Promise(resolve => { finishLookup = resolve; });
    const lookupIds = [];
    const lookupFault = async (route) => {
      const body = route.request().postDataJSON();
      if (body.command !== 'reward.lookup') return route.fallback();
      lookupIds.push(body.commandId);
      if (lookupIds.length !== 1) return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).rewards.find(item => item.id === refreshReward.id).status, 'READY');
      holdLookup();
      await lookupReleased;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    };
    await page.route('**/api/events/*/commands', lookupFault);
    const collectionsBeforeRefresh = rewards.length;
    await refreshRewards.click();
    await snapshotReady;
    assert.equal(await refreshCollect.isDisabled(), true);
    assert.equal(await page.locator('#reward-lookup-ticket').isDisabled(), true);
    await managerCommand('reward.cancel', { id: refreshReward.id });
    finishLookup();
    await rewardSection.getByRole('alert').filter({ hasText: '최신 경품 상태를 확인하지 못했습니다' }).waitFor();
    assert.equal(await refreshCollect.isDisabled(), true);
    await refreshRow.getByText('이전 조회 · 수령 대기', { exact: true }).waitFor();
    const dimensions = await refreshRewards.boundingBox();
    assert.ok(dimensions && dimensions.height >= 44);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await refreshRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'reward-refresh-locked-390.png'), mask: [page.locator('#reward-lookup-ticket')], maskColor: '#E6E8EC' });
    await refreshRewards.click();
    await refreshRow.getByText('취소', { exact: true }).waitFor();
    assert.equal(lookupIds.length, 3);
    assert.equal(lookupIds[0], lookupIds[1]);
    assert.notEqual(lookupIds[1], lookupIds[2]);
    assert.equal(rewards.length, collectionsBeforeRefresh);
    await page.unroute('**/api/events/*/commands', lookupFault);

    stage = 'a partial reward row never becomes an empty or complete list';
    const partialIds = [];
    const partialFault = async (route) => {
      const body = route.request().postDataJSON();
      if (body.command !== 'reward.lookup') return route.fallback();
      partialIds.push(body.commandId);
      if (partialIds.length !== 1) return route.continue();
      const response = await route.fetch();
      const result = await response.json();
      assert.ok(result.rewards.length > 0);
      delete result.rewards[0].name;
      return route.fulfill({ response, json: result });
    };
    await page.route('**/api/events/*/commands', partialFault);
    await refreshRewards.click();
    await rewardSection.getByRole('alert').filter({ hasText: '경품 조회 응답을 확인하지 못했습니다' }).waitFor();
    assert.equal(await rewardSection.getByText('이 참가자에게 등록된 경품이 없습니다.').count(), 0);
    assert.equal(await rewardRow(identityReward.name).getByRole('button', { name: '수령 확인' }).isDisabled(), true);
    await refreshRewards.click();
    await rewardRow(identityReward.name).getByText('수령 대기', { exact: true }).waitFor();
    assert.equal(partialIds.length, 3, 'the same receipt is replayed before a fresh lookup');
    assert.equal(partialIds[0], partialIds[1]);
    assert.notEqual(partialIds[1], partialIds[2]);
    await page.unroute('**/api/events/*/commands', partialFault);

    stage = 'an unresolved lookup can be explicitly abandoned and retried as a new lookup';
    let partialOnce = true;
    const abandonedLookupIds = [];
    const abandonLookupFault = async (route) => {
      const body = route.request().postDataJSON();
      if (body.command !== 'reward.lookup') return route.fallback();
      abandonedLookupIds.push(body.commandId);
      if (!partialOnce) return route.continue();
      partialOnce = false;
      const response = await route.fetch(); const result = await response.json();
      delete result.rewards[0].name;
      return route.fulfill({ response, json: result });
    };
    await page.route('**/api/events/*/commands', abandonLookupFault);
    await refreshRewards.click();
    await rewardSection.getByRole('alert').filter({ hasText: '경품 조회 응답을 확인하지 못했습니다' }).waitFor();
    await rewardSection.getByRole('button', { name: '이전 조회 확인 중단', exact: true }).click();
    await rewardSection.getByText('이전 조회 확인을 중단했습니다.', { exact: false }).waitFor();
    await refreshRewards.click();
    await rewardRow(identityReward.name).getByText('수령 대기', { exact: true }).waitFor();
    assert.equal(abandonedLookupIds.length, 2);
    assert.notEqual(abandonedLookupIds[0], abandonedLookupIds[1], 'a stopped read starts a new explicit lookup');
    await page.unroute('**/api/events/*/commands', abandonLookupFault);

    stage = 'a wrong-person handout response retains the same request';
    const wrongPersonRow = rewardRow(wrongPersonReward.name);
    rewardMode = 'wrong-person';
    await wrongPersonRow.getByRole('button', { name: '수령 확인', exact: true }).click();
    await rewardSection.getByRole('alert').filter({ hasText: '수령 결과를 확인하지 못했습니다' }).waitFor();
    assert.equal((await readWorkspace()).rewards.find(item => item.id === wrongPersonReward.id).status, 'RECEIVED');
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('eventouch.receipts.operator') || '[]').some(item => item.command === 'reward.collect'));
    const beforeReplay = rewards.length;
    await wrongPersonRow.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true }).click();
    await rewardSection.getByText('다른 대상 응답 확인 경품 · 수령 완료', { exact: true }).waitFor();
    assert.equal(rewards.length, beforeReplay + 1);
    assert.equal(rewards[rewards.length - 1], rewards[rewards.length - 2]);

    stage = 'stopping unresolved handout requires an explicit warning and leaves status stale';
    const abandonedRow = rewardRow(abandonedReward.name);
    rewardMode = 'wrong-person';
    await abandonedRow.getByRole('button', { name: '수령 확인', exact: true }).click();
    await rewardSection.getByRole('alert').filter({ hasText: '수령 결과를 확인하지 못했습니다' }).waitFor();
    const stop = page.getByRole('button', { name: '확인 중단하고 내역 확인', exact: true });
    acceptDialogs = false;
    await stop.click();
    assert.equal(await stop.isVisible(), true, 'cancelled confirmation retains the unresolved request');
    assert.equal(await page.locator('#staff-desk').isDisabled(), true);
    acceptDialogs = true;
    await stop.click();
    assert.ok(dialogMessages.some(message => message.includes('이미 처리된 경품 수령은 취소되지 않습니다')));
    await rewardSection.getByRole('alert').filter({ hasText: '이미 처리됐을 수 있으니 운영자에게 경품 내역을 확인하세요' }).waitFor();
    assert.equal(await abandonedRow.getByText('이전 조회 · 수령 대기', { exact: true }).count(), 1);
    assert.equal(await abandonedRow.getByRole('button', { name: '수령 확인', exact: true }).isDisabled(), true);
    await refreshRewards.click();
    await abandonedRow.getByText('수령 완료', { exact: true }).waitFor();
    assert.equal(await abandonedRow.getByRole('button', { name: '수령 확인', exact: true }).count(), 0);

    stage = 'reward verification rejects a reissued ticket and a closed desk';
    const identityRow = rewardRow(identityReward.name);
    const identityCollect = identityRow.getByRole('button', { name: '수령 확인', exact: true });
    const rewardTicket = page.locator('#reward-lookup-ticket');
    const lookupTicket = () => rewardSection.getByRole('button', { name: '경품 조회', exact: true }).click();
    const currentTicket = (await managerCommand('ticket.reissue', { id: persons[1].id })).participant.ticket;
    await identityCollect.click();
    const ticketChanged = rewardSection.getByRole('alert').filter({ hasText: '현재 티켓으로 경품을 다시 확인하세요' });
    await ticketChanged.waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'reward-lookup-ticket');
    assert.equal(await rewardTicket.inputValue(), '');
    assert.equal(await identityCollect.count(), 0);
    await ticketChanged.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'reward-ticket-changed-390.png'), mask: [rewardTicket], maskColor: '#E6E8EC' });
    await rewardTicket.fill(currentTicket);
    await lookupTicket();
    await identityCollect.waitFor();
    await managerCommand('desk.set-open', { id: fixture.deskId, open: false });
    await identityCollect.click();
    await page.getByRole('alert').filter({ hasText: '가동 중인 퇴장 데스크에서만 경품을 처리할 수 있습니다' }).waitFor();
    assert.equal((await readWorkspace()).rewards.find(item => item.id === identityReward.id).status, 'READY');
    await managerCommand('desk.set-open', { id: fixture.deskId, open: true });
    await page.getByRole('button', { name: '데스크 상태 다시 확인', exact: true }).click();
    await lookupTicket();
    await identityCollect.click();
    await identityRow.getByText('수령 완료', { exact: true }).waitFor();
    assert.equal((await readWorkspace()).rewards.find(item => item.id === identityReward.id).status, 'RECEIVED');
    stage = 'status-only scan check reconciles and reload locks new scans';
    const scanWorkspace = await readWorkspace();
    for (const person of scanWorkspace.participants.filter(item => [persons[2].id, persons[3].id].includes(item.id))) { person.inside = true; person.everIn = true; }
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(scanWorkspace)]);
    acceptDialogs = false;
    await page.getByRole('button', { name: '다음 참가자', exact: true }).click();
    assert.equal(await page.locator('#correct-reason').inputValue(), '유지할 합성 정정 사유');
    acceptDialogs = true;
    await page.getByRole('button', { name: '다음 참가자', exact: true }).click();
    scanMode = 'lost'; await page.locator('#staff-ticket').fill(persons[2].ticket);
    await page.getByRole('button', { name: '퇴장 처리', exact: true }).click();
    await page.getByRole('region', { name: '스캔 결과 미확인', exact: true }).waitFor();
    const beforeScanStatus = scans.length;
    receiptPanel = page.getByRole('region', { name: '스캔 결과 미확인', exact: true }).getByRole('group', { name: '현재 요청 서버 확인' });
    let failScanRefresh = true;
    const scanRefreshFault = async (route) => {
      if (failScanRefresh) { failScanRefresh = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    };
    await page.route('**/api/bootstrap', scanRefreshFault);
    await receiptPanel.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await page.getByText('최신 업무 정보를 불러온 뒤 다시 진행할 수 있습니다.', { exact: false }).waitFor();
    assert.equal(await page.locator('#staff-desk').isDisabled(), true, 'failed reconciliation must lock further work');
    await page.getByRole('button', { name: '업무 정보 다시 확인' }).click();
    await page.getByText('서버 처리를 확인했습니다. 최신 현장 기록을 확인하세요.').waitFor();
    await page.unroute('**/api/bootstrap', scanRefreshFault);
    assert.equal(scans.length, beforeScanStatus);
    await page.locator('#staff-ticket').fill(persons[3].ticket);
    scanMode = 'lost'; await page.getByRole('button', { name: '퇴장 처리', exact: true }).click();
    await page.getByRole('region', { name: '스캔 결과 미확인', exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#staff-ticket').waitFor();
    assert.equal(await page.locator('#staff-ticket').isDisabled(), true);
    receiptPanel = page.getByRole('region', { name: '처리 결과 확인' });
    const beforeReloadStatus = scans.length;
    await receiptPanel.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#staff-ticket')?.disabled);
    assert.equal(scans.length, beforeReloadStatus);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    stage = 'staff work recovery after a stalled bootstrap body';
    await managerCommand('desk.save', { id: fixture.deskId, name: '합성 입장 데스크', action: 'IN', mode: 'desk', confirmDirectionChange: true });
    await managerCommand('desk.set-open', { id: fixture.deskId, open: true });
    const checksBeforeReadRecovery = (await readWorkspace()).checks.length;
    await checkStaffReadRecovery(browser, fixture, persons[0], out);
    assert.equal((await readWorkspace()).checks.length, checksBeforeReadRecovery + 1);
    stage = 'desk status and stale direction recovery';
    await checkDeskDirectionRecovery(browser, fixture, persons[0], readWorkspace, managerCommand, out);
    stage = 'staff correction conflict across two desks';
    const conflictParticipant = (await readWorkspace()).participants[4];
    await checkCorrectionConflict(browser, fixture, conflictParticipant, readWorkspace, managerCommand, out);
    stage = 'unconfirmed scan followed by definite desk conflict';
    await checkUncertainDeskConflict(browser, fixture, (await readWorkspace()).participants.slice(5, 7), readWorkspace, managerCommand, out);
    stage = 'committed reward response body times out and can replay';
    await checkRewardBodyTimeout(browser, fixture, out);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', realApi: true, simulatedResponseLoss: true, malformedCorrectionAndReward: true, preservedSameIds: true, revokedAssignmentLock: true, lastResultPreserved: true, statusOnlyReconciles: true, failedRefreshLocksAndRecovers: 'scan receipt status reconciliation 503 then explicit refresh', rewardStatusOnlyRetainsTarget: true, partialRewardRejected: true, explicitLookupAndHandoutAbandon: true, wrongParticipantResponseRejected: true, stalledRewardBodyClosed: true, rewardConflictReconciles: true, giftHandoutHidden: true, rewardRefreshRequiresFreshSnapshot: true, rewardTicketAndDeskRevalidated: true, reloadLocksNewScans: true, draftLeaveProtected: true, stalledBootstrapStreamsClosed: 3, persistedReadRecoveryScans: 1, stoppedDeskBlocksScan: true, staleDirectionWrites: 0, refreshedExitWrites: 1, staleCorrectionWrites: 0, latestCorrectionWrites: 1 }, null, 2), { mode: 0o600 });
    console.log('Staff: scan/correction ambiguity, same-id recovery and revoked assignment passed');
  } catch (error) { if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { if (browser) await browser.close(); await fixture.close(); }
}
main().catch(error => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
