'use strict';
// Uses isolated event data and a disconnected provider. Never sends a message.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { source: axe } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-routing-review'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const db = f.harness.database, cookie = f.manager.cookie;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const command = (command, payload, commandId = crypto.randomUUID()) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie, body: { commandId, command, payload } });
    const initial = await read(), people = initial.participants.slice(0, 2);
    const bootstrap = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/bootstrap?messageRecipientReview=1`, { cookie });
    const versions = bootstrap.json.state.recipientReviewVersions, ids = [];
    for (let i = 0; i < 2; i++) {
      const result = await command('message.create-charset-reviewed', { ids: [people[i].id], expectedRecipientVersions: [versions[people[i].id]], channel: 'SMS', title: i ? '합성 그룹 예약' : '합성 참가 상태 예약', body: '합성 예약 안내', simulate: false, scheduled: new Date(Date.now() + 3600000).toISOString(), scheduleMode: 'MANUAL' });
      assert.equal(result.status, 201, JSON.stringify(result.json)); ids.push(result.json.message.id);
    }
    assert.equal((await command('participant.status', { ids: [people[0].id], status: 'WAITLIST' })).status, 200);
    const group = initial.groups.find(value => value !== people[1].group); assert.ok(group);
    assert.equal((await command('group.assign', { ids: [people[1].id], group })).status, 200);
    const ws = await read();
    for (const message of ws.messages.filter(item => ids.includes(item.id))) message.scheduled = new Date(Date.now() - 60000).toISOString();
    const old = structuredClone(ws.messages.find(item => item.id === ids[1]));
    old.id = 'synthetic-legacy-reservation'; old.title = '합성 이전 예약'; old.scheduled = new Date(Date.now() + 3600000).toISOString(); old.scheduleMode = 'AUTO'; old.autoScheduleIntent = 'confirmed-v1';
    delete old.recipientRoutingReviewVersion; delete old.recipientSnapshot[0].routingVersion; ws.messages.unshift(old);
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]);
    const refreshed = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/bootstrap?messageRecipientReview=1`, { cookie });
    for (const id of ids) assert.equal(refreshed.json.state.messageSchedule.blocked.find(item => item.id === id)?.reason, 'RECIPIENT_CHANGED');
    const summary = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/bootstrap?messageAttentionSummary=1`, { cookie });
    assert.equal(summary.json.state.messageAttentionSummary.blocked, true, 'the message menu shows that a reservation needs attention');
    const denied = await command('message.retry-charset-reviewed', { id: ids[0] });
    assert.equal(denied.status, 409); assert.equal(denied.json.field, 'recipientChange');
    browser = await launchBrowser(); const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`);
    const statusRow = page.locator('[data-history-row]').filter({ hasText: '합성 참가 상태 예약' });
    const groupRow = page.locator('[data-history-row]').filter({ hasText: '합성 그룹 예약' });
    const oldRow = page.locator('[data-history-row]').filter({ hasText: '합성 이전 예약' });
    await statusRow.getByText('수신자 변경 · 발송 보류').waitFor(); await groupRow.getByText('수신자 변경 · 발송 보류').waitFor();
    await oldRow.getByText('참가 상태·그룹 직접 확인').waitFor();
    assert.equal(await statusRow.getByRole('button', { name: '발송 실행' }).isDisabled(), true);
    await statusRow.getByRole('button', { name: '합성 참가 상태 예약 상세' }).click();
    const detail = page.locator(`#campaign-detail-${ids[0]}`);
    await detail.getByText(/참가 상태·그룹·연락처가 달라졌거나 확인할 수 없습니다/).waitFor();
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await statusRow.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `blocked-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await oldRow.getByRole('button', { name: '합성 이전 예약 상세' }).click();
    await page.getByText(/이전 발송 요청은 예약 당시의 참가 상태와 그룹을 확인할 수 없어/).waitFor();
    const oldDetail = page.locator('#campaign-detail-synthetic-legacy-reservation');
    await oldDetail.getByText(/자동 실행 시에도 이 비교 없이 발송될 수 있으므로/).waitFor();
    assert.match(await oldDetail.getByRole('link', { name: '참가자 명단 보기' }).getAttribute('href'), /\/participants$/);
    await statusRow.getByRole('button', { name: '예약 취소' }).click();
    const confirm = page.getByRole('group', { name: '실행 확인' });
    await confirm.getByRole('button', { name: '예약 취소하기' }).click();
    await statusRow.getByRole('button', { name: '내용·대상 불러오기' }).waitFor();
    await statusRow.getByRole('button', { name: '내용·대상 불러오기' }).click();
    await page.locator('#campaign-reload-summary').getByText(/선택 1명/).waitFor();
    await page.locator('#campaign-recipients').waitFor({ state: 'visible' }); // Reopened 2026-11-24 (시안 A): a reload whose recipients changed opens the 받는 사람 panel for review
    const final = await read();
    assert.equal(final.messages.find(item => item.id === ids[0]).status, 'CANCELLED');
    assert.equal(final.messages.find(item => item.id === ids[1]).status, 'SCHEDULED');
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, noExternalProvider: true, statusAndGroupChangesBlocked: true, oldReservationWarning: true, cancellationAndReview: true, widths: [320, 390, 1280], physicalDevices: false }, null, 2));
    console.log('message routing: status/group review, legacy warning and cancellation passed');
  } finally { await browser?.close(); await f.close(); }
})().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
