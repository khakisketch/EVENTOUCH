'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { confirmInitialStaffDesk } = require('./audit-staff-direction.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const booth = process.argv.includes('--booth');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, booth ? 'staff-inline-booth' : 'staff-inline-checkin'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  try {
    const workspace = await read(), person = workspace.participants[0];
    let boothId = '';
    if (booth) {
      person.inside = true; person.everIn = true; workspace.stampMode = 'STAFF';
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
      const command = async (name, payload) => {
        const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie: f.manager.cookie,
          body: { commandId: crypto.randomUUID(), command: name, payload } });
        assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.json)); return response.json;
      };
      await command('event.features', { features: ['stamp'] });
      boothId = (await command('booth.save', { name: '합성 인증 부스', status: 'OPEN', capacity: 0, limit: 1 })).booth.id;
      await f.helpers.insertAssignment(f.harness.database, { id: 'inline-booth', accountId: f.staff.id, eventId: f.eventId, type: 'BOOTH', targetId: boothId });
    }
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
    const page = await context.newPage(), attempts = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const name = booth ? 'booth.visit' : 'check.scan';
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON(); if (body.command !== name) return route.continue();
      attempts.push(body.commandId);
      if (attempts.length === 1) {
        if (booth) { const response = await route.fetch(); assert.ok(response.status() >= 200 && response.status() < 300); }
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    if (booth) {
      await page.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click();
      await page.locator('#staff-booth').selectOption(boothId);
    } else await confirmInitialStaffDesk(page);
    await page.locator('#staff-ticket').fill(person.ticket);
    await page.getByRole('button', { name: booth ? '부스 인증' : '입장 처리', exact: true }).last().click();
    const result = page.getByRole('region', { name: '스캔 결과 미확인', exact: true }); await result.waitFor();
    const local = result.getByRole('group', { name: '현재 요청 서버 확인' });
    await local.getByRole('button', { name: '서버 처리 확인', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: '처리 결과 확인', exact: true }).count(), 0);
    assert.equal((await read())[booth ? 'visits' : 'checks'].length, booth ? 1 : 0);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
      await page.screenshot({ path: path.join(out, `uncertain-${width}.png`), fullPage: true });
    }
    let unblock, reached;
    const hold = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { reached = resolve; });
    const intercept = async route => { reached(); await hold; return route.continue(); };
    await page.route('**/api/events/*/command-receipts/*', intercept);
    await local.getByRole('button', { name: '서버 처리 확인', exact: true }).click(); await started;
    assert.equal(await result.getByRole('button', { name: '같은 요청 재확인', exact: true }).isDisabled(), true);
    assert.equal(await result.getByRole('button', { name: '확인 중단하고 다른 업무', exact: true }).isDisabled(), true);
    unblock();
    if (booth) {
      await local.getByText(/서버에 부스 인증 기록이 있습니다/).waitFor();
      assert.equal(await page.getByText('대상 확인을 위해 아래에서 같은 요청을 다시 확인하세요.', { exact: true }).count(), 0, 'the local status result is not repeated above the task');
      assert.equal(await result.getByRole('button', { name: '같은 요청 재확인', exact: true }).isEnabled(), true);
    } else await local.getByText(/아직 처리 여부를 확인할 수 없습니다/).waitFor();
    assert.equal(attempts.length, 1, 'a status read never sends the original command');
    assert.equal((await read())[booth ? 'visits' : 'checks'].length, booth ? 1 : 0);
    await page.unroute('**/api/events/*/command-receipts/*', intercept);
    await result.getByRole('button', { name: '같은 요청 재확인', exact: true }).click();
    await page.getByRole('region', { name: '스캔 결과 상세' }).getByText(person.name, { exact: false }).waitFor();
    assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1]);
    assert.equal((await read())[booth ? 'visits' : 'checks'].length, 1, 'same-id confirmation commits at most once');
    assert.deepEqual(errors, []);
    console.log(`staff inline ${booth ? 'booth' : 'check-in'} recovery: passed`);
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
