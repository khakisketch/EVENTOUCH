'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

(async () => {
  const output = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(output);
  const fixture = await startAuditFixture();
  let browser;
  let phase = 'setup';
  try {
    const endpoint = `/api/events/${fixture.eventId}`;
    const request = (url, options = {}) => fixture.helpers.requestJson(fixture.harness.baseUrl, url, { cookie: fixture.manager.cookie, ...options });
    const command = (name, payload) => request(`${endpoint}/commands`, { method: 'POST',
      body: { commandId: crypto.randomUUID(), command: name, payload } });
    const current = async () => {
      const response = await request(`${endpoint}/bootstrap`);
      assert.equal(response.status, 200);
      return response.json.state.events.find((event) => event.id === fixture.eventId).features;
    };
    assert.equal((await command('event.features', { features: ['draw', 'poll', 'screen', 'venue'] })).status, 200);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const writes = [];
    page.on('request', (req) => { if (req.url().endsWith('/commands') && req.method() === 'POST') writes.push(req.postDataJSON()); });
    let readFault = '';
    let releaseRead;
    await page.route('**/bootstrap', async (route) => {
      const fault = readFault;
      readFault = '';
      if (fault === '503') return route.fulfill({ status: 503, json: { error: 'synthetic' } });
      if (fault === 'partial') {
        const response = await route.fetch();
        const body = await response.json();
        delete body.state.events.find((event) => event.id === fixture.eventId).features;
        return route.fulfill({ response, json: body });
      }
      if (fault === 'delay') await new Promise((resolve) => { releaseRead = resolve; });
      return route.continue();
    });
    let commandFault = '';
    await page.route('**/commands', async (route) => {
      const fault = commandFault;
      commandFault = '';
      if (fault === 'abort') return route.abort('failed');
      if (fault === '403') return route.fulfill({ status: 403, json: { error: 'synthetic' } });
      if (fault === '409') return route.fulfill({ status: 409, json: { error: 'synthetic' } });
      if (fault === 'commit-loss') {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`);
    await page.locator('#set-name').fill('합성 다른 구역 초안');
    await page.getByRole('tab', { name: /^운영 기능/ }).click();
    await page.getByLabel('퀴즈', { exact: true }).check();
    await page.screenshot({ path: path.join(output, 'features-before-conflict.png'), fullPage: true });

    phase = 'other operator and unrelated reload';
    assert.equal((await command('event.features', { features: ['draw', 'poll', 'screen', 'venue', 'reward', 'payment'] })).status, 200);
    await page.getByRole('tab', { name: /^기본 정보/ }).click();
    await page.getByRole('button', { name: '기본 정보 저장' }).click();
    await page.getByText('기본 정보를 저장했습니다.', { exact: false }).first().waitFor();
    await page.getByRole('tab', { name: /^운영 기능/ }).click();
    assert.equal(await page.getByLabel('퀴즈', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('경품', { exact: true }).isChecked(), false);
    const [conflict] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'event.features'),
      page.getByRole('button', { name: '운영 기능 저장' }).click(),
    ]);
    assert.equal(conflict.status(), 409);
    assert.equal((await conflict.json()).code, 'EVENT_FEATURES_CHANGED');
    assert.ok((await current()).includes('reward') && (await current()).includes('payment'));
    await page.getByRole('heading', { name: '다른 작업에서 운영 기능이 변경됐습니다' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '운영 기능 저장' }).isDisabled(), true);

    phase = 'read failure and compare';
    readFault = '503';
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByText('최신 설정을 불러오지 못했습니다.', { exact: false }).waitFor();
    readFault = 'partial';
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByText('최신 설정을 불러오지 못했습니다.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('table', { name: '최신 설정과 내가 선택한 운영 기능 비교' }).count(), 0);
    readFault = 'delay';
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByRole('button', { name: '최신 설정 확인 중…' }).waitFor();
    assert.equal(await page.getByLabel('퀴즈', { exact: true }).isChecked(), true);
    releaseRead();
    const table = page.getByRole('table', { name: '최신 설정과 내가 선택한 운영 기능 비교' });
    await table.waitFor();
    assert.equal(await table.locator('tbody tr').count(), 11);
    assert.deepEqual(await table.getByRole('row', { name: '경품 다름 켜짐 꺼짐' }).locator('td').allTextContents(), ['켜짐', '꺼짐']);
    assert.equal(await table.getByRole('rowheader', { name: '경품 다름' }).getByText('다름').count(), 1, 'differences have a text label');
    assert.equal(await table.getByRole('rowheader', { name: '투표' }).getByText('다름').count(), 0, 'unchanged choices are not marked different');
    await page.getByText('위의 내 선택 전체가 적용됩니다.', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(output, 'features-conflict.png'), fullPage: true });
    await page.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow at ${width}`);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => item.id)), []);
      if (width === 390) await page.screenshot({ path: path.join(output, 'features-conflict-390.png'), fullPage: true });
    }
    await page.getByRole('button', { name: '내 선택으로 계속' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '최신 설정 사용');
    const writesBeforeChoice = writes.length;
    await page.getByRole('button', { name: '내 선택으로 계속' }).click();
    assert.equal(writes.length, writesBeforeChoice);
    assert.ok((await current()).includes('reward'));
    await page.getByLabel('경품', { exact: true }).check();
    await page.getByRole('button', { name: '운영 기능 저장' }).click();
    await page.getByText('운영 기능 설정을 저장했습니다.', { exact: false }).first().waitFor();
    assert.ok((await current()).includes('payment') && (await current()).includes('reward') && (await current()).includes('quiz'));

    phase = 'hidden latest removal';
    const fresh = await context.newPage();
    await fresh.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`);
    await fresh.getByRole('tab', { name: /^운영 기능/ }).click();
    await fresh.getByLabel('퀴즈', { exact: true }).uncheck();
    const existing = await current();
    assert.equal((await command('event.features', { features: existing.filter((value) => value !== 'payment') })).status, 200);
    await fresh.getByRole('button', { name: '운영 기능 저장' }).click();
    await fresh.getByRole('heading', { name: '다른 작업에서 운영 기능이 변경됐습니다' }).waitFor();
    await fresh.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await fresh.getByRole('table', { name: '최신 설정과 내가 선택한 운영 기능 비교' }).waitFor();
    await fresh.getByRole('button', { name: '내 선택으로 계속' }).click();
    await fresh.getByRole('button', { name: '운영 기능 저장' }).click();
    await fresh.getByText('운영 기능 설정을 저장했습니다.', { exact: false }).first().waitFor();
    assert.equal((await current()).includes('payment'), false);
    await fresh.close();

    phase = 'unconfirmed request and receipt';
    await page.reload();
    await page.getByRole('tab', { name: /^운영 기능/ }).click();
    await page.getByLabel('Q&A', { exact: true }).check();
    commandFault = 'abort';
    await page.getByRole('button', { name: '운영 기능 저장' }).click();
    const recovery = page.getByRole('region', { name: '행사 설정 처리 확인 필요' });
    await recovery.waitFor();
    assert.equal((await command('event.features', { features: [...new Set([...(await current()), 'reward'])] })).status, 200);
    for (const fault of ['403', '409']) {
      commandFault = fault;
      await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
      assert.equal(await recovery.isVisible(), true);
    }
    // Make the newer state actually differ from the frozen baseline.
    assert.equal((await command('event.features', { features: (await current()).filter((value) => value !== 'reward') })).status, 200);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: '다른 작업에서 운영 기능이 변경됐습니다' }).waitFor();
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByRole('table', { name: '최신 설정과 내가 선택한 운영 기능 비교' }).waitFor();
    await page.getByRole('button', { name: '내 선택으로 계속' }).click();
    commandFault = 'commit-loss';
    await page.getByRole('button', { name: '운영 기능 저장' }).click();
    await recovery.waitFor();
    const committed = await current();
    assert.ok(committed.includes('qa'));
    assert.equal((await command('event.features', { features: [...new Set([...committed, 'reward'])] })).status, 200);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.ok((await current()).includes('reward'));
    assert.equal(await page.getByRole('heading', { name: '다른 작업에서 운영 기능이 변경됐습니다' }).count(), 0);

    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ crossSectionBaselinePreserved: true, allVisibleCompared: true,
      hiddenLatestOnPreserved: true, hiddenLatestOffPreserved: true, failedPartialAndDelayedReads: true, explicitManualSave: true,
      ambiguousDenialsRemainPending: true, committedReceiptReplay: true, keyboard: true, responsiveAndAxe: [320, 390, 1280] }, null, 2), { mode: 0o600 });
    console.log(`features conflict audit passed: ${output}`);
  } catch (error) {
    console.error(`features conflict audit failed at ${phase}`);
    throw error;
  } finally {
    await browser?.close();
    await fixture.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
