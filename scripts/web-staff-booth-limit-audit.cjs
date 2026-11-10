'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'staff-booth-limit'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { database } = fixture.harness;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = await read();
    const [first, second] = workspace.participants.filter(person => person.status === 'APPROVED' && person.ticket);
    assert.ok(first && second);
    for (const person of [first, second]) Object.assign(person, { inside: true, everIn: true, paymentStatus: 'FREE', revoked: false, ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() });
    workspace.stampMode = 'STAFF';
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
    await change('event.features', { features: ['stamp'] });
    const boothInput = { status: 'OPEN', capacity: 0, limit: 1 };
    const { booth } = await change('booth.save', { ...boothInput, name: '체험 인증 부스' });
    await change('booth.save', { ...boothInput, name: '미배정 체험 부스' });
    await fixture.helpers.insertAssignment(database, { id: 'limit-booth-assignment', accountId: fixture.staff.id, eventId: fixture.eventId, type: 'BOOTH', targetId: booth.id });

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const visits = [];
    const isVisit = request => request.url() === commandUrl && request.method() === 'POST' && request.postDataJSON().command === 'booth.visit';
    page.on('request', request => { if (isVisit(request)) visits.push(request.postDataJSON()); });
    await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await page.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click();
    const selectedBooth = page.locator('#staff-booth');
    await selectedBooth.selectOption(booth.id);
    const ticket = page.getByLabel('티켓 코드', { exact: true });
    const scan = page.locator('button[type="submit"]').and(page.getByRole('button', { name: '부스 인증', exact: true }));
    const result = page.getByRole('region', { name: '스캔 결과 상세', exact: true });
    const failure = page.getByRole('region', { name: '스캔 실패', exact: true });
    const next = failure.getByRole('button', { name: '다음 참가자', exact: true });
    const recent = page.getByRole('region', { name: '최근 처리 기록', exact: true }).getByRole('listitem');
    const submit = async () => (await Promise.all([page.waitForResponse(response => isVisit(response.request())), scan.click()]))[0];
    await ticket.fill(first.ticket);
    assert.equal((await submit()).status(), 201);
    await result.getByRole('button', { name: '다음 참가자', exact: true }).click();

    await ticket.fill(first.ticket);
    const rejected = await submit();
    assert.equal(rejected.status(), 409);
    const rejection = await rejected.json();
    assert.equal(rejection.code, 'BOOTH_LIMIT_REACHED');
    await failure.waitFor();
    await page.screenshot({ path: path.join(out, 'staff-limit-390.png'), mask: [ticket, page.locator('[data-ticket-full-code]')], maskColor: '#e4e6ea', fullPage: true });
    assert.ok(await next.isVisible(), 'a definite personal limit should lead to the next participant');
    assert.ok(!rejection.error.includes('다른 부스'), 'staff guidance should match the currently assigned booth');
    assert.equal(await failure.getByRole('button', { name: '다시 시도', exact: true }).count(), 0);
    assert.equal(await scan.count(), 0);
    assert.equal((await read()).visits.length, 1);
    assert.equal(await recent.count(), 1);
    assert.ok(await recent.getByText(`${booth.name} · 인증 완료`, { exact: true }).isVisible());
    assert.equal(await next.evaluate(node => node === document.activeElement), true);
    await page.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.ok((await next.boundingBox()).height >= 44);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => item.id)), []);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Enter');
    await ticket.waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'staff-ticket');
    assert.equal(await ticket.inputValue(), '');
    assert.equal(await selectedBooth.inputValue(), booth.id);
    assert.equal(visits.length, 2, 'starting the next participant must never send a visit');

    await page.route(commandUrl, async route => {
      if (!isVisit(route.request())) return route.continue();
      await route.fetch();
      await route.abort('failed');
    }, { times: 1 });
    await ticket.fill(second.ticket);
    await scan.click();
    const uncertain = page.getByRole('region', { name: '스캔 결과 미확인', exact: true });
    await uncertain.waitFor();
    assert.equal(await uncertain.getByRole('button', { name: '다음 참가자', exact: true }).count(), 0);
    assert.equal((await read()).visits.length, 2);
    await uncertain.getByRole('button', { name: '같은 요청 재확인', exact: true }).click();
    await result.getByText(new RegExp(second.name)).waitFor();
    assert.ok(visits.length === 4 && JSON.stringify(visits[3]) === JSON.stringify(visits[2]), 'receipt recovery must replay exactly the original booth request');
    const saved = (await read()).visits;
    assert.equal(saved.length, 2);
    assert.equal(await recent.count(), 2);
    assert.ok(saved.every(row => row.boothId === booth.id));
    assert.deepEqual(new Set(saved.map(row => row.participantId)), new Set([first.id, second.id]));
    console.log('Staff booth limit hands off to the next participant; response loss still confirms the same request. Two visits persisted.');
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

main().catch(error => {
  console.error(String(error?.message || error).split('\n')[0].replace(/https?:\/\/[^\s]+/g, '[url redacted]'));
  process.exitCode = 1;
});
