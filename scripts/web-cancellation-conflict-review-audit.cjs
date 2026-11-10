'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const oldLost = process.argv.includes('--old-lost'), old = process.argv.includes('--old') || oldLost, pending = process.argv.includes('--pending'), reload = process.argv.includes('--reload'), lost = process.argv.includes('--lost') || reload || oldLost, stale = process.argv.includes('--stale');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, oldLost ? 'cancellation-review-old-lost' : old ? 'cancellation-review-old' : pending ? 'cancellation-review-pending' : stale ? 'cancellation-review-stale' : reload ? 'cancellation-review-reload' : lost ? 'cancellation-review-lost' : 'cancellation-review'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async state => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(state)]);
  try {
    const state = await read(), person = state.participants[0]; person.cancelled = true; person.inside = false; if (pending) person.status = 'PENDING';
    const oldTicket = person.ticket; await write(state);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [], attempts = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'participant.resolve-cancellation-conflict') return route.continue();
      attempts.push(body.commandId);
      if (old && !(oldLost && attempts.length === 1)) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '지원하지 않는 참가자 작업입니다', field: 'command' }) });
      if (attempts.length === 1 && stale) { const current = await read(); current.participants[0].company = '검토 후 변경'; await write(current); }
      if (attempts.length === 1 && lost) { const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
      return route.continue();
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?ticket=review`);
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).first().click();
    const detail = page.getByRole('dialog', { name: person.name });
    await detail.getByText(/신청 상태와 취소 기록이 일치하지 않습니다/).waitFor();
    await page.screenshot({ path: path.join(out, 'detail-1280.png'), fullPage: true });
    await detail.getByRole('button', { name: '참가 취소 기록 확인', exact: true }).click();
    const review = page.getByRole('dialog', { name: '참가 취소 기록 확인' });
    await review.getByRole('heading', { name: '확인할 참가자' }).waitFor();
    assert.equal(await review.getByRole('button', { name: '확인 내용 저장' }).isDisabled(), true);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
      if (width < 500) {
        for (const button of await review.getByRole('button').all()) {
          if (!await button.isVisible()) continue;
          const box = await button.boundingBox();
          assert.ok(box && box.width >= 44 && box.height >= 44, 'dialog buttons need a 44px touch target');
        }
        const label = await review.locator('label[for="cancellation-conflict-confirm"]').boundingBox();
        assert.ok(label && label.height >= 44, 'the confirmation checkbox label needs a 44px touch target');
      }
      await page.screenshot({ path: path.join(out, `review-${width}.png`), fullPage: true });
    }
    const reason = review.getByLabel('확인 사유 (필수)');
    await reason.fill('참가자에게 직접 참가 의사를 확인');
    await reason.focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'cancellation-conflict-confirm');
    await page.keyboard.press('Space');
    assert.equal(await review.getByLabel('참가자가 취소하지 않고 참가하기로 확인했습니다.').isChecked(), true);
    await review.getByRole('button', { name: '확인 내용 저장' }).press('Enter');
    if (old) {
      if (oldLost) {
        await review.getByRole('button', { name: '같은 요청 다시 확인' }).click();
        await review.getByText(/처리 결과를 확인하지 못했습니다/).waitFor();
        assert.equal(attempts[0], attempts[1]);
        assert.equal((await read()).participants[0].cancelled, false);
        assert.equal((await read()).participants[0].revoked, true);
        assert.equal(await review.getByRole('button', { name: '같은 요청 다시 확인' }).count(), 1);
      } else {
        await review.getByText(/현재 서버에서는 취소 기록을 확인할 수 없습니다/).waitFor();
        assert.equal((await read()).participants[0].cancelled, true);
        assert.equal(await review.getByLabel('확인 사유 (필수)').inputValue(), '참가자에게 직접 참가 의사를 확인');
      }
    } else if (stale) {
      await review.getByText(/참가자 또는 관련 기록이 변경되었습니다/).waitFor();
      assert.equal((await read()).participants[0].cancelled, true);
      await review.getByRole('button', { name: '최신 정보 다시 확인' }).click();
      await review.getByText('검토 후 변경', { exact: false }).waitFor();
      assert.equal(await review.getByLabel('확인 사유 (필수)').inputValue(), '참가자에게 직접 참가 의사를 확인');
      assert.equal(await review.getByLabel('참가자가 취소하지 않고 참가하기로 확인했습니다.').isChecked(), false);
      assert.equal(await review.getByRole('button', { name: '확인 내용 저장' }).isDisabled(), true);
    } else {
      if (reload) {
        await review.getByRole('button', { name: '같은 요청 다시 확인' }).waitFor();
        page.on('dialog', dialog => dialog.accept());
        await page.reload();
        const recovery = page.getByRole('region', { name: '처리 결과 확인' });
        await recovery.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
        await recovery.getByText(person.name, { exact: true }).waitFor();
        await recovery.getByText(/티켓 무효/).waitFor();
        await page.screenshot({ path: path.join(out, 'recovery-1280.png'), fullPage: true });
        await recovery.getByRole('button', { name: '확인 완료', exact: true }).click();
        await recovery.getByText(/확인 내용을 정리했습니다/).waitFor();
        await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).first().click();
      } else {
        if (lost) { await review.getByRole('button', { name: '같은 요청 다시 확인' }).click(); assert.equal(attempts[0], attempts[1]); }
        await review.waitFor({ state: 'hidden' });
        await page.getByText(/참가 취소 기록 확인을 저장했습니다/).first().waitFor();
      }
      let after = await read(); assert.equal(after.participants[0].cancelled, false); assert.equal(after.participants[0].revoked, true);
      assert.equal(after.audit.filter(item => item.type === 'participant.resolve-cancellation-conflict').length, 1);
      const old = await page.request.get(`${f.baseUrl}/api/public/events/${f.eventId}/ticket`, { headers: { Authorization: `Bearer ${oldTicket}` } }); assert.equal(old.status(), 404);
      const newDetail = page.getByRole('dialog', { name: person.name });
      if (pending) {
        await page.keyboard.press('Escape');
        await page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `${person.name} 선택`, exact: true }) }).getByRole('checkbox').check();
        await page.getByText('선택한 승인·확정 대상 중 1명은 처리 후에도 새 티켓을 별도로 발급해야 합니다.').waitFor();
        await page.screenshot({ path: path.join(out, 'approval-review-1280.png'), fullPage: true });
        await page.locator('#roster-approve-selected').click();
        await page.getByText(/기존 티켓은 무효 상태입니다/).first().waitFor();
        after = await read(); assert.equal(after.participants[0].status, 'APPROVED'); assert.equal(after.participants[0].revoked, true);
        assert.equal(after.participants[0].ticket, oldTicket);
        await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).first().click();
      }
      await newDetail.getByRole('button', { name: '티켓 재발급', exact: true }).click();
      const ticket = page.getByRole('dialog', { name: '티켓 재발급' });
      await ticket.getByRole('button', { name: '기존 티켓 무효화 및 재발급' }).click();
      await ticket.getByText(/새 티켓을 발급했습니다/).waitFor();
      after = await read(); assert.notEqual(after.participants[0].ticket, oldTicket); assert.equal(after.participants[0].revoked, false);
      const fresh = await page.request.get(`${f.baseUrl}/api/public/events/${f.eventId}/ticket`, { headers: { Authorization: `Bearer ${after.participants[0].ticket}` } }); assert.equal(fresh.status(), 200);
      if (!lost && !pending) {
        const ownerCookie = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
        const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
        await ownerContext.addCookies([{ name: 'etko_session', value: decodeURIComponent(ownerCookie.slice('etko_session='.length)), url: f.baseUrl }]);
        const owner = await ownerContext.newPage(); await owner.goto(`${f.baseUrl}/console/team`);
        await owner.getByText('연동·활동', { exact: true }).click();
        await owner.getByText(new RegExp(`참가 취소 기록 확인.*${person.name}.*참가자에게 직접 참가 의사를 확인`)).waitFor();
        await owner.screenshot({ path: path.join(out, 'activity-1280.png'), fullPage: true });
        await ownerContext.close();
      }
    }
    assert.deepEqual(errors, []);
    console.log('cancellation conflict review: passed');
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
