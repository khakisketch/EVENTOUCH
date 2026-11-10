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
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'overview-message-attention'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  const command = (name, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
    method: 'POST', cookie: f.manager.cookie, body: { commandId: randomUUID(), command: name, payload },
  });
  try {
    const initial = await read(), person = initial.participants.find(item => item.status === 'APPROVED'); assert.ok(person);
    const reservation = await command('message.create', { ids: [person.id], title: '연락처 변경 예약', channel: 'SMS', body: '합성 예약 안내', scheduled: '2999-01-01T00:00:00Z', scheduleMode: 'AUTO' });
    assert.equal(reservation.status, 201, JSON.stringify(reservation.json));
    assert.equal((await command('participant.update', { id: person.id, phone: '01099990000' })).status, 200);
    const workspace = await read();
    const base = { channel: 'SMS', body: '합성 안내', at: '2026-11-01T00:00:00Z', recipientIds: [person.id], deliveries: [], simulate: false };
    workspace.messages.unshift(
      { ...base, id: 'failed-attention', title: '합성 발송 실패', status: 'FAILED' },
      { ...base, id: 'unknown-attention', title: '합성 접수 미확인', status: 'SENDING', providerSubmission: { id: 'synthetic-reference' } },
      { ...base, id: 'overdue-attention', title: '합성 지난 예약', status: 'SCHEDULED', scheduled: '2020-01-01T00:00:00Z', simulate: true },
      { ...base, id: 'invalid-attention', title: '합성 시각 미확인', status: 'SCHEDULED', scheduled: '2020-01-01T09:00' },
      { ...base, id: 'sent-normal', title: '합성 발송 완료', status: 'SENT' },
      { ...base, id: 'future-normal', title: '합성 정상 예약', status: 'SCHEDULED', scheduled: '2999-01-01T00:00:00Z' },
    );
    await write(workspace);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      if (width === 320) {
        await page.locator('.console-global-trigger').click();
        await page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).first().waitFor();
        const mobileLabel = page.locator('a[href*="/messages"]:visible').filter({ hasText: '메시지' }).first().locator('span').filter({ hasText: /^메시지$/ });
        assert.equal(await mobileLabel.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length; }), 1);
        await page.keyboard.press('Escape');
      }
      await page.screenshot({ path: path.join(out, `overview-${width}.png`), fullPage: true });
    }
    const task = page.locator('[data-task="message-attention"]');
    await task.getByText('5건', { exact: true }).waitFor({ timeout: 5000 });
    await page.locator('[aria-labelledby="event-now-heading"]').getByText('1가지', { exact: true }).waitFor();
    const changed = await read(); changed.messages.find(item => item.id === 'failed-attention').status = 'SENT';
    const automaticChangeRead = page.waitForResponse(response => response.url().includes('/bootstrap?ifVersion=') && response.ok(), { timeout: 25000 });
    await write(changed);
    await automaticChangeRead;
    await task.getByText('4건', { exact: true }).waitFor({ timeout: 4000 });
    assert.equal(await task.getByRole('link', { name: '발송 확인' }).getAttribute('href'), `/console/events/${f.eventId}/messages?attention=1`, 'changed automatic read retains recipient review');
    changed.messages.find(item => item.id === 'failed-attention').status = 'FAILED'; await write(changed);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await task.getByText('5건', { exact: true }).waitFor();
    const actionColor = await task.getByRole('link', { name: '발송 확인' }).evaluate(element => {
      const probe = document.createElement('span'); probe.style.color = 'var(--brand-text)'; document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color, actual = getComputedStyle(element).color; probe.remove();
      return { actual, expected };
    });
    assert.equal(actionColor.actual, actionColor.expected, 'first actionable task keeps the approved emphasis');
    await page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).waitFor();
    const messageLink = page.locator('a[href*="/messages"]:visible').filter({ hasText: '메시지' }).first();
    const labelLines = await messageLink.locator('span').filter({ hasText: /^메시지$/ }).evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length;
    });
    assert.equal(labelLines, 1, 'message navigation label stays on one line');
    const directory = await f.helpers.requestJson(f.harness.baseUrl, '/api/console/directory', { cookie: f.manager.cookie });
    const eventSummary = directory.json.directory.events.find(event => event.id === f.eventId);
    assert.equal(eventSummary.manualDue, 1, 'invalid time is not presented as an overdue reservation');
    await task.getByRole('link', { name: '발송 확인' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/messages\?attention=1/);
    const rows = page.locator('[data-history-row]');
    await page.getByText('합성 발송 실패', { exact: true }).waitFor();
    assert.equal(await rows.count(), 5);
    for (const name of ['합성 발송 실패', '합성 접수 미확인', '합성 지난 예약', '합성 시각 미확인', '연락처 변경 예약']) {
      await page.getByText(name, { exact: true }).waitFor();
    }
    assert.equal(await page.getByText('합성 발송 완료', { exact: true }).count(), 0);
    assert.equal(await page.getByText('합성 정상 예약', { exact: true }).count(), 0);
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(out, 'attention-list-1280.png'), fullPage: true });

    const readOnlyId = `overview-reader-${randomUUID()}`;
    await f.helpers.insertAccount(f.harness.database, { id: readOnlyId, role: 'MANAGER', name: '합성 담당자', email: `${readOnlyId}@example.test`, orgId: f.helpers.LEGACY_ORG });
    await f.helpers.insertMembership(f.harness.database, readOnlyId, f.eventId, ['onsite']);
    const readerCookie = (await f.helpers.sessionCookie(f.harness, readOnlyId)).split('=');
    const reader = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR' });
    await reader.addCookies([{ name: readerCookie[0], value: readerCookie.slice(1).join('='), url: f.baseUrl }]);
    const readerPage = await reader.newPage();
    await readerPage.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await readerPage.locator('[data-task="message-attention"]').getByText('5건', { exact: true }).waitFor();
    await readerPage.locator('[data-task="message-attention"]').getByRole('link', { name: '발송 확인' }).click();
    await readerPage.getByText('합성 발송 실패', { exact: true }).waitFor();
    assert.equal(await readerPage.getByRole('button', { name: '메시지 작성', exact: true }).isDisabled(), true, 'read-only manager can review but not send');
    await reader.close();

    let projectionMode = 'old';
    await page.route('**/api/events/*/bootstrap**', async route => {
      const response = await route.fetch(), body = await response.json();
      if (!body.state?.unchanged && body.state?.workspaces?.[f.eventId]) {
        if (projectionMode === 'old') {
          delete body.state.recipientReviewVersions;
          if (body.state.messageSchedule) body.state.messageSchedule.blocked = [];
        } else {
          body.state.messageSchedule.blocked.push({ id: 'future-normal', reason: 'NEW_SERVER_REASON' });
        }
      }
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    const incomplete = page.locator('[data-task="message-attention"]');
    await incomplete.getByText('4건 이상', { exact: true }).waitFor();
    await incomplete.getByText(/일부 예약 상태를 확인하지 못했습니다/).waitFor();
    assert.equal(await incomplete.getByRole('link', { name: '발송 확인' }).getAttribute('href'), `/console/events/${f.eventId}/messages`);
    await page.screenshot({ path: path.join(out, 'incomplete-review-1280.png'), fullPage: true });
    await incomplete.getByRole('link', { name: '발송 확인' }).click();
    await page.waitForURL(url => url.pathname.endsWith('/messages') && !url.search);
    await page.getByText('합성 발송 완료', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-history-row]').count(), 7, 'incomplete review opens the full history');

    projectionMode = 'new';
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await page.locator('[data-task="message-attention"]').getByText('6건', { exact: true }).waitFor();
    await page.locator('[data-task="message-attention"]').getByRole('link', { name: '발송 확인' }).click();
    await page.waitForURL(/messages\?attention=1/);
    await page.getByRole('button', { name: '합성 정상 예약 상세', exact: true }).click();
    await page.getByText('발송을 실행하기 전 확인이 필요합니다. 발송 상태를 확인하고 운영 담당자에게 문의하세요.').waitFor();
    assert.equal(await page.locator('[data-history-row]').count(), 6, 'unknown future blocker is visible instead of omitted');
    await page.unroute('**/api/events/*/bootstrap**');

    const readyWorkspace = await read();
    readyWorkspace.messages = [{ ...base, id: 'ready-failed', title: '준비 중 발송 실패', status: 'FAILED' }];
    await write(readyWorkspace);
    await f.harness.database.query("UPDATE events SET payload=jsonb_set(payload, '{stage}', '\"READY\"'::jsonb), revision=revision+1 WHERE id=$1", [f.eventId]);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await page.locator('[data-task="message-attention"]').getByText('1건', { exact: true }).waitFor();
    await page.locator('[data-task="golive"]').getByText('진행 중 전환', { exact: true }).waitFor();
    await f.harness.database.query("UPDATE events SET payload=jsonb_set(payload, '{stage}', '\"LIVE\"'::jsonb), revision=revision+1 WHERE id=$1", [f.eventId]);

    const timed = await read();
    timed.messages = [{ ...base, id: 'soon-due', title: '곧 실행 시각이 되는 예약', status: 'SCHEDULED', simulate: true, scheduled: new Date(Date.now() + 8000).toISOString() }];
    await write(timed);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await page.locator('[data-task="message-attention"]').count(), 0, 'future reservation is initially not overdue');
    await page.waitForResponse(response => response.url().includes('/bootstrap?ifVersion=') && response.ok(), { timeout: 25000 });
    await page.locator('[data-task="message-attention"]').getByText('1건', { exact: true }).waitFor({ timeout: 4000 });
    await page.getByRole('img', { name: '발송 기록에 확인할 항목이 있습니다', exact: true }).first().waitFor({ timeout: 4000 });
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Overview and attention-filtered message history show the same five actionable campaigns');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
