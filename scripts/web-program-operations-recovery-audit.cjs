'use strict';
// Isolated synthetic draw; response faults are injected after real commits.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'program-operations-before' : 'program-operations-recovery');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const run = async (command, payload) => {
      const result = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        cookie: fixture.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.json)); return result.json;
    };
    const module = (await run('module.save', { type: 'draw', title: '합성 참여 추첨' })).module;
    await run('module.status', { id: module.id, status: 'OPEN' });
    const database = fixture.harness.database;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const initial = await read();
    for (const person of initial.participants) { person.everIn = true; person.paymentStatus = 'FREE'; }
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(initial)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message)); page.on('dialog', (dialog) => dialog.accept());
    const requests = new Map(); let runMode = 'lost'; let failNextRefresh = false;
    let holdRefresh = false, releaseRefresh = () => {}, markRefresh = () => {};
    const refreshHeld = new Promise((resolve) => { markRefresh = resolve; });
    const refreshReleased = new Promise((resolve) => { releaseRefresh = resolve; });
    await page.route('**/api/events/*/bootstrap', async (route) => {
      if (failNextRefresh) { failNextRefresh = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      if (holdRefresh) { holdRefresh = false; const response = await route.fetch(); markRefresh(); await refreshReleased; return route.fulfill({ response }); }
      return route.continue();
    });
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (!['draw.run', 'draw.publish'].includes(body.command)) return route.continue();
      const rows = requests.get(body.command) || []; rows.push(body); requests.set(body.command, rows);
      if (body.command === 'draw.run' && runMode === 'lost') {
        runMode = 'denied'; const response = await route.fetch(); assert.ok(response.ok()); return route.abort('failed');
      }
      if (body.command === 'draw.run' && runMode === 'denied') {
        runMode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      }
      if (body.command === 'draw.run' && runMode === 'reload') {
        runMode = 'pass'; const response = await route.fetch(); assert.ok(response.ok()); return route.abort('failed');
      }
      if (body.command === 'draw.publish' && rows.length === 1) {
        const response = await route.fetch(); assert.ok(response.ok()); const altered = await response.json(); altered.draw.id = 'different-draw';
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(altered) });
      }
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/programs`, { waitUntil: 'networkidle' });
    const card = page.locator('li').filter({ has: page.getByRole('heading', { name: '합성 참여 추첨', exact: true }) }).first();
    await card.locator('summary').first().click();
    const count = card.locator(`#draw-count-${module.id}`);
    const runButton = card.getByRole('button', { name: '추첨 실행', exact: true });
    const panel = page.getByRole('region', { name: '콘텐츠 처리 확인 필요' });
    const execute = async () => {
      await runButton.click(); await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '실행한다' }).click();
    };
    phase = 'draw commits, response lost, later denial';
    await execute();
    if (before) {
      await card.getByRole('alert').filter({ hasText: /응답을 확인하지 못했습니다/ }).waitFor();
      await count.fill('2'); assert.equal(await runButton.isDisabled(), false);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      return;
    }
    await panel.waitFor(); await count.fill('2'); assert.equal(await runButton.isDisabled(), true);
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.getByRole('alert').filter({ hasText: /처리 여부를 확인하지 못했습니다/ }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'program-operation-recovery-heading');
    assert.equal(await runButton.isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    await page.screenshot({ path: path.join(out, 'unconfirmed-viewport-390.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    failNextRefresh = true;
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.getByRole('alert').filter({ hasText: /최신 콘텐츠를 불러오지 못했습니다/ }).waitFor();
    assert.equal(await count.inputValue(), '2');
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(new Set(requests.get('draw.run').map((entry) => entry.commandId)).size, 1);
    assert.equal(new Set(requests.get('draw.run').map((entry) => JSON.stringify(entry.payload))).size, 1);
    assert.equal((await read()).modules.find((item) => item.id === module.id).drawHistory.length, 1);
    assert.equal(await count.inputValue(), '2');

    phase = 'publish response must identify the visible draw';
    await page.setViewportSize({ width: 1280, height: 900 });
    await card.getByRole('button', { name: '최신 결과 공개' }).click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '공개한다' }).click();
    await panel.waitFor();
    const writes = requests.get('draw.publish').length;
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(requests.get('draw.publish').length, writes, 'status-only lookup does not publish again');
    assert.equal((await read()).modules.find((item) => item.id === module.id).drawHistory[0].published, true);

    phase = 'reload and status-only draw confirmation';
    runMode = 'reload';
    await count.fill('1'); await execute(); await panel.waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('draw.run') && !stored.includes('합성 참여 추첨'));
    const beforeReload = requests.get('draw.run').length;
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.getByText('간단 추첨', { exact: true }).waitFor();
    await card.locator('summary').first().click();
    assert.equal(await runButton.isDisabled(), true);
    holdRefresh = true;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    let deadline;
    try { await Promise.race([refreshHeld, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('authoritative refresh was not requested')), 15000); })]); }
    finally { clearTimeout(deadline); }
    assert.equal(await runButton.isDisabled(), true, 'another draw stays locked until the refreshed results arrive');
    releaseRefresh();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '추첨 실행' && !button.disabled));
    assert.equal(requests.get('draw.run').length, beforeReload);
    assert.equal((await read()).modules.find((item) => item.id === module.id).drawHistory.length, 2);
    phase = 'old publication confirmation cannot disclose a new draw';
    const draws = async () => (await read()).modules.find((item) => item.id === module.id).drawHistory;
    const [reviewed, previouslyPublic] = await draws();
    const publish = card.getByRole('button', { name: '최신 결과 공개', exact: true });
    await publish.click();
    const confirmation = card.getByRole('group', { name: '실행 확인' });
    assert.ok((await confirmation.innerText()).includes(reviewed.winners[0].name));
    const newest = (await run('draw.run', { id: module.id, count: 1 })).draw;
    const response = () => page.waitForResponse(reply => reply.request().method() === 'POST' &&
      reply.url().endsWith('/commands') && reply.request().postDataJSON()?.command === 'draw.publish');
    const [stale] = await Promise.all([response(), confirmation.getByRole('button', { name: '공개한다' }).click()]);
    assert.equal(stale.status(), 409);
    assert.equal(stale.request().postDataJSON().payload.expectedDrawId, reviewed.id);
    const publicDraws = async () => {
      const publicView = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/public/events/${fixture.slug}`);
      assert.equal(publicView.status, 200);
      return publicView.json.workspace.modules.find(item => item.id === module.id).drawHistory.map(draw => draw.id);
    };
    assert.deepEqual(await publicDraws(), [previouslyPublic.id]);
    assert.equal(await panel.count(), 0, 'definitive rejection has no uncertain receipt');
    const changed = card.getByRole('alert').filter({ hasText: /추첨 결과가 바뀌었습니다/ });
    await changed.waitFor();
    await card.getByText(`최신 결과: ${newest.winners[0].name}`, { exact: false }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await changed.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(out, 'draw-publication-changed-390.png') });
    await publish.click();
    assert.ok((await confirmation.innerText()).includes(newest.winners[0].name));
    const [explicit] = await Promise.all([response(), confirmation.getByRole('button', { name: '공개한다' }).click()]);
    assert.equal(explicit.status(), 200);
    assert.equal(explicit.request().postDataJSON().payload.expectedDrawId, newest.id);
    assert.deepEqual(await publicDraws(), [newest.id, previouslyPublic.id]);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, after403: true, sameIdAndPayload: true, publishTargetChecked: true, stalePublicationRejected: true, publicProjectionVerified: true, readOnlyAfterReload: true, duplicateDraws: 0 }, null, 2), { mode: 0o600 });
    console.log('Program operations: draw, publish and reload recover without duplicate draws');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); await fixture.close(); }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
