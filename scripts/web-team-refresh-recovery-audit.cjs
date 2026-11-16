'use strict';
// Real isolated PostgreSQL/API; fault only the synthetic directory response.
const assert = require('node:assert/strict');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'team-refresh-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  try {
    const cookie = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), url: f.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    await page.addInitScript(() => {
      const parse = Response.prototype.json;
      Response.prototype.json = async function (...args) {
        const value = await parse.apply(this, args);
        if (value?.directory?.__holdForRace) {
          window.__teamRaceWaiters = (window.__teamRaceWaiters || 0) + 1;
          await new Promise((resolve) => { (window.__teamRaceRelease ||= []).push(resolve); });
        }
        return value;
      };
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.dismiss());
    await page.goto(`${f.baseUrl}/console/team`);
    await page.getByRole('list', { name: '구성원 목록' }).waitFor();
    const id = `audit-manager-${f.suffix}`.toLowerCase();
    const panel = page.locator(`#org-role-panel-${id}`);
    const staff = panel.getByRole('radio', { name: '현장 스태프', exact: false });
    const rowButton = page.locator(`#member-open-${id}`);
    const drawer = page.getByRole('dialog');
    const invite = async (name, email) => {
      await page.getByRole('button', { name: '구성원 초대', exact: true }).click();
      await page.locator('#invite-name').fill(name);
      await page.locator('#invite-email').fill(email);
      await page.getByRole('dialog').getByRole('button', { name: '초대 링크 발급', exact: true }).click();
    };
    let directoryMode = 'failure';
    await page.route('**/api/console/directory', async (route) => {
      if (directoryMode === 'failure') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic"}' });
      if (directoryMode === 'partial') {
        const response = await route.fetch();
        return route.fulfill({ response, body: '{"directory":{"accounts":[],"events":[]}}' });
      }
      return route.continue();
    });
    await invite('합성 초대', 'refresh-first@example.invalid');
    const warning = page.getByText(/팀 정보를 다시 불러오지 못했습니다/);
    await warning.waitFor();
    await page.getByText('대기 중인 초대를 확인할 수 없습니다.').waitFor();
    assert.equal(await page.getByText('대기 중인 초대가 없습니다.').count(), 0);
    const link = page.getByText('초대 링크는 지금 한 번만 표시됩니다. 복사해서 전달하세요.');
    await link.waitFor();
    assert.equal(await page.getByRole('button', { name: '링크 복사' }).isEnabled(), true);
    assert.equal(await rowButton.isDisabled(), true, 'stale data locks the member rows');
    assert.equal(await page.getByRole('button', { name: '구성원 초대', exact: true }).isDisabled(), true);
    const linkText = await page.locator('code').first().innerText();
    assert.ok(linkText.includes('/invite/'));
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow ${width}`);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
      if (width !== 320) {
        const fontsReady = await page.evaluate(() => Promise.race([
          document.fonts.ready.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
        ]));
        if (!fontsReady) {
          console.warn('Font loading did not settle; screenshots may use fallback fonts.');
          process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
        }
        await page.screenshot({ path: path.join(out, `refresh-failed-${width}.png`), fullPage: true });
      }
    }
    directoryMode = 'partial';
    await page.getByRole('button', { name: '팀 정보 다시 불러오기' }).click();
    await warning.waitFor();
    assert.equal(await rowButton.isDisabled(), true, 'partial response must not unlock stale data');
    assert.equal(await page.locator('code').first().innerText(), linkText);
    directoryMode = 'pass';
    await page.getByRole('button', { name: '팀 정보 다시 불러오기' }).click();
    await warning.waitFor({ state: 'hidden' });
    await page.getByText('refresh-first@example.invalid').first().waitFor();
    assert.equal(await rowButton.isEnabled(), true);
    assert.equal(await page.locator('code').first().innerText(), linkText);
    assert.equal((await f.harness.database.query('SELECT count(*)::int AS n FROM invitations WHERE email=$1', ['refresh-first@example.invalid'])).rows[0].n, 1);

    // A role request may commit while its response is lost. The docked drawer
    // keeps the original idempotent retry, and a successful refresh that shows
    // the requested role as current must not disable it.
    const attempts = [];
    await page.route(/\/api\/auth\/organizations\/[^/]+\/members\/[^/]+$/, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        const response = await route.fetch();
        assert.ok(response.ok());
        return route.abort('failed');
      }
      return route.continue();
    });
    await rowButton.click();
    await panel.waitFor();
    await staff.check();
    await panel.getByRole('button', { name: '변경 확인' }).click();
    await panel.getByRole('button', { name: '역할을 바꾼다' }).click();
    await panel.getByText(/같은 요청으로 다시 시도하세요/).waitFor();
    // The invitation block closes and a second invite refreshes the directory
    // while the role retry stays pending beside the list.
    await page.getByRole('button', { name: '닫기', exact: true }).first().click();
    await page.getByRole('button', { name: '닫는다' }).click();
    await invite('합성 두번째 초대', 'refresh-second@example.invalid');
    await page.getByText('refresh-second@example.invalid').first().waitFor();
    const retry = panel.getByRole('button', { name: '같은 요청으로 다시 시도' }).first();
    assert.equal(await retry.isEnabled(), true, 'refresh must not disable original role retry');
    await retry.click();
    await panel.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '같은 요청으로 다시 시도' }).click();
    await page.getByText(/조직 역할을 현장 스태프.*바꿨습니다/).waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(await drawer.count(), 0, 'a proven role change closes the drawer');
    await page.locator(`#member-open-${id}`).locator('xpath=ancestor::li[1]').getByText('현장 스태프').waitFor();
    assert.deepEqual(errors, []);
    console.log('Team refresh recovery audit passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
