'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let phase = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'evidence-recovery-before' : 'evidence-recovery');
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
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/photos`, { waitUntil: 'networkidle' });
    let mode = 'malformed';
    const ids = { 'evidence.photo.add': [], 'evidence.photo.move': [], 'evidence.photo.remove': [] };
    let uploads = 0;
    await page.route(/\/api\/events\/[^/]+\/files\?/, async (route) => {
      if (route.request().method() === 'POST') uploads++;
      return route.continue();
    });
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (!Object.hasOwn(ids, body.command)) return route.continue();
      ids[body.command].push(body.commandId);
      if (mode === 'lost' || mode === 'malformed') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, 'photo command committed before response fault');
        if (mode === 'lost') { mode = 'pass'; return route.abort('failed'); }
        mode = 'pass';
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"photo":{"id":"wrong"}}' });
      }
      return route.continue();
    });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const select = async (name) => {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: before ? '파일 찾아보기' : '사진 올리기', exact: true }).click(),
      ]);
      await chooser.setFiles({ name, mimeType: 'image/png', buffer: png });
      await page.getByRole('button', { name: '선택한 사진 올리기 (1장)' }).click();
    };
    phase = 'malformed record response';
    await select('synthetic-evidence-one.png');
    if (before) {
      await page.getByText(/업로드 처리 내역/).click();
      await page.getByText('보관함에 등록됨', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(out, 'before-uncertain-1280.png'), fullPage: true });
      console.log('Evidence recovery before capture passed'); return;
    }
    await page.getByText('파일 업로드 완료 · 보관 기록 확인 필요').waitFor();
    await page.getByText(/이미 등록됐거나 파일만 남아 있을 수 있습니다/).waitFor();
    assert.equal(await page.getByRole('region', { name: '처리 결과 확인' }).count(), 0, 'local job owns its recovery');
    await page.screenshot({ path: path.join(out, 'uncertain-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'uncertain-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '기록 등록 재시도' }).click();
    await page.getByText('공간구성에 사진을 등록했습니다.', { exact: true }).waitFor();
    assert.equal(ids['evidence.photo.add'][0], ids['evidence.photo.add'][1]);
    assert.equal(uploads, 1, 'record retry must not upload the file again');
    assert.equal((await workspace()).evidencePhotos.filter((item) => item.image.name === 'synthetic-evidence-one.png').length, 1);

    phase = 'reload keeps only record identifier';
    mode = 'lost';
    await select('synthetic-evidence-two.png');
    await page.getByText('파일 업로드 완료 · 보관 기록 확인 필요').waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('evidence.photo.add') && !stored.includes('synthetic-evidence-two.png'));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    assert.equal(await page.locator('#evidence-photo-files').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '사진 올리기', exact: true }).count(), 0);
    const beforeCheck = ids['evidence.photo.add'].length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.getByRole('button', { name: '사진 올리기', exact: true }).waitFor();
    assert.equal(await page.locator('#evidence-photo-files').isEnabled(), true);
    assert.equal(ids['evidence.photo.add'].length, beforeCheck);
    assert.equal((await workspace()).evidencePhotos.filter((item) => item.image.name === 'synthetic-evidence-two.png').length, 1);

    phase = 'move status and fresh later action';
    const photo = (await workspace()).evidencePhotos.find((item) => item.image.name === 'synthetic-evidence-one.png');
    const row = page.locator(`#evidence-photo-${photo.id}`);
    const viewer = page.getByRole('dialog', { name: /^(공간구성|무대연출) ·/ });
    await row.getByRole('button', { name: /크게 보기$/ }).click();
    await viewer.getByRole('button', { name: '닫기', exact: true }).waitFor();
    await viewer.getByLabel('보관 구간 변경').selectOption('STAGE');
    await viewer.getByRole('button', { name: '구간 변경', exact: true }).click();
    mode = 'malformed';
    await viewer.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '구간 변경하기' }).click();
    await viewer.waitFor({ state: 'hidden' });
    await shared.waitFor();
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.getByRole('button', { name: '사진 올리기', exact: true }).waitFor();
    assert.equal(await page.locator('#evidence-photo-files').isEnabled(), true);
    assert.equal((await workspace()).evidencePhotos.find((item) => item.id === photo.id).section, 'STAGE');
    await page.getByRole('group', { name: '촬영 구간' }).getByRole('button', { name: /무대연출/ }).click();
    await row.getByRole('button', { name: /크게 보기$/ }).click();
    await viewer.getByLabel('보관 구간 변경').selectOption('SPACE');
    await viewer.getByRole('button', { name: '구간 변경', exact: true }).click();
    await viewer.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '구간 변경하기' }).click();
    await row.waitFor({ state: 'hidden' });
    assert.equal((await workspace()).evidencePhotos.find((item) => item.id === photo.id).section, 'SPACE');
    assert.notEqual(ids['evidence.photo.move'][0], ids['evidence.photo.move'][1]);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, malformedRecordRetried: true, fileNotReuploaded: true, statusOnlyAfterReload: true, moveVerified: true }, null, 2), { mode: 0o600 });
    console.log('Evidence: uncertain record, reload status and later move passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
