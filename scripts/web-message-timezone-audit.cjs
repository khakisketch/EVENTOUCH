'use strict';
// Isolated synthetic reservations only; never permit a live delivery.
for (const key of Object.keys(process.env)) {
  if (/^(?:SOLAPI_|MESSAGING_|ADMIN_)/.test(key) || /^EVENTOUCH_(?:MESSAGE_|PUBLIC_URL|DEV_)/.test(key)) delete process.env[key];
}
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { messageStep } = require('./ui-journey-helpers.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-timezone'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, page;
  let phase = 'setup';
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const workspace = await read();
    const person = workspace.participants.find(p => p.status === 'APPROVED');
    assert.ok(person);
    const old = [
      { id: 'tz-zoned-z', title: '합성 기존 UTC', scheduled: '2030-11-12T00:00:00.000Z' },
      { id: 'tz-zoned-offset', title: '합성 기존 오프셋', scheduled: '2030-11-12T05:30:00+05:30' },
      { id: 'tz-unzoned', title: '합성 시간대 미기록', scheduled: '2030-11-12T09:00:00' },
      { id: 'tz-bad-date', title: '합성 잘못된 날짜', scheduled: '2030-02-30T09:00:00Z' },
      { id: 'tz-bad-offset', title: '합성 잘못된 오프셋', scheduled: '2030-11-12T09:00:00+14:30' },
      { id: 'tz-missing', title: '합성 시각 미기록', scheduled: '' },
      { id: 'tz-unconnected', title: '합성 연결 필요 시간대 미기록', status: 'NEEDS_CONNECTION', scheduled: '2030-11-12T09:00:00' },
      { id: 'tz-recovery', title: '합성 연결 필요 응답 복구', status: 'NEEDS_CONNECTION', scheduled: '2020-01-01T00:00:00Z' },
    ].map(item => ({ ...item, channel: 'SMS', body: '합성 내용', status: item.status || 'SCHEDULED', recipientIds: [person.id], simulate: true, scheduleMode: 'MANUAL', at: '2026-01-01T00:00:00Z', deliveries: [], attempts: 0 }));
    workspace.messages.unshift(...old);
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const results = [];
    const errors = [];
    for (const [timezoneId, width] of [['UTC', 1280], ['Asia/Seoul', 390], ['America/Los_Angeles', 320]]) {
      phase = `compose ${timezoneId}`;
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', timezoneId });
      await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      const requests = [];
      await page.route('**/api/events/*/commands', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const body = route.request().postDataJSON();
        if (!['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(body.command)) return route.continue();
        assert.equal(body.payload.simulate, true, 'no real delivery is permitted');
        requests.push(body);
        if (timezoneId === 'UTC' && requests.length === 1) {
          const response = await route.fetch();
          assert.ok(response.ok(), 'first synthetic reservation committed');
          return route.abort('failed');
        }
        if (timezoneId === 'UTC' && requests.length === 2) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근 권한 확인"}' });
        return route.continue();
      });
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages?to=${encodeURIComponent(person.id)}`, { waitUntil: 'networkidle' });
      await messageStep(page, 2);
      await page.locator('#campaign-title').fill(`합성 예약 ${timezoneId}`);
      await page.locator('#campaign-body').fill('실제로 전달하지 않는 합성 안내입니다.');
      await messageStep(page, 3);
      const details = page.locator('details').filter({ has: page.locator('#campaign-scheduled') });
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await details.evaluate(node => node.open), true, 'keyboard opens reservation');
      assert.match(await page.locator('label[for="campaign-scheduled"]').innerText(), /한국 시간/);
      const input = page.locator('#campaign-scheduled');
      await input.focus();
      await page.keyboard.type('02302030');
      assert.equal(await input.evaluate(node => node.validity.badInput), true, 'incomplete or invalid native date is not treated as immediate');
      await page.getByText('예약 날짜와 시간을 확인하세요', { exact: true }).waitFor();
      assert.match(await page.locator('#campaign-submit-warning').innerText(), /예약 날짜·시간 확인 필요/);
      await page.getByRole('checkbox', { name: /^모의 발송으로 기록/ }).focus();
      await page.locator('#campaign-scheduled-error').waitFor();
      assert.match(await page.locator('#campaign-scheduled-error').innerText(), /날짜와 시간을 모두 입력하거나 지워/);
      await page.locator('#campaign-submit').click();
      assert.equal(requests.length, 0, 'invalid date issues no request');
      await input.fill('');
      assert.match(await page.locator('#campaign-submit-warning').innerText(), /실제 발송 시도/);
      await input.fill('2020-01-01T09:00');
      await page.locator('#campaign-submit').click();
      await page.locator('#campaign-scheduled-error').waitFor();
      assert.match(await page.locator('#campaign-scheduled-error').innerText(), /현재 이후/);
      assert.equal(requests.length, 0, 'past schedule is rejected before review');
      assert.equal(await input.inputValue(), '2020-01-01T09:00');
      await input.fill('2030-11-12T09:00');
      const mock = page.getByRole('checkbox', { name: /^모의 발송으로 기록/ });
      if (!await mock.isChecked()) await mock.check();
      assert.match(await details.innerText(), /2030\. 11\. 12\. 오전 9:00 \(한국 시간\)/);
      await page.screenshot({ path: path.join(out, `compose-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no page overflow');
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.locator('#campaign-submit').click();
      const confirmation = page.getByRole('group', { name: '실행 확인', exact: true });
      await confirmation.waitFor();
      assert.match(await confirmation.innerText(), /예약 시각: 2030\. 11\. 12\. 오전 9:00 \(한국 시간\)/);
      assert.match(await confirmation.innerText(), /전달되지 않습니다/);
      await page.screenshot({ path: path.join(out, `review-${width}.png`), fullPage: true });
      await confirmation.getByRole('button', { name: '예약 등록한다', exact: true }).click();
      if (timezoneId === 'UTC') {
        phase = 'lost response and permission denial';
        const recovery = page.getByRole('region', { name: '발송 요청 확인 필요' });
        await recovery.waitFor();
        assert.equal(await input.isDisabled(), true, 'unresolved request freezes original draft');
        await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
        assert.equal(await input.isDisabled(), true, '403 cannot settle prior lost response');
        await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
        await recovery.waitFor({ state: 'hidden' });
        assert.equal(new Set(requests.map(req => req.commandId)).size, 1);
        assert.equal(new Set(requests.map(req => JSON.stringify(req.payload))).size, 1);
      }
      await page.locator('#message-compose-open').waitFor({ state: 'visible' });
      assert.ok(requests.length >= 1);
      assert.ok(requests.every(req => req.payload.scheduled === '2030-11-12T00:00:00.000Z'));
      const stored = (await read()).messages.filter(m => m.title === `합성 예약 ${timezoneId}`);
      assert.equal(stored.length, 1);
      assert.equal(stored[0].scheduled, '2030-11-12T00:00:00.000Z');
      assert.equal(stored[0].simulate, true);
      assert.equal(stored[0].status, 'SCHEDULED');
      results.push({ timezoneId, width, stored: stored[0].scheduled, requests: requests.length });
      await context.close();
    }
    phase = 'history and legacy retention';
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await context.newPage();
    const retries = [];
    await page.route('**/api/events/*/commands', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body.command !== 'message.retry-charset-reviewed' || body.payload.id !== 'tz-recovery') return route.continue();
      retries.push(body);
      if (retries.length === 1) {
        const response = await route.fetch();
        assert.ok(response.ok(), 'synthetic retry committed before response loss');
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`, { waitUntil: 'networkidle' });
    if (await page.locator('#campaign-history-more').count()) await page.locator('#campaign-history-more').click();
    for (const id of ['tz-zoned-z', 'tz-zoned-offset']) {
      const row = page.locator(`#campaign-${id}`);
      assert.match(await row.innerText(), /예약 2030\. 11\. 12\. 오전 9:00 \(한국 시간\)/);
      await row.getByRole('button', { name: /상세$/ }).click();
      assert.match(await page.locator(`#campaign-detail-${id}`).innerText(), /2030\. 11\. 12\. 오전 9:00 \(한국 시간\)/);
    }
    const unzoned = page.locator('#campaign-tz-unzoned');
    assert.match(await unzoned.innerText(), /시간대 미기록 · 원본 2030-11-12T09:00:00/);
    assert.equal(await unzoned.getByRole('button', { name: '발송 실행', exact: true }).count(), 0);
    await unzoned.getByRole('button', { name: /상세$/ }).click();
    assert.match(await page.locator('#campaign-detail-tz-unzoned').innerText(), /예약 날짜 또는 시간대를 확인할 수 없습니다/);
    for (const id of ['tz-bad-date', 'tz-bad-offset', 'tz-missing']) {
      const row = page.locator(`#campaign-${id}`);
      assert.match(await row.innerText(), /예약 시각 확인 필요/);
      assert.equal(await row.getByRole('button', { name: '발송 실행', exact: true }).count(), 0);
    }
    const unconnected = page.locator('#campaign-tz-unconnected');
    assert.match(await unconnected.innerText(), /예약 시각 확인 필요/);
    assert.equal(await unconnected.getByRole('button', { name: '재시도', exact: true }).count(), 0);
    assert.equal(await unconnected.getByRole('button', { name: '발송 취소', exact: true }).count(), 1);
    await unconnected.getByRole('button', { name: /상세$/ }).click();
    assert.match(await page.locator('#campaign-detail-tz-unconnected').innerText(), /발송 요청을 취소한 뒤 시각을 확인하여 다시 등록/);
    for (const item of old) assert.equal((await read()).messages.find(m => m.id === item.id).scheduled, item.scheduled);
    await page.screenshot({ path: path.join(out, 'history-1280.png'), fullPage: true });
    phase = 'unconfirmed retry survives invalid stored schedule';
    const recoveryRow = page.locator('#campaign-tz-recovery');
    await recoveryRow.getByRole('button', { name: '재시도', exact: true }).click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '재시도한다', exact: true }).click();
    await recoveryRow.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).waitFor();
    const changed = await read();
    const record = changed.messages.find(m => m.id === 'tz-recovery');
    assert.equal(record.status, 'SIMULATED');
    // Simulate another writer exposing a malformed historical value while
    // the already-committed response is still unconfirmed in this browser.
    record.status = 'NEEDS_CONNECTION';
    record.scheduled = '2020-01-01T09:00:00';
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(changed)]);
    await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
    await recoveryRow.getByText('예약 시각 확인 필요', { exact: true }).waitFor();
    await recoveryRow.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '재시도한다', exact: true }).click();
    await page.getByText(/모의 실행 결과/).waitFor();
    assert.equal(retries.length, 2);
    assert.equal(retries[0].commandId, retries[1].commandId);
    assert.deepEqual(retries[0].payload, retries[1].payload);
    assert.equal((await read()).messages.find(m => m.id === 'tz-recovery').scheduled, '2020-01-01T09:00:00');
    phase = 'staff lacks permission to schedule messages';
    const beforePermission = (await read()).messages.length;
    const denied = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.staff.cookie,
      body: { commandId: crypto.randomUUID(), command: 'message.create', payload: { ids: [person.id], title: '합성 권한 확인', body: '전달되지 않는 합성 예약', channel: 'SMS', scheduled: '2030-11-12T00:00:00.000Z', simulate: true } },
    });
    assert.equal(denied.status, 403, 'assigned staff cannot create message reservations');
    assert.equal((await read()).messages.length, beforePermission, 'denied reservation is not saved');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), syntheticOnly: true, realDelivery: false, results, oldValuesUnchanged: true, lostResponseSameRequest: true, permissionDenialRetainsRequest: true, staffPermissionDenied: true, unconnectedInvalidBlocked: true, unconfirmedRetryPreserved: true, keyboard: true }, null, 2), { mode: 0o600 });
    await context.close();
    console.log('Synthetic schedule timezone, review, recovery and existing records passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(`Failed phase: ${phase}`);
    throw error;
  } finally {
    await browser?.close();
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
