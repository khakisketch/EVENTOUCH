'use strict';
// Synthetic simulated messages only; no external provider calls.
for (const key of Object.keys(process.env)) {
  if (/^(?:SOLAPI_|MESSAGING_|ADMIN_)/.test(key) || /^EVENTOUCH_(?:MESSAGE_|PUBLIC_URL|DEV_)/.test(key)) delete process.env[key];
}
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { messageStep } = require('./ui-journey-helpers.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'message-recovery-before' : 'message-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const { database } = fixture.harness;
    const readWorkspace = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const person = (await readWorkspace()).participants.find((item) => item.status === 'APPROVED');
    assert.ok(person, 'fixture includes an approved participant');
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const requests = new Map();
    const historyRequests = [];
    const historyStatusRequests = [];
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body.command === 'message.retry-charset-reviewed' && body.payload.id === 'audit-simulated-status') {
        historyStatusRequests.push(body);
        if (historyStatusRequests.length === 1) {
          const response = await route.fetch();
          assert.ok(response.status() >= 200 && response.status() < 300);
          return route.abort('failed');
        }
        return route.continue();
      }
      if (body.command === 'message.retry-charset-reviewed' && body.payload.id === 'audit-simulated-reservation') {
        historyRequests.push(body);
        if (historyRequests.length === 1) {
          const response = await route.fetch();
          assert.ok(response.status() >= 200 && response.status() < 300, 'simulated execution committed before response fault');
          return route.abort('failed');
        }
        if (historyRequests.length === 2) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근 권한 확인"}' });
        return route.continue();
      }
      if (!['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(body.command)) return route.continue();
      const title = body.payload.title;
      if (!title.startsWith('합성 발송 복구')) return route.continue();
      const prior = requests.get(title) || [];
      prior.push(body);
      requests.set(title, prior);
      assert.equal(body.payload.simulate, true, 'never request a real delivery');
      if (prior.length === 1) {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, 'message committed before response fault');
        if (title.endsWith('부분 응답')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: { id: body.commandId } }) });
        return route.abort('failed');
      }
      if (title.endsWith('원래 요청') && prior.length === 2) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근 권한 확인"}' });
      if (title.endsWith('원래 요청') && prior.length === 3) return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"잠시 후 다시"}' });
      return route.continue();
    });
    async function prepare(title) {
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages?to=${encodeURIComponent(person.id)}`, { waitUntil: 'networkidle' });
      await page.locator('#campaign-title').fill(title);
      await page.locator('#campaign-body').fill('외부로 나가지 않는 합성 본문');
      // Reopened 2026-11-23: the review zone is always on screen; no step button to press.
      await messageStep(page, 3);
      const mock = page.getByLabel(/모의 발송으로 기록/);
      if (!(await mock.isChecked())) await mock.check();
      await page.locator('#campaign-submit').click();
      const confirm = page.getByRole('group', { name: '실행 확인' });
      await confirm.getByRole('button', { name: '모의 발송을 기록한다' }).click();
    }
    const recovery = page.getByRole('region', { name: '발송 요청 확인 필요' });
    const first = '합성 발송 복구 원래 요청';
    phase = 'lost create';
    await prepare(first);
    if (before) {
      await page.getByText(/응답을 확인하지 못했습니다/).first().waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      console.log('Message recovery before capture passed');
      return;
    }
    await recovery.waitFor();
    assert.equal(await page.locator('#campaign-title').isDisabled(), true, 'original message is frozen');
    assert.equal(await page.locator('#campaign-body').isDisabled(), true);
    assert.equal(await page.locator('#campaign-submit').isDisabled(), true);
    assert.equal((await readWorkspace()).messages.filter((item) => item.title === first).length, 1);
    phase = 'lost then 403 and 429';
    for (const status of [403, 429]) {
      const response = page.waitForResponse((item) => item.status() === status && item.url().includes('/commands'));
      await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
      await response;
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
      assert.equal(await page.locator('#campaign-title').isDisabled(), true, `${status} cannot settle the earlier lost response`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(new Set(requests.get(first).map((body) => body.commandId)).size, 1);
    assert.equal(new Set(requests.get(first).map((body) => JSON.stringify(body.payload))).size, 1);
    assert.equal((await readWorkspace()).messages.filter((item) => item.title === first).length, 1);
    phase = 'partial 2xx and status-only check';
    await page.setViewportSize({ width: 1280, height: 900 });
    const second = '합성 발송 복구 부분 응답';
    await prepare(second);
    await recovery.waitFor();
    const beforeStatus = requests.get(second).length;
    await recovery.getByRole('button', { name: '서버 처리 확인' }).click();
    await recovery.getByText('서버에 발송 요청 기록이 있습니다.', { exact: false }).waitFor();
    assert.equal(requests.get(second).length, beforeStatus, 'status check does not resend');
    assert.equal(await page.locator('#campaign-title').inputValue(), second, 'status-only lookup keeps the original draft');
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(requests.get(second).length, beforeStatus + 1, 'explicit replay verifies original payload');
    assert.equal((await readWorkspace()).messages.filter((item) => item.title === second).length, 1);
    phase = 'reload retains only scoped receipt';
    const third = '합성 발송 복구 새로고침';
    await prepare(third);
    await recovery.waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('message.create') && !stored.includes('합성 발송 복구') && !stored.includes('합성 본문'));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    if (!(await page.locator('#campaign-submit').isVisible())) await page.locator('#message-compose-open').click();
    await page.locator('ul[aria-label="참가자 선택"] li').filter({ hasText: person.name }).locator('input[type="checkbox"]').check();
    assert.match(await page.locator('#recipient-summary').innerText(), /선택 1명/);
    await messageStep(page, 2);
    await page.locator('#campaign-title').fill('새 작성은 아직 차단');
    await page.locator('#campaign-body').fill('처리 확인 이후에만 검토');
    assert.equal(await page.locator('#campaign-submit').isDisabled(), true, 'unresolved create blocks a new send after reload');
    const beforeReloadCheck = requests.get(third).length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await shared.getByText('서버에 발송 요청 기록이 있습니다.', { exact: false }).waitFor();
    assert.equal(await page.locator('#campaign-submit').isDisabled(), true, 'status alone cannot prove the original audience');
    await shared.getByRole('button', { name: '목록에서 지우기' }).click();
    await page.getByRole('dialog', { name: '처리 결과 확인에서 지우기' }).getByRole('button', { name: '목록에서 지우기' }).click();
    await page.waitForFunction(() => !document.querySelector('#campaign-submit')?.disabled);
    assert.equal(requests.get(third).length, beforeReloadCheck);
    assert.equal((await readWorkspace()).messages.filter((item) => item.title === third).length, 1);
    phase = 'scheduled execution retains its id after a later 403';
    const seeded = await readWorkspace();
    seeded.messages.unshift({ id: 'audit-simulated-reservation', title: '합성 예약 실행 복구', channel: 'SMS', body: '합성 예약',
      recipientIds: [person.id], status: 'SCHEDULED', scheduled: '2020-01-01T00:00:00Z', scheduleMode: 'MANUAL',
      at: '2020-01-01T00:00:00Z', simulate: true, attempts: 0, deliveries: [] });
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(seeded)]);
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages`, { waitUntil: 'networkidle' });
    const row = page.locator('[data-history-row]').filter({ hasText: '합성 예약 실행 복구' });
    async function executeFromRow(label) {
      await row.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '실행한다', exact: true }).click();
    }
    await executeFromRow('발송 실행');
    await row.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    const denied = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/commands'));
    await executeFromRow('같은 요청 다시 시도');
    await denied;
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
    await executeFromRow('같은 요청 다시 시도');
    await page.getByText(/모의 실행 결과/).waitFor();
    assert.equal(new Set(historyRequests.map((body) => body.commandId)).size, 1);
    const reservation = (await readWorkspace()).messages.find((item) => item.id === 'audit-simulated-reservation');
    assert.equal(reservation.status, 'SIMULATED');
    assert.equal(reservation.attempts, 1);
    phase = 'scheduled execution status-only confirmation';
    const next = await readWorkspace();
    next.messages.unshift({ id: 'audit-simulated-status', title: '합성 예약 상태 조회', channel: 'SMS', body: '합성 예약',
      recipientIds: [person.id], status: 'SCHEDULED', scheduled: '2020-01-01T00:00:00Z', scheduleMode: 'MANUAL',
      at: '2020-01-01T00:00:00Z', simulate: true, attempts: 0, deliveries: [] });
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(next)]);
    await page.reload({ waitUntil: 'networkidle' });
    const secondRow = page.locator('[data-history-row]').filter({ hasText: '합성 예약 상태 조회' });
    await secondRow.getByRole('button', { name: '발송 실행', exact: true }).click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '실행한다', exact: true }).click();
    await secondRow.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    const historyShared = page.getByRole('region', { name: '처리 결과 확인' });
    await historyShared.getByRole('button', { name: '서버 처리 확인' }).click();
    await secondRow.getByText('모의 발송', { exact: false }).first().waitFor();
    assert.equal(historyStatusRequests.length, 1, 'history status check sends no command');
    assert.equal((await readWorkspace()).messages.find((item) => item.id === 'audit-simulated-status').attempts, 1);
    await secondRow.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '재시도한다', exact: true }).click();
    await secondRow.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(historyStatusRequests.length, 2, 'explicit replay uses one original request');
    assert.equal(historyStatusRequests[0].commandId, historyStatusRequests[1].commandId);
    assert.deepEqual(historyStatusRequests[0].payload, historyStatusRequests[1].payload);
    assert.equal((await readWorkspace()).messages.find((item) => item.id === 'audit-simulated-status').attempts, 1, 'receipt replay does not execute twice');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', syntheticOnly: true, realDelivery: false, frozenPayload: true, after403And429: true, scheduledRetryAfter403: true, historyStatusOnly: true, statusOnly: true, noBodyPersisted: true, duplicates: 0 }, null, 2), { mode: 0o600 });
    console.log('Message: original simulated request, 403/429, scoped status and reload recovery passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
