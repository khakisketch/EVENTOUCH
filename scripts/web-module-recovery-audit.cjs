'use strict';
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
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'module-recovery-before' : 'module-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const db = fixture.harness.database;
    const event = (await db.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    event.features = [...new Set([...event.features, 'qa'])];
    await db.query('UPDATE events SET payload=$2 WHERE id=$1', [fixture.eventId, event]);
    const workspace = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/programs`, { waitUntil: 'networkidle' });
    let mode = 'lost';
    const ids = [];
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body.command !== 'module.save') return route.continue();
      ids.push(body.commandId);
      if (mode === 'lost' || mode === 'malformed') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, 'module committed before response fault');
        if (mode === 'lost') { mode = 'rejected'; return route.abort('failed'); }
        mode = 'pass';
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"module":{"id":"wrong"}}' });
      }
      if (mode === 'rejected') { mode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      return route.continue();
    });
    const dialog = page.getByRole('dialog');
    const create = async (title) => {
      await page.getByRole('button', { name: '이벤트 만들기', exact: true }).click();
      await page.getByRole('button', { name: /^Q&A/ }).click();
      await page.locator('#program-title').fill(title);
      await page.locator('#program-type').selectOption('qa');
      await dialog.getByRole('button', { name: '만들기', exact: true }).click();
    };
    phase = 'lost create survives closing and rejected retry';
    await create('합성 복구 프로그램');
    await dialog.getByRole('alert').first().waitFor();
    await page.screenshot({ path: path.join(out, 'unconfirmed-1280.png'), fullPage: true });
    if (before) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      console.log('Module recovery before capture passed'); return;
    }
    assert.equal(await page.locator('#program-title').isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const recovery = page.getByRole('region', { name: '콘텐츠 저장 확인 필요' });
    await recovery.waitFor();
    assert.equal(await page.getByRole('button', { name: '이벤트 만들기', exact: true }).isDisabled(), true);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.getByRole('alert').waitFor();
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(new Set(ids.slice(0, 3)).size, 1);
    assert.equal((await workspace()).modules.filter((item) => item.title === '합성 복구 프로그램').length, 1);

    phase = 'status-only confirmation';
    mode = 'malformed';
    await create('합성 확인 프로그램');
    await dialog.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const beforeCheck = ids.length;
    await dialog.getByRole('button', { name: '서버 처리 확인' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(ids.length, beforeCheck);
    assert.equal((await workspace()).modules.filter((item) => item.title === '합성 확인 프로그램').length, 1);

    phase = 'reload stores no module content';
    mode = 'malformed';
    await create('합성 새로고침 프로그램');
    await dialog.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('module.save') && !stored.includes('합성 새로고침 프로그램'));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    assert.equal(await page.getByRole('button', { name: '이벤트 만들기', exact: true }).isDisabled(), true);
    const beforeReloadCheck = ids.length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '이벤트 만들기' && !button.disabled));
    assert.equal(ids.length, beforeReloadCheck);
    assert.equal((await workspace()).modules.filter((item) => item.title === '합성 새로고침 프로그램').length, 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, originalRequestRetained: true, statusOnly: true, noModuleTextPersisted: true, duplicates: 0 }, null, 2), { mode: 0o600 });
    console.log('Program: original save survives closing, rejection and reload without duplication');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
