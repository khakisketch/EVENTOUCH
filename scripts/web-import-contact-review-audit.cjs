'use strict';
// Real operator import, isolated API/database and synthetic workbook only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { source: axe } = require('axe-core');
const XLSX = require('../apps/web/node_modules/xlsx');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'import-contact-review'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    await context.addInitScript(() => {
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function() {
        if (this.name === '느린새파일.xlsx') {
          window.__waitingForImportFile = true;
          await new Promise(resolve => { window.__releaseImportFile = resolve; });
        }
        return read.call(this);
      };
    });
    let dropResponse = true;
    const requestIds = [];
    await context.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'participant.import') return route.continue();
      requestIds.push(body.commandId);
      if (!dropResponse) return route.continue();
      const response = await route.fetch();
      assert.ok(response.ok(), 'synthetic import committed before response loss');
      dropResponse = false;
      return route.abort('failed');
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants/import`);
    const file = page.locator('input[type=file]');
    const review = page.locator(':is(section,[role="region"])[aria-labelledby="participant-import-review-heading"]');
    const workbook = (rows, formatPhone = false) => {
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      if (formatPhone) sheet.B2.z = '00000000000';
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '합성명단');
      return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    };
    // The picker is only on screen before a file is read: after a review or a
    // commit the operator first asks for another file.
    const pick = async (spec) => {
      const again = page.getByRole('button', { name: '다른 파일 가져오기', exact: true });
      if (await again.count()) await again.click();
      const change = page.getByRole('button', { name: '파일 바꾸기', exact: true });
      if (await change.count() && await change.isEnabled()) await change.click();
      await file.setInputFiles(spec);
    };
    const ready = (count) => review.locator('[class*="heroNumber"]').getByText(String(count), { exact: true }).waitFor();
    const skipped = async (count) => { await review.getByRole('heading', { name: `${count}행은 등록하지 않아요` }).waitFor(); await review.getByRole('button', { name: /^오류 \d+행 보기$/ }).click(); };
    const setWorkbook = async (name, buffer) => pick({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await setWorkbook('누락가능.xlsx', workbook([['이름', '연락처'], ...Array.from({ length: 5 }, (_, i) => [`합성정상${i}`, `0109000200${i}`]), ['합성누락', 1090002009]]));
    await ready(6);
    // 2026-11-19: a spreadsheet-dropped leading 0 is restored and listed, never a gate.
    // Reopened 2026-11-20: auto-fixed rows sit in a closed group; open it, then read the list.
    await review.getByText('자동으로 맞춘 항목 1건').click();
    await review.getByText('연락처 1건은 앞자리 0을 붙여 등록해요').waitFor();
    const list = review.getByRole('list', { name: '앞자리 0을 붙인 연락처 목록' });
    assert.match(await list.innerText(), /파일 7행 · 합성누락/); assert.match(await list.innerText(), /1090002009 → 010-9000-2009/);
    const submit = page.getByRole('button', { name: /^6명 등록$/ });
    assert.equal(await submit.isEnabled(), true, 'a restored number does not block the import');
    const original = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    assert.ok(!original.participants.some(person => person.name === '합성누락'));
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(node => node.target), summary: v.nodes.map(node => node.failureSummary) }))), []);
      await page.screenshot({ path: path.join(out, `review-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await submit.focus(); await page.keyboard.press('Enter');
    await review.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button', { name: '파일 바꾸기', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await page.getByText(/^6명을 반영했습니다\./).waitFor();
    assert.equal(requestIds[0], requestIds[1], 'reviewed import retries the same request after a lost response');
    const saved = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    assert.equal(saved.participants.find(person => person.name === '합성누락').phone, '01090002009', 'the dropped leading zero is restored as shown');
    assert.equal(saved.participants.filter(person => person.name === '합성누락').length, 1, 'retry does not duplicate the reviewed person');
    await setWorkbook('표시서식.xlsx', workbook([['이름', '연락처'], ['합성서식', 1090002020]], true));
    await ready(1);
    assert.equal(await review.getByText(/앞자리 0을 붙여 등록해요/).count(), 0, 'displayed leading zero stays intact');
    assert.match(await review.innerText(), /010-9000-2020/);
    await setWorkbook('빈행.xlsx', workbook([['이름', '연락처'], [], ['합성빈행', 1090002021], ['합성오류', 123]]));
    await skipped(1);
    await review.getByText('자동으로 맞춘 항목 1건').click();
    assert.match(await review.getByRole('list', { name: '앞자리 0을 붙인 연락처 목록' }).innerText(), /파일 3행 · 합성빈행/);
    assert.match(await review.getByRole('list', { name: '가져오기 오류 목록' }).innerText(), /파일 4행/);
    await pick({ name: '합성.txt', mimeType: 'text/plain', buffer: Buffer.from('첫번째,123\n\n두번째,01090002019\n') });
    await skipped(1);
    assert.match(await review.getByRole('list', { name: '가져오기 오류 목록' }).innerText(), /파일 1행/);
    await pick({ name: '합성.csv', mimeType: 'text/csv', buffer: Buffer.from('이름,연락처\n"합성\n이름",01090002018\n\n합성오류,123\n') });
    await skipped(1);
    assert.match(await review.getByRole('list', { name: '가져오기 오류 목록' }).innerText(), /파일 5행/);
    await pick({ name: '이전.csv', mimeType: 'text/csv', buffer: Buffer.from('이름,연락처\n이전참가자,01090003001\n') });
    await review.getByText('이전참가자', { exact: true }).waitFor();
    await setWorkbook('느린새파일.xlsx', workbook([['이름', '연락처'], ['새참가자', '01090003002']]));
    await page.waitForFunction(() => window.__waitingForImportFile === true);
    await page.getByText('느린새파일.xlsx 파일을 읽고 있습니다.', { exact: false }).waitFor();
    assert.equal(await review.isVisible(), false, 'previous data cannot be reviewed during a new read');
    assert.equal(await page.getByLabel('이름에 연결할 열').count(), 0, 'previous column mapping is not actionable');
    await page.evaluate(() => window.__releaseImportFile());
    await review.getByText('새참가자', { exact: true }).waitFor();
    assert.equal(await review.getByText('이전참가자', { exact: true }).count(), 0);
    await page.getByRole('button', { name: /^1명 등록$/ }).click();
    await page.getByText(/^1명을 반영했습니다\./).waitFor();
    const afterRace = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    assert.ok(afterRace.participants.some(person => person.name === '새참가자'));
    assert.ok(!afterRace.participants.some(person => person.name === '이전참가자'));
    const roster = await context.newPage();
    await roster.setViewportSize({ width: 390, height: 850 });
    await roster.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    // Reopened 2026-11-21 (owner: 시안 A, 모바일): 휴대폰 폭에서는 명단 가져오기가 도구 줄의 ⋯ 메뉴 안에 접힌다.
    const utilities = roster.locator('summary[aria-label="내보내기·가져오기"]');
    await utilities.waitFor();
    const utilityBox = await utilities.boundingBox();
    assert.ok(utilityBox.width >= 44 && utilityBox.height >= 44, 'phone ⋯ menu keeps a 44px target');
    await utilities.click();
    await roster.getByRole('button', { name: '명단 가져오기', exact: true }).click();
    const dialog = roster.getByRole('dialog', { name: '명단 가져오기' });
    await dialog.locator('input[type=file]').setInputFiles({ name: '모달.csv', mimeType: 'text/csv', buffer: Buffer.from('이름,연락처\n모달검토,1090002099\n') });
    await dialog.getByText('자동으로 맞춘 항목 1건').click();
    await dialog.getByText('연락처 1건은 앞자리 0을 붙여 등록해요').waitFor();
    const modalSubmit = dialog.getByRole('button', { name: /^1명 등록$/ });
    assert.equal(await modalSubmit.isEnabled(), true);
    await roster.evaluate(axe);
    assert.deepEqual(await roster.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(node => node.target), summary: v.nodes.map(node => node.failureSummary) }))), []);
    assert.ok(await roster.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await dialog.screenshot({ path: path.join(out, 'modal-review-390.png') });
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, hiddenSixthPhoneListed: true, leadingZeroRestored: true, responseLossSameRequest: true, formattedZeroPreserved: true, csvMultilineAndBlankRows: true, txtAndWorkbookRowNumbers: true, pendingFileCannotImportPrevious: true, modalReviewed: true, keyboard: true, widths: [320, 390, 1280], physicalDevices: false }, null, 2));
    console.log('명단 가져오기: 연락처 앞자리 0 복원·실제 저장·행 위치·키보드·작은 화면 확인');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
