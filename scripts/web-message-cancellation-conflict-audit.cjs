'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { messageStep, openRecipientList, openMessageMore } = require('./ui-journey-helpers.cjs');
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const before = process.argv.includes('--before');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'message-conflict-before' : 'message-conflict-after'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const row = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0];
    const ws = row.payload, conflict = ws.participants[0], valid = ws.participants[1];
    conflict.cancelled = true;
    const reservationId = 'synthetic-conflict-reservation';
    ws.messages.unshift({ id: reservationId, title: '합성 예약', body: '합성 안내', channel: 'SMS', status: 'SCHEDULED', simulate: false,
      scheduled: new Date(Date.now() + 3600000).toISOString(), scheduleMode: 'MANUAL', recipientIds: [conflict.id],
      recipientSnapshot: [{ id: conflict.id, name: conflict.name, phone: conflict.phone }], deliveries: [{ participantId: conflict.id, status: 'WAITING' }] });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]);
    if (!before) {
      const detailed = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/bootstrap?messageRecipientReview=1`, { cookie: f.manager.cookie });
      assert.equal(detailed.json.state.messageSchedule.blocked.find(item => item.id === reservationId)?.reason, 'RECIPIENT_CHANGED');
      assert.equal(detailed.json.state.recipientReviewVersions[conflict.id], undefined);
      const summary = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/bootstrap?messageAttentionSummary=1`, { cookie: f.manager.cookie });
      assert.equal(summary.json.state.messageAttentionSummary.blocked, true, 'navigation must show that the reservation needs attention');
    }
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [], creates = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
      const body = request.postDataJSON();
      if (['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(body.command)) {
        assert.equal(body.payload.simulate, true, 'the browser audit must not submit a real message');
        creates.push(body);
      }
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages?to=${encodeURIComponent(conflict.id)},${encodeURIComponent(valid.id)}`, { waitUntil: 'networkidle' });
    await openRecipientList(page); // Reopened 2026-11-24 (시안 A): the list is folded inside the 받는 사람 panel
    if (await page.locator('#recipient-selected-only').isChecked()) await page.locator('#recipient-selected-only').uncheck();
    const list = page.getByRole('list', { name: '참가자 선택', exact: true });
    await list.waitFor();
    if (before) {
      assert.equal(await list.getByText(conflict.name, { exact: true }).count(), 1, 'the old screen presents the inconsistent participant as selectable');
      await page.screenshot({ path: path.join(out, 'before-1280.png'), fullPage: true });
      return;
    }
    const warning = page.getByText(/신청 상태와 취소 기록이 일치하지 않는 1명/);
    await warning.waitFor();
    assert.equal(await list.getByText(conflict.name, { exact: true }).count(), 0);
    assert.equal(await list.getByText(valid.name, { exact: true }).count(), 1);
    await page.getByText(/제외 1명.*상태 확인 필요/).waitFor();
    const review = warning.getByRole('link', { name: '참가자 명단에서 확인' });
    assert.equal(await review.getAttribute('href'), `/console/events/${encodeURIComponent(f.eventId)}/participants?ticket=review`);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await warning.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
      await page.screenshot({ path: path.join(out, `after-${width}.png`), fullPage: true });
    }
    await review.focus(); assert.equal(await review.evaluate(element => element === document.activeElement), true);
    const reviewPage = await context.newPage();
    reviewPage.on('dialog', dialog => dialog.accept());
    await reviewPage.goto(`${f.baseUrl}/console/events/${f.eventId}/messages?to=${encodeURIComponent(conflict.id)},${encodeURIComponent(valid.id)}`, { waitUntil: 'networkidle' });
    await messageStep(reviewPage, 1);
    const reviewLink = reviewPage.getByRole('link', { name: '참가자 명단에서 확인', exact: true });
    await reviewLink.focus();
    await reviewPage.keyboard.press('Enter');
    await reviewPage.getByRole('heading', { name: '참가자 명단', exact: true }).waitFor();
    await reviewPage.getByText(conflict.name, { exact: true }).first().waitFor();
    await reviewPage.getByText('취소 상태 확인 필요', { exact: true }).first().waitFor();
    await messageStep(page, 2);
    await openMessageMore(page);
    await page.locator('#campaign-title').fill('합성 안내');
    await page.locator('#campaign-body').fill('작성한 내용은 보존됩니다.');
    await messageStep(page, 3);
    await page.getByRole('checkbox', { name: /^모의 발송으로 기록/ }).check();
    await page.locator('#campaign-submit').click();
    const confirm = page.getByRole('group', { name: '실행 확인', exact: true }).getByRole('button', { name: '모의 발송을 기록한다', exact: true });
    await confirm.waitFor();
    const changed = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    changed.participants.find(person => person.id === valid.id).cancelled = true;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(changed)]);
    const response = await Promise.all([page.waitForResponse(r => r.url().endsWith('/commands') && r.request().method() === 'POST'), confirm.click()]);
    assert.equal(response[0].status(), 409, 'a new cancellation conflict invalidates the final review');
    await page.getByRole('button', { name: '최신 수신자 불러오기', exact: true }).click();
    await page.getByText(/신청 상태와 취소 기록이 일치하지 않는 2명/).waitFor();
    assert.equal(await page.locator('#campaign-body').inputValue(), '작성한 내용은 보존됩니다.');
    assert.equal(creates.length, 1);
    assert.equal((await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload.messages.length, ws.messages.length, 'the refused request creates no campaign');
    assert.deepEqual(errors, []);
    console.log('message cancellation conflict: passed');
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
