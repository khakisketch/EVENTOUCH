'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'workspace-preservation');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.getByRole('button', { name: '참가자 추가', exact: true }).click();
    const form = page.getByRole('dialog', { name: '참가자 추가' });
    await form.locator('#participant-add-name').fill('합성 보존 참가자');
    await form.locator('#participant-add-phone').fill('01076543210');
    const original = await read(), damaged = structuredClone(original);
    damaged.participants = { original: '복구할 명단' };
    await write(damaged);
    await form.locator('button[form="participant-add-form"]').click();
    await form.getByText('참가자 명단을 확인할 수 없어 저장하지 못했습니다. 화면을 새로 고친 뒤에도 같으면 조직 관리자에게 문의하세요.').waitFor();
    assert.equal(await form.locator('#participant-add-name').inputValue(), '합성 보존 참가자');
    assert.equal(await form.locator('#participant-add-phone').inputValue(), '01076543210');
    assert.deepEqual(await read(), damaged, 'failed create leaves all original data intact');
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact)));
      assert.deepEqual(violations, []);
      await page.screenshot({ path: path.join(out, `blocked-${width}.png`) });
    }
    original.rewards = { preserved: '손상된 다른 자료' };
    await write(original);
    await form.locator('button[form="participant-add-form"]').click();
    await form.waitFor({ state: 'hidden' });
    await page.getByText('합성 보존 참가자님을 등록했습니다.').waitFor();
    const result = await read();
    assert.equal(result.participants.filter(item => item.name === '합성 보존 참가자').length, 1);
    assert.deepEqual(result.rewards, original.rewards);
    await page.screenshot({ path: path.join(out, 'saved-1280.png') });

    const scheduled = new Date(Date.now() + 60000).toISOString();
    const reservation = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie,
      body: { commandId: crypto.randomUUID(), command: 'message.create', payload: {
        ids: [result.participants[0].id], title: '합성 예약 안내', channel: 'SMS', body: '행사 안내입니다.', scheduled, scheduleMode: 'AUTO',
      } },
    });
    assert.equal(reservation.status, 201, JSON.stringify(reservation.json));
    const beforeAuditDamage = await read(); beforeAuditDamage.audit = { original: '복구할 이력' }; await write(beforeAuditDamage);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`);
    await page.getByRole('button', { name: '합성 예약 안내 상세', exact: true }).click();
    const detail = page.locator(`[id="campaign-detail-${reservation.json.message.id}"]`);
    await detail.getByText(/행사 활동 기록을 확인할 수 없어/).waitFor();
    assert.equal(await page.locator(`[id="campaign-${reservation.json.message.id}"]`).getByRole('button', { name: '예약 취소', exact: true }).isDisabled(), true);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact)));
      assert.deepEqual(violations, []);
      await page.screenshot({ path: path.join(out, `scheduled-after-${width}.png`), fullPage: true });
    }
    beforeAuditDamage.audit = [];
    await write(beforeAuditDamage);
    await page.reload();
    await page.getByRole('button', { name: '합성 예약 안내 상세', exact: true }).click();
    assert.equal(await page.getByText(/행사 활동 기록을 확인할 수 없어/).count(), 0, 'warning clears after the record is repaired');
    assert.equal(await page.locator(`[id="campaign-${reservation.json.message.id}"]`).getByRole('button', { name: '예약 취소', exact: true }).isEnabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Blocked create preserves entered values; repaired create persists once without replacing other data');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
