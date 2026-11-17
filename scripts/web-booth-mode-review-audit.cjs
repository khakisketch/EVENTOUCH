'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'booth-mode-review'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  const command = (command, payload, id = randomUUID()) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
    method: 'POST', cookie: f.manager.cookie, body: { commandId: id, command, payload },
  });
  try {
    assert.equal((await command('event.features', { features: ['stamp'] })).status, 200);
    const original = await read(); original.stampMode = 'STAFF'; original.visits = { preserved: '합성 손상 기록' }; await write(original);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/operations#ops-booth-mode`);
    const section = page.locator(':is(section,[role=region])[aria-labelledby="ops-booth-mode"]');
    await section.locator('summary').waitFor({ state: 'visible' });
    if (!(await section.locator('details').evaluate(el => el.open))) await section.locator('summary').click();
    await section.getByRole('button', { name: '참가자 셀프 스캔' }).waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({ path: path.join(out, `unknown-${width}.png`) });
      if (width === 1280) await page.screenshot({ path: path.join(out, 'unknown-page-1280.png'), fullPage: true });
    }
    await section.getByText(/부스 인증 기록을 확인할 수 없습니다/).waitFor();
    assert.equal(await section.getByRole('button', { name: '참가자 셀프 스캔' }).isDisabled(), true);
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact)));
    assert.deepEqual(violations, []);

    const repaired = await read(); repaired.visits = []; await write(repaired);
    await page.reload();
    if (!(await section.locator('details').evaluate(el => el.open))) await section.locator('summary').click();
    await section.getByRole('button', { name: '참가자 셀프 스캔' }).focus();
    await page.keyboard.press('Enter');
    await section.getByRole('button', { name: '인증 방식 바꾸기' }).waitFor();
    const changedElsewhere = await command('booth.mode-reviewed', { expectedMode: 'STAFF', mode: 'SELF', acknowledge: true });
    assert.equal(changedElsewhere.status, 200);
    await section.getByRole('button', { name: '인증 방식 바꾸기' }).click();
    await page.getByText('인증 방식이 변경되었습니다. 최신 상태를 확인하고 다시 선택하세요.').waitFor();
    await section.getByText('인증 방식 · 참가자 셀프 스캔').waitFor();
    assert.equal((await read()).audit.filter(entry => entry.type === 'booth.mode-reviewed').length, 1);
    await page.screenshot({ path: path.join(out, 'conflict-1280.png'), fullPage: true });

    assert.equal((await command('booth.mode-reviewed', { expectedMode: 'SELF', mode: 'STAFF', acknowledge: true })).status, 200);
    await page.reload();
    if (!(await section.locator('details').evaluate(el => el.open))) await section.locator('summary').click();
    await section.getByRole('button', { name: '참가자 셀프 스캔' }).click();
    const visitRace = await read(); visitRace.visits.push({ id: 'new-visit', boothId: 'synthetic', participantId: 'synthetic' }); await write(visitRace);
    await section.getByRole('button', { name: '인증 방식 바꾸기' }).click();
    await page.getByText('인증 기록이 있어 방식을 변경할 수 없습니다.').waitFor();
    await section.getByText(/이미 인증 1건이라 방식을 바꿀 수 없습니다/).waitFor();
    assert.equal((await read()).stampMode, 'STAFF');
    visitRace.visits = []; await write(visitRace);
    await page.reload();
    if (!(await section.locator('details').evaluate(el => el.open))) await section.locator('summary').click();
    const attempts = [];
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'booth.mode-reviewed') return route.continue();
      attempts.push(body);
      if (attempts.length === 1) { await route.fetch(); return route.abort('failed'); }
      return route.continue();
    });
    await section.getByRole('button', { name: '참가자 셀프 스캔' }).click();
    await section.getByRole('button', { name: '인증 방식 바꾸기' }).click();
    await page.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    await page.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await page.getByText('부스 인증 방식을 바꿨습니다.').waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0], 'retry uses the same request');
    assert.equal((await read()).audit.filter(entry => entry.id === attempts[0].commandId).length, 1);
    await page.unroute('**/api/events/*/commands');

    assert.equal((await command('booth.mode-reviewed', { expectedMode: 'SELF', mode: 'STAFF', acknowledge: true })).status, 200);
    await page.reload();
    if (!(await section.locator('details').evaluate(el => el.open))) await section.locator('summary').click();
    const lostBeforeCommit = [];
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'booth.mode-reviewed') return route.continue();
      lostBeforeCommit.push(body);
      if (lostBeforeCommit.length === 1) return route.abort('failed');
      return route.continue();
    });
    await section.getByRole('button', { name: '참가자 셀프 스캔' }).click();
    await section.getByRole('button', { name: '인증 방식 바꾸기' }).click();
    await page.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    assert.equal((await command('booth.mode-reviewed', { expectedMode: 'STAFF', mode: 'SELF', acknowledge: true })).status, 200);
    await page.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await page.getByText('인증 방식이 변경되었습니다. 최신 상태를 확인하고 다시 선택하세요.').waitFor();
    await page.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor({ state: 'hidden' });
    assert.deepEqual(lostBeforeCommit[1], lostBeforeCommit[0]);
    assert.equal((await read()).audit.filter(entry => entry.id === lostBeforeCommit[0].commandId).length, 0, 'conflicted retry never commits');
    await page.unroute('**/api/events/*/commands');

    const invalidMode = await read(); invalidMode.stampMode = null; await write(invalidMode);
    await page.reload();
    await section.getByText('인증 방식 · 확인 필요').waitFor();
    await section.getByText(/현재 인증 방식을 확인할 수 없습니다/).waitFor();
    assert.equal(await section.getByRole('button', { name: '스태프 확인' }).isDisabled(), true);
    assert.equal(await section.getByRole('button', { name: '참가자 셀프 스캔' }).isDisabled(), true);

    const validAgain = await read(); validAgain.stampMode = 'STAFF'; delete validAgain.visits; await write(validAgain);
    await page.reload();
    if (!(await section.locator('details').evaluate(el => el.open))) await section.locator('summary').click();
    assert.equal(await section.getByRole('button', { name: '참가자 셀프 스캔' }).isEnabled(), true, 'absent legacy visits remain an empty record');
    await page.route('**/api/events/*/bootstrap', async route => {
      const response = await route.fetch(); const body = await response.json();
      delete body.state.workspaces[f.eventId].boothVisitsAvailable;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await section.getByText(/부스 인증 기록을 확인할 수 없습니다/).waitFor();
    assert.equal(await section.getByRole('button', { name: '참가자 셀프 스캔' }).isDisabled(), true, 'an old server cannot silently bypass review');
    await page.unroute('**/api/events/*/bootstrap');
    const restrictedId = `onsite-only-${randomUUID()}`;
    await f.helpers.insertAccount(f.harness.database, { id: restrictedId, role: 'MANAGER', name: '현장 담당', email: `${restrictedId}@example.test`, orgId: f.helpers.LEGACY_ORG });
    await f.helpers.insertMembership(f.harness.database, restrictedId, f.eventId, ['onsite']);
    const restrictedCookie = (await f.helpers.sessionCookie(f.harness, restrictedId)).split('=');
    const limited = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR' });
    await limited.addCookies([{ name: restrictedCookie[0], value: restrictedCookie.slice(1).join('='), url: f.baseUrl }]);
    const restrictedPage = await limited.newPage();
    await restrictedPage.goto(`${f.baseUrl}/console/events/${f.eventId}/operations`);
    const restrictedSection = restrictedPage.locator(':is(section,[role=region])[aria-labelledby="ops-booth-mode"]');
    if (!(await restrictedSection.locator('details').evaluate(el => el.open))) await restrictedSection.locator('summary').click();
    assert.equal(await restrictedSection.getByRole('button', { name: '참가자 셀프 스캔' }).isDisabled(), true, 'onsite-only manager cannot change booth mode');
    await limited.close();
    assert.deepEqual(errors, []);
    console.log('Unknown records, stale settings, exact retry, invalid mode and old-server boundary passed');
    await context.close();
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
