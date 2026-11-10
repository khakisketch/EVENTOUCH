'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const lost = process.argv.includes('--lost');
  const before = process.argv.includes('--before');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'approval-conflict-before' : lost ? 'approval-conflict-lost' : 'approval-conflict'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async state => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(state)]);
  try {
    const state = await read(), template = state.participants[0];
    const make = (id, name, cancelled) => ({ ...template, id, name, phone: id === 'normal' ? '01011112222' : id === 'conflict' ? '01022223333' : '01033334444', ticket: `ET:${f.eventId}:T-${crypto.randomBytes(32).toString('base64url')}`, status: 'PENDING', cancelled, inside: false, everIn: false, revoked: false });
    state.participants = [make('normal', '합성 정상', false), make('conflict', '합성 충돌', true), make('race', '합성 변경', false)];
    await write(state);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.locator('#roster-search').waitFor();
    const row = name => page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `${name} 선택`, exact: true }) });
    if (before) {
      await row('합성 충돌').getByRole('checkbox').check();
      await row('합성 정상').getByRole('checkbox').check();
      assert.equal(await row('합성 충돌').getByRole('button', { name: '승인', exact: true }).count(), 1);
      assert.equal(await page.locator('#roster-approve-selected').innerText(), '신청 승인 2');
      await page.screenshot({ path: path.join(out, 'before-1280.png'), fullPage: true });
      console.log('reconstructed previous approval screen captured');
      return;
    }
    await row('합성 충돌').getByText('취소 상태 확인 필요').waitFor();
    assert.equal(await row('합성 충돌').getByRole('button', { name: '승인', exact: true }).count(), 0);
    await row('합성 충돌').getByRole('checkbox').check();
    await row('합성 정상').getByRole('checkbox').check();
    await page.getByText('취소 기록 확인이 필요한 1명은 승인·확정에서 제외됩니다.', { exact: false }).waitFor();
    assert.equal(await page.locator('#roster-approve-selected').innerText(), '신청 승인 1');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
      await page.screenshot({ path: path.join(out, `selection-${width}.png`), fullPage: true });
    }
    const [approval] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/commands') && response.request().method() === 'POST'), page.locator('#roster-approve-selected').press('Enter')]);
    assert.equal(approval.status(), 200, JSON.stringify(await approval.json()));
    await page.getByText(/1명을 승인했습니다/).first().waitFor();
    let after = await read();
    assert.equal(after.participants.find(p => p.id === 'normal').status, 'APPROVED');
    assert.equal(after.participants.find(p => p.id === 'conflict').status, 'PENDING');
    await page.getByRole('button', { name: '합성 충돌 참가자 상세', exact: true }).first().click();
    const detail = page.getByRole('dialog', { name: '합성 충돌' });
    await detail.getByText(/신청 상태와 취소 기록이 일치하지 않습니다/).waitFor();
    assert.equal(await detail.getByRole('option', { name: '참가 확정' }).isDisabled(), true);
    assert.equal(await detail.getByRole('option', { name: '신청 취소' }).isDisabled(), false);
    await page.screenshot({ path: path.join(out, 'detail-1280.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await row('합성 충돌').getByRole('checkbox').uncheck();
    await row('합성 변경').getByRole('checkbox').check();
    const attempts = [];
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'participant.status') return route.continue();
      attempts.push(body.commandId);
      if (attempts.length === 1) {
        const current = await read(); current.participants.find(p => p.id === 'race').cancelled = true; await write(current);
        if (lost) { const response = await route.fetch(); assert.equal(response.status(), 409); return route.abort('failed'); }
      }
      return route.continue();
    });
    await page.locator('#roster-approve-selected').click();
    if (lost) {
      await page.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).click();
      assert.equal(attempts[0], attempts[1]);
    }
    await page.getByText(/신청 상태와 취소 기록을 확인한 뒤 상태를 변경하세요/).first().waitFor();
    await row('합성 변경').getByText('취소 상태 확인 필요').waitFor();
    assert.equal(await page.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).count(), 0);
    after = await read(); assert.equal(after.participants.find(p => p.id === 'race').status, 'PENDING');
    assert.deepEqual(errors, []);
    console.log('approval cancellation conflict: passed');
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
