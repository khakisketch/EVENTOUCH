'use strict';

// Isolated staff check-in and print-output regression; no physical printer.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { defaultCaptureDir, prepareCaptureDir, ensureRunTmpDir, runStamp } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk, typeTicket } = require('./audit-staff-direction.cjs');

async function main() {
  const out = process.env.EVENTOUCH_CAPTURE_ROOT
    ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'nametag-freshness')
    : defaultCaptureDir(`nametag-freshness-${runStamp()}`);
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  let page;
  const check = async () => (await fixture.harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
  try {
    const person = (await check()).participants[0];
    const updateCompany = async (company) => {
      const response = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie,
        body: { commandId: crypto.randomUUID(), command: 'participant.update', payload: { id: person.id, company } },
      });
      assert.equal(response.status, 200, JSON.stringify(response.json));
    };
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.addInitScript(() => { window.print = () => { window.__printCalls = (window.__printCalls || 0) + 1; }; });
    await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`, { waitUntil: 'networkidle' });
    await confirmInitialStaffDesk(page);
    await updateCompany('합성 최신 소속');
    let mode = 'error';
    let loseScan = true;
    const scanIds = [];
    await page.route('**/api/bootstrap', async (route) => {
      if (mode === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic unavailable"}' });
      if (mode === 'forbidden') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' });
      if (mode === 'partial') {
        const response = await route.fetch();
        const json = await response.json();
        delete json.state.workspaces[fixture.eventId].participants;
        return route.fulfill({ response, json });
      }
      return route.continue();
    });
    await page.route('**/commands', async (route) => {
      const data = route.request().postDataJSON();
      if (data.command !== 'check.scan') return route.continue();
      scanIds.push(data.commandId);
      if (!loseScan) return route.continue();
      loseScan = false;
      await route.fetch();
      return route.fulfill({ status: 504, contentType: 'application/json', body: '{"error":"synthetic response lost"}' });
    });
    await typeTicket(page, person.ticket);
    await page.getByRole('button', { name: '입장 처리', exact: true }).click();
    const unknown = page.getByRole('region', { name: '스캔 결과 미확인', exact: true });
    await unknown.getByRole('button', { name: '같은 요청 재확인', exact: true }).click();
    const result = page.getByRole('region', { name: '스캔 결과 상세', exact: true });
    await result.waitFor();
    assert.deepEqual(scanIds.length, 2);
    assert.equal(scanIds[0], scanIds[1]);
    assert.equal((await check()).checks.length, 1);
    assert.ok((await result.innerText()).includes(person.name));
    await result.getByRole('button', { name: '네임택 인쇄', exact: true }).click();
    const preview = page.getByRole('region', { name: '네임택 미리보기', exact: true });
    const retry = preview.getByRole('button', { name: '최신 정보 다시 확인', exact: true });
    const print = preview.getByRole('button', { name: '인쇄하기', exact: true });
    await retry.waitFor();
    assert.equal(await print.isDisabled(), true);
    assert.ok(!(await preview.innerText()).includes(person.company));
    for (const failure of ['partial']) {
      mode = failure;
      await retry.click();
      await retry.waitFor();
      assert.equal(await print.isDisabled(), true, failure);
    }
    mode = 'pass';
    await retry.click();
    await preview.getByText('합성 최신 소속', { exact: true }).waitFor();
    assert.equal(await print.isEnabled(), true);
    await updateCompany('합성 변경된 소속');
    await print.click();
    await preview.getByText('합성 변경된 소속', { exact: true }).waitFor();
    await preview.getByText(/미리보기를 확인한 뒤 다시 인쇄/).waitFor();
    assert.equal(await page.evaluate(() => window.__printCalls || 0), 0);
    mode = 'error';
    await print.click();
    await retry.waitFor();
    assert.equal(await print.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__printCalls || 0), 0);
    mode = 'pass';
    await retry.click();
    await preview.getByText('합성 변경된 소속', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, 'fresh-preview-390.png'), fullPage: true });
    await print.click();
    await page.waitForFunction(() => window.__printCalls === 1);
    await page.emulateMedia({ media: 'print' });
    const output = page.locator('[data-nametag-output]');
    assert.ok((await output.innerText()).includes('합성 변경된 소속'));
    await page.pdf({ path: path.join(out, 'fresh-label.pdf'), preferCSSPageSize: true, printBackground: true });
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    mode = 'forbidden';
    await print.click();
    await retry.waitFor();
    assert.equal(await print.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__printCalls || 0), 1);
    assert.equal((await check()).checks.length, 1);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
      build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), synthetic: true, physicalPrinter: false,
      checks: ['receipt replay once', '503 and partial and 403 block print', 'retry uses fresh company',
        'changed identity requires review', 'print-time failure blocks print', 'fresh output preserves check-in'],
    }, null, 2), { mode: 0o600 });
    console.log('Staff nametag: fresh identity, print-time review and recovery verified');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
