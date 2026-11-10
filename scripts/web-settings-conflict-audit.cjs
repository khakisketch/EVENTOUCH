'use strict';

// Two operators, isolated PostgreSQL, real browser and real command receipts.
// Network interception is restricted to testing failed/incomplete reads.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const axeSource = require('axe-core').source;

(async () => {
  const output = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(output);
  const fixture = await startAuditFixture();
  let browser;
  let phase = 'setup';
  try {
    const endpoint = `/api/events/${fixture.eventId}`;
    const request = (url, options = {}) => fixture.helpers.requestJson(fixture.harness.baseUrl, url, { cookie: fixture.manager.cookie, ...options });
    const bootstrap = async () => {
      const result = await request(`${endpoint}/bootstrap`);
      assert.equal(result.status, 200);
      return result.json.state;
    };
    const command = async (name, payload) => request(`${endpoint}/commands`, {
      method: 'POST', body: { commandId: crypto.randomUUID(), command: name, payload },
    });
    const workspace = async () => (await bootstrap()).workspaces[fixture.eventId];
    const event = async () => (await bootstrap()).events.find((item) => item.id === fixture.eventId);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const posts = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/commands') && req.method() === 'POST') posts.push(req.postDataJSON());
    });
    let tamper = '';
    let releaseDelayed;
    await page.route('**/bootstrap', async (route) => {
      const mode = tamper;
      tamper = '';
      if (mode === 'delayed') await new Promise((resolve) => { releaseDelayed = resolve; });
      if (mode === 'failure') return route.fulfill({ status: 503, json: { error: 'synthetic' } });
      if (mode === 'partial-intake' || mode === 'partial-basics') {
        const response = await route.fetch();
        const data = await response.json();
        if (mode === 'partial-intake') delete data.state.workspaces[fixture.eventId].consentVersion;
        else delete data.state.events.find((item) => item.id === fixture.eventId).date;
        return route.fulfill({ response, json: data });
      }
      return route.continue();
    });
    let commandFault = '';
    await page.route('**/commands', async (route) => {
      const mode = commandFault;
      commandFault = '';
      if (mode === 'abort') return route.abort('failed');
      if (mode === 'deny') return route.fulfill({ status: 403, json: { error: '합성 권한 오류' } });
      if (mode === 'generic-conflict') return route.fulfill({ status: 409, json: { error: '합성 일반 충돌' } });
      if (mode === 'commit-loss') {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        return route.abort('failed');
      }
      return route.continue();
    });
    async function inspectLayout(label) {
      await page.evaluate(axeSource);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert.equal(overflow, false, `${label}: overflow at ${width}`);
        const violations = await page.evaluate(async () => (await window.axe.run()).violations.filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => item.id));
        assert.deepEqual(violations, [], `${label}: axe at ${width}`);
        if (width === 390) await page.screenshot({ path: path.join(output, `${label}-390.png`), fullPage: true });
      }
    }
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`);
    await page.locator('#set-name').fill('합성 운영자 A의 이름');
    await page.getByRole('tab', { name: /^참가 접수/ }).click();
    await page.locator('#set-consent').fill('합성 운영자 A의 안내');

    phase = 'intake conflict and read recovery';
    const before = await workspace();
    const published = await command('form.publish', { consentText: '합성 운영자 B의 안내', expectedFormVersion: before.formVersion });
    assert.equal(published.status, 200);
    const [intakeResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/commands') && r.request().postDataJSON()?.command === 'form.publish'),
      page.getByRole('button', { name: '양식 게시·접수 열기' }).click(),
    ]);
    assert.equal(intakeResponse.status(), 409);
    await page.getByRole('heading', { name: '다른 작업에서 참가 접수 설정이 변경됐습니다' }).waitFor();
    assert.equal(await page.locator('#set-consent').inputValue(), '합성 운영자 A의 안내');
    assert.equal(await page.getByRole('button', { name: '양식 게시·접수 열기' }).isDisabled(), true);
    tamper = 'failure';
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByText('최신 설정을 불러오지 못했습니다.', { exact: false }).waitFor();
    tamper = 'partial-intake';
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByText('최신 설정을 불러오지 못했습니다.', { exact: false }).waitFor();
    assert.equal(await page.getByText('최신 동의 안내').count(), 0);
    tamper = 'delayed';
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByRole('button', { name: '최신 설정 확인 중…' }).waitFor();
    assert.equal(await page.locator('#set-consent').inputValue(), '합성 운영자 A의 안내');
    releaseDelayed();
    await page.getByText('합성 운영자 B의 안내', { exact: true }).waitFor();
    await inspectLayout('intake');
    assert.equal(await page.getByText('게시될 신청 항목 3개').isVisible(), true);
    await page.getByRole('link', { name: '신청 항목 편집' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '내 작성 내용으로 계속');
    await page.screenshot({ path: path.join(output, 'intake-conflict.png'), fullPage: true });
    const beforeSelection = posts.length;
    await page.getByRole('button', { name: '내 작성 내용으로 계속' }).click();
    assert.equal(posts.length, beforeSelection);
    assert.equal((await workspace()).consentText, '합성 운영자 B의 안내');

    phase = 'basic baseline survives unrelated save';
    const otherEvent = await event();
    const otherWorkspace = await workspace();
    const changed = await command('event.update', {
      name: otherEvent.name, slug: otherEvent.slug, clientId: otherEvent.clientId || '', date: otherEvent.date,
      start: otherEvent.start, end: otherEvent.end, capacity: 350, price: Number(otherWorkspace.price) || 0,
      format: otherEvent.format || '', approvalRequired: otherWorkspace.approvalRequired === true,
      allowReentry: otherWorkspace.allowReentry !== false, verificationRequired: true,
    });
    assert.equal(changed.status, 200);
    await page.getByRole('tab', { name: /^운영 기능/ }).click();
    await page.getByLabel('퀴즈', { exact: true }).check();
    await page.getByRole('button', { name: '운영 기능 저장' }).click();
    await page.getByText('운영 기능 설정을 저장했습니다.', { exact: false }).first().waitFor();
    await page.getByRole('tab', { name: /^기본 정보/ }).click();
    assert.equal(await page.locator('#set-name').inputValue(), '합성 운영자 A의 이름');
    const [basicResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/commands') && r.request().postDataJSON()?.command === 'event.basics.save'),
      page.getByRole('button', { name: '기본 정보 저장' }).click(),
    ]);
    assert.equal(basicResponse.status(), 409);
    assert.equal((await basicResponse.json()).code, 'EVENT_BASICS_CHANGED');
    assert.equal((await event()).capacity, 350);
    assert.equal((await workspace()).verificationRequired, true);
    await page.getByRole('heading', { name: '다른 작업에서 기본 정보가 변경됐습니다' }).waitFor();
    tamper = 'partial-basics';
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByText('최신 설정을 불러오지 못했습니다.', { exact: false }).waitFor();
    assert.equal(await page.getByText('최신 기본 정보').count(), 0);
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByText('최신 기본 정보').waitFor();
    const basicTable = page.getByRole('table', { name: '최신 정보와 내가 작성 중인 기본 정보 비교' });
    assert.equal(await basicTable.locator('tbody tr').count(), 12, 'all basic fields remain reviewable');
    const capacityRow = basicTable.getByRole('row', { name: /정원 다름/ });
    assert.deepEqual(await capacityRow.locator('td').allTextContents(), ['350', '200'], 'each changed value stays beside its corresponding field');
    assert.equal(await basicTable.getByRole('rowheader', { name: '날짜' }).getByText('다름').count(), 0, 'unchanged fields are not marked different');
    await page.getByText('다른 운영자가 바꾼 항목을 포함해 현재 입력된 기본 정보 전체가 적용됩니다.', { exact: false }).waitFor();
    await inspectLayout('basics');
    await page.screenshot({ path: path.join(output, 'basics-conflict.png'), fullPage: true });
    const beforeLatest = posts.length;
    await page.getByRole('button', { name: '최신 정보 사용' }).click();
    assert.equal(posts.length, beforeLatest);
    assert.equal(await page.locator('#set-capacity').inputValue(), '350');
    assert.equal(await page.locator('#set-name').inputValue(), otherEvent.name);
    await page.locator('#set-name').fill('합성 확인 후 저장');
    await page.getByRole('button', { name: '기본 정보 저장' }).click();
    await page.getByText('기본 정보를 저장했습니다.', { exact: false }).first().waitFor();
    assert.equal((await event()).name, '합성 확인 후 저장');
    assert.equal((await event()).capacity, 350);
    assert.equal((await workspace()).verificationRequired, true);
    await page.getByRole('tab', { name: /^참가 접수/ }).click();
    assert.equal(await page.locator('#set-consent').inputValue(), '합성 운영자 A의 안내');
    await page.getByRole('button', { name: '양식 게시·접수 열기' }).click();
    await page.getByText('양식을 게시하고 접수를 열었습니다.', { exact: false }).first().waitFor();
    assert.equal((await workspace()).consentText, '합성 운영자 A의 안내');

    phase = 'unconfirmed receipt versus definite conflict';
    await page.getByRole('button', { name: '양식 게시·접수 열기' }).waitFor({ state: 'visible' });
    await page.locator('#set-consent').fill('합성 미확정 A');
    commandFault = 'abort';
    await page.getByRole('button', { name: '양식 게시·접수 열기' }).click();
    const recovery = page.getByRole('region', { name: '행사 설정 처리 확인 필요' });
    await recovery.waitFor();
    let pendingGuard = '';
    page.once('dialog', async (dialog) => { pendingGuard = dialog.message(); await dialog.dismiss(); });
    await page.getByRole('link', { name: '신청 항목 편집' }).click();
    assert.match(pendingGuard, /응답을 확인하지 못한 요청/);
    const afterLoss = await workspace();
    const raced = await command('form.publish', { consentText: '합성 미확정 B', expectedFormVersion: afterLoss.formVersion });
    assert.equal(raced.status, 200);
    commandFault = 'deny';
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
    assert.equal(await recovery.isVisible(), true, 'a later generic denial cannot settle an uncertain receipt');
    commandFault = 'generic-conflict';
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
    assert.equal(await recovery.isVisible(), true, 'a generic conflict cannot settle an uncertain receipt');
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: '다른 작업에서 참가 접수 설정이 변경됐습니다' }).waitFor();
    assert.equal(await page.locator('#set-consent').inputValue(), '합성 미확정 A');
    await page.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await page.getByText('합성 미확정 B', { exact: true }).waitFor();
    await page.getByRole('button', { name: '내 작성 내용으로 계속' }).click();
    commandFault = 'commit-loss';
    await page.getByRole('button', { name: '양식 게시·접수 열기' }).click();
    await recovery.waitFor();
    const committed = await workspace();
    assert.equal(committed.consentText, '합성 미확정 A');
    assert.equal((await command('form.publish', { consentText: '합성 나중 B', expectedFormVersion: committed.formVersion })).status, 200);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('heading', { name: '다른 작업에서 참가 접수 설정이 변경됐습니다' }).count(), 0);
    assert.equal((await workspace()).consentText, '합성 나중 B');

    phase = 'clean consent still requires review of changed fields';
    const fresh = await context.newPage();
    await fresh.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`);
    await fresh.getByRole('tab', { name: /^운영 기능/ }).click();
    const fieldBefore = await workspace();
    assert.equal((await command('field.save', { id: 'synthetic-new', label: '합성 새 항목', type: 'select', required: true,
      options: ['선택 하나', '선택 둘'], expectedFormVersion: fieldBefore.formVersion })).status, 200);
    const quiz = fresh.getByLabel('퀴즈', { exact: true });
    await quiz.setChecked(!(await quiz.isChecked()));
    await fresh.getByRole('button', { name: '운영 기능 저장' }).click();
    await fresh.getByText('운영 기능 설정을 저장했습니다.', { exact: false }).first().waitFor();
    await fresh.getByRole('tab', { name: /^참가 접수/ }).click();
    const [fieldConflict] = await Promise.all([
      fresh.waitForResponse((response) => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'form.publish'),
      fresh.getByRole('button', { name: '양식 게시·접수 열기' }).click(),
    ]);
    assert.equal(fieldConflict.status(), 409);
    let conflictGuard = '';
    fresh.once('dialog', async (dialog) => { conflictGuard = dialog.message(); await dialog.dismiss(); });
    await fresh.getByRole('link', { name: '신청 항목 편집' }).click();
    assert.match(conflictGuard, /최신 설정을 아직 확인하지 않았습니다/);
    assert.doesNotMatch(conflictGuard, /응답을 확인하지 못한 요청/);
    await fresh.getByRole('button', { name: '최신 설정 확인', exact: true }).click();
    await fresh.getByText('합성 새 항목 · 필수 · 선택형 (선택 하나, 선택 둘)', { exact: true }).waitFor();
    await fresh.close();
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ intakeConflict: true, failedAndPartialReadsPreserveDrafts: true,
      delayedReadPreservesDraft: true, basicsBaselineAfterOtherSave: true, explicitChoicesDoNotWrite: true, finalManualPublish: true,
      ambiguousReceiptAndDefiniteConflict: true, committedReceiptReplay: true, cleanConsentFieldReview: true,
      keyboard: true, responsiveAndAxe: [320, 390, 1280] }, null, 2), { mode: 0o600 });
    console.log(`settings conflict audit passed: ${output}`);
  } catch (error) {
    console.error(`settings conflict audit failed at ${phase}`);
    throw error;
  } finally {
    await browser?.close();
    await fixture.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
