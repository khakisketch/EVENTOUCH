'use strict';
// Open real downloads made by the browser against an isolated synthetic API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('../apps/web/node_modules/xlsx');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
let stage = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'roster-export');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { database } = fixture.harness;
    const workspace = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    workspace.publishedFields = [
      { id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true },
      { id: 'employee', label: '사번', type: 'text' },
      { id: 'special', label: '추가 응답', type: 'text' },
      { id: 'agree', label: '추가 동의', type: 'checkbox' },
    ];
    workspace.participants[0].name = '엑셀 검증 A';
    workspace.participants[0].phone = '01001234567';
    workspace.participants[0].answers = { employee: '000123', special: '=1+1', agree: true };
    workspace.participants[1].name = '엑셀 검증 B';
    workspace.participants[1].phone = '01009876543';
    workspace.participants[1].answers = { employee: '000456', special: '  +1+1', agree: false };
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`, { waitUntil: 'networkidle' });
    await page.locator('#roster-search').fill('엑셀 검증');
    const sort = page.getByRole('button', { name: /참가자.*이름순 정렬/ });
    await sort.click();
    await sort.click(); // descending
    const tableNames = await page.locator('table tbody tr').allTextContents();
    assert.match(tableNames[0], /엑셀 검증 B/);
    await page.locator('summary[aria-label="내보내기·가져오기"]').click();
    await page.screenshot({ path: path.join(out, 'roster-export-menu-1280.png'), fullPage: true });
    stage = 'XLSX';
    const xlsxDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: /엑셀 내보내기 · 검색·필터 결과 2명/ }).click();
    const xlsx = await xlsxDownload;
    assert.equal(xlsx.suggestedFilename(), 'EVENTOUCH_participants.xlsx');
    const book = XLSX.read(fs.readFileSync(await xlsx.path()), { type: 'buffer' });
    assert.deepEqual(book.SheetNames, ['참가자']);
    const sheet = book.Sheets['참가자'];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    assert.deepEqual(data[0].slice(-3), ['사번', '추가 응답', '추가 동의']);
    assert.equal(data.length, 3, 'only the two filter results are exported');
    assert.equal(data[1][0], '엑셀 검증 B', 'current descending sort is preserved');
    assert.equal(data[2][0], '엑셀 검증 A');
    const employeeCol = data[0].indexOf('사번');
    const extraCol = data[0].indexOf('추가 응답');
    const phoneCol = data[0].indexOf('연락처');
    const cell = (column, row) => sheet[XLSX.utils.encode_cell({ c: column, r: row })];
    assert.equal(cell(phoneCol, 1).t, 's');
    assert.equal(cell(phoneCol, 1).v, '01009876543');
    assert.equal(cell(employeeCol, 2).t, 's');
    assert.equal(cell(employeeCol, 2).v, '000123');
    assert.equal(cell(extraCol, 2).t, 's');
    assert.equal(cell(extraCol, 2).v, '=1+1');
    assert.equal(cell(extraCol, 2).f, undefined, 'untrusted text is not a spreadsheet formula');
    assert.equal(data[1][data[0].indexOf('추가 동의')], '아니요');
    stage = 'CSV';
    const csvDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: /CSV 내보내기 · 검색·필터 결과 2명/ }).click();
    const csv = await csvDownload;
    assert.equal(csv.suggestedFilename(), 'EVENTOUCH_participants.csv');
    const csvText = fs.readFileSync(await csv.path(), 'utf8');
    assert.match(csvText, /사번,추가 응답,추가 동의/);
    assert.match(csvText, /'  \+1\+1/);
    assert.match(csvText, /'=1\+1/);
    assert.match(csvText, /000123/);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: path.join(out, `roster-export-menu-${width}.png`), fullPage: true });
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        buttons: [...document.querySelectorAll('details[open] button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { x: rect.x, right: rect.right, width: rect.width, height: rect.height };
        }),
      }));
      fs.writeFileSync(path.join(out, `menu-geometry-${width}.json`), JSON.stringify(geometry, null, 2), { mode: 0o600 });
      assert.equal(geometry.overflow, false, `mobile page does not overflow at ${width}px`);
      assert.ok(geometry.buttons.length >= 2);
      for (const button of geometry.buttons) {
        assert.ok(button.x >= 0 && button.right <= width && button.width >= 44 && button.height >= 44,
          `export action remains visible and usable at ${width}px`);
      }
    }
    await context.close();
    process.stdout.write('Roster XLSX/CSV: filtered and sorted rows, published fields, text IDs and formula safety passed\n');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => {
  const message = String(error && error.message || 'Unknown failure').split('\n')[0].replace(/https?:\/\/[^\s]+/g, '[url redacted]');
  console.error(`Stage ${stage}: ${message}`);
  process.exitCode = 1;
});
