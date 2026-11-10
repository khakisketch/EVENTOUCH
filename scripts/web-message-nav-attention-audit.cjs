'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-navigation'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const command = (name, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
    method: 'POST', cookie: f.manager.cookie, body: { commandId: randomUUID(), command: name, payload },
  });
  try {
    const { rows } = await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId]);
    const person = rows[0].payload.participants.find(item => item.status === 'APPROVED'); assert.ok(person);
    const reservation = await command('message.create', { ids: [person.id], title: '연락처 변경 예약', channel: 'SMS', body: '합성 예약 안내', scheduled: '2999-01-01T00:00:00Z', scheduleMode: 'AUTO' });
    assert.equal(reservation.status, 201, JSON.stringify(reservation.json));
    assert.equal((await command('participant.update', { id: person.id, phone: '01099990000' })).status, 200);
    const summaryUrl = `/api/events/${f.eventId}/bootstrap?messageAttentionSummary=1`;
    const summary = await f.helpers.requestJson(f.harness.baseUrl, summaryUrl, { cookie: f.manager.cookie });
    assert.equal(summary.status, 200);
    assert.equal(summary.json.state.messageAttentionSummary.available, true);
    assert.equal(summary.json.state.messageAttentionSummary.blocked, true);
    assert.ok(Number.isFinite(summary.json.state.messageAttentionSummary.nextScheduledAt));
    assert.ok(Number.isFinite(Date.parse(summary.json.state.messageAttentionSummary.observedAt)));
    assert.deepEqual(Object.keys(summary.json.state).sort(), ['messageAttentionSummary', 'refreshVersion']);
    const unchanged = await f.helpers.requestJson(f.harness.baseUrl, `${summaryUrl}&ifVersion=${summary.json.state.refreshVersion}`, { cookie: f.manager.cookie });
    assert.equal(unchanged.json.state.unchanged, true);
    assert.equal(unchanged.json.state.refreshVersion, summary.json.state.refreshVersion);
    assert.ok(Number.isFinite(Date.parse(unchanged.json.state.messageReadObservedAt)));
    assert.deepEqual(Object.keys(unchanged.json.state).sort(), ['messageReadObservedAt', 'refreshVersion', 'unchanged']);
    const changedVersion = await f.helpers.requestJson(f.harness.baseUrl, `${summaryUrl}&messageVersionOnly=1&ifVersion=0.0`, { cookie: f.manager.cookie });
    assert.equal(changedVersion.json.state.changed, true);
    assert.deepEqual(Object.keys(changedVersion.json.state).sort(), ['changed', 'messageReadObservedAt', 'refreshVersion']);
    assert.equal((await f.helpers.requestJson(f.harness.baseUrl, `${summaryUrl}&messageVersionOnly=1&ifVersion=0.0`)).status, 401);
    assert.equal((await f.helpers.requestJson(f.harness.baseUrl, summaryUrl)).status, 401);
    assert.equal((await f.helpers.requestJson(f.harness.baseUrl, '/api/events/not-a-visible-event/bootstrap?messageAttentionSummary=1', { cookie: f.manager.cookie })).status, 404);
    const staffSummary = await f.helpers.requestJson(f.harness.baseUrl, summaryUrl, { cookie: f.staff.cookie });
    assert.equal(staffSummary.status, 200);
    assert.deepEqual(staffSummary.json.state.messageAttentionSummary, { available: false });
    assert.deepEqual(Object.keys(staffSummary.json.state).sort(), ['messageAttentionSummary', 'refreshVersion']);
    const staffDirectory = await f.helpers.requestJson(f.harness.baseUrl, '/api/console/directory', { cookie: f.staff.cookie });
    const staffEvent = staffDirectory.json.directory.events.find(event => event.id === f.eventId);
    assert.equal(Object.hasOwn(staffEvent, 'scheduledMessages'), false);
    assert.equal(Object.hasOwn(staffEvent, 'invalidScheduled'), false);
    assert.equal(Object.hasOwn(staffEvent, 'messageRefreshVersion'), false);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.getByRole('heading', { name: '참가자' }).first().waitFor();
    await page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).first().waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(out, 'participants-1280.png'), fullPage: true });
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator('.console-global-trigger').click();
    await page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(out, 'participants-320.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 900 });
    const timedRefresh = page.waitForResponse(response => response.url().includes('messageAttentionSummary=1&ifVersion=') && response.ok(), { timeout: 40000 });
    assert.equal((await command('participant.update', { id: person.id, phone: person.phone })).status, 200);
    await timedRefresh;
    await page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).first().waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal((await command('participant.update', { id: person.id, phone: '01099990000' })).status, 200);
    await page.evaluate(() => window.dispatchEvent(new Event('eventouch:shell-reload')));
    await page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).first().waitFor({ timeout: 5000 });
    const link = page.locator('a[href*="/messages"]:visible').filter({ hasText: '메시지' }).first();
    assert.match(await link.getAttribute('href'), /attention=1/);
    await link.click();
    await page.getByText('연락처 변경 예약', { exact: true }).waitFor();

    // A failed or old-server summary must never look like an all-clear and
    // must lead to the complete history, not a potentially partial filter.
    await page.route('**/bootstrap?messageAttentionSummary=1*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.getByRole('img', { name: '예약 발송 상태를 확인하지 못했습니다', exact: true }).first().waitFor();
    assert.equal(await page.getByRole('img', { name: '예약 발송 상태를 확인하지 못했습니다', exact: true }).first().textContent(), '상태 확인');
    assert.doesNotMatch(await page.locator('a[href*="/messages"]:visible').filter({ hasText: '메시지' }).first().getAttribute('href'), /attention=1/);
    await page.screenshot({ path: path.join(out, 'summary-unavailable.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator('.console-global-trigger').click();
    await page.getByRole('img', { name: '예약 발송 상태를 확인하지 못했습니다', exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('a[href*="/messages"]:visible').filter({ hasText: '메시지' }).first().click();
    await page.getByText('연락처 변경 예약', { exact: true }).waitFor();
    assert.doesNotMatch(page.url(), /attention=1/);
    await page.unroute('**/bootstrap?messageAttentionSummary=1*');

    const current = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    current.messages = [];
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(current)]);
    const refreshedDirectory = page.waitForResponse(response => response.url().endsWith('/api/console/directory') && response.ok());
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.getByRole('heading', { name: '참가자' }).first().waitFor();
    await refreshedDirectory;
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('img', { name: /발송 기록에 확인할 항목|예약 발송 상태를 확인하지/ }).count(), 0);

    current.messages = [
      { id: 'unconfirmed-without-reservation', status: 'SENDING', genericSubmissionUnconfirmed: true },
      { id: 'invalid-simulated-reservation', status: 'SCHEDULED', scheduled: 'invalid', simulate: true },
    ];
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(current)]);
    const directory = await f.helpers.requestJson(f.harness.baseUrl, '/api/console/directory', { cookie: f.manager.cookie });
    const item = directory.json.directory.events.find(event => event.id === f.eventId);
    assert.equal(item.messageAttention, 1, 'an unconfirmed submission is independently visible');
    assert.equal(item.invalidScheduled, true, 'an invalid simulated reservation is not silently omitted');
    await page.reload();
    await page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).first().waitFor();
    assert.deepEqual(errors, []);
    console.log('message navigation attention: passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
