'use strict';
// A synthetic canvas stream tests browser state transitions, not physical cameras.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk } = require('./audit-staff-direction.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let stage = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'camera-before' : 'camera-recovery');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    await context.addInitScript(({ before }) => {
      window.__cameraMode = before ? 'NotFoundError' : 'NotAllowedError';
      window.__cameraStreams = [];
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        if (window.__cameraMode !== 'ok') throw new DOMException('synthetic camera failure', window.__cameraMode);
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
        const drawing = canvas.getContext('2d'); drawing.fillStyle = '#88aacc'; drawing.fillRect(0, 0, 160, 120);
        const stream = canvas.captureStream(8); window.__cameraStreams.push({ canvas, stream }); return stream;
      } });
    }, { before });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`, { waitUntil: 'networkidle' });
    await page.locator('#staff-desk').waitFor();
    await confirmInitialStaffDesk(page);
    await page.getByRole('button', { name: '카메라로 스캔', exact: true }).click();
    const camera = page.getByRole('region', { name: '카메라 스캔', exact: true });
    await camera.getByRole('alert').waitFor();
    await page.screenshot({ path: path.join(out, 'camera-390.png'), fullPage: true });
    if (before) { console.log('Camera before capture passed'); return; }
    stage = 'permission and hardware errors';
    assert.match(await camera.getByRole('alert').innerText(), /카메라 권한이 없습니다.*참가자 명단에서 확인하거나.*현장 책임자/s);
    await page.evaluate(() => { window.__cameraMode = 'NotFoundError'; });
    await camera.getByRole('button', { name: '다시 시도', exact: true }).click();
    await camera.getByRole('alert').filter({ hasText: '카메라를 찾지 못했습니다' }).waitFor();
    await page.screenshot({ path: path.join(out, 'camera-missing-390.png'), fullPage: true });
    await page.evaluate(() => { window.__cameraMode = 'NotReadableError'; });
    await camera.getByRole('button', { name: '다시 시도', exact: true }).click();
    await camera.getByRole('alert').filter({ hasText: '다른 앱이 사용 중인지' }).waitFor();
    assert.equal(await page.locator('#staff-ticket').isVisible(), true, 'manual entry remains available');
    stage = 'stream interruption and resume';
    await page.evaluate(() => { window.__cameraMode = 'ok'; });
    await camera.getByRole('button', { name: '다시 시도', exact: true }).click();
    await page.waitForFunction(() => window.__cameraStreams.length === 1 && document.querySelector('video')?.readyState >= 2);
    assert.equal(await camera.evaluate(el => document.activeElement === el), true, 'retry keeps focus on the scanner');
    await page.evaluate(() => window.__cameraStreams[0].stream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
    await camera.getByRole('alert').filter({ hasText: '카메라 연결이 중단됐습니다' }).waitFor();
    assert.equal(await page.evaluate(() => window.__cameraStreams[0].stream.getVideoTracks()[0].readyState), 'ended');
    await camera.getByRole('button', { name: '다시 시도', exact: true }).click();
    await page.waitForFunction(() => window.__cameraStreams.length === 2 && document.querySelector('video')?.readyState >= 2);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await camera.getByRole('status').filter({ hasText: '화면이 가려져 카메라를 멈췄습니다' }).waitFor();
    assert.equal(await page.evaluate(() => window.__cameraStreams[1].stream.getVideoTracks()[0].readyState), 'ended');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await camera.getByRole('button', { name: '다시 시도', exact: true }).click();
    await page.waitForFunction(() => window.__cameraStreams.length === 3 && document.querySelector('video')?.readyState >= 2);
    await camera.getByRole('button', { name: '닫기', exact: true }).click();
    await camera.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__cameraStreams[2].stream.getVideoTracks()[0].readyState), 'ended');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); });
    await page.getByRole('button', { name: '카메라로 스캔', exact: true }).click();
    await camera.getByRole('status').filter({ hasText: '화면이 가려져 카메라를 멈췄습니다' }).waitFor();
    assert.equal(await page.evaluate(() => window.__cameraStreams.length), 3, 'a scanner opened in a hidden tab never opens a camera');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
    await camera.getByRole('button', { name: '다시 시도', exact: true }).click();
    await page.waitForFunction(() => window.__cameraStreams.length === 4 && document.querySelector('video')?.readyState >= 2);
    await camera.getByRole('button', { name: '닫기', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__cameraStreams[3].stream.getVideoTracks()[0].readyState), 'ended');
    assert.equal(await page.locator('#staff-ticket').isVisible(), true);
    assert.equal(fixture.gateway.commands.filter(call => ['check.scan', 'booth.visit'].includes(call.command)).length, 0, 'camera recovery submits no scan');
    assert.deepEqual(errors, []);
    await page.evaluate(axeSource);
    const issues = await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id));
    assert.deepEqual(issues, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', syntheticMedia: true, noPhysicalCamera: true, trackCleanup: true, manualEntryPreserved: true, noScanSubmitted: true }, null, 2), { mode: 0o600 });
    console.log('Camera: permission, missing/busy device, interruption, pause, retry and cleanup passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); await fixture.close(); }
}
main().catch(error => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
