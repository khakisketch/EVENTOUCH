'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { floorplanPng } = require('../tests/helpers/floorplan-image.cjs');
const { randomUUID } = require('node:crypto');
let stage = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'venue-map');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const attempts = [];
    let lose = true;
    // Install interception before navigation so initial and lazy font
    // requests run under the same routing setup.
    await page.route('**/api/events/*/files?*', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(new URL(route.request().url()).searchParams.get('commandId'));
      if (lose) { lose = false; await route.fetch(); return route.abort('failed'); }
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/content`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '장소 안내', exact: true }).click();
    const file = page.locator('#content-venue-map-file');
    await file.waitFor();
    stage = 'size and description validation';
    await file.setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(500000) });
    await page.getByRole('alert').filter({ hasText: '500KB 미만' }).first().waitFor();
    assert.equal(attempts.length, 0);
    await file.setInputFiles({ name: 'venue.png', mimeType: 'image/png', buffer: floorplanPng() });
    const alt = page.getByLabel('안내도 설명');
    await alt.waitFor();
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '안내도에 대한 설명을 입력하세요' }).first().waitFor();
    assert.equal(await alt.evaluate(el => document.activeElement === el), true);
    assert.equal(attempts.length, 0);
    await alt.fill('동문에서 접수대를 지나 행사장으로 이동');
    // Capture the same draft before the native dialog: a screenshot immediately
    // after a dismissed browser dialog can hang Chromium's capture pipeline.
    try {
      await page.screenshot({ path: path.join(out, 'venue-edit-1280.png'), fullPage: true, timeout: 30000 });
    } catch (error) {
      if (!String(error?.message || error).includes("Timeout")) throw error;
      // Some Chromium runs stall while capturing this long form. Preserve
      // any first artifact and retry the same unmodified screen once; the
      // functional guards below are still mandatory and failures propagate.
      console.warn('Venue edit capture timed out; retrying the same screen once.');
      await page.screenshot({ path: path.join(out, 'venue-edit-1280-retry.png'), fullPage: true, timeout: 60000 });
    }
    const warning = page.waitForEvent('dialog').then(async dialog => { const message = dialog.message(); await dialog.dismiss(); return message; });
    await page.locator('.desktop-side-nav').getByRole('link', { name: '참가자 명단', exact: true }).click({ noWaitAfter: true });
    assert.match(await warning, /저장하지 않은 장소 안내/);
    assert.equal(await alt.inputValue(), '동문에서 접수대를 지나 행사장으로 이동');
    stage = 'lost upload response';
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '업로드 결과가 확인되지 않았습니다' }).first().waitFor();
    assert.equal(await file.isDisabled(), true);
    assert.equal(attempts.length, 1);
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await page.getByText('장소 안내 초안을 저장했습니다. 게시 검토 후 참가자 화면에 반영할 수 있습니다.', { exact: true }).first().waitFor();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1], 'retry uses the original upload id');
    const rows = await fixture.harness.database.query('SELECT id FROM stored_files WHERE event_id=$1 AND original_name=$2', [fixture.eventId, 'venue.png']);
    assert.equal(rows.rowCount, 1, 'lost response and retry store one file');
    const stored = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(stored.venue.draft.map.image.fileId, rows.rows[0].id);
    assert.equal(stored.venue.draft.map.alt, '동문에서 접수대를 지나 행사장으로 이동');
    stage = 'concurrent map change';
    await page.locator('#content-venue-name').fill('변경한 합성 장소');
    const updatedAlt = '다른 운영자가 수정한 동선';
    const concurrent = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      cookie: fixture.manager.cookie, method: 'POST', body: {
        commandId: `venue-concurrent-${randomUUID()}`, command: 'venue.save',
        payload: { ...stored.venue.draft, mode: "draft", expectedVersion: stored.venue.version, map: { image: { fileId: rows.rows[0].id }, alt: updatedAlt },
          expectedMap: { fileId: rows.rows[0].id, alt: stored.venue.draft.map.alt } },
      },
    });
    assert.equal(concurrent.status, 200);
    const textOnlySave = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/commands') && request.postDataJSON()?.command === 'venue.save');
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    const textOnlyBody = (await textOnlySave).postDataJSON();
    assert.equal(Object.hasOwn(textOnlyBody.payload, 'map'), false, 'an unrelated text edit does not overwrite a newer map');
    await page.waitForFunction(expected => document.querySelector('#content-venue-map-alt')?.value === expected, updatedAlt);
    const refreshed = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(refreshed.venue.draft.map.alt, updatedAlt);
    // Conflicting map edits are kept until the operator explicitly chooses
    // the newer map; unrelated text must survive that recovery.
    await page.locator('#content-venue-name').fill('보존할 장소 문구');
    await page.getByLabel('안내도 설명').fill('내가 작성한 동선');
    const finalAlt = '다른 운영자의 최신 동선';
    const conflictSource = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      cookie: fixture.manager.cookie, method: 'POST', body: {
        commandId: `venue-concurrent-${randomUUID()}`, command: 'venue.save',
        payload: { ...refreshed.venue.draft, mode: "draft", expectedVersion: refreshed.venue.version, map: { image: { fileId: rows.rows[0].id }, alt: finalAlt },
          expectedMap: { fileId: rows.rows[0].id, alt: updatedAlt } },
      },
    });
    assert.equal(conflictSource.status, 200);
    const conflictResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/commands') && response.status() === 409);
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await conflictResponse;
    await page.getByRole('button', { name: '최신 안내도 불러오기' }).waitFor();
    assert.equal(await page.getByLabel('안내도 설명').inputValue(), '내가 작성한 동선');
    await page.getByRole('button', { name: '최신 안내도 불러오기' }).click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '최신 안내도 불러오기' }).click();
    await page.waitForFunction(expected => document.querySelector('#content-venue-map-alt')?.value === expected, finalAlt);
    assert.equal(await page.locator('#content-venue-name').inputValue(), '보존할 장소 문구');
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await page.getByText('장소 안내 초안을 저장했습니다. 게시 검토 후 참가자 화면에 반영할 수 있습니다.', { exact: true }).first().waitFor();
    stage = 'public presentation';
    const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const attendee = await publicContext.newPage();
    await attendee.goto(`${fixture.baseUrl}/event/${fixture.slug}`, { waitUntil: 'networkidle' });
    assert.equal(await attendee.getByRole('img', { name: finalAlt }).count(), 0, 'draft map is not published');
    assert.equal((await attendee.request.get(`${fixture.baseUrl}/api/public/events/${fixture.slug}/files/${rows.rows[0].id}`)).status(), 404);
    await page.getByRole('button', { name: '게시 검토', exact: true }).click();
    await page.getByRole('dialog', { name: '장소 안내 게시 검토', exact: true }).getByRole('button', { name: '게시하기', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await attendee.reload({ waitUntil: 'domcontentloaded' });
    const image = attendee.getByRole('img', { name: finalAlt });
    await image.waitFor();
    await attendee.waitForFunction(alt => [...document.images].some(item => item.alt === alt && item.complete && item.naturalWidth > 0), finalAlt);
    assert.equal(await image.evaluate(el => el.complete && el.naturalWidth > 0), true);
    // 2026-11-23: the guide map is below the facts, so it loads lazily and decodes off the main thread.
    assert.equal(await image.evaluate(el => `${el.loading},${el.decoding}`), 'lazy,async');
    assert.equal(await attendee.getByRole('link', { name: '안내도 크게 보기 (새 탭)' }).getAttribute('target'), '_blank');
    for (const width of [320, 390]) {
      await attendee.setViewportSize({ width, height: 844 });
      await image.scrollIntoViewIfNeeded();
      await attendee.screenshot({ path: path.join(out, `venue-public-${width}.png`), fullPage: true });
      assert.equal(await attendee.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }
    stage = 'remove map';
    await page.getByRole('button', { name: '안내도 제거' }).click();
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await page.getByText('장소 안내 초안을 저장했습니다. 게시 검토 후 참가자 화면에 반영할 수 있습니다.', { exact: true }).first().waitFor();
    await attendee.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await attendee.getByRole('img', { name: finalAlt }).count(), 1, 'draft removal keeps the live map');
    assert.equal((await attendee.request.get(`${fixture.baseUrl}/api/public/events/${fixture.slug}/files/${rows.rows[0].id}`)).status(), 200);
    await page.getByRole('button', { name: '게시 검토', exact: true }).click();
    await page.getByRole('dialog', { name: '장소 안내 게시 검토', exact: true }).getByRole('button', { name: '게시하기', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await attendee.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await attendee.getByRole('img', { name: finalAlt }).count(), 0);
    assert.equal((await attendee.request.get(`${fixture.baseUrl}/api/public/events/${fixture.slug}/files/${rows.rows[0].id}`)).status(), 404);
    await publicContext.close();
    await context.close();
    process.stdout.write('Venue map: size, description, draft guard, idempotent upload, public image, removal and mobile layout passed\n');
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
