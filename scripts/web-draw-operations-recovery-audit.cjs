'use strict';
// Real isolated API/database; faults are injected after the server commits.
const assert = require('node:assert/strict');
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
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'draw-operations-before' : 'draw-operations-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const requests = new Map();
    let holdRefresh = false, failNextRefresh = false, releaseRefresh = () => {}, markRefresh = () => {};
    const refreshHeld = new Promise((resolve) => { markRefresh = resolve; });
    const refreshReleased = new Promise((resolve) => { releaseRefresh = resolve; });
    await page.route('**/api/events/*/bootstrap', async (route) => {
      if (failNextRefresh) { failNextRefresh = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      if (!holdRefresh) return route.continue();
      holdRefresh = false;
      const response = await route.fetch(); markRefresh(); await refreshReleased;
      return route.fulfill({ response });
    });
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      const key = body.command === 'team.save' && body.payload.name.startsWith('합성 복구') ? body.payload.name :
        body.command === 'lucky.preassign-range-reviewed' ? 'lucky' : '';
      if (!key) return route.continue();
      const rows = requests.get(key) || [];
      rows.push(body); requests.set(key, rows);
      if (rows.length === 1) {
        const response = await route.fetch();
        assert.ok(response.ok(), `${key} committed before response fault`);
        if (key.endsWith('부분 응답')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"team":{"id":"wrong","name":"다른 팀","order":1}}' });
        return route.abort('failed');
      }
      if (rows.length === 2 && key.endsWith('원래 팀')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      return route.continue();
    });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/draws`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^순위 투표/ }).click();
    await page.locator('summary').filter({ hasText: /^투표 설정/ }).click();
    await page.locator('summary').filter({ hasText: /^투표 팀 등록/ }).click();
    const team = page.locator('#draws-team-name');
    const submit = page.getByRole('button', { name: '팀 등록', exact: true });
    const panel = page.getByRole('region', { name: '추첨·투표 처리 확인 필요' });
    const original = '합성 복구 원래 팀';
    phase = 'team saved, response lost, changed local draft';
    await team.fill(original); await submit.click();
    if (before) {
      await page.getByRole('alert').filter({ hasText: /서버 응답을 확인하지 못했습니다/ }).waitFor();
      await team.fill('합성 다음 작성 팀');
      assert.equal(await submit.isDisabled(), false, 'old screen can send another team before resolving the first');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      return;
    }
    await panel.waitFor();
    await team.fill('합성 다음 작성 팀');
    assert.equal(await submit.isDisabled(), true, 'an uncertain operation locks a new write');
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.getByRole('alert').filter({ hasText: /이전 요청의 처리 여부를 확인하지 못했습니다/ }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'draw-operation-recovery-heading');
    assert.equal(await submit.isDisabled(), true, 'later 403 cannot settle the first loss');
    assert.equal(await team.inputValue(), '합성 다음 작성 팀');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    await page.screenshot({ path: path.join(out, 'unconfirmed-viewport-390.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    failNextRefresh = true;
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.getByRole('alert').filter({ hasText: /최신 결과를 불러오지 못했습니다/ }).waitFor();
    assert.equal(await team.inputValue(), '합성 다음 작성 팀');
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(new Set(requests.get(original).map((entry) => entry.commandId)).size, 1);
    assert.equal(new Set(requests.get(original).map((entry) => JSON.stringify(entry.payload))).size, 1);
    assert.equal((await workspace()).teams.filter((entry) => entry.name === original).length, 1);
    assert.equal(await team.inputValue(), '합성 다음 작성 팀', 'later edits survive confirmation');

    phase = 'wrong success body and read-only confirmation';
    await page.setViewportSize({ width: 1280, height: 900 });
    const partial = '합성 복구 부분 응답';
    await team.fill(partial); await submit.click(); await panel.waitFor();
    assert.equal((await workspace()).teams.filter((entry) => entry.name === partial).length, 1);
    const writeCount = requests.get(partial).length;
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(requests.get(partial).length, writeCount, 'status-only lookup sends no second write');
    assert.equal(await team.inputValue(), '');

    phase = 'reload retains only a scoped pointer';
    const reloaded = '합성 복구 새로고침 팀';
    await team.fill(reloaded); await submit.click(); await panel.waitFor();
    const storage = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(storage.includes('team.save') && !storage.includes(reloaded));
    const reloadWrites = requests.get(reloaded).length;
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^순위 투표/ }).click();
    await page.locator('summary').filter({ hasText: /^투표 설정/ }).click();
    await page.locator('summary').filter({ hasText: /^투표 팀 등록/ }).click();
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.getByText('투표 팀 저장', { exact: true }).waitFor();
    await team.fill('합성 확인 후 팀');
    assert.equal(await submit.isDisabled(), true);
    holdRefresh = true;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    let deadline;
    try { await Promise.race([refreshHeld, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('authoritative refresh was not requested')), 15000); })]); }
    finally { clearTimeout(deadline); }
    assert.equal(await submit.isDisabled(), true, 'a new write stays locked until the refreshed state arrives');
    releaseRefresh();
    await page.waitForFunction(() => !document.body.textContent.includes('이전 추첨·투표 요청의 처리 결과를 화면 위의'));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '팀 등록' && !button.disabled));
    assert.equal(requests.get(reloaded).length, reloadWrites);
    assert.equal((await workspace()).teams.filter((entry) => entry.name === reloaded).length, 1);

    phase = 'lucky batch lost response and status-only lookup';
    await page.getByRole('button', { name: /^럭키번호 사전 배정/ }).click();
    await page.getByRole('checkbox', { name: /승인 참가자 전체/ }).check();
    const assign = page.getByRole('button', { name: /명 번호 일괄 배정/ });
    await assign.click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '번호 배정', exact: true }).click();
    await panel.waitFor();
    const assigned = (await workspace()).luckyNumbers;
    assert.ok(assigned.length > 0 && new Set(assigned.map((entry) => entry.number)).size === assigned.length);
    assert.equal(await assign.isDisabled(), true);
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(requests.get('lucky').length, 1);
    assert.equal((await workspace()).luckyNumbers.length, assigned.length);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, after403: true, sameIdAndPayload: true, laterEditsPreserved: true, readOnlyAfterReload: true, duplicateTeams: 0, duplicateLuckyAssignments: 0 }, null, 2), { mode: 0o600 });
    console.log('Draw operations: team and lucky-number recovery preserve original requests and later edits');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
