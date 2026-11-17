'use strict';
// Synthetic browser streams exercise the real staff screen and API, not a physical camera.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk } = require('./audit-staff-direction.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'camera-fallback');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    await context.addInitScript(() => {
      window.__cameraMode = 'pending';
      window.__cameraCalls = 0;
      window.__streams = [];
      window.__resolveCamera = null;
      window.__makeStream = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 120;
        canvas.getContext('2d').fillRect(0, 0, 160, 120);
        const stream = canvas.captureStream(8);
        window.__streams.push({ canvas, stream });
        return stream;
      };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => {
        window.__cameraCalls++;
        if (window.__cameraMode === 'pending') return new Promise(resolve => { window.__resolveCamera = resolve; });
        if (window.__cameraMode === 'denied') return Promise.reject(new DOMException('denied', 'NotAllowedError'));
        return Promise.resolve(window.__makeStream());
      } });
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`, { waitUntil: 'networkidle' });
    await confirmInitialStaffDesk(page, { hold: false }); // this audit watches a result hand itself back
    const open = page.getByRole('button', { name: '카메라 켜기', exact: true });
    const camera = page.getByRole('region', { name: '카메라 스캔', exact: true });
    const turnOff = () => page.evaluate(() => {
      document.querySelector('details')?.setAttribute('open', '');
      [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '카메라 끄기')?.click();
    });
    await open.click();
    await page.waitForFunction(() => window.__cameraCalls === 1);
    await camera.getByRole('status').filter({ hasText: '권한 요청' }).waitFor();
    for (const [width, height] of [[390, 844], [320, 568], [1280, 844]]) {
      await page.setViewportSize({ width, height });
      const box = await camera.locator('video').boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= height + 1, `camera preview visible at ${width}x${height}`);
      const manual = await page.getByRole('button', { name: '명단 찾기', exact: true }).boundingBox();
      assert.ok(manual && manual.width >= 44 && manual.height >= 44, 'the name search stays a usable touch target while the permission is pending');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.evaluate(axe);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 1280) await page.screenshot({ path: path.join(out, `pending-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await camera.getByRole('status').filter({ hasText: '카메라 시작이 늦어지고 있습니다' }).waitFor();
    assert.match(await camera.getByRole('status').innerText(), /참가자 명단/);
    await page.getByRole('button', { name: '명단 찾기', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'staff-manual-search');
    assert.equal(await page.locator('#staff-manual-search').isVisible(), true);
    await page.evaluate(() => window.__resolveCamera(window.__makeStream()));
    assert.equal(fixture.gateway.commands.filter(call => call.command === 'check.scan').length, 0);
    const workspace = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const person = workspace.participants.find(row => row.name.startsWith('감사 참가자') && row.company && row.status === 'APPROVED');
    assert.ok(person, 'synthetic approved participant exists');
    await page.locator('#staff-manual-search').fill(person.name);
    await page.getByRole('button', { name: `${person.name} ${person.company} 선택`, exact: true }).click();
    await page.getByLabel('이름·소속을 직접 확인했습니다').check();
    const [response] = await Promise.all([
      page.waitForResponse(res => res.request().method() === 'POST' && res.request().postDataJSON()?.command === 'check.scan'),
      page.getByRole('button', { name: '확인한 참가자 입장 처리' }).click(),
    ]);
    assert.equal(response.status(), 200);
    await page.getByText('입장 처리됨').waitFor();
    const after = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(after.checks.filter(row => row.participantId === person.id).length, 1);
    // The camera stays open behind the result and the screen hands itself back without a tap.
    await page.getByText('입장 처리됨').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('video').count(), 1, 'the camera is still open for the next person');
    assert.equal(await page.evaluate(() => window.__cameraCalls), 1, 'no second camera request was needed');
    await turnOff();
    await page.waitForFunction(() => window.__streams[0].stream.getVideoTracks()[0].readyState === 'ended');
    await page.evaluate(() => { window.__cameraMode = 'denied'; });
    await open.click();
    await camera.getByRole('alert').filter({ hasText: '카메라 권한이 없습니다' }).waitFor();
    await page.screenshot({ path: path.join(out, 'denied-390.png') });
    await camera.getByRole('button', { name: '명단에서 참가자 찾기' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'staff-manual-search');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ pendingAndSlow: true, nameSearchWhilePending: true, permissionDeniedFallback: true, manualCheckin: true, checkRecords: 1, cameraStaysOpen: true, syntheticMedia: true, physicalCamera: false }, null, 2), { mode: 0o600 });
    console.log('Camera fallback: pending, delayed permission, name search, manual check-in, denied access and the open camera passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
