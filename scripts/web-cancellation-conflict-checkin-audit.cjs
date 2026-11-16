'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { typeTicket, holdResults } = require('./audit-staff-direction.cjs');
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const lost = process.argv.includes('--lost');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, lost ? 'cancellation-conflict-checkin-lost' : 'cancellation-conflict-checkin'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  try {
    const state = await read(), conflict = state.participants[0], valid = state.participants[1];
    conflict.cancelled = true;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(state)]);
    browser = await launchBrowser();
    const staffContext = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await staffContext.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
    const page = await staffContext.newPage(), errors = [], attempts = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'check.scan') return route.continue();
      attempts.push(body.commandId);
      if (lost && attempts.length === 1) {
        const response = await route.fetch(); assert.equal(response.status(), 409);
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    await page.getByRole('region', { name: '데스크 업무 방향을 확인해 주세요' }).getByRole('button', { name: '입장 업무 확인' }).click();
    await holdResults(page);
    await typeTicket(page, conflict.ticket);
    if (lost) {
      await page.getByRole('button', { name: '입장 처리', exact: true }).click();
      const uncertain = page.getByRole('region', { name: '스캔 결과 미확인', exact: true });
      await uncertain.getByRole('button', { name: '같은 요청 재확인' }).waitFor();
    }
    const [denied] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/commands') && response.request().method() === 'POST'),
      lost ? page.getByRole('region', { name: '스캔 결과 미확인', exact: true }).getByRole('button', { name: '같은 요청 재확인' }).click()
        : page.getByRole('button', { name: '입장 처리', exact: true }).click(),
    ]);
    assert.equal(denied.status(), 409); assert.equal((await denied.json()).code, 'TICKET_STATUS_CONFLICT');
    if (lost) { assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1], 'the retry uses the original request'); }
    const failure = page.getByRole('region', { name: '스캔 실패', exact: true });
    await failure.getByText('신청 상태와 취소 기록이 일치하지 않습니다. 현장 책임자에게 확인을 요청하세요.').waitFor();
    assert.equal(await failure.getByRole('button', { name: '다시 시도' }).count(), 0);
    assert.equal((await read()).checks.length, 0);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
      await page.screenshot({ path: path.join(out, `staff-${width}.png`), fullPage: true });
    }
    await failure.getByRole('button', { name: '다음 참가자' }).click();
    await typeTicket(page, valid.ticket);
    await page.getByRole('button', { name: '입장 처리', exact: true }).click();
    await page.getByRole('region', { name: '스캔 결과 상세' }).getByText(valid.name, { exact: false }).waitFor();
    const checks = (await read()).checks;
    assert.equal(checks.length, 1); assert.equal(checks[0].participantId, valid.id);
    const changed = await read();
    changed.participants.find(person => person.id === valid.id).cancelled = true;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(changed)]);
    const managerContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await managerContext.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const manager = await managerContext.newPage();
    await manager.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?ticket=review`);
    await manager.getByRole('button', { name: `${conflict.name} 참가자 상세`, exact: true }).first().click();
    const detail = manager.getByRole('dialog', { name: conflict.name });
    await detail.getByText(/신청 상태와 취소 기록이 일치하지 않습니다/).waitFor();
    assert.equal(await detail.getByRole('button', { name: '티켓 재발급', exact: true }).isDisabled(), true);
    await manager.screenshot({ path: path.join(out, 'manager-1280.png'), fullPage: true });
    await manager.keyboard.press('Escape');
    await manager.getByRole('button', { name: `${valid.name} 참가자 상세`, exact: true }).first().click();
    await manager.getByRole('dialog', { name: valid.name }).getByRole('button', { name: '확인 후 퇴장 기록', exact: true }).click();
    const review = manager.getByRole('dialog', { name: '확인 후 퇴장 기록' });
    await review.getByRole('heading', { name: '확인할 참가자' }).waitFor();
    await manager.screenshot({ path: path.join(out, 'manager-reviewed-exit-1280.png'), fullPage: true });
    await review.getByLabel('확인 사유').fill('현장에서 실제 퇴장 확인');
    await review.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').check();
    await review.getByRole('button', { name: '퇴장 기록', exact: true }).click();
    await review.waitFor({ state: 'hidden' });
    const result = await read();
    assert.equal(result.participants.find(person => person.id === valid.id).inside, false);
    assert.equal(result.checks.filter(item => item.participantId === valid.id && item.source === 'REVIEWED_EXIT').length, 1);
    assert.deepEqual(errors, []);
    console.log('cancellation conflict check-in: passed');
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
