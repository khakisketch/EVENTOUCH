'use strict';
// Real isolated API/database; only response bodies/loss are injected after commit.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'draw-before' : 'draw-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const run = async (command, payload) => {
      const result = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        cookie: fixture.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.json));
      return result.json;
    };
    const module = (await run('module.save', { type: 'draw', title: '추첨 검증 무대' })).module;
    await run('module.status', { id: module.id, status: 'OPEN' });
    const program = (await run('draw.program.save', { name: '안전 추첨 검증', quota: 5, moduleId: module.id, eligibility: 'PERSON',
      eligibleGroups: [], eligibleCompanies: [], overlap: 'EVENT', prizeTiers: null, status: 'OPEN', published: true })).program;
    const database = fixture.harness.database;
    const readWorkspace = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = await readWorkspace();
    for (const person of workspace.participants) { person.everIn = true; person.paymentStatus = 'FREE'; }
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/draws`, { waitUntil: 'networkidle' });
    let slot = page.locator(`#draw-program-${program.id}`);
    await slot.getByRole('button', { name: '1명 추첨 실행', exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, 'draw-1280.png'), fullPage: true });
    if (before) { console.log('Draw before capture passed'); return; }
    let mode = 'malformed';
    const ids = [];
    await page.route('**/api/events/*/commands', async route => {
      let body; try { body = route.request().postDataJSON(); } catch { return route.continue(); }
      if (body.command !== 'draw.program.run') return route.continue();
      ids.push(body.commandId);
      if (mode === 'malformed') {
        mode = 'pass';
        const response = await route.fetch();
        assert.equal(response.status(), 200, 'the real draw committed before malformed response');
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
      }
      if (mode === 'lost') {
        mode = 'rejected';
        const response = await route.fetch();
        assert.equal(response.status(), 200, 'the real draw committed before response loss');
        return route.abort('failed');
      }
      if (mode === 'rejected') {
        mode = 'pass';
        return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      }
      if (mode === 'rate') {
        mode = 'pass';
        return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"잠시 후 다시 시도하세요"}' });
      }
      return route.continue();
    });
    const execute = async () => {
      slot = page.locator(`#draw-program-${program.id}`);
      await slot.getByRole('button', { name: '1명 추첨 실행', exact: true }).click();
      await page.getByRole('group', { name: '실행 확인', exact: true }).getByRole('button', { name: '추첨 실행', exact: true }).click();
    };
    stage = 'malformed success';
    await execute();
    const recovery = page.getByRole('region', { name: '추첨 처리 확인 필요' });
    await recovery.waitFor();
    assert.equal(await slot.getByRole('button', { name: '1명 추첨 실행', exact: true }).isDisabled(), true);
    assert.equal(await slot.locator('input[type=number]').isDisabled(), true);
    assert.equal((await readWorkspace()).drawPrograms.find(item => item.id === program.id).winners.length, 1);
    await page.screenshot({ path: path.join(out, 'draw-unconfirmed-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'draw-unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    const issues = await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id));
    assert.deepEqual(issues, []);
    await recovery.getByRole('button', { name: '원래 추첨 요청 다시 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(ids[0], ids[1], 'malformed success retry uses original id');
    assert.equal((await readWorkspace()).drawPrograms.find(item => item.id === program.id).winners.length, 1, 'retry does not draw twice');

    stage = 'lost reply followed by rejected retry';
    await page.setViewportSize({ width: 1280, height: 900 });
    mode = 'lost';
    await execute();
    await recovery.waitFor();
    await recovery.getByRole('button', { name: '원래 추첨 요청 다시 확인' }).click();
    await page.getByRole('alert').filter({ hasText: '추첨 응답을 확인하지 못했습니다' }).waitFor();
    assert.equal(await slot.getByRole('button', { name: '1명 추첨 실행', exact: true }).isDisabled(), true, 'a later 403 cannot erase an earlier ambiguous result');
    await recovery.getByRole('button', { name: '원래 추첨 요청 다시 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(ids[2], ids[3]); assert.equal(ids[3], ids[4]);
    assert.equal((await readWorkspace()).drawPrograms.find(item => item.id === program.id).winners.length, 2);

    for (const [failureMode, total] of [['malformed', 3], ['lost', 4]]) {
      stage = `reload and read-only confirmation after ${failureMode}`;
      mode = failureMode;
      await execute();
      await recovery.waitFor();
      const countBeforeReload = ids.length;
      await page.reload({ waitUntil: 'networkidle' });
      await recovery.waitFor();
      assert.equal(await recovery.getByRole('button', { name: '원래 추첨 요청 다시 확인' }).count(), 0, 'request body is not persisted across reload');
      await recovery.getByRole('button', { name: '추첨 처리 확인', exact: true }).click();
      await recovery.waitFor({ state: 'hidden' });
      assert.equal(ids.length, countBeforeReload, 'read-only confirmation never re-sends the draw');
      assert.equal((await readWorkspace()).drawPrograms.find(item => item.id === program.id).winners.length, total);
      await page.getByText('추첨이 서버에 반영된 것을 확인하고 최신 결과를 불러왔습니다.').waitFor();
    }
    stage = 'rate-limited request retains its identifier';
    mode = 'rate';
    const firstRateRequest = ids.length;
    await execute();
    await recovery.waitFor();
    assert.equal((await readWorkspace()).drawPrograms.find(item => item.id === program.id).winners.length, 4);
    await recovery.getByRole('button', { name: '원래 추첨 요청 다시 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(ids[firstRateRequest], ids[firstRateRequest + 1]);
    assert.equal((await readWorkspace()).drawPrograms.find(item => item.id === program.id).winners.length, 5);

    stage = 'reviewed stage draw conflicts with a second operator';
    const concurrent = (await run('draw.program.save', { name: '무대 동시 실행 검증', quota: 3, moduleId: module.id,
      status: 'OPEN', overlap: 'NONE' })).program;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle' });
    const concurrentSlot = page.locator(`#draw-program-${concurrent.id}`);
    const stageAction = concurrentSlot.getByRole('button', { name: '무대 터치 실행', exact: true });
    const review = page.getByRole('group', { name: '실행 확인', exact: true });
    const confirmStage = review.getByRole('button', { name: '추첨하고 전광판에 표시', exact: true });
    await stageAction.click();
    assert.match(await review.innerText(), /현재 0명 당첨 · 3명 남음/);
    const fromAnotherOperator = await run('draw.program.run', { id: concurrent.id, count: 1, showOnScreen: true, expectedRevision: concurrent.revision });
    let failNextRead = true;
    await page.route('**/api/events/*/bootstrap', async (route) => {
      if (!failNextRead) return route.continue();
      failNextRead = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    const beforeConflict = ids.length;
    const [rejected] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/commands') && response.status() === 409),
      confirmStage.click(),
    ]);
    assert.equal((await rejected.json()).code, 'DRAW_PROGRAM_CHANGED');
    const retryRead = page.getByRole('button', { name: '다시 불러오기', exact: true });
    await retryRead.waitFor();
    assert.equal(await stageAction.count(), 0, 'a failed refresh exposes no stale draw control');
    await retryRead.click();
    const conflictNotice = concurrentSlot.getByRole('alert').filter({ hasText: '추첨 내용이 다른 곳에서 바뀌었습니다' });
    await conflictNotice.waitFor();
    await page.waitForFunction(() => document.activeElement?.firstElementChild?.getAttribute('role') === 'alert');
    assert.equal(ids.length, beforeConflict + 1, 'refresh never resends the rejected draw');
    assert.match(await concurrentSlot.innerText(), /당첨 1명 · 남은 2명/);
    assert.equal(await recovery.count(), 0, 'a definitive conflict is not a lost response');
    await conflictNotice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'draw-conflict-390.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
    await stageAction.click();
    assert.match(await review.innerText(), /현재 1명 당첨 · 2명 남음/);
    const [nextDraw] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/commands') && response.status() === 200),
      confirmStage.click(),
    ]);
    assert.equal(nextDraw.request().postDataJSON().payload.expectedRevision, fromAnotherOperator.program.revision);
    assert.notEqual(ids.at(-1), ids.at(-2));
    const settled = await readWorkspace();
    assert.equal(settled.drawPrograms.find(item => item.id === concurrent.id).winners.length, 2);
    assert.equal(settled.rewards.filter(item => item.source?.programId === concurrent.id).length, 2);
    assert.equal(settled.modules.find(item => item.id === module.id).drawHistory.filter(item => item.programId === concurrent.id).length, 2);

    stage = 'venue board stays on its chosen draw';
    const activeDrawId = nextDraw.request().postDataJSON().commandId;
    assert.equal(settled.display.drawId, activeDrawId);
    const audience = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const screen = await audience.newPage();
    const screenUrl = `${fixture.baseUrl}/screen/${fixture.slug}`;
    await screen.goto(screenUrl);
    const stageTitle = screen.getByRole('heading', { name: concurrent.name, exact: true });
    await stageTitle.waitFor();
    const backstage = (await run('draw.program.save', { name: '별도 시상 검증', quota: 1, moduleId: module.id,
      status: 'OPEN', overlap: 'NONE' })).program;
    await run('draw.program.run', { id: backstage.id, count: 1 });
    await screen.reload();
    await stageTitle.waitFor();
    assert.equal(await screen.getByRole('heading', { name: backstage.name, exact: true }).count(), 0);
    await screen.screenshot({ path: path.join(out, 'draw-output-retained-1280.png') });

    stage = 'manual venue output and withdrawal';
    const latest = (await readWorkspace()).modules.find(item => item.id === module.id).drawHistory[0];
    assert.equal(latest.programId, backstage.id);
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/operations`);
    await page.getByRole('tab', { name: '전광판 출력', exact: true }).click();
    const output = page.locator('[data-workspace-section="ops-display"]');
    await output.getByText(new RegExp(`현재 추첨 결과 · ${concurrent.name}`)).waitFor();
    const choice = output.getByLabel('전광판 출력 선택');
    await choice.selectOption(`draw|${module.id}|${latest.id}`);
    await output.getByRole('status').filter({ hasText: '아직 적용되지 않았습니다' }).waitFor();
    await output.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'draw-output-choice-390.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
    await output.getByRole('button', { name: '출력 적용', exact: true }).click();
    await output.getByText(new RegExp(`현재 추첨 결과 · ${backstage.name}`)).waitFor();
    const otherTitle = screen.getByRole('heading', { name: backstage.name, exact: true });
    await screen.bringToFront();
    await otherTitle.waitFor();
    assert.equal((await readWorkspace()).display.drawId, latest.id);
    await run('draw.program.save', { id: backstage.id, published: false });
    await otherTitle.waitFor({ state: 'hidden' });
    assert.equal(await stageTitle.count(), 0, 'withdrawing the selected result must not replace it with another draw');
    await page.reload();
    await page.getByRole('tab', { name: '전광판 출력', exact: true }).click();
    await output.getByText('현재 기본 화면 · 선택한 추첨 결과 출력 불가', { exact: true }).waitFor();
    assert.equal((await audience.cookies()).some(cookie => cookie.name === 'etko_session'), false);
    await audience.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', apiAndDatabaseReal: true, malformedAndLostResponses: true, sameIdOnRetry: true, readOnlyAfterReload: true, staleReviewRejected: true, failedRefreshRecovery: true, duplicateDraws: 0, exactVenueOutput: true, withdrawnOutputFallsBack: true }, null, 2), { mode: 0o600 });
    console.log('Draw: response recovery, reviewed-stage conflict, selected venue output and withdrawal passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
