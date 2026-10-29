'use strict';

// Real browser -> same-origin test gateway -> API -> isolated PostgreSQL
// schema. Requires a running production Next build, never intercepts an API
// response with a fabricated result, and never sends a message.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, ensureCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID', 'SOLAPI_API_HOST']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
process.env.EVENTOUCH_MAIL_MOCK = '1';
const { startOwnedNext, ensureAuditDatabaseEnv } = require('./audit-fixture.cjs');
ensureAuditDatabaseEnv();
const { chromium } = require('playwright');
const XLSX = require('../apps/web/node_modules/xlsx');
const { emptyWorkspace } = require('../server/state');
const { startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, LEGACY_ORG } = require('../tests/helpers/postgres-api-server.cjs');
const { startWebApiGateway } = require('../tests/helpers/web-api-gateway.cjs');

const webBaseExplicit = Object.hasOwn(process.env, 'WEB_BASE');
const captureDir = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'import-real')
  : defaultCaptureDir(`import-real-${runStamp()}`);

function workbookBuffer(count, offset, bookType, wide = false) {
  const extra = wide ? Array.from({ length: 8 }, (_, index) => `기타 ${index + 1}`) : [];
  const rows = [[...extra, '이름', '연락처', '소속']];
  for (let index = 1; index <= count; index += 1) {
    const number = index + offset;
    rows.push([...extra.map(() => ''), `검증 참가자 ${number}`, 1000000000 + number, `검증 업체 ${number % 4 + 1}`]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  // Excel displays a leading 0 although the stored value is numeric.
  for (let row = 1; row <= count; row += 1) sheet[XLSX.utils.encode_cell({ c: extra.length + 1, r: row })].z = '00000000000';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '참가자');
  return XLSX.write(book, { type: 'buffer', bookType });
}

async function main() {
  prepareCaptureDir(captureDir);
  // Uploaded workbooks and browser profiles stay under this run's
  // private tree, never the shared /tmp/opencode directory.
  process.env.TMPDIR = ensureRunTmpDir(captureDir);
  const buildId = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
  assert.ok(buildId, 'import audit requires a production Next build');
  let harness;
  let owned;
  let gateway;
  let browser;
  let page;
  try {
    harness = await startApiHarness();
    if (webBaseExplicit) process.stderr.write('[import-audit] WEB_BASE is superseded: auditing the isolated owned Next server\n');
    owned = await startOwnedNext({ apiBase: harness.baseUrl });
    {
      const probe = await fetch(`${owned.baseUrl}/login`, { headers: { connection: 'close' } });
      await probe.text().catch(() => '');
      assert.equal(probe.status, 200, 'owned Next must serve the login shell before the browser runs');
    }
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const eventId = `browser-import-${suffix}`;
    const accountId = `browser-import-manager-${suffix}`;
    await insertAccount(harness.database, { orgId: LEGACY_ORG, id: accountId, role: 'MANAGER', name: '가져오기 검증 운영자', email: `${accountId}@example.test` });
    await insertEvent(harness.database, {
      orgId: LEGACY_ORG,
      id: eventId,
      slug: eventId,
      payload: { id: eventId, slug: eventId, name: '가져오기 검증 행사', stage: 'LIVE', date: '2027-01-16', start: '09:00', end: '17:00', capacity: 100, features: ['draw', 'poll', 'reward'] },
      workspace: emptyWorkspace(),
    });
    await insertMembership(harness.database, accountId, eventId, ['all']);
    gateway = await startWebApiGateway({ apiBase: harness.baseUrl, webBase: owned.baseUrl, loseFirstResponseFor: 'participant.import' });
    browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const cookie = await sessionCookie(harness, accountId);
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), url: gateway.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${gateway.baseUrl}/console/events/${eventId}/participants/import`, { waitUntil: 'networkidle' });
    const file = page.locator('input[type="file"]');
    // The redesigned picker keeps the real input keyboard-focusable while
    // rendering its Korean label as the visible control. Exercise Tab and
    // native Space/filechooser, not a fabricated button click. Chromium's
    // native file input did not open with Enter after Tab in a minimal
    // independent reproduction; Space opens it without app-specific handlers.
    await file.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.equal(await file.evaluate(element => element === document.activeElement), true, 'Tab returns to the real file input');
    const picker = page.locator('label').filter({ has: file });
    const visibleControl = picker.getByText('파일 선택', { exact: true });
    const controlGeometry = await visibleControl.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { width: rect.width, height: rect.height, outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
    });
    assert.ok(controlGeometry.width >= 44 && controlGeometry.height >= 44 && controlGeometry.outline !== 'none' && controlGeometry.outlineWidth >= 2, `file-picker focus or touch target: ${JSON.stringify(controlGeometry)}`);
    const fileChooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Space');
    await (await fileChooser).setFiles({ name: '참가자.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbookBuffer(8, 0, 'xlsx') });
    const review = page.locator('section[aria-labelledby="participant-import-review-heading"]');
    await review.getByText('유효 8행', { exact: true }).waitFor();
    await review.getByText('오류 0행', { exact: true }).waitFor();
    assert.equal(await picker.getByText('참가자.xlsx', { exact: true }).isVisible(), true, 'selected filename is visible');
    await page.getByRole('button', { name: /유효 8행 반영/ }).click();
    await page.getByRole('alert').filter({ hasText: /연결하지 못했습니다/ }).waitFor();
    await page.getByRole('button', { name: /유효 8행 반영/ }).click();
    await page.getByText('8명을 반영했습니다.', { exact: true }).waitFor();
    const calls = gateway.commands.filter((item) => item.command === 'participant.import');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].commandId, calls[1].commandId, 'lost-response retry must reuse its receipt key');
    assert.equal(calls[0].responseLost, true);
    let stored = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    assert.equal(stored.participants.length, 8, 'response loss must not import the same eight people twice');
    assert.equal(stored.participants[0].phone, '01000000001', 'Excel displayed leading zero must survive parsing');
    await page.screenshot({ path: path.join(captureDir, 'xlsx-retry-1280.png'), fullPage: true });

    await file.setInputFiles({ name: '추가참가자.xls', mimeType: 'application/vnd.ms-excel', buffer: workbookBuffer(2, 8, 'biff8') });
    await review.getByText('유효 2행', { exact: true }).waitFor();
    await review.getByText('오류 0행', { exact: true }).waitFor();
    await page.getByRole('button', { name: /유효 2행 반영/ }).click();
    await page.getByText('2명을 반영했습니다.', { exact: true }).waitFor();
    stored = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    assert.equal(stored.participants.length, 10);
    assert.equal(stored.participants[8].phone, '01000000009');
    assert.equal(new Set(stored.participants.map((person) => person.phone)).size, 10);
    assert.ok(stored.participants.every((person) => person.status === 'APPROVED'));
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(captureDir, 'xls-1280.png'), fullPage: true });

    await file.setInputFiles({ name: '여러열참가자.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbookBuffer(2, 10, 'xlsx', true) });
    await review.getByText('유효 2행', { exact: true }).waitFor();
    await review.getByText('오류 0행', { exact: true }).waitFor();
    await page.getByRole('button', { name: /유효 2행 반영/ }).click();
    await page.getByText('2명을 반영했습니다.', { exact: true }).waitFor();
    stored = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    assert.equal(stored.participants.length, 12);
    assert.equal(stored.participants[10].phone, '01000000011', 'columns beyond the old eight-column truncation must remain mappable');

    const writesBeforeRejection = gateway.commands.filter((item) => item.command === 'participant.import').length;
    await file.setInputFiles({ name: '행수초과.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbookBuffer(1001, 100, 'xlsx') });
    await page.getByRole('alert').filter({ hasText: /1,000/ }).waitFor();
    assert.equal(gateway.commands.filter((item) => item.command === 'participant.import').length, writesBeforeRejection, 'an oversized workbook must not be silently partially imported');
    await harness.restartHttp();
    const reloaded = await context.request.get(`${gateway.baseUrl}/api/bootstrap`);
    assert.equal(reloaded.status(), 200);
    const persisted = await reloaded.json();
    assert.equal(persisted.state.workspaces[eventId].participants.length, 12);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ outcome: 'passed', buildId, ownedNext: owned.baseUrl, apiResponsesMocked: false, formats: ['xlsx', 'xls'], imported: 12, leadingZeroPreserved: true, wideColumnsMapped: true, oversizedWorkbookRejected: true, lostResponseReplayed: true, persistedAfterHttpRestart: true, pageErrors: 0, captures: captureDir }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(captureDir, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    if (gateway) await gateway.close().catch(() => {});
    if (owned) await owned.close().catch(() => {});
    if (harness) await harness.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
