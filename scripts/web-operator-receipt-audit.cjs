'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
let stage = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'operator-receipts');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture({ loseFirstResponseFor: 'event.basics.save' });
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    let writes = 0;
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
      try { if (request.postDataJSON().command === 'event.basics.save') writes += 1; } catch {}
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`, { waitUntil: 'networkidle' });
    await page.locator('#set-name').fill('합성 결과 확인 행사');
    await page.getByRole('button', { name: '기본 정보 저장' }).click();
    stage = 'lost response';
    const local = page.getByRole('region', { name: '행사 설정 처리 확인 필요' });
    await local.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    assert.equal(await page.locator('#set-name').isDisabled(), true, 'the original values stay frozen while the result is unknown');
    assert.equal(writes, 1);
    const raw = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator'));
    const pointers = JSON.parse(raw);
    assert.deepEqual(Object.keys(pointers[0]).sort(), ['command', 'commandId', 'eventId', 'organizationId', 'userId']);
    assert.equal(pointers[0].command, 'event.basics.save');
    assert.equal(raw.includes('합성 결과 확인 행사'), false);
    await page.screenshot({ path: path.join(out, 'operator-recovery-390.png'), fullPage: true });
    stage = 'reload';
    page.once('dialog', d => d.accept());
    await page.reload({ waitUntil: 'networkidle' });
    const panel = page.getByRole('region', { name: '처리 결과 확인' });
    await panel.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    assert.equal(await page.locator('#set-name').inputValue(), '합성 결과 확인 행사');
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    const status = panel.getByRole('status').filter({ hasText: '서버에 행사 정보 저장 기록이 있습니다' });
    await status.waitFor();
    await status.getByText('원래 화면에서 같은 요청을 다시 확인하거나', { exact: false }).waitFor();
    assert.equal(await status.getByRole('link', { name: '티켓 확인 필요 명단 보기' }).getAttribute('href'), `/console/events/${encodeURIComponent(fixture.eventId)}/participants?ticket=review`);
    assert.equal(writes, 1, 'checking a receipt never submits a second write');
    assert.ok((await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator'))).includes('event.basics.save'), 'status only cannot release the reviewed request');
    await panel.getByRole('button', { name: '목록에서 지우기' }).click();
    await page.getByRole('dialog', { name: '처리 결과 확인에서 지우기' }).getByRole('button', { name: '목록에서 지우기' }).click();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator')), null);
    const row = (await fixture.harness.database.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0];
    assert.equal(row.payload.name, '합성 결과 확인 행사');
    await context.close();
    process.stdout.write('Operator receipt recovery: response loss, reload, scoped status GET and no resend passed\n');
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
