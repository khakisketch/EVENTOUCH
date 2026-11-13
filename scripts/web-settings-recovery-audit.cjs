'use strict';
// Isolated synthetic event. Response faults occur after the real commit.
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
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'settings-recovery-before' : 'settings-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const requests = new Map();
    let publishRequests = 0;
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body.command === 'form.publish') publishRequests += 1;
      let key = '';
      if (body.command === 'event.basics.save' && body.payload.name.startsWith('합성 설정 복구')) key = body.payload.name;
      if (body.command === 'event.features') key = 'features';
      if (body.command === 'form.publish' && body.payload.consentText === '합성 동의 초안') key = 'publish';
      if (body.command === 'event.stage' && body.payload.stage === 'ENDED') key = 'stage';
      if (!key) return route.continue();
      const rows = requests.get(key) || [];
      rows.push(body); requests.set(key, rows);
      if (rows.length === 1) {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, `${key} committed before response fault`);
        if (key.endsWith('부분 응답')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ event: { id: fixture.eventId } }) });
        if (key === 'features') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"features":["other"]}' });
        return route.abort('failed');
      }
      if (rows.length === 2 && (key.endsWith('원래 요청') || key === 'stage')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      return route.continue();
    });
    const event = async () => (await fixture.harness.database.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const tab = async (name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
    const panel = page.getByRole('region', { name: '행사 설정 처리 확인 필요' });
    const original = '합성 설정 복구 원래 요청';
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`, { waitUntil: 'networkidle' });
    if (!before) {
      await tab('참가 접수');
      await page.locator('#set-consent').fill('합성 동의 초안');
      await tab('기본 정보');
    }
    phase = 'lost event update';
    await page.locator('#set-name').fill(original);
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    if (before) {
      await page.getByText(/같은 요청으로 다시 시도하세요/).first().waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      assert.equal(await page.locator('#set-name').isDisabled(), false);
      console.log('Settings before capture: the prior request is not locked');
      return;
    }
    await panel.waitFor();
    await panel.getByText(/기본 정보 저장 요청이 반영됐을 수 있습니다/).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'settings-recovery-heading');
    assert.equal(await page.locator('#set-name').isDisabled(), true);
    const denied = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/commands'));
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await denied;
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
    assert.equal(await page.locator('#set-name').isDisabled(), true, 'later denial cannot settle an earlier loss');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(new Set(requests.get(original).map((item) => item.commandId)).size, 1);
    assert.equal(new Set(requests.get(original).map((item) => JSON.stringify(item.payload))).size, 1);
    assert.equal((await event()).name, original);
    await tab('참가 접수');
    assert.equal(await page.locator('#set-consent').inputValue(), '합성 동의 초안', 'saving another section preserves the draft');

    phase = 'partial update and status-only read';
    await page.setViewportSize({ width: 1280, height: 900 });
    await tab('기본 정보');
    const partial = '합성 설정 복구 부분 응답';
    await page.locator('#set-name').fill(partial);
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await panel.waitFor();
    const partialWrites = requests.get(partial).length;
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.getByText(/저장 내용과 티켓 영향을 확인하려면 같은 요청/).waitFor();
    assert.equal(requests.get(partial).length, partialWrites);
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(new Set(requests.get(partial).map((item) => item.commandId)).size, 1);
    assert.equal((await event()).name, partial);

    phase = 'features response must match the selected flags';
    await tab('운영 기능');
    const checkbox = page.getByRole('checkbox', { name: 'Q&A', exact: true });
    const next = !(await checkbox.isChecked());
    await checkbox.setChecked(next);
    await page.getByRole('button', { name: '운영 기능 저장', exact: true }).click();
    await panel.waitFor();
    assert.equal(await checkbox.isDisabled(), true);
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal((await event()).features.includes('qa'), next);
    assert.equal(requests.get('features').length, 1);

    phase = 'publish retains the original consent';
    await tab('참가 접수');
    assert.equal(await page.locator('#set-consent').inputValue(), '합성 동의 초안');
    await page.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click();
    await panel.waitFor();
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal((await workspace()).consentText, '합성 동의 초안');
    assert.equal((await workspace()).registrationOpen, true);
    assert.equal(requests.get('publish').length, 1);
    await page.locator('#set-consent').fill('');
    const publishCount = publishRequests;
    await page.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click();
    await page.getByText('빈 동의 안내는 저장되지 않습니다. 기존 안내를 유지하거나 내용을 입력하세요.').first().waitFor();
    assert.equal(await page.getByText('빈 동의 안내는 저장되지 않습니다. 기존 안내를 유지하거나 내용을 입력하세요.').count(), 1);
    for (const notice of await page.getByText('서버에 설정이 반영된 것을 확인했습니다. 최신 내용을 확인하세요.', { exact: false }).all()) {
      assert.equal(await notice.isVisible(), false, 'an older success must not compete with the current field error');
    }
    assert.equal(publishRequests, publishCount, 'an empty editor never silently reuses stored consent');
    assert.equal(await page.locator('#set-consent').inputValue(), '');
    assert.equal(await page.locator('#set-consent').getAttribute('aria-describedby'), 'settings-consent-error');
    await page.waitForFunction(() => document.activeElement?.id === 'set-consent');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'consent-error-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '기존 안내 되돌리기' }).click();
    assert.equal(await page.locator('#set-consent').inputValue(), '합성 동의 초안');
    assert.equal(publishRequests, publishCount, 'restoring the draft does not publish it');

    phase = 'reload leaves only a scoped pointer';
    await tab('기본 정보');
    const reloaded = '합성 설정 복구 새로고침';
    await page.locator('#set-name').fill(reloaded);
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await panel.waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('event.basics.save') && !stored.includes(reloaded));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    assert.equal(await page.locator('#set-name').isDisabled(), true);
    const beforeCheck = requests.get(reloaded).length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await shared.getByText(/원래 화면에서 같은 요청을 다시 확인/).waitFor();
    assert.equal(await page.locator('#set-name').isDisabled(), true);
    await shared.getByRole('button', { name: '목록에서 지우기' }).click();
    const dismiss = page.getByRole('dialog', { name: '처리 결과 확인에서 지우기' });
    await dismiss.getByRole('button', { name: '목록에서 지우기' }).click();
    await page.waitForFunction(() => !document.querySelector('#set-name')?.disabled);
    assert.equal(requests.get(reloaded).length, beforeCheck);
    assert.equal((await event()).name, reloaded);

    phase = 'stage loss followed by denial';
    await tab('진행 단계');
    await page.getByRole('button', { name: '종료 단계로 전환', exact: true }).click();
    await page.getByRole('group', { name: '단계 전환 확인' }).getByRole('button', { name: /정말 전환합니다/ }).click();
    await panel.waitFor();
    const deniedStage = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/commands'));
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await deniedStage;
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '서버 처리 확인' && !button.disabled));
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal((await event()).stage, 'ENDED');
    assert.equal(new Set(requests.get('stage').map((item) => item.commandId)).size, 1);
    assert.equal(new Set(requests.get('stage').map((item) => JSON.stringify(item.payload))).size, 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, sameIdAndPayload: true, after403: true, statusOnly: true, otherDraftPreserved: true, noContentPersisted: true }, null, 2), { mode: 0o600 });
    console.log('Settings: exact update, features, publish and stage outcomes recover without a duplicate write');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
