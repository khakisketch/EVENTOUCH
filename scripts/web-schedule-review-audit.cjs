'use strict';
// Isolated synthetic event only: no messages are sent.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'schedule-review');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    async function command(name, payload) {
      const response = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.ok(response.status >= 200 && response.status < 300, `${name}: ${JSON.stringify(response.json)}`);
      return response.json;
    }
    const program = await command('program.save', { title: '합성 개회식', date: '2027-01-16', start: '09:00', end: '10:00', place: '합성 A홀', mode: 'draft' });
    await command('program.publish', { id: program.program.id, expectedVersion: program.program.version, published: true });
    const notice = await command('notice.save', { title: '합성 일정 안내', body: '행사는 2027-01-16 합성 A홀에서 진행됩니다.', mode: 'draft' });
    await command('notice.publish', { id: notice.notice.id, expectedVersion: notice.notice.version, published: true });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`, { waitUntil: 'networkidle' });
    const review = page.getByRole('region', { name: '참가자에게 보이는 안내도 확인해 주세요' });
    assert.equal(await review.count(), 0, 'initial page does not claim a change');
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await page.getByText('기본 정보를 저장했습니다.', { exact: false }).first().waitFor();
    assert.equal(await review.count(), 0, 'unchanged save does not create a review');
    await page.locator('#set-date').fill('2027-02-16');
    assert.equal(await review.count(), 0, 'editing alone is not presented as saved');
    const rejectSave = async route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '합성 저장 오류', field: 'date' }) });
    await page.route('**/api/events/*/commands', rejectSave);
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await page.getByText('합성 저장 오류', { exact: false }).first().waitFor();
    assert.equal(await review.count(), 0, 'rejected save does not claim a change');
    assert.equal(await page.locator('#set-date').inputValue(), '2027-02-16', 'rejected save preserves the draft');
    await page.unroute('**/api/events/*/commands', rejectSave);
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await review.waitFor();
    await review.getByText(/기존에 게시한 프로그램 일정과 공지·장소 안내는 그대로/).waitFor();
    await review.getByText(/여러 날짜에 진행하는 일정일 수/).waitFor();
    const targets = [['프로그램 일정 확인', 'content-program'], ['공지 확인', 'content-notices'], ['장소 안내 확인', 'content-venue']];
    for (const [label, anchor] of targets) {
      const link = review.getByRole('link', { name: label });
      assert.equal(await link.getAttribute('href'), `/console/events/${fixture.eventId}/content#${anchor}`);
      const destination = await context.newPage();
      await destination.goto(new URL(await link.getAttribute('href'), fixture.baseUrl).href, { waitUntil: 'networkidle' });
      await destination.locator(`#${anchor}`).waitFor({ state: 'visible' });
      await destination.close();
    }
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'saved-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'saved-320.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
    const programLink = review.getByRole('link', { name: '프로그램 일정 확인' });
    await programLink.focus();
    assert.equal(await programLink.evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Enter');
    await page.locator('#content-program').waitFor({ state: 'visible' });
    const guest = await browser.newPage();
    await guest.goto(`${fixture.baseUrl}/event/${fixture.slug}`, { waitUntil: 'networkidle' });
    const publicText = await guest.locator('body').innerText();
    assert.ok(publicText.includes('2027-02-16') && publicText.includes('2027-01-16') && publicText.includes('합성 개회식'));
    assert.ok(publicText.includes('합성 일정 안내'), 'saving the event does not publish or edit the old notice');
    await guest.screenshot({ path: path.join(out, 'public-unchanged.png'), fullPage: true });
    const timeOnly = await context.newPage();
    await timeOnly.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`, { waitUntil: 'networkidle' });
    await timeOnly.locator('#set-start').fill('08:45');
    await timeOnly.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await timeOnly.getByRole('region', { name: '참가자에게 보이는 안내도 확인해 주세요' }).waitFor();
    await timeOnly.close();
    await fixture.harness.database.query('UPDATE memberships SET write_permissions=$3::jsonb WHERE account_id=$1 AND event_id=$2',
      [fixture.manager.id, fixture.eventId, JSON.stringify(['settings'])]);
    const limited = await context.newPage();
    await limited.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`, { waitUntil: 'networkidle' });
    await limited.locator('#set-start').fill('08:30');
    await limited.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    const limitedReview = limited.getByRole('region', { name: '참가자에게 보이는 안내도 확인해 주세요' });
    await limitedReview.getByText(/담당 운영자에게 검토를 요청/).waitFor();
    assert.equal(await limitedReview.getByRole('link').count(), 0, 'restricted manager is not sent to unavailable editors');
    await limited.close();
    assert.deepEqual(errors, []);
    console.log('Schedule review: unchanged, rejected, saved, time-only, links, permissions, keyboard, narrow layout, axe, public content preserved.');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
