'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { typeTicket } = require('./audit-staff-direction.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'booth-availability'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { database } = fixture.harness;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = await read();
    const attendee = workspace.participants.find(person => person.status === 'APPROVED' && person.ticket);
    assert.ok(attendee);
    Object.assign(attendee, { inside: true, everIn: true, paymentStatus: 'FREE', revoked: false, ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() });
    workspace.stampMode = 'STAFF';
    workspace.visits = [];
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);

    const commandUrl = `${fixture.baseUrl}/api/events/${fixture.eventId}/commands`;
    const change = async (command, payload) => {
      const response = await fetch(commandUrl, {
        method: 'POST', headers: { cookie: fixture.manager.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: randomUUID(), command, payload }),
      });
      assert.ok(response.ok, `${command} returned ${response.status}`);
      return response.json();
    };
    const visit = async (page, submit) => {
      const [response] = await Promise.all([
        page.waitForResponse(item => item.url() === commandUrl && item.request().method() === 'POST' && item.request().postDataJSON().command === 'booth.visit'),
        submit.click(),
      ]);
      return response;
    };
    await change('event.features', { features: ['stamp'] });
    const { booth } = await change('booth.save', { name: '감사 인증 부스', status: 'OPEN', capacity: 1, limit: 1 });
    const setMode = mode => change('booth.mode', { mode, acknowledge: true });
    const setStatus = status => change('booth.save', { ...booth, status });
    await fixture.helpers.insertAssignment(database, {
      id: 'audit-booth-assignment', accountId: fixture.staff.id, eventId: fixture.eventId, type: 'BOOTH', targetId: booth.id,
    });

    browser = await launchBrowser();
    const mobile = { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' };
    const staffContext = await browser.newContext(mobile);
    await staffContext.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    const staff = await staffContext.newPage();
    const boothTask = staff.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true });
    const boothSelect = staff.locator('#staff-booth');
    const scan = staff.locator('button[type="submit"]').and(staff.getByRole('button', { name: '부스 인증', exact: true }));
    const refresh = staff.getByRole('button', { name: '부스 상태 다시 확인', exact: true });
    const qr = staff.getByRole('img', { name: `${booth.name} 인증 QR`, exact: true });
    await staff.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await boothTask.click();
    await boothSelect.selectOption(booth.id);
    const ticket = staff.getByLabel('티켓 코드', { exact: true });
    await typeTicket(staff, attendee.ticket);
    await setMode('SELF');
    const rejectedStaff = await visit(staff, scan);
    assert.equal(rejectedStaff.status(), 409);
    assert.equal((await rejectedStaff.json()).code, 'BOOTH_MODE_CHANGED');
    await staff.getByRole('region', { name: '스캔 실패', exact: true }).getByRole('button', { name: '부스 상태 다시 확인' }).waitFor();
    assert.equal(await scan.count(), 0);
    await staff.screenshot({ path: path.join(out, 'staff-mode-rejected.png'), mask: [ticket, staff.locator('[data-ticket-full-code]')], fullPage: true });

    await staff.route('**/api/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    await refresh.focus();
    await staff.keyboard.press('Enter');
    await staff.getByText('업무 정보를 불러오지 못했습니다.', { exact: true }).waitFor();
    assert.equal(await scan.count(), 0);
    await staff.getByRole('button', { name: '데스크 체크인', exact: true }).click();
    await boothTask.click();
    assert.equal(await scan.count(), 0, 'switching staff tasks must not restore the stale scanner');
    await refresh.click();
    await qr.waitFor();
    assert.equal(await ticket.count(), 0);
    assert.equal(await staff.evaluate(() => document.activeElement?.id), 'staff-booth');
    await staff.screenshot({ path: path.join(out, 'staff-mode-updated.png'), mask: [qr], fullPage: true });
    await setStatus('CLOSED');
    await refresh.click();
    await staff.getByText('선택한 부스 · 운영 종료', { exact: true }).waitFor();
    assert.equal(await qr.count(), 0);
    await setStatus('OPEN');
    await refresh.click();
    await qr.waitFor();

    const guestContext = await browser.newContext(mobile);
    await guestContext.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: fixture.slug, ticket: attendee.ticket });
    const guest = await guestContext.newPage();
    await guest.clock.install();
    await guest.goto(`${fixture.baseUrl}/event/${fixture.slug}/home?view=stamp`);
    const boothRow = guest.getByRole('listitem').filter({ hasText: booth.name });
    const status = label => boothRow.getByText(label, { exact: true });
    const boothCode = guest.getByLabel('부스 코드', { exact: true });
    const stamp = guest.getByRole('button', { name: '인증하기', exact: true });
    await status('운영 중').waitFor();
    await guest.clock.pauseAt(await guest.evaluate(() => Date.now() + 250));
    await boothCode.fill(`ET:BOOTH:${fixture.eventId}:${booth.id}`);
    await setStatus('CLOSED');
    const rejectedGuest = await visit(guest, stamp);
    assert.equal(rejectedGuest.status(), 409);
    assert.equal((await rejectedGuest.json()).code, 'BOOTH_UNAVAILABLE');
    await guest.getByRole('alert').filter({ hasText: '종료된 부스입니다.' }).waitFor();
    await status('운영 종료').waitFor({ timeout: 1500 });
    assert.equal(await stamp.count(), 0);
    assert.equal((await read()).visits.length, 0);
    await guest.screenshot({ path: path.join(out, 'guest-closed.png'), mask: [boothCode], fullPage: true });

    await setStatus('OPEN');
    await guest.clock.runFor(5000);
    await status('운영 중').waitFor();
    assert.ok(await boothCode.inputValue(), 'reopening preserves the entered code');
    await setStatus('CLOSED');
    await guest.route('**/api/public/events/*/ticket', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    assert.equal((await visit(guest, stamp)).status(), 409);
    await guest.getByRole('status').filter({ hasText: '최신 부스 상태를 확인하지 못했습니다.' }).waitFor();
    assert.ok(await status('상태 확인 필요').isVisible());
    assert.equal(await stamp.count(), 0, 'a failed availability read must not unlock the previous scanner');
    assert.equal((await read()).visits.length, 0);
    await guest.screenshot({ path: path.join(out, 'guest-refresh-failed.png'), fullPage: true });

    await setStatus('OPEN');
    await guest.clock.runFor(5000);
    await status('운영 중').waitFor();
    assert.ok(await boothCode.inputValue(), 'a failed read preserves the entered code');
    assert.equal((await visit(guest, stamp)).status(), 201);
    await status('수량 소진').waitFor();
    assert.equal(await stamp.count(), 0);
    assert.equal((await read()).visits.length, 1);
    await refresh.click();
    await staff.getByText('선택한 부스 · 수량 소진', { exact: true }).waitFor();
    assert.equal(await qr.count(), 0);
    await guest.screenshot({ path: path.join(out, 'guest-sold-out.png'), fullPage: true });

    const { booth: limited } = await change('booth.save', { name: '체험 인증 부스', status: 'OPEN', capacity: 0, limit: 1 });
    const { booth: alternative } = await change('booth.save', { name: '파트너 체험 부스', status: 'OPEN', capacity: 0, limit: 1 });
    const codeFor = boothId => `ET:BOOTH:${fixture.eventId}:${boothId}`;
    await guest.clock.runFor(5000);
    const limitedRow = guest.getByRole('listitem').filter({ hasText: limited.name });
    await limitedRow.getByText('운영 중', { exact: true }).waitFor();
    const otherTab = await fetch(commandUrl, {
      method: 'POST', headers: { authorization: `Bearer ${attendee.ticket}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), command: 'booth.visit', payload: { code: codeFor(limited.id) } }),
    });
    assert.equal(otherTab.status, 201);
    await boothCode.fill(codeFor(limited.id));
    const limitRejection = await visit(guest, stamp);
    assert.equal(limitRejection.status(), 409);
    assert.equal((await limitRejection.json()).code, 'BOOTH_LIMIT_REACHED');
    await limitedRow.getByText('한도 도달', { exact: true }).waitFor({ timeout: 1500 });
    assert.equal(await boothCode.inputValue(), '');
    const nextBooth = guest.getByRole('link', { name: '인증 가능한 부스 1곳 보기', exact: true });
    await nextBooth.focus();
    await guest.keyboard.press('Enter');
    await guest.waitForURL(url => url.hash === '#stamp-next-booth');
    assert.ok(await guest.locator('#stamp-next-booth').getByText(alternative.name, { exact: true }).isVisible());
    assert.equal(await guest.evaluate(() => document.activeElement?.id), 'stamp-next-booth');
    assert.equal((await read()).visits.length, 2, 'opening the alternative never submits a visit');
    await guest.screenshot({ path: path.join(out, 'guest-next-booth.png'), fullPage: true });
    await boothCode.fill(codeFor(alternative.id));
    assert.equal((await visit(guest, stamp)).status(), 201);
    await guest.getByText('지금 인증할 수 있는 부스가 없습니다.', { exact: false }).waitFor();
    assert.equal(await nextBooth.count(), 0);
    assert.equal((await read()).visits.length, 3);

    await guest.clock.resume();
    for (const page of [staff, guest]) {
      await page.evaluate(axeSource);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const violations = await page.evaluate(async () => (await window.axe.run()).violations.map(({ id, impact }) => ({ id, impact })));
        assert.deepEqual(violations.filter(item => ['critical', 'serious'].includes(item.impact)), []);
      }
    }
    console.log('Staff and attendee booth recovery, eligible alternative navigation and three confirmed visits; layout and axe checked at 320/390/1280px.');
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

main().catch(error => {
  console.error(String(error?.message || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]'));
  process.exitCode = 1;
});
