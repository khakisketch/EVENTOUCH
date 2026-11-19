'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  if (!['create', 'due'].includes(process.argv[2])) throw new Error('Expected create or due');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, `message-freshness-${process.argv[2]}-${process.env.EVENTOUCH_AUDIT_CLOCK_BEHIND ? 'behind' : 'ahead'}`));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  const command = (name, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie: f.manager.cookie, body: { commandId: randomUUID(), command: name, payload } });
  try {
    const workspace = await read(); workspace.messages = [];
    const person = workspace.participants.find(item => item.status === 'APPROVED'); assert.ok(person);
    if (process.argv[2] === 'due') workspace.messages = [{ id: 'due-refresh', title: '합성 예약 시각 도래', status: 'SCHEDULED', scheduled: new Date(Date.now() + 6000).toISOString(), simulate: true, channel: 'SMS', body: '합성 안내', recipientIds: [person.id], deliveries: [] }];
    await write(workspace);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    await context.addInitScript(({ drift }) => {
      const original = window.setInterval.bind(window);
      window.setInterval = (handler, delay, ...args) => original(handler, delay === 30000 ? 500 : delay, ...args);
      const originalTimeout = window.setTimeout.bind(window);
      window.setTimeout = (handler, delay, ...args) => originalTimeout(handler, delay === 15000 ? 500 : delay === 8000 ? 1000 : delay, ...args);
      const NativeDate = Date;
      class SkewedDate extends NativeDate {
        constructor(...args) { if (args.length) super(...args); else super(NativeDate.now() + drift); }
        static now() { return NativeDate.now() + drift; }
      }
      window.Date = SkewedDate;
    }, { drift: process.env.EVENTOUCH_AUDIT_CLOCK_BEHIND ? -86400000 : 86400000 });
    const page = await context.newPage(), summaryRequests = [];
    page.on('request', request => {
      if (request.url().includes('messageAttentionSummary=1')) summaryRequests.push(request.url());
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.getByRole('heading', { name: '참가자' }).first().waitFor();
    await page.waitForTimeout(1000);
    if (process.argv[2] === 'create') {
      assert.ok(summaryRequests.length > 0, 'an event without reservations is monitored');
      assert.ok(summaryRequests[0].includes('ifVersion='), 'an unchanged empty event starts with a lightweight version check');
      assert.ok(summaryRequests[0].includes('messageVersionOnly=1'), 'an empty event does not read full workspaces on another operator change');
    }
    const badge = page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).first();
    assert.equal(await badge.count(), 0, 'future reservation or empty event is not yet actionable despite browser clock drift');
    await page.screenshot({ path: path.join(out, `${process.argv[2]}-before.png`), fullPage: true });
    let overview;
    if (process.argv[2] === 'due') {
      overview = await context.newPage();
      await overview.goto(`${f.baseUrl}/console/events/${f.eventId}`);
      await overview.getByRole('heading', { name: '지금 할 일' }).waitFor();
      assert.equal(await overview.locator('[data-task="message-attention"]').count(), 0, 'overview must use server time before the due instant');
    }
    let directoryReads = 0;
    if (process.argv[2] === 'create') {
      let heldSummary = false;
      const releaseSummaries = Promise.withResolvers();
      await page.route('**/bootstrap?messageAttentionSummary=1*', async route => {
        heldSummary = true;
        // Keep the connection stalled through the client's timeout and any
        // intervening poll, until the operator's uncertainty indicator appears.
        await releaseSummaries.promise;
        return route.continue().catch(() => {});
      });
      const unknown = page.getByRole('img', { name: '예약 발송 상태를 확인하지 못했습니다', exact: true }).first();
      try {
        await unknown.waitFor({ timeout: 5000 });
      } finally {
        releaseSummaries.resolve();
      }
      await unknown.waitFor({ state: 'hidden', timeout: 5000 });
      assert.equal(heldSummary, true, 'a stalled read shows uncertainty and then retries');
      await page.unroute('**/bootstrap?messageAttentionSummary=1*');
      await page.route('**/api/console/directory', route => {
        directoryReads += 1;
        return directoryReads === 1
          ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
          : route.continue();
      });
      const reservation = await command('message.create', { ids: [person.id], title: '다른 운영자의 예약', channel: 'SMS', body: '합성 예약 안내', scheduled: '2999-01-01T00:00:00Z', scheduleMode: 'AUTO' });
      assert.equal(reservation.status, 201, JSON.stringify(reservation.json));
      assert.equal((await command('participant.update', { id: person.id, phone: '01099990000' })).status, 200);
    }
    await badge.waitFor({ timeout: 12000 });
    if (process.argv[2] === 'create') assert.ok(directoryReads >= 2, 'a temporary directory failure retries without another user action');
    if (overview) await overview.locator('[data-task="message-attention"]').getByText('1건', { exact: true }).waitFor({ timeout: 5000 });
    const link = page.locator('a[href*="/messages"]:visible').filter({ hasText: '메시지' }).first();
    assert.match(await link.getAttribute('href'), /attention=1/);
    await page.screenshot({ path: path.join(out, `${process.argv[2]}-after.png`), fullPage: true });
    await link.click();
    await page.getByText(process.argv[2] === 'create' ? '다른 운영자의 예약' : '합성 예약 시각 도래', { exact: true }).waitFor();
    if (process.argv[2] === 'create') {
      await page.goBack();
      await badge.waitFor();
      const updated = await read(); updated.messages = [];
      await write(updated);
      await badge.waitFor({ state: 'hidden', timeout: 8000 });
    }
    console.log(`message freshness ${process.argv[2]}: passed`);
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
