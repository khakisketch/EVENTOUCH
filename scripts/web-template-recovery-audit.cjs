'use strict';
// Isolated synthetic data; response faults happen only after a real commit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'template-recovery-before' : 'template-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const requests = new Map();
    let holdRefresh = false, releaseRefresh = () => {}, markRefresh = () => {};
    const refreshHeld = new Promise((resolve) => { markRefresh = resolve; });
    const refreshReleased = new Promise((resolve) => { releaseRefresh = resolve; });
    const bootstrapPath = `/api/events/${fixture.eventId}/bootstrap`;
    await page.route(url => url.pathname === bootstrapPath &&
      (url.searchParams.get('messageRecipientReview') === '1' || (before && !url.search)), async (route) => {
      if (!holdRefresh) return route.continue();
      holdRefresh = false;
      const response = await route.fetch(); markRefresh(); await refreshReleased;
      return route.fulfill({ response });
    });
    let sends = 0;
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (['message.create', 'message.create-reviewed'].includes(body.command)) { sends += 1; return route.abort('blockedbyclient'); }
      const key = body.command === 'template.save' && body.payload.name.startsWith('합성 템플릿 복구') ? body.payload.name : '';
      if (!key) return route.continue();
      const rows = requests.get(key) || [];
      rows.push(body); requests.set(key, rows);
      if (rows.length === 1) {
        const response = await route.fetch();
        assert.ok(response.ok(), `${key} committed before response fault`);
        if (key.endsWith('부분 응답')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ template: { id: 'different', name: key, channel: 'SMS', body: '다른 내용', solapiTemplateId: null } }) });
        return route.abort('failed');
      }
      if (rows.length === 2 && key.endsWith('원래 요청')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      return route.continue();
    });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages`, { waitUntil: 'networkidle' });
    const details = page.locator('#template-details');
    if (before) await details.locator('summary').click();
    else await page.getByRole('tab', { name: '템플릿 관리', exact: true }).click();
    const name = page.locator('#template-name');
    const content = page.locator('#template-body');
    const add = page.getByRole('button', { name: '템플릿 추가', exact: true });
    const panel = page.getByRole('region', { name: '템플릿 저장 확인 필요' });
    const original = '합성 템플릿 복구 원래 요청';
    const originalBody = '합성 메시지 본문입니다.';
    phase = 'commit, loss, later denial and same request retry';
    await name.fill(original); await content.fill(originalBody); await add.click();
    if (before) {
      await page.getByRole('alert').filter({ hasText: /응답을 확인하지 못했습니다/ }).waitFor();
      await name.fill('합성 템플릿 복구 다른 요청');
      assert.equal(await add.isDisabled(), false, 'old screen permits a different create before resolving the first');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      return;
    }
    await panel.waitFor();
    assert.equal(await name.isDisabled(), true);
    assert.equal(await content.inputValue(), originalBody);
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.getByRole('alert').filter({ hasText: /결과를 확인하지 못했습니다/ }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'template-recovery-heading');
    assert.equal(await name.isDisabled(), true, 'a later 403 cannot settle a previous loss');
    assert.equal(await name.inputValue(), original);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    await page.screenshot({ path: path.join(out, 'unconfirmed-viewport-390.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(new Set(requests.get(original).map((entry) => entry.commandId)).size, 1);
    assert.equal(new Set(requests.get(original).map((entry) => JSON.stringify(entry.payload))).size, 1);
    assert.equal((await workspace()).templates.filter((entry) => entry.name === original).length, 1);

    phase = 'wrong success response and status-only confirmation';
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '새로 작성' }).click();
    const partial = '합성 템플릿 복구 부분 응답';
    await name.fill(partial); await content.fill('합성 부분 응답 본문'); await add.click(); await panel.waitFor();
    assert.equal((await workspace()).templates.filter((entry) => entry.name === partial).length, 1);
    const count = requests.get(partial).length;
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(requests.get(partial).length, count, 'status-only check does not save again');
    assert.equal(await name.inputValue(), '');

    phase = 'reload retains only scoped pointer';
    const reloaded = '합성 템플릿 복구 새로고침';
    await name.fill(reloaded); await content.fill('합성 새로고침 본문'); await add.click(); await panel.waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('template.save') && !stored.includes(reloaded) && !stored.includes('합성 새로고침 본문'));
    const reloadWrites = requests.get(reloaded).length;
    await page.reload({ waitUntil: 'networkidle' });
    if (before) await details.locator('summary').click();
    else await page.getByRole('tab', { name: '템플릿 관리', exact: true }).click();
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.getByText('메시지 템플릿 저장', { exact: true }).waitFor();
    assert.equal(await name.isDisabled(), true, 'a reload cannot create another template before checking');
    holdRefresh = true;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    let deadline;
    try { await Promise.race([refreshHeld, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('authoritative refresh was not requested')), 15000); })]); }
    finally { clearTimeout(deadline); }
    assert.equal(await name.isDisabled(), true, 'new templates stay locked until the refreshed list arrives');
    releaseRefresh();
    await page.waitForFunction(() => !document.querySelector('#template-name')?.disabled);
    assert.equal(requests.get(reloaded).length, reloadWrites);
    assert.equal((await workspace()).templates.filter((entry) => entry.name === reloaded).length, 1);
    assert.equal(sends, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, after403: true, sameIdAndPayload: true, readOnlyAfterReload: true, duplicateTemplates: 0, sends: 0 }, null, 2), { mode: 0o600 });
    console.log('Templates: response loss, different response and reload recover without another save or message send');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
