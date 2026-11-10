'use strict';
// Synthetic roster/identity regression. window.print is stubbed; no printer is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { defaultCaptureDir, prepareCaptureDir, ensureRunTmpDir, runStamp } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  const out = process.env.EVENTOUCH_CAPTURE_ROOT
    ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'roster-nametag')
    : defaultCaptureDir(`roster-nametag-${runStamp()}`);
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, page;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const command = async (command, payload) => {
    const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.equal(response.status, 200, `${command}: ${JSON.stringify(response.json)}`);
  };
  try {
    const person = (await read()).participants[0];
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.addInitScript(() => { window.print = () => { window.__printCount = (window.__printCount || 0) + 1; }; });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.locator('#roster-search').fill(person.name);
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
    const dialog = page.getByRole('dialog');
    // The inspector was open before this update; opening its disclosure must read afresh.
    await command('event.update', { name: '합성 최신 행사명', date: '2027-01-16', start: '09:00', end: '17:00', capacity: 200 });
    const disclosure = dialog.locator('summary').filter({ hasText: '네임택 인쇄' });
    await disclosure.focus();
    await page.keyboard.press('Enter');
    const preview = page.getByRole('region', { name: '네임택 미리보기' });
    await preview.getByText('합성 최신 행사명', { exact: true }).waitFor();
    await preview.getByText(person.name, { exact: true }).waitFor();
    await dialog.getByText(/상세 창을 연 뒤 이름, 소속 또는 행사명이 변경됐습니다/).waitFor();
    const print = preview.getByRole('button', { name: '인쇄하기', exact: true });
    const retry = preview.getByRole('button', { name: '최신 정보 다시 확인', exact: true });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(axeSource);
      const failures = await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id));
      assert.deepEqual(failures, [], `axe ${width}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(overflow, false, `horizontal overflow ${width}`);
      await page.screenshot({ path: path.join(out, `preview-${width}.png`), fullPage: true });
    }
    await command('participant.update', { id: person.id, name: '합성 변경 이름', company: '합성 변경 소속' });
    await print.click();
    await preview.getByText('합성 변경 이름', { exact: true }).waitFor();
    await preview.getByText('합성 변경 소속', { exact: true }).waitFor();
    await preview.getByText(/미리보기를 확인한 뒤 다시 인쇄/).waitFor();
    assert.equal(await page.evaluate(() => window.__printCount || 0), 0);
    let mode = 'pass';
    let release;
    let started;
    let announceStart;
    let requests = 0;
    await page.route(`**/api/events/${f.eventId}/bootstrap`, async (route) => {
      requests += 1;
      if (mode === 'pause') {
        await new Promise((resolve) => { release = resolve; announceStart(); });
        return route.continue().catch(() => {});
      }
      if (['partial', 'partial-person', 'unknown-stage'].includes(mode)) {
        const response = await route.fetch();
        const json = await response.json();
        if (mode === 'partial') delete json.state.workspaces[f.eventId].participants;
        if (mode === 'partial-person') delete json.state.workspaces[f.eventId].participants.find((entry) => entry.id === person.id).company;
        if (mode === 'unknown-stage') json.state.events.find((entry) => entry.id === f.eventId).stage = 'BROKEN';
        return route.fulfill({ response, json });
      }
      if (mode === 'error' || mode === 'conflict') return route.fulfill({ status: mode === 'error' ? 503 : 409, contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    for (const failure of ['partial', 'partial-person', 'unknown-stage', 'error', 'conflict']) {
      mode = failure;
      await print.click();
      await retry.waitFor();
      assert.equal(await print.isDisabled(), true, failure);
      assert.equal(await page.evaluate(() => window.__printCount || 0), 0, failure);
      mode = 'pass';
      await retry.click();
      await preview.getByText('합성 변경 이름', { exact: true }).waitFor();
    }
    await command('event.update', { name: '합성 인쇄 직전 행사명', date: '2027-01-16', start: '09:00', end: '17:00', capacity: 200 });
    await print.click();
    await preview.getByText('합성 인쇄 직전 행사명', { exact: true }).waitFor();
    await preview.getByText(/미리보기를 확인한 뒤 다시 인쇄/).waitFor();
    assert.equal(await page.evaluate(() => window.__printCount || 0), 0);
    // Only one read and one native dialog even if pressed twice while checking.
    mode = 'pause';
    started = new Promise((resolve) => { announceStart = resolve; });
    const before = requests;
    await print.click();
    await started;
    await page.waitForFunction(() => document.querySelector('[aria-label="네임택 미리보기"] [role="status"]')?.textContent?.includes('확인'));
    await print.evaluate((el) => el.click());
    assert.equal(requests, before + 1);
    release();
    await page.waitForFunction(() => window.__printCount === 1);
    assert.match(await page.locator('[data-nametag-output]').innerText(), /합성 변경 이름/);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    mode = 'pass';
    // A real membership downgrade leaves read access but removes print permission.
    await f.harness.database.query('UPDATE memberships SET write_permissions=$1::jsonb WHERE account_id=$2 AND event_id=$3', ['[]', f.manager.id, f.eventId]);
    await print.click();
    await preview.getByText(/업무 권한이 바뀌었습니다/).waitFor();
    assert.equal(await print.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__printCount), 1);
    await f.harness.database.query('UPDATE memberships SET write_permissions=$1::jsonb WHERE account_id=$2 AND event_id=$3', ['["all"]', f.manager.id, f.eventId]);
    await retry.click();
    await preview.getByText('합성 변경 이름', { exact: true }).waitFor();
    // Closing the inspector during a read aborts the stale result. Reopening
    // performs a new verification rather than resuming the old print.
    mode = 'pause';
    release = null;
    started = new Promise((resolve) => { announceStart = resolve; });
    await print.click();
    await started;
    await page.waitForFunction(() => document.querySelector('[aria-label="네임택 미리보기"] [role="status"]')?.textContent?.includes('확인'));
    await dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
    assert.equal(await dialog.count(), 0);
    if (release) release();
    mode = 'pass';
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
    await page.getByRole('dialog').locator('summary').filter({ hasText: '네임택 인쇄' }).click();
    await preview.getByText('합성 변경 이름', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__printCount), 1);
    await f.harness.database.query('DELETE FROM memberships WHERE account_id=$1 AND event_id=$2', [f.manager.id, f.eventId]);
    await print.click();
    await retry.waitFor();
    assert.equal(await print.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__printCount), 1);
    await f.helpers.insertMembership(f.harness.database, f.manager.id, f.eventId, ['all']);
    await retry.click();
    await preview.getByText('합성 변경 이름', { exact: true }).waitFor();
    await command('participant.status', { id: person.id, status: 'CANCELLED' });
    await print.click();
    await preview.getByText(/참가 확정 상태가 바뀌었습니다/).waitFor();
    assert.equal(await print.isDisabled(), true);
    assert.equal(await dialog.getByText(/상세 창을 연 뒤 이름, 소속 또는 행사명이 변경됐습니다/).count(), 0);
    assert.equal(await page.evaluate(() => window.__printCount), 1);
    await page.screenshot({ path: path.join(out, 'cancelled-1280.png'), fullPage: true });
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
      build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), synthetic: true, physicalPrinter: false,
      checks: ['fresh on disclosure', 'identity change requires review', 'partial/503/409 block output', 'single print while checking', 'real event permission downgrade and access revocation block', 'closing during read aborts printing', 'actual cancellation blocks', 'keyboard disclosure', '320/390/1280 axe and overflow'],
    }, null, 2), { mode: 0o600 });
    console.log('Roster nametag freshness and recovery verified:', out);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await f.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
