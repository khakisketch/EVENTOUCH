'use strict';
// Synthetic operators and a disposable database schema. Browser faults are local.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const axeSource = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

(async () => {
  const output = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(output);
  const fixture = await startAuditFixture();
  let browser;
  let phase = 'setup';
  try {
    const endpoint = `/api/events/${fixture.eventId}`;
    const request = (url, options = {}) => fixture.helpers.requestJson(fixture.harness.baseUrl, url, { cookie: fixture.manager.cookie, ...options });
    const command = (name, payload) => request(`${endpoint}/commands`, { method: 'POST', body: { commandId: crypto.randomUUID(), command: name, payload } });
    const current = async (id) => (await request(`${endpoint}/bootstrap`)).json.state.workspaces[fixture.eventId].desks.find((desk) => desk.id === id);
    const created = await command('desk.save', { name: '합성 입장 데스크', action: 'IN', mode: 'desk', open: true });
    assert.equal(created.status, 201);
    const id = created.json.desk.id;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let commandFault = '';
    let readFault = '';
    const writes = [];
    await page.route('**/api/events/*/commands', async (route) => {
      const body = route.request().postDataJSON();
      writes.push(body);
      const fault = commandFault; commandFault = '';
      if (fault === 'abort') return route.abort('failed');
      if (fault === '403' || fault === '409') return route.fulfill({ status: Number(fault), json: { error: 'synthetic' } });
      if (fault === 'incomplete') return route.fulfill({ status: 409, json: { code: 'DESK_INCOMPLETE', error: '데스크 정보를 확인하세요.' } });
      if (fault === 'commit-loss') { const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
      if (fault === 'partial-open') { const response = await route.fetch(); assert.equal(response.status(), 200); return route.fulfill({ status: 200, json: { desk: { id: body.payload.id, open: body.payload.open } } }); }
      return route.continue();
    });
    await page.route('**/bootstrap', async (route) => {
      const fault = readFault; readFault = '';
      if (fault === '503') return route.fulfill({ status: 503, json: { error: 'synthetic' } });
      if (fault.startsWith('missing-')) {
        const response = await route.fetch();
        const body = await response.json();
        delete body.state.workspaces[fixture.eventId].desks.find((desk) => desk.id === id)[fault.slice(8)];
        return route.fulfill({ response, json: body });
      }
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/operations`, { waitUntil: 'networkidle' });
    const row = page.getByRole('listitem').filter({ hasText: '합성 입장 데스크' }).first();
    // Reopened 2026-11-20: 데스크 행은 상세 시트를 여는 버튼 하나와 가동 스위치만 가진다(행 안의 '편집'·'가동 시작'·'가동 중지' 버튼이 사라짐).
    // 편집은 상세 시트의 '데스크 편집'에서, 가동은 '<이름> 가동' 스위치로(중지는 확인 한 단계 뒤) 같은 동작을 검증한다.
    const openDeskEditor = async (target) => {
      await target.locator('button[class*="locationOpen"]').click();
      await page.getByRole('button', { name: '데스크 편집', exact: true }).click();
    };
    const runSwitch = (target) => target.getByRole('switch', { name: /가동$/ });
    const stopDesk = async (target) => {
      await runSwitch(target).click();
      await page.getByRole('button', { name: '가동 중지', exact: true }).click();
    };
    await openDeskEditor(row);
    const dialog = page.getByRole('dialog');
    await dialog.locator('#desk-name').fill('합성 작성 중인 이름');
    await page.screenshot({ path: path.join(output, 'before-conflict.png'), fullPage: true });
    phase = 'uncertain response followed by definitive conflict';
    assert.equal((await command('desk.set-open', { id, open: false })).status, 200);
    commandFault = 'abort';
    await dialog.getByRole('button', { name: '데스크 저장' }).click();
    const recovery = dialog.getByRole('region', { name: '현장 운영 처리 확인 필요' });
    await recovery.waitFor();
    commandFault = '403';
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor();
    commandFault = '409';
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.waitFor();
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.getByRole('heading', { name: '다른 작업에서 데스크 정보가 변경됐습니다' }).waitFor();
    assert.equal(await recovery.count(), 0);
    assert.equal(await dialog.locator('#desk-name').inputValue(), '합성 작성 중인 이름');
    page.once('dialog', (prompt) => prompt.dismiss());
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await dialog.locator('#desk-name').inputValue(), '합성 작성 중인 이름', 'cancelling the close preserves the draft');
    assert.equal(new Set(writes.slice(0, 4).map((write) => write.commandId)).size, 1, 'uncertain retries use the same request');
    for (const fault of ['503', 'missing-name', 'missing-action', 'missing-mode', 'missing-open']) {
      readFault = fault;
      await dialog.getByRole('button', { name: '최신 데스크 확인' }).click();
      await dialog.getByRole('alert').filter({ hasText: '최신 데스크를 불러오지 못했습니다' }).waitFor();
      assert.equal(await dialog.locator('#desk-name').inputValue(), '합성 작성 중인 이름');
      assert.equal(await dialog.getByRole('table').count(), 0);
    }
    await dialog.getByRole('button', { name: '최신 데스크 확인' }).click();
    const table = dialog.getByRole('table', { name: '최신 데스크와 내 작성 내용 비교' });
    await table.waitFor();
    assert.deepEqual(await table.getByRole('row', { name: /이름/ }).locator('td').allTextContents(), ['합성 입장 데스크', '합성 작성 중인 이름']);
    await dialog.getByText('가동 상태는 최신 상태(중지됨)를 따릅니다.', { exact: false }).waitFor();
    await page.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow at ${width}`);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
      await page.screenshot({ path: path.join(output, `edit-conflict-${width}.png`), fullPage: true });
    }
    const beforeChoice = writes.length;
    await dialog.getByRole('button', { name: '내 작성 내용으로 계속' }).click();
    assert.equal(writes.length, beforeChoice, 'choosing does not write');
    assert.equal(await dialog.locator('#desk-name').inputValue(), '합성 작성 중인 이름');
    await dialog.getByRole('button', { name: '데스크 저장' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await current(id)).name, '합성 작성 중인 이름');
    assert.equal((await current(id)).open, false, 'saving preserves latest stopped state');

    phase = 'stale toggle cannot turn on changed direction';
    const changed = await command('desk.save', { id, name: '합성 작성 중인 이름', action: 'OUT', mode: 'desk', open: false, confirmDirectionChange: true });
    assert.equal(changed.status, 200);
    const staleRow = page.getByRole('listitem').filter({ hasText: '합성 작성 중인 이름' }).first();
    await runSwitch(staleRow).click();
    await page.getByRole('heading', { name: '다른 작업에서 데스크 상태가 변경됐습니다' }).waitFor();
    assert.equal((await current(id)).open, false);
    await page.getByRole('button', { name: '최신 데스크 확인' }).click();
    await page.getByText('퇴장 · 데스크 · 중지됨', { exact: false }).waitFor();
    const beforeApply = writes.length;
    await page.getByRole('button', { name: '최신 상태 적용' }).click();
    assert.equal(writes.length, beforeApply, 'refreshing state does not start the desk');
    assert.equal((await current(id)).open, false);
    await page.screenshot({ path: path.join(output, 'toggle-after-refresh.png'), fullPage: true });

    phase = 'committed receipt replay';
    await openDeskEditor(staleRow);
    await dialog.locator('#desk-name').fill('합성 응답 유실');
    commandFault = 'commit-loss';
    await dialog.getByRole('button', { name: '데스크 저장' }).click();
    await recovery.waitFor();
    assert.equal((await current(id)).name, '합성 응답 유실');
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await current(id)).name, '합성 응답 유실');

    phase = 'partial success does not settle desk start';
    const repairedRow = page.getByRole('listitem').filter({ hasText: '합성 응답 유실' }).first();
    await repairedRow.waitFor();
    commandFault = 'partial-open';
    await runSwitch(repairedRow).click();
    const globalRecovery = page.getByRole('region', { name: '현장 운영 처리 확인 필요' });
    await globalRecovery.waitFor();
    assert.equal((await current(id)).open, true, 'the real command committed before the response was truncated');
    await globalRecovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await globalRecovery.waitFor({ state: 'hidden' });
    assert.equal((await current(id)).open, true);

    phase = 'incomplete desk response after uncertain retry';
    await stopDesk(repairedRow);
    await page.waitForFunction(() => [...document.querySelectorAll('li')].some((row) => row.textContent?.includes('합성 응답 유실') && row.textContent?.includes('중지됨')));
    commandFault = 'abort';
    await runSwitch(repairedRow).click();
    await globalRecovery.waitFor();
    commandFault = 'incomplete';
    await globalRecovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await page.getByRole('heading', { name: '데스크 정보를 확인해야 합니다' }).waitFor();
    assert.equal(await globalRecovery.count(), 0, 'definitive rejection settles the earlier unknown request');
    assert.equal((await current(id)).open, false);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(output, 'incomplete-rejection-390.png'), fullPage: true });
    await page.getByRole('button', { name: '최신 데스크 확인' }).click();
    await page.getByRole('button', { name: '최신 상태 적용' }).click();
    await page.getByText('편집에서 이름·작업 방향·화면 방식을 확인해 주세요.', { exact: false }).waitFor();
    assert.equal((await current(id)).open, false, 'confirming latest information does not start the desk');

    phase = 'legacy desk needs explicit direction and name';
    const legacyId = 'synthetic-legacy-without-name-and-action';
    await fixture.harness.database.query(
      "UPDATE event_workspaces SET payload = jsonb_set(payload, '{desks}', COALESCE(payload->'desks', '[]'::jsonb) || $2::jsonb) WHERE event_id = $1",
      [fixture.eventId, JSON.stringify([{ id: legacyId, open: false }])]
    );
    await page.reload({ waitUntil: 'networkidle' });
    const legacyRow = page.getByRole('listitem').filter({ hasText: '이름 확인 필요' }).first();
    await legacyRow.waitFor();
    await legacyRow.getByText('방향 확인 필요').waitFor();
    assert.equal(await runSwitch(legacyRow).isDisabled(), true);
    await openDeskEditor(legacyRow);
    assert.equal(await dialog.getByRole('radio', { name: '입장', exact: true }).isChecked(), false);
    assert.equal(await dialog.getByRole('radio', { name: '퇴장', exact: true }).isChecked(), false);
    assert.equal(await dialog.getByRole('button', { name: '데스크 저장' }).isDisabled(), true);
    await dialog.locator('#desk-name').fill('합성 복구 데스크');
    await dialog.getByRole('radio', { name: '입장', exact: true }).check();
    assert.equal(await dialog.getByRole('button', { name: '데스크 저장' }).isDisabled(), true, 'direction change requires explicit acknowledgement');
    await dialog.locator('#desk-direction-confirm').check();
    await dialog.getByRole('button', { name: '데스크 저장' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const repaired = await current(legacyId);
    assert.equal(repaired.name, '합성 복구 데스크');
    assert.equal(repaired.action, 'IN');
    assert.equal(repaired.open, false, 'repairing a direction does not start the desk');
    const badModeId = 'synthetic-legacy-invalid-screen-mode';
    await fixture.harness.database.query(
      "UPDATE event_workspaces SET payload = jsonb_set(payload, '{desks}', COALESCE(payload->'desks', '[]'::jsonb) || $2::jsonb) WHERE event_id = $1",
      [fixture.eventId, JSON.stringify([{ id: badModeId, name: '합성 화면 방식 오류', action: 'IN', mode: 'unknown', open: false }])]
    );
    await page.reload({ waitUntil: 'networkidle' });
    const badModeRow = page.getByRole('listitem').filter({ hasText: '합성 화면 방식 오류' }).first();
    await badModeRow.getByText('화면 방식 확인 필요', { exact: false }).waitFor();
    assert.equal(await runSwitch(badModeRow).isDisabled(), true);
    await openDeskEditor(badModeRow);
    assert.equal(await dialog.getByRole('radio', { name: '데스크', exact: true }).isChecked(), false);
    assert.equal(await dialog.getByRole('radio', { name: '태블릿', exact: true }).isChecked(), false);
    assert.equal(await dialog.getByRole('button', { name: '데스크 저장' }).isDisabled(), true);
    await dialog.getByRole('radio', { name: '데스크', exact: true }).check();
    await dialog.getByRole('button', { name: '데스크 저장' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await current(badModeId)).mode, 'desk');
    assert.equal((await current(badModeId)).open, false);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ definitiveConflict: true, uncertainDenialsPreserved: true, incompleteReadsPreserved: true, partialStartResponseRetained: true, incompleteRejectionAfterRetry: true, sameReceiptReplay: true, latestOpenPreserved: true, changedDirectionNotStarted: true, explicitSave: true, legacyNameDirectionAndModeRepair: true, responsiveAndAxe: [320, 390, 1280] }, null, 2), { mode: 0o600 });
    console.log('Desk conflict audit passed');
  } catch (error) {
    console.error(`Desk conflict audit failed during ${phase}:`, error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
})();
