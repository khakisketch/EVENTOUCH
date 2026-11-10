'use strict';
// Real signup validation and recovery against an isolated synthetic event.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'register-field-error');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser, page;
  try {
    const command = async (name, payload) => {
      const result = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.equal(result.status, 200, `fixture ${name}`); return result.json;
    };
    let customId;
    for (let index = 0; index < 5; index++) {
      const result = await command('field.save', { label: `추가 질문 ${index + 1}`, type: 'text', required: false });
      if (index === 0) customId = result.field.id;
    }
    await command('form.publish', {});
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const duplicate = (await read()).participants[0];
    browser = await launchBrowser();
    async function open(width) {
      const context = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      await page.goto(`${f.baseUrl}/event/${f.slug}/register`, { waitUntil: 'networkidle' });
      await page.locator('#field-name').fill('합성 신청자');
      await page.locator('#field-phone').fill('123');
      await page.locator(`#field-${customId}`).fill('보존할 응답');
      if (await page.locator('#consent').count()) await page.locator('#consent').check();
      return { context, page };
    }
    const errors = [];
    for (const width of [320, 390, 1280]) {
      const current = await open(width); page = current.page;
      const beforeCount = (await read()).participants.length;
      const requests = [];
      page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/signup')) requests.push(request.postDataJSON()); });
      page.on('pageerror', error => errors.push(error.message));
      const response = page.waitForResponse(res => res.url().includes('/signup') && res.request().method() === 'POST');
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      assert.equal((await response).status(), 400);
      await page.locator('#field-phone-error').waitFor();
      await page.locator('#field-phone:enabled').waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'field-phone', null, { timeout: 3000 });
      const rect = await page.locator('#field-phone-error').boundingBox();
      assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= (width === 320 ? 568 : 844), `error visible at ${width}px`);
      const inputRect = await page.locator('#field-phone').boundingBox();
      const hintRect = await page.locator('#field-phone-hint').boundingBox();
      assert.ok(inputRect && hintRect && hintRect.y - (inputRect.y + inputRect.height) >= 6, 'focused input outline does not overlap its hint');
      assert.equal(await page.locator('#field-phone').getAttribute('aria-invalid'), 'true');
      assert.match(await page.locator('#field-phone').getAttribute('aria-describedby'), /field-phone-error/);
      assert.equal(await page.locator(`#field-${customId}`).inputValue(), '보존할 응답');
      assert.equal((await read()).participants.length, beforeCount);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.evaluate(axe);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 1280) await page.screenshot({ path: path.join(out, `invalid-${width}.png`) });
      if (width === 390) {
        await page.locator('#field-phone').fill('01098761235');
        await page.getByRole('button', { name: '신청하기', exact: true }).click();
        await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
        assert.equal(requests.length, 2);
        assert.notEqual(requests[0].commandId, requests[1].commandId);
        assert.equal((await read()).participants.filter(person => person.phone === '01098761235').length, 1);
      }
      await current.context.close(); page = null;
    }
    // Duplicate signup must keep its recovery explanation next to the field.
    {
      const current = await open(390); page = current.page;
      await page.locator('#field-phone').fill(duplicate.phone);
      const response = page.waitForResponse(res => res.url().includes('/signup') && res.request().method() === 'POST');
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      assert.equal((await response).status(), 409);
      await page.waitForFunction(() => document.activeElement?.id === 'field-phone');
      const recovery = page.locator('#field-phone').locator('xpath=..').getByRole('status');
      assert.match(await recovery.innerText(), /이미 신청/);
      await page.screenshot({ path: path.join(out, 'duplicate-390.png') });
      await page.locator('#field-phone').fill('01098761234');
      assert.equal(await recovery.count(), 0, 'editing the phone clears the duplicate recovery notice');
      await current.context.close(); page = null;
    }
    // A response arriving after the attendee chose another destination must
    // not steal focus. The field error remains present for later review.
    {
      const current = await open(390); page = current.page;
      let release; const held = new Promise(resolve => { release = resolve; });
      let reached; const intercepted = new Promise(resolve => { reached = resolve; });
      await page.route('**/api/events/*/signup', async route => {
        const response = await route.fetch(); reached(); await held; await route.fulfill({ response });
      });
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      await intercepted;
      const other = page.getByRole('link', { name: '← 행사 안내로' });
      await other.focus(); release();
      await page.locator('#field-phone-error').waitFor();
      await page.locator('#field-phone:enabled').waitFor();
      await page.waitForTimeout(100);
      assert.equal(await other.evaluate(el => document.activeElement === el), true);
      await current.context.close(); page = null;
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ realApi: true, inputPreserved: true, singleSignup: true, duplicateRecovery: true, delayedResponseFocus: true, syntheticData: true }, null, 2), { mode: 0o600 });
    console.log('Register: server field error, correction, duplicate recovery and delayed focus passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
