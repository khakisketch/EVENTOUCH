'use strict';
// Isolated synthetic fixture: a committed scan followed by a desk-direction change.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'staff-direction-review');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture(); let browser, context;
  try {
    const db = fixture.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = await read();
    const [first, second, third] = workspace.participants;
    second.inside = true; second.everIn = true; third.inside = true; third.everIn = true;
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    const command = async (name, payload) => {
      const response = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.ok(response.status >= 200 && response.status < 300, `${name}: ${JSON.stringify(response.json)}`);
      return response.json;
    };
    const changeDirection = async (action, open = true) => {
      const desk = (await read()).desks.find(item => item.id === fixture.deskId);
      await command('desk.save', { id: fixture.deskId, name: desk.name, action, mode: desk.mode || 'desk', confirmDirectionChange: true });
      if (open) await command('desk.set-open', { id: fixture.deskId, open: true });
    };
    browser = await launchBrowser(); context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; const scans = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/commands') && request.postDataJSON()?.command === 'check.scan') scans.push(request.postDataJSON()); });
    const url = `${fixture.baseUrl}/staff/events/${fixture.eventId}`;
    const ticket = page.locator('#staff-ticket');
    const alert = page.getByRole('region', { name: '데스크 업무 방향을 확인해 주세요' });
    const next = page.getByRole('button', { name: '다음 참가자', exact: true });
    const latest = () => page.getByRole('region', { name: '스캔 결과 상세', exact: true });
    await page.goto(url, { waitUntil: 'networkidle' });
    await ticket.fill(first.ticket);
    await alert.getByText(/시작하기 전에 업무 방향을 확인/).waitFor();
    assert.equal(await page.getByRole('button', { name: '입장 처리', exact: true }).isDisabled(), true, 'an automatically selected desk requires explicit initial review');
    await alert.getByRole('button', { name: '입장 업무 확인', exact: true }).click();
    await alert.waitFor({ state: 'hidden' });
    assert.equal(await ticket.inputValue(), first.ticket);
    let flipFirst = true;
    await page.route('**/api/events/*/commands', async route => {
      let body; try { body = route.request().postDataJSON(); } catch { return route.continue(); }
      if (!flipFirst || body.command !== 'check.scan') return route.continue();
      flipFirst = false;
      const response = await route.fetch(); assert.equal(response.status(), 200);
      await changeDirection('OUT');
      return route.fulfill({ response });
    });
    await page.getByRole('button', { name: '입장 처리', exact: true }).click();
    await latest().getByText(first.name, { exact: false }).waitFor();
    await alert.waitFor();
    await alert.getByText(/이전에 확인한 방향은 입장.*현재 방향은 퇴장/).waitFor();
    assert.equal(await next.isDisabled(), true);
    assert.equal((await read()).checks.length, 1);
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '퇴장 업무 확인');
    await page.screenshot({ path: path.join(out, 'after-change-390.png'), fullPage: true });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
    const confirmOut = () => alert.getByRole('button', { name: '퇴장 업무 확인', exact: true });
    assert.equal(await confirmOut().evaluate(el => document.activeElement === el), true);
    let flipDuringReview = true;
    await page.route('**/api/bootstrap', async route => {
      if (flipDuringReview) { flipDuringReview = false; await changeDirection('IN'); }
      return route.continue();
    });
    await page.keyboard.press('Enter');
    await alert.getByText(/현재 방향은 입장/).waitFor();
    assert.equal(await next.isDisabled(), true, 'a second direction change is not silently approved');
    assert.equal((await read()).checks.length, 1, 'confirmation sends no scan');
    await page.unroute('**/api/bootstrap');
    let failRead = true;
    await page.route('**/api/bootstrap', route => {
      if (!failRead) return route.continue();
      failRead = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    await alert.getByRole('button', { name: '입장 업무 확인', exact: true }).click();
    await alert.getByText(/업무 정보를 불러오지 못했습니다/).waitFor();
    assert.equal(await next.isDisabled(), true, 'failed refresh cannot approve a direction');
    await page.unroute('**/api/bootstrap');
    await page.reload({ waitUntil: 'networkidle' });
    await alert.getByText(/현재 방향은 입장/).waitFor();
    await ticket.fill(second.ticket);
    assert.equal(await page.getByRole('button', { name: '입장 처리', exact: true }).isDisabled(), true, 'a reload requires a fresh direction confirmation');
    assert.equal(await ticket.inputValue(), second.ticket);
    let flipAfterReload = true;
    await page.route('**/api/bootstrap', async route => {
      if (flipAfterReload) { flipAfterReload = false; await changeDirection('OUT', false); }
      return route.continue();
    });
    await alert.getByRole('button', { name: '입장 업무 확인', exact: true }).click();
    await alert.getByText(/현재 방향은 퇴장/).waitFor();
    await alert.getByText(/가동 중지/).waitFor();
    assert.equal(await ticket.inputValue(), second.ticket);
    assert.equal(await page.getByRole('button', { name: '퇴장 처리', exact: true }).isDisabled(), true);
    await page.unroute('**/api/bootstrap');
    await command('desk.set-open', { id: fixture.deskId, open: true });
    await alert.getByRole('button', { name: '데스크 상태 다시 확인', exact: true }).click();
    await alert.getByRole('button', { name: '퇴장 업무 확인', exact: true }).waitFor();
    assert.equal(await ticket.inputValue(), second.ticket);
    await alert.getByRole('button', { name: '퇴장 업무 확인', exact: true }).click();
    await alert.waitFor({ state: 'hidden' });
    assert.equal(await ticket.inputValue(), second.ticket);
    assert.equal((await read()).checks.length, 1);
    await page.getByRole('button', { name: '퇴장 처리', exact: true }).click();
    await latest().getByText(second.name, { exact: false }).waitFor();
    assert.equal((await read()).participants.find(p => p.id === second.id).inside, false);
    assert.equal((await read()).checks[0].action, 'OUT');
    await next.click();
    await ticket.fill(third.ticket);
    let loseResponse = true;
    await page.route('**/api/events/*/commands', async route => {
      let body; try { body = route.request().postDataJSON(); } catch { return route.continue(); }
      if (!loseResponse || body.command !== 'check.scan') return route.continue();
      loseResponse = false; const response = await route.fetch(); assert.equal(response.status(), 200);
      await changeDirection('IN');
      return route.abort('failed');
    });
    await page.getByRole('button', { name: '퇴장 처리', exact: true }).click();
    const uncertain = page.getByRole('region', { name: '스캔 결과 미확인', exact: true });
    await uncertain.waitFor();
    const beforeRetry = scans.length;
    await uncertain.getByRole('button', { name: '같은 요청 재확인', exact: true }).click();
    await latest().getByText(third.name, { exact: false }).waitFor();
    await alert.getByText(/현재 방향은 입장/).waitFor();
    assert.equal(scans.length, beforeRetry + 1);
    assert.equal(scans[scans.length - 1].commandId, scans[scans.length - 2].commandId, 'uncertain request replays the original receipt');
    assert.equal(await next.isDisabled(), true);
    assert.equal((await read()).checks.filter(c => c.participantId === third.id).length, 1, 'replay does not duplicate the exit');
    await page.screenshot({ path: path.join(out, 'replay-keeps-result-390.png'), fullPage: true });
    const { desk: otherDesk } = await command('desk.save', { name: '합성 다른 데스크', action: 'IN', mode: 'desk', open: true });
    await command('staff.assign', { accountId: fixture.staff.id, type: 'DESK', targetId: otherDesk.id });
    const oldAssignment = (await read()).assignments.find(item => item.accountId === fixture.staff.id && item.targetId === fixture.deskId);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#staff-desk').selectOption(otherDesk.id);
    assert.equal(await alert.count(), 0, 'choosing a different desk does not inherit another desk review');
    await page.locator('#staff-desk').selectOption(fixture.deskId);
    assert.equal(await alert.count(), 0, 'choosing a desk with its displayed direction is an explicit selection');
    await ticket.fill(second.ticket);
    let flipAcrossDesks = true;
    const flipHandler = async route => {
      let body; try { body = route.request().postDataJSON(); } catch { return route.continue(); }
      if (!flipAcrossDesks || body.command !== 'check.scan') return route.continue();
      flipAcrossDesks = false; const response = await route.fetch(); assert.equal(response.status(), 200);
      await changeDirection('OUT'); return route.fulfill({ response });
    };
    await page.route('**/api/events/*/commands', flipHandler);
    await page.getByRole('button', { name: '입장 처리', exact: true }).click();
    await alert.getByText(/현재 방향은 퇴장/).waitFor();
    await page.unroute('**/api/events/*/commands', flipHandler);
    await page.locator('#staff-desk').selectOption(otherDesk.id);
    assert.equal(await alert.count(), 0);
    await page.locator('#staff-desk').selectOption(fixture.deskId);
    await alert.getByText(/현재 방향은 퇴장/).waitFor();
    assert.equal(await page.getByRole('button', { name: '퇴장 처리', exact: true }).isDisabled(), true, 'returning to the first desk preserves its pending review');
    await command('staff.unassign', { id: oldAssignment.id });
    await alert.getByRole('button', { name: '퇴장 업무 확인', exact: true }).click();
    await alert.getByText(/현재 데스크 방향이나 배정을 확인할 수 없습니다/).waitFor();
    assert.equal(await page.getByRole('button', { name: '입장 처리', exact: true }).isDisabled(), true, 'a removed assignment cannot be approved');
    await page.locator('#staff-desk').selectOption(otherDesk.id);
    assert.equal(await alert.count(), 0);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('eventouch.staff-desk-direction'))), false, 'no desk direction or organization state is persisted');
    assert.deepEqual(errors, []);
    console.log('Staff direction: initial selection, confirmed result, changed-again, 503, reload, closed desk, preserved input, exact retry, separate desks, revoked assignment, no direction storage, keyboard, layouts and axe passed.');
  } finally {
    if (context) await context.close(); if (browser) await browser.close(); await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
