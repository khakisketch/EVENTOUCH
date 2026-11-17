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
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendance-reconciliation');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  const command = async (command, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
    method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
  });
  try {
    const initial = await read(), person = initial.participants[0]; initial.allowReentry = false; await write(initial);
    assert.equal((await command('check.scan', { deskId: f.deskId, ticket: person.ticket, expectedAction: 'IN' })).status, 200);
    const damaged = await read(); damaged.participants[0].inside = false; await write(damaged);
    browser = await launchBrowser();
    const limitedId = `limited-${crypto.randomUUID()}`, onsiteId = `onsite-${crypto.randomUUID()}`;
    for (const [id, scope] of [[limitedId, 'participants'], [onsiteId, 'onsite']]) {
      await f.helpers.insertAccount(f.harness.database, { id, role: 'MANAGER', name: '합성 담당자', email: `${id}@example.test`, orgId: f.helpers.LEGACY_ORG });
      await f.helpers.insertMembership(f.harness.database, id, f.eventId, [scope]);
      const cookie = (await f.helpers.sessionCookie(f.harness, id)).split('=');
      const scoped = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await scoped.addCookies([{ name: cookie[0], value: cookie.slice(1).join('='), url: f.baseUrl }]);
      const tab = await scoped.newPage();
      await tab.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?attendance=REVIEW`);
      await tab.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
      const button = tab.getByRole('dialog', { name: person.name }).getByRole('button', { name: '출입 상태 확인', exact: true });
      assert.equal(await button.count(), scope === 'onsite' ? 1 : 0);
      await scoped.close();
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await page.getByRole('link', { name: '출입 기록 확인 필요 1명' }).click();
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
    const inspector = page.getByRole('dialog', { name: person.name });
    await inspector.getByRole('button', { name: '출입 상태 확인', exact: true }).click();
    const review = page.getByRole('dialog', { name: '출입 상태 확인 및 복구' });
    await review.getByRole('heading', { name: '확인할 참가자' }).waitFor();
    await review.getByText('복구 후', { exact: true }).waitFor();
    await review.getByText('입장 중', { exact: true }).waitFor();
    await review.getByText('누적 입장에 포함', { exact: false }).waitFor();
    const checkbox = review.getByLabel('이 참가자가 현재 행사장 안에 있음을 확인했습니다.');
    const save = review.getByRole('button', { name: '출입 상태 복구', exact: true });
    assert.equal(await save.isDisabled(), true);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.equal(await checkbox.evaluate(element => getComputedStyle(element.parentElement).display), 'flex');
      const saveBox = await save.boundingBox(), dialogBox = await review.boundingBox();
      assert.ok(saveBox && dialogBox && saveBox.y + saveBox.height <= dialogBox.y + dialogBox.height + 1, 'the primary action remains inside the visible dialog');
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `review-${width}.png`), fullPage: true });
      await checkbox.check();
      const checkedBox = await checkbox.boundingBox(), stickyAction = await save.boundingBox();
      assert.ok(checkedBox && stickyAction && checkedBox.y + checkedBox.height <= stickyAction.y, 'the confirmation remains usable above the sticky action');
      if (width === 320) await page.screenshot({ path: path.join(out, 'review-confirmation-320.png'), fullPage: true });
      if (width === 320) {
        await checkbox.focus(); await page.keyboard.press('Tab');
        assert.equal(await review.getByRole('button', { name: '닫기', exact: true }).evaluate(button => button === document.activeElement), true, 'keyboard focus stays inside the dialog');
      }
      await checkbox.uncheck();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await review.getByLabel('확인 사유').fill('현장 책임자가 실제 위치를 확인');
    await checkbox.focus(); await page.keyboard.press('Space'); assert.equal(await checkbox.isChecked(), true);
    await review.getByRole('button', { name: '닫기', exact: true }).click();
    await review.getByText('작성한 출입 확인 사유가 사라집니다.').waitFor();
    await review.getByRole('button', { name: '계속 작업', exact: true }).click();
    const changed = await read(); changed.participants[0].company = '변경된 합성 소속'; await write(changed);
    await save.click();
    await review.getByText(/참가자 또는 출입 기록이 바뀌었거나 확인할 수 없습니다/).waitFor();
    assert.equal((await read()).participants[0].inside, false);
    await review.getByRole('button', { name: '최신 기록 다시 확인' }).click();
    await review.getByText(/변경된 합성 소속/).waitFor();
    assert.equal(await checkbox.isChecked(), false); assert.equal(await review.getByLabel('확인 사유').inputValue(), '현장 책임자가 실제 위치를 확인');
    await checkbox.check();
    const requests = []; let fault = 'lost';
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'check.reconcile') return route.continue();
      requests.push(body.commandId);
      if (fault === 'lost') { fault = 'temporary'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
      if (fault === 'temporary') { fault = 'pass'; return route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    });
    await save.click();
    const retry = review.getByRole('button', { name: '같은 요청 다시 시도', exact: true });
    await retry.waitFor();
    await page.screenshot({ path: path.join(out, 'uncertain-1280.png'), fullPage: true });
    await retry.click(); await retry.waitFor(); await retry.click();
    await review.waitFor({ state: 'hidden', timeout: 20000 });
    assert.equal(requests.length, 3); assert.equal(new Set(requests).size, 1);
    const result = await read();
    assert.equal(result.participants[0].inside, true); assert.equal(result.participants[0].everIn, true);
    assert.equal(result.checks.filter(item => item.participantId === person.id).length, 1);
    assert.equal(result.audit.filter(item => item.type === 'check.reconcile' && item.reconciliation?.participantId === person.id).length, 1);
    assert.equal(await page.evaluate(id => Object.keys(localStorage).some(key => key.endsWith(id)), requests[0]), false);
    await page.getByText(`${person.name}님의 출입 상태를 복구했습니다. 최신 명단을 확인하세요.`).waitFor();
    assert.equal(await page.getByRole('dialog', { name: person.name }).count(), 0, 'the updated list and confirmation are visible');
    await page.waitForFunction(() => document.activeElement?.id === 'roster-search');
    await page.getByRole('heading', { name: '확인이 필요한 출입 기록이 없습니다.' }).waitFor();
    await page.screenshot({ path: path.join(out, 'completed-list-1280.png'), fullPage: true });
    await page.getByRole('button', { name: '전체 참가자 보기', exact: true }).click();
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'roster-search');
    assert.equal(new URL(page.url()).searchParams.has('attendance'), false);
    const activity = await context.newPage();
    await activity.goto(`${f.baseUrl}/console/team`);
    await activity.getByRole('tab', { name: '연동·활동' }).click();
    const activityList = activity.getByRole('list', { name: '최근 활동 목록' });
    const activityRow = activityList.getByRole('listitem').filter({ hasText: '출입 상태 복구' }).filter({ hasText: person.name });
    await activityRow.getByText(/입장 중/).waitFor();
    await activityRow.getByText(/현장 책임자가 실제 위치를 확인/).waitFor();
    await activity.screenshot({ path: path.join(out, 'activity-1280.png'), fullPage: true });
    await activity.close();

    // A last valid OUT is a different explicit confirmation; no scan is
    // invented while reconciling it either.
    const second = result.participants[1];
    const outDesk = await command('desk.save', { name: '합성 퇴장 데스크', action: 'OUT', mode: 'desk', open: true });
    assert.equal(outDesk.status, 201, JSON.stringify(outDesk.json));
    assert.equal((await command('check.scan', { deskId: f.deskId, ticket: second.ticket, expectedAction: 'IN' })).status, 200);
    assert.equal((await command('check.scan', { deskId: outDesk.json.desk.id, ticket: second.ticket, expectedAction: 'OUT' })).status, 200);
    const uncertainOut = await read(); uncertainOut.participants[1].inside = null; uncertainOut.participants[1].everIn = false; await write(uncertainOut);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?attendance=REVIEW`);
    await page.getByRole('button', { name: `${second.name} 참가자 상세`, exact: true }).click();
    await page.getByRole('dialog', { name: second.name }).getByRole('button', { name: '출입 상태 확인', exact: true }).click();
    const outReview = page.getByRole('dialog', { name: '출입 상태 확인 및 복구' });
    await outReview.getByText('복구 후', { exact: true }).waitFor();
    await outReview.getByText('퇴장', { exact: true }).first().waitFor();
    await outReview.getByLabel('확인 사유').fill('현장 책임자가 실제 퇴장 상태 확인');
    await outReview.getByLabel('이 참가자가 현재 행사장 밖에 있음을 확인했습니다.').check();
    fault = 'lost'; const beforeOutRequests = requests.length;
    await outReview.getByRole('button', { name: '출입 상태 복구', exact: true }).click();
    await outReview.getByRole('button', { name: '서버 처리 확인', exact: true }).waitFor();
    const otherTab = await context.newPage();
    await otherTab.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    const recovery = otherTab.getByRole('region', { name: '처리 결과 확인' });
    await recovery.getByText('출입 상태 복구', { exact: false }).waitFor();
    await recovery.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await recovery.getByText(/서버에 반영된 것을 확인했습니다/).waitFor();
    await outReview.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await outReview.waitFor({ state: 'hidden' });
    assert.equal(requests.length, beforeOutRequests + 1, 'cross-tab status check never submits a second write');
    await otherTab.close();
    const afterOut = await read();
    assert.equal(afterOut.participants[1].inside, false); assert.equal(afterOut.participants[1].everIn, true);
    assert.equal(afterOut.checks.filter(item => item.participantId === second.id).length, 2);

    // No reliable latest record is never converted into a guess.
    const noEvidence = afterOut.participants[2]; noEvidence.inside = null; await write(afterOut);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?attendance=REVIEW`);
    await page.getByRole('button', { name: `${noEvidence.name} 참가자 상세`, exact: true }).click();
    await page.getByRole('dialog', { name: noEvidence.name }).getByRole('button', { name: '출입 상태 확인', exact: true }).click();
    const noReview = page.getByRole('dialog', { name: '출입 상태 확인 및 복구' });
    await noReview.getByText(/복구에 필요한 참가자 정보 또는 출입·작업 기록을 확인할 수 없습니다/).waitFor();
    assert.equal(await noReview.getByRole('button', { name: '출입 상태 복구', exact: true }).isDisabled(), true);
    await context.close();
    assert.deepEqual(errors, []);
    console.log('History review, stale identity, lost response, one audit record and current roster passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
