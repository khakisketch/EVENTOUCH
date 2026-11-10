'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'ticket-loading-recovery'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser, page;
  try {
    const ws = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const person = ws.participants.find(item => item.status === 'APPROVED' && item.ticket); assert.ok(person);
    const ticketUrl = `${f.baseUrl}/event/${f.slug}/ticket?ticket=${encodeURIComponent(person.ticket)}`;
    const qr = target => target.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ });
    browser = await launchBrowser();
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' }); page = await c.newPage();
    // Real server-rendered HTML, but the browser cannot load the scripts.
    let blockScripts = true;
    const scriptFailure = route => blockScripts && route.request().resourceType() === 'script' ? route.abort('failed') : route.continue();
    await page.route('**/_next/static/**', scriptFailure); await page.goto(ticketUrl, { waitUntil: 'domcontentloaded' });
    await page.getByText('티켓을 확인하고 있습니다.').waitFor(); const retry = page.getByRole('link', { name: '다시 불러오기', exact: true });
    assert.equal(await retry.getAttribute('href'), '', 'the fallback does not copy the bearer into a link');
    await page.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      if (width === 390) await page.screenshot({ path: path.join(out, 'script-unavailable-390.png'), fullPage: true });
    }
    await retry.focus(); assert.equal(await page.evaluate(() => document.activeElement?.textContent), '다시 불러오기');
    blockScripts = false;
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.keyboard.press('Enter')]);
    await qr(page).waitFor(); assert.equal(await page.getByRole('heading', { name: person.name, exact: true }).count(), 1);
    assert.equal(new URL(page.url()).searchParams.has('ticket'), false);
    await page.unroute('**/_next/static/**', scriptFailure); await c.close();
    // When hydration is active and tab storage is unavailable, retry must
    // stay in the document and use the already-held bearer for the same person.
    const blocked = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await blocked.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Unavailable', 'SecurityError'); } }); });
    const p = await blocked.newPage(); page = p;
    let calls = 0, releaseFirst, started;
    const firstStarted = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { releaseFirst = resolve; });
    const auth = [];
    await p.route('**/api/public/events/*/ticket', async route => {
      calls += 1; auth.push(route.request().headers().authorization || '');
      if (calls === 1) { started(); await held; return route.abort('failed').catch(() => {}); }
      return route.continue();
    });
    await p.goto(ticketUrl, { waitUntil: 'domcontentloaded' }); await firstStarted;
    await p.waitForFunction(() => !new URL(location.href).searchParams.has('ticket'));
    const retryInTab = p.getByRole('link', { name: '다시 불러오기', exact: true });
    await retryInTab.click(); await qr(p).waitFor(); releaseFirst();
    assert.equal(calls, 2); assert.equal(auth[0], `Bearer ${person.ticket}`); assert.equal(auth[1], auth[0]);
    assert.equal(await p.getByRole('heading', { name: person.name, exact: true }).count(), 1);
    assert.equal(new URL(p.url()).searchParams.has('ticket'), false);
    await blocked.close();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, blockedScriptNativeReload: true, keyboard: true, memoryOnlyRetry: true, samePerson: true, widths: [320, 390, 1280], physicalDevices: false }, null, 2), { mode: 0o600 });
    console.log('PASS: unhydrated native reload and in-tab retry preserve the synthetic ticket');
  } catch (error) { if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
