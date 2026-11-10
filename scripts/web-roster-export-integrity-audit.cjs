'use strict';
// Synthetic operator, isolated API/DB, and real browser downloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { source: axe } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'roster-export-integrity'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const db = f.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const write = async workspace => db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    const original = await read();
    original.publishedFields = [{ id: 'name', label: '이름', type: 'text' }, { id: 'phone', label: '연락처', type: 'text' }, { id: 'employee', label: '합성 사번', type: 'text' }];
    original.participants[0].name = '합성 원본 참가자'; original.participants[0].answers = { employee: '000123' };
    await write(original);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    await context.addInitScript(() => {
      const original = Response.prototype.json;
      Response.prototype.json = async function() {
        const value = await original.call(this);
        if (this.headers.get('x-audit-hold') === 'yes') {
          window.__rosterHoldSeen = true;
          await new Promise(resolve => { window.__releaseRosterHold = resolve; });
          window.__rosterHoldReleased = true;
        }
        return value;
      };
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    let mode = 'ok';
    await context.route('**/api/events/*/bootstrap', async route => {
      if (mode === 'failure') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic"}' });
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const json = await response.json(), workspace = json.state?.workspaces?.[f.eventId];
      const hold = mode === 'race-old';
      if (hold) mode = 'race-new';
      if (workspace) {
        if (mode === 'missing-fields' || (!hold && mode === 'race-new')) delete workspace.publishedFields;
        if (mode === 'old-server') delete workspace.rosterExportFieldsAvailable;
        if (mode === 'missing-field-count') delete workspace.rosterExportFieldCount;
        if (mode === 'missing-participant-count') delete workspace.rosterExportParticipantCount;
        if (mode === 'one-field') workspace.publishedFields.pop();
        if (mode === 'invalid-field') workspace.publishedFields[2].type = 'unknown';
        if (mode === 'missing-answers') delete workspace.participants[0].answers;
        if (mode === 'one-answer') delete workspace.participants[0].answers.employee;
        if (mode === 'missing-answer-proof') delete workspace.participants[0].rosterExportAnswerKeys;
        if (mode === 'missing-phone') delete workspace.participants[0].phone;
        if (mode === 'missing-id') delete workspace.participants[0].id;
        if (mode === 'duplicate-id') workspace.participants[0].id = workspace.participants[1].id;
        if (mode === 'one-row') workspace.participants.pop();
      }
      return route.fulfill({ response, json, ...(hold ? { headers: { ...response.headers(), 'x-audit-hold': 'yes' } } : {}) });
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    const search = page.locator('#roster-search'); await search.fill('합성 원본 참가자');
    const chosen = page.getByRole('checkbox', { name: '합성 원본 참가자 선택', exact: true });
    await chosen.check();
    const summary = page.locator('summary[aria-label="명단 도구"]');
    const menu = summary.locator('..');
    await summary.click();
    const csv = page.getByRole('button', { name: /CSV 내보내기/ });
    const xlsx = page.getByRole('button', { name: /엑셀 내보내기/ });
    const refresh = page.getByRole('button', { name: '새로고침', exact: true });
    const checkExport = async () => {
      if (!await menu.evaluate(node => node.open)) await summary.click();
      assert.equal(await csv.isDisabled(), false); assert.equal(await xlsx.isDisabled(), false);
      const pending = page.waitForEvent('download'); await csv.click(); const download = await pending;
      const text = fs.readFileSync(await download.path(), 'utf8');
      assert.match(text, /합성 사번/); assert.match(text, /000123/);
      assert.equal((text.match(/합성 원본 참가자/g) || []).length, 1, 'filtered download contains the selected person exactly once');
    };
    await checkExport();
    const verifyBlocked = async (nextMode, phrase) => {
      mode = nextMode; await refresh.click();
      const alert = page.locator('#roster-export-unavailable');
      await alert.getByText(phrase, { exact: false }).waitFor();
      await page.waitForFunction(() => !document.querySelector('summary[aria-label="명단 도구"]')?.parentElement?.open);
      await summary.click();
      assert.equal(await csv.isDisabled(), true, nextMode); assert.equal(await xlsx.isDisabled(), true, nextMode);
      assert.equal(await csv.getAttribute('aria-describedby'), 'roster-export-unavailable');
      assert.equal(await search.inputValue(), '합성 원본 참가자'); assert.equal(await chosen.isChecked(), true);
      await summary.click();
      return alert;
    };
    const first = await verifyBlocked('missing-fields', '게시된 신청 항목을 확인할 수 없어');
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `missing-fields-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    mode = 'ok'; await first.getByRole('button', { name: '다시 확인', exact: true }).focus();
    await page.keyboard.press('Enter'); await first.waitFor({ state: 'hidden' });
    assert.equal(await search.inputValue(), '합성 원본 참가자'); assert.equal(await chosen.isChecked(), true);
    await checkExport();
    for (const [fault, phrase] of [
      ['old-server', '게시된 신청 항목을 확인할 수 없어'], ['invalid-field', '게시된 신청 항목을 확인할 수 없어'],
      ['one-field', '게시된 신청 항목을 확인할 수 없어'], ['missing-field-count', '게시된 신청 항목을 확인할 수 없어'],
      ['missing-answers', '일부 참가자의 신청 정보를 확인할 수 없어'], ['missing-phone', '일부 참가자의 신청 정보를 확인할 수 없어'],
      ['one-answer', '일부 참가자의 신청 정보를 확인할 수 없어'], ['missing-answer-proof', '일부 참가자의 신청 정보를 확인할 수 없어'],
      ['missing-participant-count', '참가자 명단의 전체 범위를 확인할 수 없어'],
    ]) {
      const warning = await verifyBlocked(fault, phrase); mode = 'ok';
      await warning.getByRole('button', { name: '다시 확인', exact: true }).click(); await warning.waitFor({ state: 'hidden' });
    }
    let corrupt = await read(); corrupt.publishedFields = { invalid: true }; await write(corrupt);
    mode = 'ok'; await refresh.click();
    let warning = page.locator('#roster-export-unavailable'); await warning.getByText('게시된 신청 항목을 확인할 수 없어', { exact: false }).waitFor();
    await summary.click(); assert.equal(await csv.isDisabled(), true); await summary.click(); assert.deepEqual((await read()).publishedFields, { invalid: true });
    corrupt.publishedFields = original.publishedFields; corrupt.participants[0].answers = null; await write(corrupt);
    await warning.getByRole('button', { name: '다시 확인', exact: true }).click();
    await warning.getByText('일부 참가자의 신청 정보를 확인할 수 없어', { exact: false }).waitFor();
    assert.equal((await read()).participants[0].answers, null);
    corrupt.participants[0].answers = { employee: '000123' }; await write(corrupt);
    await warning.getByRole('button', { name: '다시 확인', exact: true }).click(); await warning.waitFor({ state: 'hidden' });
    await checkExport();
    for (const fault of ['missing-id', 'duplicate-id', 'one-row', 'failure']) {
      mode = fault; await refresh.click();
      await page.getByText(/최신 목록을 불러오지 못했습니다|참가자 명단을 확인할 수 없어/).first().waitFor();
      await page.waitForFunction(() => !document.querySelector('summary[aria-label="명단 도구"]')?.parentElement?.open);
      await summary.click();
      assert.equal(await csv.isDisabled(), true, `${fault} cannot export the previous snapshot`);
      assert.equal(await search.inputValue(), '합성 원본 참가자'); assert.equal(await chosen.isChecked(), true);
      await summary.click();
      mode = 'ok'; await refresh.click();
      await page.getByText(/최신 목록을 불러오지 못했습니다|참가자 명단을 확인할 수 없어/).first().waitFor({ state: 'hidden' });
      await checkExport();
    }
    mode = 'race-old'; await refresh.click();
    await page.waitForFunction(() => window.__rosterHoldSeen === true);
    assert.equal(await csv.isDisabled(), true, 'a pending refresh must lock exporting the earlier list');
    await page.evaluate(() => { const channel = new BroadcastChannel('eventouch-console-freshness'); channel.postMessage({ changed: true }); channel.close(); });
    const raceWarning = page.locator('#roster-export-unavailable');
    await raceWarning.getByText('게시된 신청 항목을 확인할 수 없어', { exact: false }).waitFor();
    await page.evaluate(() => window.__releaseRosterHold());
    await page.waitForFunction(() => window.__rosterHoldReleased === true);
    await page.waitForTimeout(300);
    assert.equal(await raceWarning.isVisible(), true, 'an older successful read must not overwrite the newer incomplete read');
    await summary.click(); assert.equal(await csv.isDisabled(), true); await summary.click();
    mode = 'ok'; await raceWarning.getByRole('button', { name: '다시 확인', exact: true }).click();
    await raceWarning.waitFor({ state: 'hidden' }); await checkExport();
    // On initial load an unidentified person must not disappear as a valid row.
    mode = 'missing-id'; const another = await context.newPage();
    await another.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await another.getByText('참가자 명단을 완전히 확인할 수 없습니다.', { exact: false }).waitFor();
    assert.equal(await another.locator('#roster-search').count(), 0);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, realDownloads: true, missingAndMalformedFieldsBlocked: true, partialFieldAnswerAndRowBlocked: true, legacyServerSimulated: true, truncatedAnswersAndBaseBlocked: true, missingAndDuplicateIdsBlocked: true, refreshFailureBlocksStaleExport: true, supersededReadCannotOverwrite: true, dataAndSelectionPreserved: true, viewportWidths: [320, 390, 1280], physicalDevices: false }, null, 2));
    console.log('명단 내보내기: 부분 응답·저장 오류·식별자·실제 파일 및 복구 확인');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
