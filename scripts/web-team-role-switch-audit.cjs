'use strict';
// Synthetic team members only; the API and PostgreSQL schema are isolated.
const assert = require('node:assert/strict');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'team-role-switch');
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
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.dismiss());
    await page.goto(`${f.baseUrl}/console/team`);
    await page.getByRole('heading', { name: '구성원', exact: true }).first().waitFor();
    const id = `audit-manager-${f.suffix}`.toLowerCase();
    const other = `audit-staff-${f.suffix}`.toLowerCase();
    const panel = page.locator(`#org-role-panel-${id}`);
    const toggle = page.locator(`#org-role-toggle-${id}`);
    const otherToggle = page.locator(`#org-role-toggle-${other}`);
    const staff = panel.getByRole('radio', { name: '현장 스태프', exact: false });
    await toggle.click();
    await staff.check();
    await toggle.click();
    let review = panel.getByRole('group', { name: '실행 확인' });
    await review.getByText(/저장하지 않은 역할 선택이 사라집니다/).waitFor();
    assert.equal(await review.getByRole('button', { name: '계속 편집' }).evaluate((button) => document.activeElement === button), true, 'safe action gets focus');
    await page.screenshot({ path: path.join(out, 'role-discard-review-1280.png'), fullPage: true });
    await review.getByRole('button', { name: '계속 편집' }).click();
    assert.equal(await staff.isChecked(), true, 'cancel preserves selected role');
    await panel.getByRole('button', { name: '변경 확인' }).click();
    await panel.getByRole('button', { name: '역할을 바꾼다' }).waitFor();
    await toggle.click();
    assert.equal(await panel.getByRole('button', { name: '역할을 바꾼다' }).count(), 0, 'switch replaces role confirmation');
    await review.getByRole('button', { name: '계속 편집' }).click();
    await otherToggle.click();
    review = panel.getByRole('group', { name: '실행 확인' });
    await review.getByRole('button', { name: '계속 편집' }).click();
    assert.equal(await staff.isChecked(), true, 'switch cancellation preserves selected role');
    assert.equal(await page.locator(`#org-role-panel-${other}`).count(), 0);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await otherToggle.click();
      await review.getByText(/저장하지 않은 역할 선택이 사라집니다/).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow ${width}`);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
      if (width === 390) await page.screenshot({ path: path.join(out, 'role-discard-review-390.png'), fullPage: true });
      await review.getByRole('button', { name: '계속 편집' }).click();
    }
    await otherToggle.click();
    await review.getByRole('button', { name: '선택을 버리고 이동' }).click();
    await page.locator(`#org-role-panel-${other}`).waitFor();
    assert.equal(await panel.count(), 0);
    await toggle.click();
    await staff.check();
    const attempts = [];
    let releaseResponse, markCommitted;
    const responseHeld = new Promise((resolve) => { releaseResponse = resolve; });
    const committed = new Promise((resolve) => { markCommitted = resolve; });
    await page.route(/\/api\/auth\/organizations\/[^/]+\/members\/[^/]+$/, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        const response = await route.fetch();
        assert.ok(response.ok(), 'first role change committed');
        markCommitted();
        await responseHeld;
        return route.abort('failed');
      }
      return route.continue();
    });
    await panel.getByRole('button', { name: '변경 확인' }).click();
    await panel.getByRole('button', { name: '역할을 바꾼다' }).click();
    await committed;
    await otherToggle.click();
    assert.equal(await panel.isVisible(), true, 'in-flight attempt cannot be discarded');
    assert.equal(await page.locator(`#org-role-panel-${other}`).count(), 0);
    releaseResponse();
    await panel.getByText(/같은 요청으로 다시 시도하세요/).waitFor();
    await toggle.click();
    await panel.getByText(/진행 중이거나 결과를 확인하지 못한 역할 변경/).waitFor();
    await otherToggle.click();
    assert.equal(await panel.isVisible(), true, 'unknown attempt remains available');
    assert.equal(await page.locator(`#org-role-panel-${other}`).count(), 0);
    await panel.getByRole('button', { name: '같은 요청으로 다시 시도' }).first().click();
    await panel.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '같은 요청으로 다시 시도' }).click();
    await page.getByText(/조직 역할을 현장 스태프.*바꿨습니다/).waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0], 'retry replays the same request');
    assert.deepEqual(errors, []);
    console.log('Team role switch audit passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
