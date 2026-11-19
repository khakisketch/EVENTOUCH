'use strict';
// The fixture commits real writes; only the response is altered after commit.
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
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'content-recovery-before' : 'content-recovery');
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
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/content`, { waitUntil: 'networkidle' });
    const ids = { 'notice.save': [], 'program.save': [] };
    let mode = 'lost';
    let uploadMode = 'lost';
    const uploadIds = [];
    await page.route(/\/api\/events\/[^/]+\/files\?/, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      uploadIds.push(new URL(route.request().url()).searchParams.get('commandId'));
      if (uploadMode === 'lost') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, 'file committed before response loss');
        uploadMode = 'rejected';
        return route.abort('failed');
      }
      if (uploadMode === 'rejected') { uploadMode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      return route.continue();
    });
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (!Object.hasOwn(ids, body.command)) return route.continue();
      ids[body.command].push(body.commandId);
      if (mode === 'lost' || mode === 'malformed') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, `${body.command} committed before response fault`);
        if (mode === 'lost') { mode = 'rejected'; return route.abort('failed'); }
        mode = 'pass';
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
      }
      if (mode === 'rejected') { mode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      return route.continue();
    });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const editor = page.getByRole('tabpanel');

    phase = 'notice lost then rejected';
    await page.getByRole('button', { name: '공지 작성', exact: true }).click();
    await page.locator('#content-notice-title').fill('합성 공지 복구');
    await page.locator('#content-notice-body').fill('합성 공지 내용');
    await editor.getByRole('button', { name: '초안 저장', exact: true }).click();
    await editor.getByRole('alert').first().waitFor();
    await page.screenshot({ path: path.join(out, 'notice-unconfirmed-1280.png'), fullPage: true });
    if (before) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-notice-unconfirmed-390.png'), fullPage: true });
      console.log('Content recovery before capture passed');
      return;
    }
    assert.equal(await page.locator('#content-notice-title').isDisabled(), true);
    await editor.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await editor.getByText(/저장 결과를 확인하지 못했습니다/).first().waitFor();
    assert.equal(await editor.getByText('저장 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.', { exact: true }).count(), 1, 'repeat failures announce the current guidance once');
    assert.equal(await page.locator('#content-notice-title').isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'notice-unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await editor.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    assert.equal(new Set(ids['notice.save']).size, 1);
    assert.equal((await workspace()).notices.filter((item) => item.title === '합성 공지 복구').length, 1);

    phase = 'schedule status check';
    await page.getByRole('tab', { name: /^일정/ }).click();
    await page.getByRole('button', { name: '일정 추가', exact: true }).click();
    await page.locator('#content-program-title').fill('합성 일정 복구');
    await page.locator('#content-program-start').fill('09:00');
    await page.locator('#content-program-end').fill('10:00');
    await page.locator('#content-program-attachment').setInputFiles({ name: 'synthetic-schedule.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic audit fixture\n%%EOF\n') });
    const uploadRetry = editor.getByRole('button', { name: '같은 파일 요청 다시 확인' });
    await uploadRetry.waitFor();
    assert.equal(await page.locator('#content-program-attachment').isDisabled(), true);
    await uploadRetry.click();
    await editor.getByText(/업로드 결과를 확인하지 못했습니다/).first().waitFor();
    await uploadRetry.click();
    await uploadRetry.waitFor({ state: 'hidden' });
    assert.equal(new Set(uploadIds).size, 1);
    const uploaded = await fixture.harness.database.query('SELECT id FROM stored_files WHERE event_id=$1 AND original_name=$2', [fixture.eventId, 'synthetic-schedule.pdf']);
    assert.equal(uploaded.rowCount, 1);
    mode = 'malformed';
    await editor.getByRole('button', { name: '초안 저장', exact: true }).click();
    await editor.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const postsBeforeStatus = ids['program.save'].length;
    await editor.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.getByRole('button', { name: '일정 추가', exact: true }).waitFor();
    assert.equal(ids['program.save'].length, postsBeforeStatus);
    const savedProgram = (await workspace()).program.filter((item) => item.title === '합성 일정 복구');
    assert.equal(savedProgram.length, 1);
    assert.equal(savedProgram[0].attachment.fileId, uploaded.rows[0].id);

    phase = 'reload does not persist content';
    await page.getByRole('tab', { name: /^공지/ }).click();
    await page.getByRole('button', { name: '공지 작성', exact: true }).click();
    await page.locator('#content-notice-title').fill('합성 새로고침 공지');
    await page.locator('#content-notice-body').fill('보관하지 않는 합성 본문');
    mode = 'malformed';
    await editor.getByRole('button', { name: '초안 저장', exact: true }).click();
    await editor.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('notice.save') && !stored.includes('합성 새로고침') && !stored.includes('보관하지 않는'));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    assert.equal(await page.getByRole('button', { name: '공지 작성', exact: true }).isDisabled(), true);
    const postsBeforeReloadCheck = ids['notice.save'].length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '공지 작성' && !button.disabled));
    assert.equal(ids['notice.save'].length, postsBeforeReloadCheck);
    assert.equal((await workspace()).notices.filter((item) => item.title === '합성 새로고침 공지').length, 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, originalRequestRetained: true, statusOnly: true, reloadStoresNoContent: true, duplicates: 0 }, null, 2), { mode: 0o600 });
    console.log('Content: original notice and schedule writes recover without duplicate creation');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
