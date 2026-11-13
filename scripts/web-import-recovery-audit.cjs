'use strict';
// Exercise real commits in an isolated database; only responses are faulted.
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
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'import-recovery-before' : 'import-recovery');
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
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants/import`, { waitUntil: 'networkidle' });
    const file = page.locator('input[type="file"]');
    const review = page.locator(':is(section,[role=region])[aria-labelledby="participant-import-review-heading"]');
    const load = async (n) => {
      await file.setInputFiles({ name: `합성명단${n}.csv`, mimeType: 'text/csv', buffer: Buffer.from(`이름,연락처,이메일,소속\n합성 가져오기 ${n},0108888000${n},import${n}@example.test,합성 조직\n`) });
      await review.getByText('유효 1행', { exact: true }).waitFor();
    };
    let mode = 'lost';
    const ids = [];
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body.command !== 'participant.import') return route.continue();
      ids.push(body.commandId);
      if (mode === 'lost' || mode === 'malformed') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, `import committed: ${response.status()}`);
        if (mode === 'lost') { mode = 'rejected'; return route.abort('failed'); }
        mode = 'pass';
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"participants":[]}' });
      }
      if (mode === 'rejected') { mode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      if (mode === 'rate') { mode = 'pass'; return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"잠시 후 다시 시도하세요"}' }); }
      return route.continue();
    });
    const people = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload.participants;

    phase = 'lost response and same-request replay';
    await load(1);
    await review.getByRole('button', { name: '유효 1행 반영' }).click();
    await review.getByRole('alert').waitFor();
    await page.screenshot({ path: path.join(out, 'unconfirmed-1280.png'), fullPage: true });
    if (before) { console.log('Import response-loss before capture passed'); return; }
    assert.equal(await file.isDisabled(), true, 'file cannot be replaced during an uncertain import');
    assert.equal(await page.getByRole('region', { name: '처리 결과 확인' }).count(), 0, 'the inline recovery owns the pointer on this screen');
    assert.equal(await review.getByText(/원래 파일과 열 연결을 유지/).isVisible(), true);
    assert.equal(await page.getByLabel('이름 *').isDisabled(), true);
    await review.getByRole('button', { name: '확인 전 닫기' }).click();
    const closeConfirm = review.getByRole('group', { name: '실행 확인' });
    await closeConfirm.getByText(/서버 처리는 취소되지 않습니다/).waitFor();
    await closeConfirm.getByRole('button', { name: '계속 확인하기' }).click();
    assert.equal(await file.isDisabled(), true, 'canceling dismissal keeps the original file');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await review.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await review.getByRole('alert').filter({ hasText: /확인하지 못했습니다/ }).waitFor();
    assert.equal(await file.isDisabled(), true, 'later 403 cannot prove the first request failed');
    mode = 'rate';
    await review.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await review.getByRole('alert').filter({ hasText: /확인하지 못했습니다/ }).waitFor();
    await review.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await page.getByText('1명을 반영했습니다.', { exact: true }).waitFor();
    assert.equal(new Set(ids.slice(0, 4)).size, 1);
    assert.equal((await people()).filter((person) => person.name === '합성 가져오기 1').length, 1);

    phase = 'status-only check after malformed response';
    await load(2);
    mode = 'malformed';
    await review.getByRole('button', { name: '유효 1행 반영' }).click();
    await review.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const beforeCheck = ids.length;
    await review.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.getByText('1명을 반영했습니다.', { exact: true }).waitFor();
    assert.equal(ids.length, beforeCheck, 'status lookup must not resend the import');
    assert.equal((await people()).filter((person) => person.name === '합성 가져오기 2').length, 1);

    phase = 'reload preserves only a scoped identifier';
    await load(3);
    mode = 'malformed';
    await review.getByRole('button', { name: '유효 1행 반영' }).click();
    await review.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const saved = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(saved.includes('participant.import'));
    assert.ok(!saved.includes('합성 가져오기') && !saved.includes('0108888') && !saved.includes('import3@'));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    assert.equal(await file.isDisabled(), true, 'unresolved earlier import blocks replacing the file');
    const beforeReloadCheck = ids.length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.waitForFunction(() => !document.querySelector('input[type="file"]')?.disabled);
    assert.equal(ids.length, beforeReloadCheck);
    assert.equal((await people()).filter((person) => person.name === '합성 가져오기 3').length, 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, lostThen403Then429: true, sameCommand: true, statusCheckDoesNotResend: true, reloadBlocksAnotherImport: true, duplicateRows: 0 }, null, 2), { mode: 0o600 });
    console.log('Import: frozen rows, status-only recovery and reload protection passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
