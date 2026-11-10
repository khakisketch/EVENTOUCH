'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'report-cancellation-review');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const save = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    const source = await read();
    const person = source.participants.find(item => item.status === 'APPROVED' && item.cancelled !== true);
    assert.ok(person);
    const oldReport = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie: f.manager.cookie,
      body: { commandId: crypto.randomUUID(), command: 'report.create', payload: { title: '합성 이전 집계' } } });
    assert.equal(oldReport.status, 201);
    const saved = await read(); saved.participants.find(item => item.id === person.id).cancelled = true;
    delete saved.reports.find(item => item.id === oldReport.json.report.id).snapshot.metrics.cancellationReview; await save(saved);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`, { waitUntil: 'networkidle' });
    if (process.argv.includes('--baseline')) {
      assert.doesNotMatch(await page.innerText('body'), /취소 기록과 신청 상태/);
      await page.screenshot({ path: path.join(out, 'before-overview.png'), fullPage: true });
    } else {
      assert.match(await page.innerText('body'), /취소 기록과 신청 상태.*1명/);
      await page.evaluate(axe);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
        if (width === 390) await page.screenshot({ path: path.join(out, 'overview-390.png'), fullPage: true });
      }
      await page.screenshot({ path: path.join(out, 'overview-1280.png'), fullPage: true });
    }
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '결과 분석', exact: true }).click();
    const analysis = page.locator('[data-workspace-section="reports-analysis"]'); await analysis.waitFor();
    if (process.argv.includes('--baseline')) {
      assert.doesNotMatch(await analysis.innerText(), /취소 기록/);
      await page.screenshot({ path: path.join(out, 'before-analysis.png'), fullPage: true });
      await page.getByRole('tab', { name: '보고서', exact: true }).click();
      await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      assert.doesNotMatch(await dialog.innerText(), /취소 기록/);
      await page.screenshot({ path: path.join(out, 'before-review.png') });
      console.log('REPRODUCED: cancellation conflict is invisible in analysis and before freezing'); return;
    }
    assert.match(await analysis.innerText(), /취소 기록.*1명/);
    assert.match(await analysis.innerText(), /집계에 포함/);
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `analysis-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('tab', { name: '행사 마감', exact: true }).click();
    assert.match(await page.innerText('body'), /취소 기록.*1명/);
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
    const dialog = page.getByRole('dialog'); await page.locator('#report-title').fill('합성 충돌 보고서');
    assert.match(await dialog.innerText(), /취소 기록.*1명/);
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
    await page.screenshot({ path: path.join(out, 'review-390.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.screenshot({ path: path.join(out, 'review-1280.png') });
    await dialog.getByRole('button', { name: '보고서 만들기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const final = (await read()).reports.find(report => report.title === '합성 충돌 보고서');
    assert.equal(final.snapshot.metrics.cancellationReview, 1);
    await page.locator('li').filter({ hasText: '합성 충돌 보고서' }).getByRole('button', { name: '내용 보기' }).click();
    const article = page.locator('article'); assert.match(await article.innerText(), /취소 기록.*1명/);
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    await page.locator('li').filter({ hasText: '합성 이전 집계' }).getByRole('button', { name: '내용 보기' }).click();
    assert.match(await article.innerText(), /취소 기록.*확인.*저장되지/);
    const clean = await read(); clean.participants.find(item => item.id === person.id).cancelled = false; await save(clean);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '결과 분석', exact: true }).click();
    assert.doesNotMatch(await analysis.innerText(), /취소 기록과 신청 상태가 다른/);
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
    await page.locator('#report-title').fill('합성 변경 재검토');
    const changed = await read(); changed.participants.find(item => item.id === person.id).cancelled = true; await save(changed);
    const [rejected] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/api/events/${f.eventId}/commands`) && response.request().method() === 'POST'),
      dialog.getByRole('button', { name: '보고서 만들기', exact: true }).click(),
    ]);
    assert.equal(rejected.status(), 409, 'a newly conflicted participant invalidates the reviewed aggregate');
    assert.equal((await rejected.json()).field, 'expectedAttendance');
    assert.equal(await page.locator('#report-title').inputValue(), '합성 변경 재검토');
    await dialog.getByRole('button', { name: '최신 집계 사용', exact: true }).click();
    assert.match(await dialog.innerText(), /취소 기록.*1명/);
    await dialog.getByRole('button', { name: '보고서 만들기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await read()).reports.find(report => report.title === '합성 변경 재검토').snapshot.metrics.cancellationReview, 1);
    const bootstrap = `**/api/events/${f.eventId}/bootstrap`;
    await page.route(bootstrap, async route => {
      const response = await route.fetch(); const data = await response.json();
      delete data.state.workspaces[f.eventId].reportCancellationReviewVersion;
      await route.fulfill({ response, json: data });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().isDisabled(), true, 'an older server cannot claim to guard this review');
    assert.match(await page.innerText('body'), /취소 기록 검토.*확인할 수 없/);
    await page.unroute(bootstrap);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '결과 분석', exact: true }).click();
    const link = page.getByRole('link', { name: /티켓 확인 필요 명단/ }).first();
    assert.match(await link.getAttribute('href'), /ticket=review/);
    await link.click(); await page.waitForURL(/\/participants\?ticket=review/);
    await page.locator('select[aria-labelledby="roster-ticket-label"]').waitFor();
    assert.equal(await page.locator('select[aria-labelledby="roster-ticket-label"]').inputValue(), 'review');
    assert.match(await page.innerText('body'), new RegExp(person.name));
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).first().click();
    await page.getByRole('dialog', { name: person.name }).getByRole('button', { name: '참가 취소 기록 확인', exact: true }).click();
    const review = page.getByRole('dialog', { name: '참가 취소 기록 확인' });
    await review.getByLabel('확인 사유 (필수)').fill('합성 참가자의 참가 의사를 확인');
    await review.getByLabel('참가자가 취소하지 않고 참가하기로 확인했습니다.').check();
    await review.getByRole('button', { name: '확인 내용 저장', exact: true }).click();
    await review.waitFor({ state: 'hidden' });
    const resolved = await read();
    assert.equal(resolved.participants.find(item => item.id === person.id).cancelled, false);
    assert.equal(resolved.participants.find(item => item.id === person.id).revoked, true, 'old ticket stays revoked');
    assert.equal(resolved.reports.find(report => report.id === final.id).snapshot.metrics.cancellationReview, 1, 'resolving the participant does not rewrite a frozen report');
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '결과 분석', exact: true }).click();
    assert.doesNotMatch(await analysis.innerText(), /취소 기록과 신청 상태가 다른/);
    const ended = await read(); ended.participants.find(item => item.id === person.id).cancelled = true; await save(ended);
    const event = (await f.harness.database.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    event.stage = 'ENDED';
    await f.harness.database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [f.eventId, JSON.stringify(event)]);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
    await page.locator('#report-title').fill('종료 후 확인 보고서');
    assert.match(await dialog.innerText(), /종료 이후에는 참가자 상태를 변경할 수 없으며 이 상태가 보고서에 남습니다/);
    await dialog.getByRole('button', { name: '보고서 만들기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await read()).reports.find(report => report.title === '종료 후 확인 보고서').snapshot.metrics.cancellationReview, 1);
    assert.deepEqual(errors, []);
    console.log('PASS: cancellation conflict is visible before and after freezing, with historical uncertainty');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
