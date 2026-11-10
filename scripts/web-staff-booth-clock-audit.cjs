'use strict';
// A real server and isolated synthetic event exercise a booth's time boundary.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'staff-booth-clock'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { database } = fixture.harness;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    let workspace = await read();
    const person = workspace.participants.find(item => item.status === 'APPROVED' && item.ticket);
    assert.ok(person);
    Object.assign(person, { inside: true, everIn: true, paymentStatus: 'FREE', revoked: false, ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() });
    workspace.stampMode = 'STAFF'; workspace.visits = [];
    workspace.booths = [{ id: 'clock-booth', name: '합성 시간 부스', zone: '동관', status: 'OPEN', startsAt: new Date(Date.now() + 3600000).toISOString(), endsAt: '', capacity: 0, limit: 2, used: 0 }];
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    await fixture.helpers.insertAssignment(database, { id: 'clock-assignment', accountId: fixture.staff.id, eventId: fixture.eventId, type: 'BOOTH', targetId: 'clock-booth' });
    const url = `${fixture.baseUrl}/api/events/${fixture.eventId}/commands`;
    const command = async (cookie, name, payload, assignmentId) => fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: crypto.randomUUID(), command: name, assignmentId, payload }) });
    assert.equal((await command(fixture.manager.cookie, 'event.features', { features: ['stamp'] })).status, 200);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await page.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click();
    const select = page.locator('#staff-booth');
    const option = select.locator('option[value="clock-booth"]');
    await option.waitFor({ state: 'attached' });
    workspace = await read();
    const start = Date.now() + 15000, end = start + 35000;
    workspace.booths[0].startsAt = new Date(start).toISOString();
    workspace.booths[0].endsAt = new Date(end).toISOString();
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    await page.getByRole('button', { name: '부스 상태 다시 확인', exact: true }).click();
    assert.equal(await option.isDisabled(), true);
    assert.match(await option.textContent(), /운영 예정/);
    assert.equal((await command(fixture.staff.cookie, 'booth.visit', { boothId: 'clock-booth', ticket: person.ticket }, 'clock-assignment')).status, 409);
    await page.screenshot({ path: path.join(out, 'before-start-390.png'), fullPage: true });
    await page.waitForFunction(() => {
      const option = document.querySelector('#staff-booth option[value="clock-booth"]');
      return option && !option.disabled && !option.textContent.includes('인증 시 시간 확인');
    }, null, { timeout: 25000 });
    assert.ok(Date.now() >= start, 'a definite operating state follows the real server boundary');
    await select.selectOption('clock-booth');
    await page.locator('#staff-ticket').fill(person.ticket);
    await page.locator('form').filter({ has: page.locator('#staff-ticket') }).getByRole('button', { name: '부스 인증', exact: true }).click();
    await page.getByRole('button', { name: '다음 참가자', exact: true }).waitFor();
    assert.equal((await read()).visits.length, 1, 'successful staff action is saved once');
    await page.getByRole('button', { name: '다음 참가자', exact: true }).click();
    const ticket = page.locator('#staff-ticket');
    await ticket.fill('합성 입력 보존');
    await ticket.focus();
    // A second staff screen commits just before closing; hold only its HTTP
    // response so the UI crosses the boundary with a real request in flight.
    const pendingContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await pendingContext.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    const pendingPage = await pendingContext.newPage();
    pendingPage.setDefaultTimeout(12000);
    await pendingPage.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await pendingPage.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click();
    await pendingPage.locator('#staff-booth').selectOption('clock-booth');
    await pendingPage.locator('#staff-ticket').fill(person.ticket);
    const cameraContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await cameraContext.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    await cameraContext.addInitScript(() => {
      window.__cameraCalls = 0;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        window.__cameraCalls++;
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
        window.__clockCamera = canvas.captureStream(8);
        return window.__clockCamera;
      } });
    });
    const cameraPage = await cameraContext.newPage();
    await cameraPage.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await cameraPage.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click();
    await cameraPage.locator('#staff-booth').selectOption('clock-booth');
    await cameraPage.getByRole('button', { name: '카메라로 스캔', exact: true }).click();
    await cameraPage.waitForFunction(() => window.__cameraCalls === 1 && window.__clockCamera?.getVideoTracks().length === 1);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, end - Date.now() - 5000)));
    assert.ok(Date.now() < end - 2000, 'leave time for the committed request before closing');
    let releaseResponse, committed;
    const held = new Promise(resolve => { releaseResponse = resolve; });
    const requestCommitted = new Promise(resolve => { committed = resolve; });
    await pendingPage.route('**/commands', async route => {
      const request = route.request().postDataJSON();
      if (request?.command !== 'booth.visit') return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      committed();
      await held;
      await route.fulfill({ response });
    });
    await pendingPage.locator('form').filter({ has: pendingPage.locator('#staff-ticket') }).getByRole('button', { name: '부스 인증', exact: true }).click();
    await Promise.race([requestCommitted, new Promise((_, reject) => setTimeout(() => reject(new Error('pre-end request did not commit')), 8000))]);
    await page.waitForFunction(() => document.querySelector('#staff-booth option[value="clock-booth"]')?.disabled, null, { timeout: 45000 });
    assert.ok(Date.now() > end, 'the booth does not close before the inclusive end boundary');
    assert.match(await option.textContent(), /운영 종료/);
    assert.equal(await ticket.inputValue(), '합성 입력 보존');
    assert.equal(await ticket.evaluate(node => document.activeElement === node), true, 'time transition preserves typing focus');
    assert.equal(await page.locator('form').filter({ has: ticket }).getByRole('button', { name: '부스 인증', exact: true }).isDisabled(), true);
    await page.getByText(/선택한 부스가 운영 종료 상태입니다/).waitFor();
    await pendingPage.getByText('처리 결과를 확인하고 있습니다. 확인이 끝나면 티켓과 업무를 다시 바꿀 수 있습니다.', { exact: true }).waitFor();
    assert.equal(await pendingPage.locator('#staff-ticket').inputValue(), person.ticket, 'in-flight request stays bound to its ticket');
    releaseResponse();
    await pendingPage.getByRole('button', { name: '다음 참가자', exact: true }).waitFor();
    await cameraPage.waitForFunction(() => window.__clockCamera.getVideoTracks()[0].readyState === 'ended');
    assert.equal(await cameraPage.getByRole('region', { name: '카메라 스캔', exact: true }).count(), 0);
    await cameraPage.evaluate(past => { Date.now = () => past; window.dispatchEvent(new Event('focus')); }, start + 2000);
    await cameraPage.waitForFunction(() => !document.querySelector('#staff-booth option[value="clock-booth"]')?.disabled);
    assert.equal(await cameraPage.getByRole('region', { name: '카메라 스캔', exact: true }).count(), 0, 'camera stays closed when the local clock changes back');
    assert.equal(await cameraPage.evaluate(() => window.__cameraCalls), 1);
    const rejected = await command(fixture.staff.cookie, 'booth.visit', { boothId: 'clock-booth', ticket: person.ticket }, 'clock-assignment');
    assert.equal(rejected.status, 409); assert.equal((await rejected.json()).code, 'BOOTH_UNAVAILABLE');
    assert.equal((await read()).visits.length, 2, 'a committed pre-end request settles once, and the post-end request adds no visit');
    await page.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `ended-${width}.png`), fullPage: true });
    }
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, realServerTime: true, startWithoutInteraction: true, uiVisitCount: 2, endPreservesInputAndFocus: true, committedResponseHeldAcrossEnd: true, simulatedCameraStopsAndStaysClosed: true, serverRejectsAfterEnd: true, viewportWidths: [320, 390, 1280], physicalDevices: false }, null, 2));
    console.log('부스 시작·인증·종료: 스태프 화면과 서버, 입력·초점 보존 확인');
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
