'use strict';
// Local fake SMS supplier + isolated PostgreSQL. Never contacts a real sender.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'verification-before' : 'verification-uncertain');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const codes = new Map(); let sent = 0;
  const supplier = http.createServer((req, res) => {
    let body = ''; req.on('data', (part) => { body += part; });
    req.on('end', () => {
      try {
        const message = JSON.parse(body).messages[0];
        const code = String(message.text).match(/인증번호 (\d{6})/)?.[1];
        if (!code) throw new Error('missing code');
        codes.set(String(message.to).replace(/\D/g, ''), code); sent += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ groupInfo: { groupId: 'fixture-local' }, failedMessageList: [] }));
      } catch { res.writeHead(400); res.end(); }
    });
  });
  await new Promise((resolve) => supplier.listen(0, '127.0.0.1', resolve));
  let fixture, browser, page;
  try {
    fixture = await startAuditFixture({ fixtureSolapiHost: `http://127.0.0.1:${supplier.address().port}` });
    await fixture.harness.database.query("UPDATE event_workspaces SET payload=jsonb_set(payload,'{verificationRequired}','true'::jsonb) WHERE event_id=$1", [fixture.eventId]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
    let dialogPolicy = 'accept', dialogSeen = false;
    page.on('dialog', async (dialog) => { dialogSeen = true; if (dialogPolicy === 'dismiss') await dialog.dismiss(); else await dialog.accept(); });
    let requestMode = 'lost'; let confirmMode = 'pass'; let requestPosts = 0; let confirmPosts = 0;
    await page.route('**/api/public/events/*/verification/request', async (route) => {
      requestPosts += 1;
      if (requestMode === 'lost') { requestMode = 'pass'; const real = await route.fetch(); assert.ok(real.ok()); return route.abort('failed'); }
      return route.continue();
    });
    await page.route('**/api/public/events/*/verification/confirm', async (route) => {
      confirmPosts += 1;
      if (confirmMode === 'lost') { confirmMode = 'pass'; const real = await route.fetch(); assert.ok(real.ok()); return route.abort('failed'); }
      return route.continue();
    });
    phase = 'recovery request response lost';
    await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/ticket/recover`, { waitUntil: 'networkidle' });
    await page.getByLabel('신청할 때 입력한 연락처').fill('01000000001');
    if (before) await page.getByRole('button', { name: '인증번호 받기' }).click();
    else await page.evaluate(() => { const form = document.querySelector('form.registration-form'); form.requestSubmit(); form.requestSubmit(); });
    if (before) {
      await page.getByRole('alert').getByText('연결하지 못했습니다. 다시 시도하세요.').waitFor();
      assert.equal(await page.getByLabel('인증번호 6자리').count(), 0);
      await page.screenshot({ path: path.join(out, 'request-lost-before-390.png'), fullPage: true });
      fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'captured', isolated: true }, null, 2), { mode: 0o600 });
      return;
    }
    await page.getByLabel('인증번호 6자리').waitFor();
    await page.getByText('번호로 보낸 요청의 결과는 미확인입니다.', { exact: false }).waitFor();
    assert.equal(requestPosts, 1); assert.equal(sent, 1);
    await page.screenshot({ path: path.join(out, 'request-lost-390.png'), fullPage: true });
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    const firstCode = codes.get('01000000001'); assert.match(firstCode, /^\d{6}$/);
    // After a reload the short-lived challenge still exists on the server.
    // A cooldown response must leave an explicit path to the code already sent.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByLabel('신청할 때 입력한 연락처').fill('01000000001');
    await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
    await page.getByText('인증번호를 다시 받으려면 잠시 후 시도하세요', { exact: false }).waitFor();
    await page.getByRole('button', { name: '이미 받은 인증번호 입력' }).click();
    await page.getByLabel('인증번호 6자리').fill(firstCode);
    await page.getByRole('button', { name: '인증번호 다시 받기' }).click();
    await page.getByText('이전 요청의 발송 여부는 아직 확인되지 않았습니다.', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('인증번호 6자리').inputValue(), firstCode);
    assert.equal(sent, 1, 'rate-limited retry must not send a second message');
    dialogSeen = false; dialogPolicy = 'dismiss';
    await page.getByRole('link', { name: '행사 안내 보기' }).click();
    assert.equal(dialogSeen, true); assert.ok(page.url().endsWith('/ticket/recover'));
    phase = 'recovery confirmation lost and ticket check';
    confirmMode = 'lost';
    await page.getByRole('button', { name: '내 티켓 열기' }).click();
    await page.getByText('인증 결과를 확인하지 못했습니다.', { exact: false }).waitFor();
    assert.equal(confirmPosts, 1);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '인증번호 다시 확인' && !button.disabled));
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '인증번호 다시 확인');
      return button && getComputedStyle(button).backgroundColor === 'rgb(255, 255, 255)';
    });
    const primaryColor = await page.getByRole('button', { name: '연결된 티켓 확인' }).evaluate((element) => getComputedStyle(element).backgroundColor);
    const retryColor = await page.getByRole('button', { name: '인증번호 다시 확인' }).evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(primaryColor, retryColor, 'checking the linked ticket remains visually distinct from reposting the code');
    await page.screenshot({ path: path.join(out, 'confirm-lost-390.png'), fullPage: true });
    const stored = await page.evaluate(() => JSON.stringify(sessionStorage));
    assert.ok(!stored.includes(firstCode) && !stored.includes('01000000001'));
    // Simulate the lost response carrying no usable cookie, without touching
    // any real browser profile. The existing ticket page must offer recovery.
    await context.clearCookies();
    await page.getByRole('button', { name: '연결된 티켓 확인' }).click();
    await page.waitForURL(/\/ticket$/);
    await page.getByRole('heading', { name: '티켓이 확인되지 않습니다' }).waitFor();
    await context.close();

    phase = 'a malformed successful recovery response does not imply a session';
    const malformedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await malformedContext.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/ticket/recover`, { waitUntil: 'networkidle' });
    await page.getByLabel('신청할 때 입력한 연락처').fill('01000000002');
    await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
    await page.getByLabel('인증번호 6자리').waitFor();
    await page.getByLabel('인증번호 6자리').fill(codes.get('01000000002'));
    await page.route('**/api/public/events/*/verification/confirm', async (route) => {
      const real = await route.fetch(); assert.ok(real.ok());
      return route.fulfill({ response: real, contentType: 'application/json', body: '{"ok":true,"grant":"wrong-kind"}' });
    });
    await page.getByRole('button', { name: '내 티켓 열기' }).click();
    await page.getByText('인증 결과를 확인하지 못했습니다.', { exact: false }).waitFor();
    assert.ok(page.url().endsWith('/ticket/recover'));
    await malformedContext.close();

    phase = 'signup request and confirmation results lost';
    const signupContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await signupContext.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    let signupRequests = 0, signupConfirm = 0; requestMode = 'lost'; confirmMode = 'lost';
    await page.route('**/api/public/events/*/verification/request', async (route) => {
      signupRequests += 1;
      if (requestMode === 'lost') { requestMode = 'pass'; const real = await route.fetch(); assert.ok(real.ok()); return route.abort('failed'); }
      return route.continue();
    });
    await page.route('**/api/public/events/*/verification/confirm', async (route) => {
      signupConfirm += 1;
      if (confirmMode === 'lost') { confirmMode = 'pass'; const real = await route.fetch(); assert.ok(real.ok()); return route.abort('failed'); }
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`, { waitUntil: 'networkidle' });
    await page.locator('#field-name').fill('인증 합성 신청자');
    await page.locator('#field-phone').fill('01044445555');
    await page.locator('#consent').check();
    await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
    await page.getByText('발송 여부는 미확인입니다.', { exact: false }).waitFor();
    assert.equal(signupRequests, 1);
    await page.locator('#verify-code').fill(codes.get('01044445555'));
    await page.getByRole('button', { name: '인증 확인', exact: true }).click();
    await page.getByText('인증 결과를 확인하지 못했습니다.', { exact: false }).waitFor();
    await page.getByRole('button', { name: '인증 확인', exact: true }).click();
    await page.getByText('인증 결과를 확인하지 못했습니다.', { exact: false }).waitFor();
    assert.equal(signupConfirm, 2);
    await page.getByRole('button', { name: '인증번호 다시 받기' }).click();
    await page.getByText('인증번호 요청을 접수했습니다.', { exact: false }).waitFor();
    assert.equal(signupRequests, 2);
    await page.locator('#verify-code').fill(codes.get('01044445555'));
    await page.getByRole('button', { name: '인증 확인', exact: true }).click();
    await page.getByText('연락처 인증됨.', { exact: false }).waitFor();
    await page.getByRole('button', { name: '신청하기', exact: true }).click();
    await page.waitForURL(/\/ticket/);
    const workspace = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(workspace.participants.filter((person) => person.phone === '01044445555').length, 1);
    assert.deepEqual(pageErrors, []);
    await signupContext.close();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, realSms: false,
      requestLost: true, doubleSubmitBlocked: true, resend429: true, confirmLost: true, malformedConfirm: true,
      signupRecovered: true, sensitiveStorage: false }, null, 2), { mode: 0o600 });
    console.log('Verification: lost send and confirmation responses recover without silent duplicate requests');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close(); if (fixture) await fixture.close();
    await new Promise((resolve) => supplier.close(resolve));
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
