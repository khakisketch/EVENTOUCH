'use strict';
// Isolated files and synthetic recipients only; this audit never sends a message.
for (const key of Object.keys(process.env)) {
  if (/^(?:SOLAPI_|MESSAGING_|ADMIN_)/.test(key) || /^EVENTOUCH_(?:MESSAGE_|PUBLIC_URL|DEV_)/.test(key)) delete process.env[key];
}
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { chooseRadio, openMessageMore } = require('./ui-journey-helpers.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'mms-upload-before' : 'mms-upload-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const { database } = fixture.harness;
    const workspace = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const person = workspace.participants.find((item) => item.status === 'APPROVED');
    assert.ok(person, 'fixture includes an approved participant');
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const requests = new Map();
    let sends = 0;
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() === 'POST' && ['message.create', 'message.create-reviewed'].includes(route.request().postDataJSON().command)) sends += 1;
      return route.continue();
    });
    await page.route('**/api/events/*/files?*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const url = new URL(route.request().url());
      const name = url.searchParams.get('name');
      if (!['mms-recovery.jpg', 'mms-partial.jpg'].includes(name)) return route.continue();
      const ids = requests.get(name) || [];
      ids.push(url.searchParams.get('commandId'));
      requests.set(name, ids);
      if (ids.length === 1) {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, 'upload commits before the simulated response fault');
        if (name === 'mms-partial.jpg') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"file":{"fileId":"unrelated","name":"other.jpg","type":"image/jpeg","size":1,"width":1,"height":1}}' });
        return route.abort('failed');
      }
      if (name === 'mms-recovery.jpg' && ids.length === 2) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages?to=${encodeURIComponent(person.id)}`, { waitUntil: 'networkidle' });
    await openMessageMore(page); // Reopened 2026-11-24 (시안 A): the photo and the optional record title sit under 더 보기
    await page.locator('#campaign-title').fill('합성 사진 확인');
    await page.locator('#campaign-body').fill('발송하지 않는 합성 본문');
    if (before) await chooseRadio(page, 'campaign-channel', 'MMS');
    else assert.equal(await page.locator('#campaign-channel input[value=SMS]').isChecked(), true, 'photo selection begins from the automatic text family');
    const jpeg = Buffer.alloc(1024);
    Buffer.from('ffd8ffc0000b080001000a01011100ffd9', 'hex').copy(jpeg);
    await page.locator('#campaign-channel input[value=MMS]').check({ force: true }); // Reopened 2026-11-26: 사진 문자 is chosen before the photo
    const input = page.locator('#campaign-image');
    const recovery = page.getByRole('region', { name: 'MMS 사진 확인 필요' });
    phase = 'upload committed but response lost';
    await input.setInputFiles({ name: 'mms-recovery.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    if (before) {
      await page.getByRole('alert').first().waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      assert.equal(await input.isDisabled(), false);
      console.log('MMS upload before capture: the original request is not recoverable');
      return;
    }
    await recovery.waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'mms-upload-recovery-heading');
    assert.equal(await input.isDisabled(), true);
    assert.equal(await page.locator('#campaign-title').isDisabled(), true);
    assert.equal(await page.locator('#campaign-submit').isDisabled(), true);
    const denied = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/files?'));
    await recovery.getByRole('button', { name: '같은 사진 요청 다시 시도' }).click();
    await denied;
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 사진 요청 다시 시도' && !button.disabled));
    assert.equal(await input.isDisabled(), true, 'later 403 cannot settle the earlier lost upload');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await recovery.getByRole('button', { name: '같은 사진 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    await page.locator('#campaign-image-help').getByText(/첨부됨: mms-recovery.jpg/).waitFor();
    assert.equal(new Set(requests.get('mms-recovery.jpg')).size, 1);
    assert.ok(requests.get('mms-recovery.jpg')[0]);
    const uploaded = await database.query('SELECT id FROM stored_files WHERE event_id=$1 AND original_name=$2', [fixture.eventId, 'mms-recovery.jpg']);
    assert.equal(uploaded.rowCount, 1);
    phase = 'semantically incorrect success response';
    await page.setViewportSize({ width: 1280, height: 900 });
    await input.setInputFiles({ name: 'mms-partial.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await recovery.waitFor();
    assert.match(await page.locator('#campaign-image-help').textContent(), /mms-recovery.jpg/);
    await recovery.getByRole('button', { name: '같은 사진 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    await page.locator('#campaign-image-help').getByText(/첨부됨: mms-partial.jpg/).waitFor();
    assert.equal(new Set(requests.get('mms-partial.jpg')).size, 1);
    assert.equal((await database.query('SELECT id FROM stored_files WHERE event_id=$1 AND original_name=$2', [fixture.eventId, 'mms-partial.jpg'])).rowCount, 1);
    assert.equal(sends, 0, 'upload recovery never sends a message');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, sameFileAndId: true, after403: true, rejectsWrongFileResponse: true, duplicateFiles: 0, messagesSent: 0 }, null, 2), { mode: 0o600 });
    console.log('MMS: lost and incorrect upload responses recover with the original file and request');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
