'use strict';
const { messageStep } = require('./ui-journey-helpers.cjs');

// Synthetic status snapshots only: no message dispatch or real provider.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'message-before' : 'message-results');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const { database } = fixture.harness;
    const workspace = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const persons = workspace.participants.slice(0, 3);
    const common = { channel: 'SMS', body: '합성 안내', at: '2026-10-01T00:00:00Z', simulate: false, attempts: 1 };
    workspace.messages = [
      { ...common, id: 'audit-pending', title: '결과 확인 검증', status: 'SENDING', providerKind: 'solapi', acceptedCount: 2, recipientIds: persons.map(person => person.id),
        deliveries: persons.map((person, index) => ({ participantId: person.id, name: person.name, status: ['SENT', 'FAILED', 'SENDING'][index], at: common.at })) },
      { ...common, id: 'audit-submission-unknown', title: '합성 접수 미확인', status: 'SENDING',
        providerSubmission: { id: crypto.randomUUID(), at: common.at }, recipientIds: [persons[0].id],
        deliveries: [{ participantId: persons[0].id, name: persons[0].name, status: 'SENDING', at: common.at }] },
      { ...common, id: 'audit-blocked', title: '예약 점검 검증', status: 'SCHEDULED', body: '{{럭키번호}}', scheduled: '2020-01-01T00:00:00Z', recipientIds: [persons[0].id], deliveries: [], attempts: 0 },
      { ...common, id: 'audit-legacy-delivery', title: '합성 출처 미확인', status: 'SENT', recipientIds: [persons[0].id], deliveries: [{ participantId: persons[0].id, name: persons[0].name, status: 'SENT', at: common.at }] },
    ];
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages`, { waitUntil: 'networkidle' });
    assert.match(await page.locator('#campaign-audit-legacy-delivery').innerText(), /전달 근거 미확인/);
    await page.getByRole('button', { name: '결과 확인 검증 상세', exact: true }).click();
    await page.getByRole('button', { name: '예약 점검 검증 상세', exact: true }).click();
    await page.screenshot({ path: path.join(out, 'history-1280.png'), fullPage: true });
    if (!before) {
      phase = 'delivery states';
      await page.getByRole('button', { name: '결과 확인 검증 상세', exact: true }).click();
      const details = page.locator('#campaign-detail-audit-pending');
      assert.match(await details.innerText(), /공급사 접수 2명 · 전달 확인 1명 · 실패 1명 · 확인 중 1명/);
      assert.match(await details.innerText(), /공급사 접수는 최종 전달과 다릅니다/);
      await details.getByText(/수신자별 처리 상태/).click();
      assert.match(await details.innerText(), /접수·전달 상태 확인 중/);
      await page.screenshot({ path: path.join(out, 'delivery-details-1280.png'), fullPage: true });
      const blockedRow = page.locator('[data-history-row]').filter({ hasText: '예약 점검 검증' });
      assert.match(await blockedRow.innerText(), /실행 전 확인 필요/);
      assert.equal(await blockedRow.getByRole('button', { name: '발송 실행', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '예약 점검 검증 상세', exact: true }).click();
      const blocked = page.locator('#campaign-detail-audit-blocked');
      assert.match(await blocked.innerText(), /수동 실행/);
      assert.match(await blocked.innerText(), /럭키번호가 배정되지 않았습니다/);
      await page.screenshot({ path: path.join(out, 'details-1280.png'), fullPage: true });
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.screenshot({ path: path.join(out, `history-${width}.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      }
      await page.evaluate(axeSource);
      const issues = await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id));
      assert.deepEqual(issues, []);

      phase = 'supplier acceptance still unknown';
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages?attention=1`, { waitUntil: 'networkidle' });
      const unconfirmed = page.locator('#campaign-audit-submission-unknown');
      await unconfirmed.getByText('공급사 접수 미확인', { exact: true }).waitFor();
      await unconfirmed.getByRole('button', { name: '합성 접수 미확인 상세', exact: true }).press('Enter');
      assert.match(await page.locator('#campaign-detail-audit-submission-unknown').innerText(), /접수 내역만 다시 조회합니다/);
      assert.equal(await unconfirmed.getByRole('button', { name: '발송 결과 확인', exact: true }).count(), 1);
      assert.equal(await unconfirmed.getByRole('button', { name: '내용·대상 불러오기', exact: true }).count(), 0);

      phase = 'ambiguous recipient result';
      workspace.messages[0].deliveries[2].resultMatchUnconfirmed = true;
      await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '결과 확인 검증 상세', exact: true }).press('Enter');
      await details.getByText(/수신자별 처리 상태/).press('Enter');
      assert.equal(await details.getByText('결과 연결 미확인', { exact: true }).count(), 1);
      assert.match(await details.innerText(), /공급사 내역과 명단의 연락처를 확인하세요/);

      phase = 'changed reservation recipient';
      const command = async (command, payload, status = 200) => {
        const response = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
          method: 'POST', cookie: fixture.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
        });
        assert.equal(response.status, status);
        return response.json;
      };
      const title = '변경 대상 재검토';
      const body = '예약 본문을 다시 검토합니다.';
      const reservation = (await command('message.create', {
        ids: persons.slice(0, 2).map(person => person.id), title, body, channel: 'SMS',
        scheduled: new Date(Date.now() + 3_600_000).toISOString(),
      }, 201)).message;
      const contact = '01000009998';
      await command('participant.update', { id: persons[0].id, phone: contact });
      await command('participant.status', { ids: [persons[1].id], status: 'CANCELLED' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages?attention=1`, { waitUntil: 'networkidle' });
      const changed = page.locator(`[id="campaign-${reservation.id}"]`);
      const changedDetail = page.locator(`[id="campaign-detail-${reservation.id}"]`);
      await changed.getByRole('button', { name: `${title} 상세`, exact: true }).press('Enter');
      assert.match(await changed.innerText(), /수신자 변경 · 발송 보류/);
      await changedDetail.getByRole('heading', { name: '변경된 수신자 2명', exact: true }).waitFor();
      assert.equal(await changedDetail.getByRole('list', { name: '변경된 수신자 목록' }).getByRole('listitem').count(), 2);
      await changed.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, 'recipient-hold-390.png') });
      await changed.getByRole('button', { name: '예약 취소', exact: true }).press('Enter');
      await changedDetail.getByRole('button', { name: '예약을 취소한다', exact: true }).press('Enter');
      await changed.getByRole('button', { name: '내용·대상 불러오기', exact: true }).press('Enter');
      await page.locator('#campaign-reload-summary').waitFor();
      assert.match(await page.locator('#campaign-reload-summary').innerText(), /선택 1명 · 제외 1명/);
      assert.match(await page.locator('#campaign-recipients').innerText(), /9998/);
      await page.waitForFunction(() => document.activeElement?.id === 'recipient-search');
      await page.evaluate(axeSource);
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations
          .filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
        if (width === 390 || width === 1280) await page.screenshot({ path: path.join(out, `recipient-reload-${width}.png`) });
      }
      await messageStep(page, 2);
      assert.equal(await page.locator('#campaign-title').inputValue(), title);
      assert.equal(await page.locator('#campaign-body').inputValue(), body);
      assert.equal(await page.locator('#campaign-scheduled').inputValue(), '');
      const saved = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
      const original = saved.messages.find(message => message.id === reservation.id);
      assert.equal(original.status, 'CANCELLED');
      assert.equal(original.attempts, 0);
      assert.equal(saved.messages.filter(message => message.title === title).length, 1);
      assert.equal(fixture.gateway.commands.filter(call => ['message.retry', 'message.retry-charset-reviewed'].includes(call.command)).length, 0);
      await messageStep(page, 3);
      await page.getByRole('checkbox', { name: /^모의 발송으로 기록/ }).check();
      await page.locator('#campaign-submit').click();
      const newReview = page.getByRole('group', { name: '실행 확인', exact: true });
      assert.match(await newReview.innerText(), /1명/);
      const [created] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/commands')),
        newReview.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click(),
      ]);
      assert.equal(created.status(), 201);
      const result = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
      const replacement = result.messages.filter(message => message.title === title && message.id !== reservation.id);
      assert.equal(replacement.length, 1);
      assert.equal(replacement[0].status, 'SIMULATED');
      assert.deepEqual(replacement[0].recipientIds, [persons[0].id]);
      assert.equal(replacement[0].recipientSnapshot[0].phone, contact);
    }
    phase = 'schedule compose';
    const createsBeforeReview = fixture.gateway.commands.filter(call => ['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(call.command)).length;
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages?to=${encodeURIComponent(persons[0].id)}`, { waitUntil: 'networkidle' });
    await page.locator('#campaign-title').fill('합성 예약');
    await page.locator('#campaign-body').fill('합성 안내');
    await messageStep(page, 3);
    await page.locator('details').filter({ has: page.locator('#campaign-scheduled') }).locator('summary').click();
    await page.locator('#campaign-scheduled').fill('2099-01-16T10:00');
    assert.equal(await page.getByRole('radio', { name: '수동 실행', exact: true }).isChecked(), true);
    await page.getByRole('radio', { name: '자동 실행', exact: true }).check();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(out, 'schedule-1280.png'), fullPage: true });
    if (!before) {
      assert.equal(await page.getByText(/예약 시각 이후 자동 발송을 시도합니다/).count(), 1, 'long execution guidance appears once in the editor');
      assert.equal(await page.locator('#message-composer').getByText(/이 서버의 예약 자동 실행 설정이 꺼져 있습니다/).count(), 1, 'server status appears once in the editor');
      await page.locator('#campaign-submit').click();
      const confirmation = page.getByRole('group', { name: '실행 확인', exact: true });
      assert.match(await confirmation.innerText(), /자동 실행/);
      assert.match(await confirmation.innerText(), /나중에 설정을 켜면 발송될 수 있습니다/);
      assert.equal(fixture.gateway.commands.filter(call => ['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(call.command)).length, createsBeforeReview, 'review never sends');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'schedule-confirm-390.png'), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', syntheticOnly: true, providerCalled: false, manualLegacyPreserved: true, noSendOnReview: true }, null, 2), { mode: 0o600 });
    }
    console.log(`Message ${before ? 'before capture' : 'results and schedule'} passed`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
