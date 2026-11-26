'use strict';
// Isolated browser -> real API -> PostgreSQL. Faults are injected only after
// the real write committed; no real customer data or external service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { settleLayout } = require('./ui-journey-helpers.cjs');
const before = process.argv.includes('--before');
let stage = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'org-write-before' : 'org-write-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const ownerId = `audit-owner-${fixture.suffix}`;
    const cookie = await fixture.helpers.sessionCookie(fixture.harness, ownerId);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), url: fixture.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const db = fixture.harness.database;
    const count = async (table, name) => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE payload->>'name'=$1`, [name])).rows[0].n;
    await page.goto(`${fixture.baseUrl}/console/clients`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '고객사 등록', exact: true }).click();
    await page.locator('#client-name').fill('합성 고객사 보호');
    await page.screenshot({ path: path.join(out, 'client-form-1280.png'), fullPage: true });
    if (before) {
      await page.route('**/api/clients', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
      });
      await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
      await page.getByRole('dialog').getByText(/응답을 확인하지 못했습니다/).waitFor();
      await page.screenshot({ path: path.join(out, 'before-client-unconfirmed-1280.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-client-unconfirmed-390.png'), fullPage: true });
      console.log('Organization write before capture passed');
      return;
    }

    let clientMode = 'malformed';
    let eventMode = 'pass';
    let fileMode = 'pass';
    const clientIds = [];
    const eventIds = [];
    const fileIds = [];
    const intercept = (kind) => async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      const ids = kind === 'client' ? clientIds : eventIds;
      ids.push(body.commandId);
      const mode = kind === 'client' ? clientMode : eventMode;
      const setMode = (next) => { if (kind === 'client') clientMode = next; else eventMode = next; };
      if (mode === 'malformed' || mode === 'lost') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, `${kind} must commit before fault`);
        setMode(mode === 'lost' ? 'rejected' : 'pass');
        return mode === 'lost' ? route.abort('failed') : route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
      }
      if (mode === 'rejected') { setMode('pass'); return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      return route.continue();
    };
    await page.route('**/api/clients', intercept('client'));
    await page.route('**/api/events', intercept('event'));
    await page.route(/\/api\/clients\/[^/]+\/files\?/, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      fileIds.push(new URL(route.request().url()).searchParams.get('commandId'));
      if (fileMode === 'lost') {
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        fileMode = 'rejected';
        return route.abort('failed');
      }
      if (fileMode === 'rejected') { fileMode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      return route.continue();
    });

    stage = 'client malformed success and status check';
    await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).waitFor();
    assert.equal(await page.locator('#client-name').getAttribute('readonly'), '');
    assert.equal(await count('clients', '합성 고객사 보호'), 1);
    await page.screenshot({ path: path.join(out, 'client-unconfirmed-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'client-unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    // Reopened 2026-11-26: colour contrast is sampled mid-transition (the dialog fades in) unless the page has settled first.
    await settleLayout(page);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    const clientPosts = clientIds.length;
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(clientIds.length, clientPosts, 'status check sends no save request');
    await page.getByText('고객사 저장이 반영된 것을 확인하고 목록을 불러왔습니다.').waitFor();

    stage = 'file upload and client-link response loss';
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = page.locator('li').filter({ has: page.getByRole('heading', { name: '합성 고객사 보호', exact: true }) });
    await row.getByRole('button', { name: '합성 고객사 보호', exact: true }).click();
    await page.getByRole('dialog', { name: '고객사 정보 수정' }).waitFor();
    fileMode = 'lost';
    clientMode = 'malformed';
    await page.getByRole('dialog', { name: '고객사 정보 수정' }).locator('input[type=file]').first().setInputFiles({ name: 'synthetic-logo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
    const fileRecovery = page.getByRole('region', { name: '파일 처리 확인' });
    await fileRecovery.getByRole('button', { name: '같은 파일 요청 다시 확인' }).waitFor();
    await page.getByText(/연결이 끊겨 파일 처리 결과/).waitFor();
    assert.equal(await page.getByRole('button', { name: '고객사 등록', exact: true }).isDisabled(), true);
    await page.screenshot({ path: path.join(out, 'file-unconfirmed-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'file-unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await fileRecovery.getByRole('button', { name: '같은 파일 요청 다시 확인' }).click();
    await page.getByText(/파일 업로드 결과를 확인하지 못했습니다/).waitFor();
    await fileRecovery.getByRole('button', { name: '같은 파일 요청 다시 확인' }).click();
    await page.getByText(/고객사 연결 결과를 확인하지 못했습니다/).waitFor();
    const filePostCount = fileIds.length;
    await fileRecovery.getByRole('button', { name: '같은 파일 요청 다시 확인' }).click();
    await fileRecovery.waitFor({ state: 'hidden' });
    assert.equal(new Set(fileIds).size, 1, 'upload retries keep their original id');
    assert.equal(fileIds.length, filePostCount, 'a known upload is not repeated when only linking needs confirmation');
    assert.equal(clientIds.at(-1), clientIds.at(-2), 'link retry keeps its original id');
    const attachment = await db.query("SELECT c.payload->>'logoFileId' AS file_id, count(f.id)::int AS files FROM clients c JOIN stored_files f ON f.client_id=c.id WHERE c.payload->>'name'=$1 GROUP BY c.payload", ['합성 고객사 보호']);
    assert.equal(attachment.rows[0].files, 1);
    assert.ok(attachment.rows[0].file_id);
    assert.equal((await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '')).includes('synthetic-logo.png'), false);

    stage = 'client lost response, rejection, same-id replay';
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '고객사 등록', exact: true }).click();
    await page.locator('#client-name').fill('합성 고객사 재시도');
    clientMode = 'lost';
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await dialog.getByText(/저장 결과를 확인하지 못했습니다/).waitFor();
    assert.equal(await page.locator('#client-name').getAttribute('readonly'), '');
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(new Set(clientIds.slice(-3)).size, 1);
    assert.equal(await count('clients', '합성 고객사 재시도'), 1);

    stage = 'reload retains only pointer';
    await page.getByRole('button', { name: '고객사 등록', exact: true }).click();
    await page.locator('#client-name').fill('합성 고객사 새로고침');
    clientMode = 'malformed';
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).waitFor();
    const pointer = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator'));
    assert.ok(pointer && !pointer.includes('합성 고객사 새로고침'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('region', { name: '처리 결과 확인' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '고객사 등록', exact: true }).isDisabled(), true);
    await page.getByRole('region', { name: '처리 결과 확인' }).getByRole('button', { name: '서버 처리 확인' }).click();
    await page.getByRole('button', { name: '고객사 등록', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '고객사 등록' && !button.disabled));
    assert.equal(await count('clients', '합성 고객사 새로고침'), 1);

    stage = 'inline client status check preserves event draft';
    await page.goto(`${fixture.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '새 행사 만들기', exact: true }).click();
    await page.locator('#create-name').fill('합성 행사 복구');
    await page.locator('#create-date').fill('2027-05-21');
    await page.locator('[data-create-settings] > summary').click();
    await page.getByRole('button', { name: '새 고객사 등록', exact: true }).click();
    await page.locator('#create-new-client-name').fill('합성 행사 고객사');
    clientMode = 'malformed';
    await dialog.getByRole('button', { name: '고객사 등록', exact: true }).click();
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).waitFor();
    assert.equal(await page.locator('#create-new-client-name').getAttribute('readonly'), '');
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await page.locator('#create-client').waitFor();
    assert.equal(await page.locator('#create-name').inputValue(), '합성 행사 복구');
    assert.equal(await page.locator('#create-client').inputValue(), '', 'status-only receipt never guesses between customer names');
    await page.locator('#create-client').selectOption({ label: '합성 행사 고객사' });

    stage = 'event lost response and rejected retry';
    eventMode = 'lost';
    await dialog.getByRole('button', { name: '행사 만들기', exact: true }).click();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).waitFor();
    assert.equal(await page.locator('#create-name').getAttribute('readonly'), '');
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await dialog.getByText(/행사 생성 결과를 확인하지 못했습니다/).waitFor();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await page.waitForURL(/\/console\/events\/[^/]+/);
    assert.equal(new Set(eventIds.slice(-3)).size, 1);
    assert.equal(await count('events', '합성 행사 복구'), 1);

    stage = 'event status-only confirmation';
    await page.goto(`${fixture.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '새 행사 만들기', exact: true }).click();
    await page.locator('#create-name').fill('합성 행사 확인');
    await page.locator('#create-date').fill('2027-05-22');
    eventMode = 'malformed';
    await dialog.getByRole('button', { name: '행사 만들기', exact: true }).click();
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).waitFor();
    const eventPosts = eventIds.length;
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('행사 생성이 서버에 반영된 것을 확인했습니다. 목록에서 행사를 확인하세요.').waitFor();
    assert.equal(eventIds.length, eventPosts);
    assert.equal(await count('events', '합성 행사 확인'), 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', apiAndDatabaseReal: true, syntheticData: true, partialResponses: true, lostThenRejected: true, sameIdRetry: true, uploadAndLinkRecovery: true, statusOnly: true, noPersonalInputPersisted: true }, null, 2), { mode: 0o600 });
    console.log('Customer and event creation: uncertain responses, same-id retries and status-only recovery passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
