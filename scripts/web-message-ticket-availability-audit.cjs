'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { messageStep } = require('./ui-journey-helpers.cjs');
const axeSource = require('axe-core').source;
let stage = 'setup';
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-ticket-availability');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const row = await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId]);
    const ws = row.rows[0].payload;
    ws.participants[0].ticketExpiresAt = '2020-01-01T00:00:00.000Z';
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    let creates = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/commands')) { try { if (['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(request.postDataJSON().command)) creates++; } catch {} } });
    stage = 'compose';
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages?to=${encodeURIComponent(ws.participants[0].id)}`, { waitUntil: 'networkidle' });
    await messageStep(page, 2);
    await page.locator('#campaign-title').fill('합성 티켓 안내');
    await page.locator('#campaign-body').fill('입장 안내 {{티켓링크}}');
    // Reopened 2026-11-23: the review zone is always on screen; the checklist link only moves there.
    await messageStep(page, 3);
    await page.getByRole('heading', { name: '발송 전 검토' }).waitFor();
    if (process.argv.includes('--before')) {
      assert.equal(await page.getByText(/티켓을 사용할 수 없거나 상태를 확인할 수 없는 수신자/).count(), 0);
      await page.locator('#campaign-review-heading').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, 'before-390.png') });
      fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ before: true, expiredTicketWarning: false }, null, 2), { mode: 0o600 });
      return;
    }
    stage = 'blocked review';
    const warning = page.getByText(/티켓을 사용할 수 없거나 상태를 확인할 수 없는 수신자 1명/);
    await warning.waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await warning.scrollIntoViewIfNeeded();
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: path.join(out, `ticket-review-${width}.png`) });
    }
    await page.locator('#campaign-submit').click();
    await page.getByRole('alert').filter({ hasText: '티켓을 사용할 수 없거나' }).waitFor();
    assert.equal(creates, 0);
    assert.equal(await page.locator('#campaign-body').inputValue(), '입장 안내 {{티켓링크}}');
    assert.equal(await warning.locator('a').getAttribute('href'), `/console/events/${encodeURIComponent(f.eventId)}/participants?ticket=review`);
    // Exact navigation occurs in a separate tab so the compose draft remains intact.
    await page.locator('#campaign-submit').focus();
    assert.equal(await page.locator('#campaign-submit').evaluate(node => node === document.activeElement), true);
    stage = 'manual provider review';
    const current = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const id = `synthetic-provider-${crypto.randomUUID()}`, submissionId = `submission-${crypto.randomUUID()}`;
    current.messages.unshift({ id, title: '합성 접수 미확인', body: '합성 안내', channel: 'SMS', recipientIds: [ws.participants[0].id],
      status: 'SENDING', genericTransport: true, genericAttemptActive: false, genericSubmissionUnconfirmed: true, deliveryUnconfirmed: true,
      providerSubmission: { id: submissionId, kind: 'HTTP' }, recipientSnapshot: [{ id: ws.participants[0].id, name: ws.participants[0].name, phone: ws.participants[0].phone }],
      deliveries: [{ participantId: ws.participants[0].id, name: ws.participants[0].name, status: 'SENDING', at: new Date().toISOString() }], at: new Date().toISOString() });
    const partialId = `synthetic-partial-${crypto.randomUUID()}`;
    current.messages.unshift({ id: partialId, title: '합성 부분 접수', body: '합성 안내', channel: 'SMS', recipientIds: [ws.participants[0].id, ws.participants[1].id],
      status: 'ACCEPTED', genericTransport: true, genericAttemptActive: false, genericSubmissionUnconfirmed: false, deliveryUnconfirmed: true,
      acceptedCount: 1, deliveries: [{ participantId: ws.participants[0].id, name: ws.participants[0].name, status: 'ACCEPTED', at: new Date().toISOString() },
        { participantId: ws.participants[1].id, name: ws.participants[1].name, status: 'FAILED', at: new Date().toISOString() }], at: new Date().toISOString() });
    const legacyId = `synthetic-legacy-${crypto.randomUUID()}`;
    current.messages.unshift({ id: legacyId, title: '합성 이전 부분 발송', body: '합성 안내', channel: 'SMS', recipientIds: [ws.participants[0].id, ws.participants[1].id],
      status: 'PARTIAL', deliveries: [{ participantId: ws.participants[0].id, name: ws.participants[0].name, status: 'SENT', at: new Date().toISOString() },
        { participantId: ws.participants[1].id, name: ws.participants[1].name, status: 'FAILED', at: new Date().toISOString() }], at: new Date().toISOString() });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(current)]);
    const historyPage = await context.newPage(); historyPage.setDefaultTimeout(12000);
    let checks = 0, lost = false;
    await historyPage.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(body?.command)) throw new Error('unexpected message send');
      if (body?.command === 'message.record-provider-check') {
        checks++;
        if (!lost) { lost = true; await route.fetch(); await route.abort('failed'); return; }
      }
      await route.continue();
    });
    await historyPage.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`, { waitUntil: 'networkidle' });
    await historyPage.getByRole('button', { name: '합성 접수 미확인 상세', exact: true }).click();
    const manualDetail = historyPage.locator(`[id="campaign-detail-${id}"]`);
    await manualDetail.getByText('공급사 접수 0명 · 미접수 0명 · 접수 미확인 1명.', { exact: false }).waitFor();
    await manualDetail.getByText('수신자별 처리 상태', { exact: false }).click();
    const openCheck = manualDetail.getByRole('button', { name: `${ws.participants[0].name} 공급사 확인 기록`, exact: true });
    await openCheck.click();
    const form = manualDetail.getByRole('region', { name: '공급사 확인 결과 기록' });
    await historyPage.waitForFunction(() => document.activeElement?.id === 'provider-check-heading');
    assert.equal(await openCheck.count(), 0, 'the open action is not repeated in the form');
    await form.getByRole('button', { name: '나중에 확인', exact: true }).click();
    await historyPage.waitForFunction((triggerId) => document.activeElement?.id === triggerId, `provider-check-trigger-${id}-${ws.participants[0].id}`);
    await openCheck.click();
    await historyPage.waitForFunction(() => document.activeElement?.id === 'provider-check-heading');
    for (const width of [320, 390, 1280]) {
      await historyPage.setViewportSize({ width, height: 844 });
      await form.scrollIntoViewIfNeeded();
      assert.equal(await historyPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await historyPage.addScriptTag({ content: axeSource });
      assert.deepEqual(await historyPage.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      const choice = form.getByLabel('공급사 접수 확인');
      await choice.focus();
      assert.equal(await choice.evaluate(node => node === document.activeElement), true);
      await historyPage.keyboard.press('Space');
      assert.equal(await choice.isChecked(), true);
      await historyPage.keyboard.press('ArrowRight');
      assert.equal(await form.getByLabel('공급사 미접수 확인').isChecked(), true);
      await historyPage.screenshot({ path: path.join(out, `provider-check-${width}.png`) });
    }
    await form.getByLabel('공급사 미접수 확인').check();
    await form.getByRole('button', { name: '기록 내용 확인', exact: true }).click();
    await form.getByRole('button', { name: '확인 결과 기록', exact: true }).click();
    await form.getByText('기록 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하세요.').waitFor();
    assert.equal(checks, 1);
    await form.getByRole('button', { name: '같은 요청 다시 확인', exact: true }).click();
    await historyPage.getByText('공급사 확인 결과를 운영자 기록으로 저장했습니다.', { exact: false }).waitFor();
    assert.equal(checks, 2);
    const stored = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload.messages.find(message => message.id === id);
    assert.equal(stored.deliveries[0].manualProviderReview.outcome, 'NOT_ACCEPTED');
    assert.equal(stored.status, 'FAILED');
    assert.equal(creates, 0);
    await historyPage.setViewportSize({ width: 390, height: 844 });
    await historyPage.screenshot({ path: path.join(out, 'provider-review-390.png') });
    await historyPage.getByRole('button', { name: '합성 부분 접수 상세', exact: true }).click();
    const partial = historyPage.locator(`[id="campaign-detail-${partialId}"]`);
    const summary = partial.getByText('공급사 접수 1명 · 미접수 1명 · 접수 미확인 0명.', { exact: false });
    await summary.waitFor();
    assert.equal((await summary.innerText()).match(/공급사 접수 1명/g)?.length, 1, 'provider acceptance is not repeated');
    await summary.scrollIntoViewIfNeeded();
    await historyPage.screenshot({ path: path.join(out, 'partial-acceptance-390.png') });
    await historyPage.getByRole('button', { name: '합성 이전 부분 발송 상세', exact: true }).click();
    const legacy = historyPage.locator(`[id="campaign-detail-${legacyId}"]`);
    await legacy.getByText('전달 근거 미확인 1명', { exact: false }).waitFor();
    await legacy.getByText('수신자별 처리 상태', { exact: false }).click();
    await legacy.getByText('전달 근거 미확인', { exact: true }).waitFor();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ passed: true, expiredTicketWarning: true, noSend: creates === 0, draftPreserved: true, recipientLink: true, manualReview: true, responseLossSameRequest: checks === 2, emptyPartialAndUnknown: true, legacyMixedDeliveryNotAssumed: true, viewports: [320,390,1280] }, null, 2), { mode: 0o600 });
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(`Stage ${stage}: ${String(error?.message || error).split('\n')[0]}`); process.exitCode = 1; });
