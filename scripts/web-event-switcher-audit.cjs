'use strict';
// Browser check for the 행사 바꾸기 switcher (rail card / drawer card) and its unsaved-draft guard.
// Synthetic fixture data only: two events from the audit fixture.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'event-switcher');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  const results = [];
  const check = (name, ok) => { results.push([name, Boolean(ok)]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
  let browser;
  try {
    const otherId = `audit-switch-${fixture.suffix}`;
    await fixture.helpers.insertEvent(fixture.harness.database, {
      orgId: fixture.helpers.LEGACY_ORG, id: otherId, slug: `switch-${fixture.suffix}`,
      payload: { id: otherId, slug: `switch-${fixture.suffix}`, name: '두 번째 시연 포럼', stage: 'READY', date: '2027-03-05', start: '09:30', end: '17:00', capacity: 120, features: ['venue'] },
      workspace: fixture.helpers.emptyWorkspace(),
    });
    await fixture.helpers.insertMembership(fixture.harness.database, fixture.manager.id, otherId, ['all']);
    const panelName = { name: '행사 바꾸기', exact: true };
    // Reopened 2026-11-21: the control is the current-event card in the rail (desktop) or the drawer (phone).
    const trigger = (page) => page.getByRole('button', { name: /행사 바꾸기/ }).first();
    const openMenu = async (page) => { const menu = page.getByRole('button', { name: '메뉴', exact: true }); if (await menu.isVisible().catch(() => false)) await menu.click(); };
    browser = await launchBrowser();

    for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`, { waitUntil: 'networkidle' });
      await openMenu(page);
      await trigger(page).waitFor({ timeout: 15000 });
      check(`${label}: trigger visible and page does not overflow`, await trigger(page).isVisible() &&
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await trigger(page).click();
      const panel = page.getByRole('navigation', panelName);
      const otherLink = panel.getByRole('link', { name: /두 번째 시연 포럼/ });
      await otherLink.waitFor({ timeout: 15000 });
      check(`${label}: lists both events and marks the current one`, await otherLink.count() === 1 && await panel.locator('a[aria-current="true"]').count() === 1);
      check(`${label}: open panel does not overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(out, `switch-open-${label}.png`) });
      if (label === 'desktop') {
        await page.keyboard.press('Escape');
        check('desktop: Escape closes the panel and returns focus to the trigger', await panel.count() === 0 &&
          await page.evaluate(() => document.activeElement?.textContent?.includes('행사 바꾸기')));
        await trigger(page).click();
      }
      await otherLink.click();
      await page.waitForURL(new RegExp(`/console/events/${otherId}/participants`), { timeout: 15000 });
      check(`${label}: opens the same menu page of the chosen event`, page.url().includes(`/console/events/${otherId}/participants`));
      check(`${label}: no page errors`, errors.length === 0);
      await context.close();
    }

    // Unsaved draft: the shell's leave guard must ask before the switch.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const dialogs = [];
    let answer = 'dismiss';
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      if (answer === 'accept') await dialog.accept(); else await dialog.dismiss();
    });
    const settingsPath = `/console/events/${fixture.eventId}/settings`;
    await page.goto(`${fixture.baseUrl}${settingsPath}`, { waitUntil: 'networkidle' });
    const field = page.locator('main input:not([type=checkbox]):not([type=radio]):not([type=hidden]):visible, main textarea:visible').first();
    await field.waitFor({ timeout: 15000 });
    await field.click();
    await field.press('End');
    await field.type(' 임시');
    await trigger(page).click();
    await page.getByRole('navigation', panelName).getByRole('link', { name: /두 번째 시연 포럼/ }).click();
    await page.waitForTimeout(1500);
    check('unsaved draft: leaving by the switcher asks first', dialogs.length === 1);
    check('unsaved draft: cancel keeps the current event', page.url().includes(settingsPath) && page.url().includes(fixture.eventId));
    answer = 'accept';
    const panelNow = page.getByRole('navigation', panelName);
    if (!(await panelNow.isVisible())) await trigger(page).click();
    await panelNow.getByRole('link', { name: /두 번째 시연 포럼/ }).click();
    await page.waitForURL(new RegExp(`/console/events/${otherId}/settings`), { timeout: 15000 }).catch(() => {});
    check('unsaved draft: confirming opens the chosen event', page.url().includes(`/console/events/${otherId}/settings`));
    await context.close();
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`event switcher checks: ${results.length - failed.length}/${results.length} passed`);
  assert.equal(failed.length, 0, `failed: ${failed.map(([name]) => name).join('; ')}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
