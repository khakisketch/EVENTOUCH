'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'reviewed-exit-before' : 'reviewed-exit');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const command = async (command, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
    method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
  });
  try {
    const person = (await read()).participants[0];
    const entry = await command('check.scan', { deskId: f.deskId, ticket: person.ticket, expectedAction: 'IN' });
    assert.equal(entry.status, 200, JSON.stringify(entry.json));
    const changed = await read();
    Object.assign(changed.participants.find(p => p.id === person.id), { status: 'PENDING', ticketExpiresAt: '2020-01-01T00:00:00.000Z', paymentStatus: 'PENDING' });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(changed)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.locator('#roster-search').fill(person.name);
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: person.name });
    await dialog.getByText(/입장 중/).first().waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: path.join(out, `inspector-${width}.png`), fullPage: true });
    }
    if (before) {
      assert.equal(await dialog.getByRole('button', { name: '확인 후 퇴장 기록' }).count(), 0);
      console.log('Confirmed: no reviewed exit path for inconsistent attendee');
      return;
    }
    const restrictedId = `restricted-${crypto.randomUUID()}`;
    await f.helpers.insertAccount(f.harness.database, { id: restrictedId, role: 'MANAGER', name: '합성 명단 담당', email: `${restrictedId}@example.test`, orgId: f.helpers.LEGACY_ORG });
    await f.helpers.insertMembership(f.harness.database, restrictedId, f.eventId, ['participants']);
    const restrictedCookie = await f.helpers.sessionCookie(f.harness, restrictedId);
    const limitedContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const cookieBits = restrictedCookie.split('=');
    await limitedContext.addCookies([{ name: cookieBits[0], value: cookieBits.slice(1).join('='), url: f.baseUrl }]);
    const limited = await limitedContext.newPage();
    await limited.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await limited.locator('#roster-search').fill(person.name);
    await limited.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
    assert.equal(await limited.getByRole('dialog', { name: person.name }).getByRole('button', { name: '확인 후 퇴장 기록' }).count(), 0);
    await limitedContext.close();
    const onsiteId = `onsite-${crypto.randomUUID()}`;
    await f.helpers.insertAccount(f.harness.database, { id: onsiteId, role: 'MANAGER', name: '합성 현장 담당', email: `${onsiteId}@example.test`, orgId: f.helpers.LEGACY_ORG });
    await f.helpers.insertMembership(f.harness.database, onsiteId, f.eventId, ['onsite']);
    const onsiteCookie = (await f.helpers.sessionCookie(f.harness, onsiteId)).split('=');
    const onsiteContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await onsiteContext.addCookies([{ name: onsiteCookie[0], value: onsiteCookie.slice(1).join('='), url: f.baseUrl }]);
    const onsitePage = await onsiteContext.newPage();
    await onsitePage.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await onsitePage.locator('#roster-search').fill(person.name);
    await onsitePage.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
    const onsiteDialog = onsitePage.getByRole('dialog', { name: person.name });
    await onsiteDialog.getByRole('button', { name: '확인 후 퇴장 기록', exact: true }).waitFor();
    assert.equal(await onsiteDialog.getByLabel(`${person.name} 상태 변경`).count(), 0);
    await onsiteContext.close();
    await page.setViewportSize({ width: 1280, height: 900 });
    let failRead = true;
    const bootPattern = `**/api/events/${f.eventId}/bootstrap`;
    await page.route(bootPattern, route => {
      if (failRead) { failRead = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    });
    await dialog.getByRole('button', { name: '확인 후 퇴장 기록', exact: true }).click();
    const review = page.getByRole('dialog', { name: '확인 후 퇴장 기록' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '최신 기록 다시 확인');
    await review.getByRole('button', { name: '최신 기록 다시 확인' }).click();
    await review.getByRole('heading', { name: '확인할 참가자' }).waitFor();
    await review.getByText(person.name, { exact: true }).waitFor();
    assert.equal(await review.getByRole('button', { name: '퇴장 기록', exact: true }).isDisabled(), true);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await review.getByLabel('확인 사유').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `review-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await review.getByLabel('확인 사유').focus();
    await page.keyboard.press('Tab');
    assert.equal(await review.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Space');
    assert.equal(await review.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').isChecked(), true);
    await review.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').uncheck();
    const reason = '현장 책임자가 실제 퇴장을 확인';
    await review.getByLabel('확인 사유').fill(reason);
    await review.getByRole('button', { name: '닫기', exact: true }).click();
    await review.getByText(/작성한 퇴장 확인 사유가 사라집니다/).waitFor();
    await review.getByRole('button', { name: '계속 작업', exact: true }).click();
    assert.equal(await review.getByLabel('확인 사유').inputValue(), reason);
    await review.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').check();
    // The participant changes after the operator opened the review.
    const fresh = await read(); fresh.participants.find(p => p.id === person.id).company = '변경된 합성 소속';
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(fresh)]);
    await review.getByRole('button', { name: '퇴장 기록', exact: true }).click();
    await review.getByText(/참가자 정보 또는 입장 상태가 바뀌었습니다/).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '최신 기록 다시 확인');
    assert.equal((await read()).participants.find(p => p.id === person.id).inside, true);
    await review.getByRole('button', { name: '최신 기록 다시 확인' }).click();
    await review.getByText(/변경된 합성 소속/).waitFor();
    assert.equal(await review.getByLabel('확인 사유').inputValue(), reason);
    assert.equal(await review.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').isChecked(), false);
    await review.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').check();
    // Lose the committed response, then simulate a temporary retry rejection.
    let fault = 'lost'; const ids = [];
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'check.reviewed-exit') return route.continue();
      ids.push(body.commandId);
      if (fault === 'lost') { fault = 'rate'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
      if (fault === 'rate') { fault = 'pass'; return route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    });
    await review.getByRole('button', { name: '퇴장 기록', exact: true }).click();
    const retry = review.getByRole('button', { name: '같은 요청 다시 시도', exact: true });
    await retry.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '서버 처리 확인');
    await page.screenshot({ path: path.join(out, 'uncertain-1280.png'), fullPage: true });
    await review.getByRole('button', { name: '닫기', exact: true }).click();
    await review.getByText(/닫은 뒤 처리 결과 확인에서 확인해야 합니다/).waitFor();
    await review.getByRole('button', { name: '계속 작업', exact: true }).click();
    await retry.click(); await retry.waitFor();
    await retry.click();
    await review.waitFor({ state: 'hidden', timeout: 20000 });
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 1);
    const final = await read(), target = final.participants.find(p => p.id === person.id);
    assert.equal(target.inside, false); assert.equal(target.status, 'PENDING'); assert.equal(target.paymentStatus, 'PENDING');
    assert.equal(final.checks.filter(item => item.participantId === person.id && item.source === 'REVIEWED_EXIT').length, 1);
    assert.equal(final.checks[0].reason, reason);
    await page.getByText(/퇴장 기록을 저장했습니다/).waitFor();
    assert.equal(await page.evaluate(id => Object.keys(localStorage).some(key => key.endsWith(id)), ids[0]), false, 'success does not resurrect a receipt pointer');
    const overview = await context.newPage();
    await overview.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await overview.getByText('운영자 확인', { exact: true }).waitFor();
    await overview.close();

    // A second lost response can be resolved from another tab without
    // sending another exit request; the original dialog can then refresh.
    const person2 = final.participants[1];
    const secondEntry = await command('check.scan', { deskId: f.deskId, ticket: person2.ticket, expectedAction: 'IN' });
    assert.equal(secondEntry.status, 200, JSON.stringify(secondEntry.json));
    const secondState = await read();
    Object.assign(secondState.participants.find(p => p.id === person2.id), { status: 'PENDING', paymentStatus: 'PENDING' });
    secondState.participants.push({ ...secondState.participants.find(p => p.id === person2.id), id: 'ambiguous-synthetic-person', phone: `0107777${person2.phone.slice(-4)}`, status: 'CANCELLED', inside: false });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(secondState)]);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.locator('#roster-search').fill(person2.name);
    await page.getByRole('row').filter({ hasText: '승인 대기' }).getByRole('button', { name: `${person2.name} 참가자 상세`, exact: true }).click();
    await page.getByRole('dialog', { name: person2.name }).getByRole('button', { name: '확인 후 퇴장 기록' }).click();
    const secondReview = page.getByRole('dialog', { name: '확인 후 퇴장 기록' });
    await secondReview.getByText(/표시된 이름·소속·연락처가 같은 참가자가 있습니다/).waitFor();
    assert.equal(await secondReview.getByRole('button', { name: '퇴장 기록', exact: true }).isDisabled(), true);
    const distinct = await read(); distinct.participants = distinct.participants.filter(p => p.id !== 'ambiguous-synthetic-person');
    const originalEntry = distinct.checks.find(item => item.id === secondEntry.json.checkId); originalEntry.corrected = true;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(distinct)]);
    await secondReview.getByRole('button', { name: '최신 기록 다시 확인' }).click();
    await secondReview.getByText(/최근 입장 기록을 확인할 수 없습니다/).waitFor();
    originalEntry.corrected = false;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(distinct)]);
    await secondReview.getByRole('button', { name: '최신 기록 다시 확인' }).click();
    await secondReview.getByLabel('확인 사유').fill('합성 현장에서 실제 퇴장을 확인');
    await secondReview.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').check();
    fault = 'lost'; ids.length = 0;
    await secondReview.getByRole('button', { name: '퇴장 기록', exact: true }).click();
    await secondReview.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const otherTab = await context.newPage();
    await otherTab.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    const recovery = otherTab.getByRole('region', { name: '처리 결과 확인' });
    await recovery.getByText('확인 후 퇴장 기록', { exact: false }).waitFor();
    await recovery.getByRole('button', { name: '서버 처리 확인' }).click();
    await recovery.getByText(/서버에 반영된 것을 확인했습니다/).waitFor();
    assert.equal(ids.length, 1, 'status check did not send an exit');
    await secondReview.getByRole('button', { name: '서버 처리 확인' }).click();
    await secondReview.waitFor({ state: 'hidden', timeout: 20000 });
    assert.equal(ids.length, 1);
    assert.equal((await read()).checks.filter(item => item.participantId === person2.id && item.source === 'REVIEWED_EXIT').length, 1);
    await otherTab.close();
    assert.deepEqual(errors, []);
    console.log('Reviewed exit permissions, conflict, retry, cross-tab status and saved record passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
