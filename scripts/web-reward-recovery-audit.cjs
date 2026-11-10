'use strict';
// Real isolated API/Postgres; responses are faulted only after real commits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let stage = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'reward-before' : 'reward-recovery');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const database = fixture.harness.database;
    const readWorkspace = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = await readWorkspace();
    const person = workspace.participants[0];
    for (let n = 1; n <= 4; n += 1) workspace.rewards.push({
      id: `audit-reward-${n}`, participantId: person.id, name: `합성 경품 ${n}`, method: 'ONSITE', status: 'READY', at: '2026-10-01T00:00:00Z',
    });
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [], attempts = [];
    page.on('pageerror', error => errors.push(error.message));
    let allowLeave = true, dialogMessage = '';
    page.on('dialog', dialog => { dialogMessage = dialog.message(); return allowLeave ? dialog.accept() : dialog.dismiss(); });
    let mode = 'lost';
    await page.route('**/api/events/*/commands', async route => {
      let body; try { body = route.request().postDataJSON(); } catch { return route.continue(); }
      if (!['reward.fulfill', 'reward.cancel'].includes(body.command)) return route.continue();
      attempts.push({ command: body.command, commandId: body.commandId, id: body.payload.id });
      if (mode === 'lost') { mode = 'rejected'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
      if (mode === 'rejected') { mode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"권한 확인"}' }); }
      if (mode === 'malformed') { mode = 'pass'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reward: { id: body.payload.id, status: 'NEEDS_CONNECTION' } }) }); }
      if (mode === 'rate') { mode = 'pass'; return route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/rewards`, { waitUntil: 'networkidle' });
    const row = (n) => page.locator('li').filter({ has: page.getByText(`합성 경품 ${n}`, { exact: true }) });
    await row(1).getByRole('button', { name: '수령 처리', exact: true }).waitFor();
    const execute = async (n, action) => {
      await row(n).getByRole('button', { name: action === 'fulfill' ? '수령 처리' : '취소', exact: true }).click();
      await row(n).getByRole('group', { name: '실행 확인' }).getByRole('button', { name: action === 'fulfill' ? '처리한다' : '취소한다', exact: true }).click();
    };
    stage = 'lost fulfill';
    await execute(1, 'fulfill');
    if (before) {
      await page.getByText('연결하지 못했습니다. 같은 동작으로 다시 시도하세요.').waitFor();
      assert.equal((await readWorkspace()).rewards.find(item => item.id === 'audit-reward-1').status, 'RECEIVED');
      assert.equal(await row(2).getByRole('button', { name: '수령 처리' }).isEnabled(), true);
      await page.screenshot({ path: path.join(out, 'reward-lost-before-390.png'), fullPage: true });
      console.log('Captured committed-response-loss baseline; another reward remains actionable.');
      return;
    }
    let recovery = page.getByRole('region', { name: '경품 처리 확인 필요' });
    await recovery.waitFor();
    await page.getByRole('alert').filter({ hasText: '경품 처리 결과를 확인하지 못했습니다' }).waitFor();
    assert.equal((await readWorkspace()).rewards.find(item => item.id === 'audit-reward-1').status, 'RECEIVED');
    assert.equal(await row(2).getByRole('button', { name: '수령 처리' }).isDisabled(), true);
    await recovery.getByRole('button', { name: '서버 처리 확인' }).waitFor({ state: 'visible' });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no horizontal overflow at ${width}`);
      for (const button of await recovery.getByRole('button').all()) {
        const box = await button.boundingBox();
        assert.ok(box && box.height >= 44 && box.width >= 44, `recovery target >=44px at ${width}`);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'reward-lost-390.png'), fullPage: true });
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    allowLeave = false;
    await page.getByRole('link', { name: '참가자로' }).click();
    assert.ok(dialogMessage.includes('요청 결과를 아직 확인하지 못했습니다'));
    assert.equal(await recovery.isVisible(), true);
    allowLeave = true;
    await page.getByRole('searchbox', { name: '경품 검색' }).fill('다른 검색어');
    assert.equal(await recovery.isVisible(), true, 'filtering cannot hide the recovery controls');
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await page.getByRole('alert').filter({ hasText: '경품 처리 결과를 확인하지 못했습니다' }).waitFor();
    assert.equal(await recovery.isVisible(), true, 'a later 403 must not erase uncertainty');
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(attempts[0].commandId, attempts[1].commandId);
    assert.equal(attempts[1].commandId, attempts[2].commandId);
    assert.equal((await readWorkspace()).rewards.find(item => item.id === 'audit-reward-1').status, 'RECEIVED');
    await page.getByRole('searchbox', { name: '경품 검색' }).fill('');

    stage = 'mismatched success and failed refresh';
    mode = 'malformed'; await execute(2, 'fulfill');
    recovery = page.getByRole('region', { name: '경품 처리 확인 필요' }); await recovery.waitFor();
    await page.getByRole('alert').filter({ hasText: '경품 처리 결과를 확인하지 못했습니다' }).waitFor();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('eventouch.receipts.operator') || '[]').some(item => item.command === 'reward.fulfill'));
    const pointer = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.equal(pointer.includes(person.name), false); assert.equal(pointer.includes('합성 경품 2'), false);
    let failRefresh = true;
    await page.route('**/api/events/*/bootstrap', async route => {
      if (failRefresh) {
        failRefresh = false;
        const response = await route.fetch();
        const data = await response.json();
        delete data.state.workspaces[fixture.eventId].rewards;
        return route.fulfill({ response, json: data });
      }
      return route.continue();
    });
    const countBeforeStatus = attempts.length;
    await recovery.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await recovery.getByRole('button', { name: '최신 목록 다시 확인' }).waitFor();
    assert.equal(attempts.length, countBeforeStatus, 'status lookup never repeats a command');
    assert.equal(await row(3).getByRole('button', { name: '수령 처리' }).isDisabled(), true);
    assert.equal(await page.getByRole('alert').filter({ hasText: '최신 경품 목록을 불러오지 못했습니다' }).isVisible(), true);
    await recovery.getByRole('button', { name: '최신 목록 다시 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    await page.unroute('**/api/events/*/bootstrap');
    assert.equal(attempts.length, countBeforeStatus);

    stage = 'lost cancellation and reload';
    mode = 'lost'; await execute(3, 'cancel');
    recovery = page.getByRole('region', { name: '경품 처리 확인 필요' }); await recovery.waitFor();
    await page.getByRole('alert').filter({ hasText: '경품 처리 결과를 확인하지 못했습니다' }).waitFor();
    const countBeforeReload = attempts.length;
    await page.reload({ waitUntil: 'networkidle' });
    const common = page.getByRole('region', { name: '처리 결과 확인' });
    await common.getByText('경품 취소', { exact: false }).waitFor();
    await page.getByText('이전 경품 처리 결과를').waitFor();
    assert.equal(await row(4).getByRole('button', { name: '수령 처리' }).isDisabled(), true);
    failRefresh = true;
    await page.route('**/api/events/*/bootstrap', route => {
      if (failRefresh) { failRefresh = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    });
    await common.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await page.getByRole('button', { name: '경품 목록 다시 확인' }).waitFor();
    assert.equal(await row(4).getByRole('button', { name: '수령 처리' }).isDisabled(), true);
    await page.getByRole('button', { name: '경품 목록 다시 확인' }).click();
    await row(4).getByRole('button', { name: '수령 처리' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('li')).some(li => li.textContent.includes('합성 경품 4') && Array.from(li.querySelectorAll('button')).some(button => button.textContent.includes('수령 처리') && !button.disabled)));
    await page.unroute('**/api/events/*/bootstrap');
    assert.equal(attempts.length, countBeforeReload, 'reload status check never resends');
    assert.equal((await readWorkspace()).rewards.find(item => item.id === 'audit-reward-3').status, 'CANCELLED');

    stage = 'rate limit and same-id retry';
    mode = 'rate'; await execute(4, 'fulfill');
    recovery = page.getByRole('region', { name: '경품 처리 확인 필요' }); await recovery.waitFor();
    await page.getByRole('alert').filter({ hasText: '경품 처리 결과를 확인하지 못했습니다' }).waitFor();
    assert.equal((await readWorkspace()).rewards.find(item => item.id === 'audit-reward-4').status, 'READY');
    let failSuccessRefresh = true;
    await page.route('**/api/events/*/bootstrap', route => {
      if (failSuccessRefresh) { failSuccessRefresh = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    });
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.getByRole('button', { name: '최신 목록 다시 확인' }).waitFor();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('eventouch.receipts.operator') || '[]').some(item => item.command === 'reward.fulfill'));
    assert.equal((await readWorkspace()).rewards.find(item => item.id === 'audit-reward-4').status, 'RECEIVED');
    await recovery.getByRole('button', { name: '최신 목록 다시 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    await page.unroute('**/api/events/*/bootstrap');
    assert.equal(attempts.at(-2).commandId, attempts.at(-1).commandId);
    assert.equal((await readWorkspace()).rewards.find(item => item.id === 'audit-reward-4').status, 'RECEIVED');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', realDatabase: true, lostAndMalformed: true, sameIdRetry: true, scopedStatus: true, refreshFailureRetainsLock: true }, null, 2), { mode: 0o600 });
    console.log('Reward desk: loss, rejected retry, scoped status and refresh locks passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
