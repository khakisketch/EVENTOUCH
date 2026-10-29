'use strict';

// Real production boundaries, with faults injected ONLY into this fixture's
// browser responses. No test route, product flag, server edit, or user data.
process.env.EVENTOUCH_SMS_MOCK = '1';
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const baseline = process.env.ERROR_RECOVERY_PHASE === 'baseline';
const captureRoot = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`system-improvement-20261024/ux-${runStamp()}`);
const runId = process.env.EVENTOUCH_AUDIT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(captureRoot, 'errors', `${baseline ? 'baseline' : 'verified'}-${runId}`);
const SECRET = 'fixture-private-error-do-not-display';
const PRIVATE_DIGEST = '01012345678'; // Synthetic numeric contact-like client digest, not a trusted server reference.
const PRIVATE_GLOBAL_DIGEST = 'fixture-private-digest-do-not-display';

function chunkWith(marker) {
  const dir = 'apps/web/.next/static/chunks';
  const matches = fs.readdirSync(dir).filter((name) => name.endsWith('.js')).filter((name) => fs.readFileSync(path.join(dir, name), 'utf8').includes(marker));
  assert.equal(matches.length, 1, `one precise built client module for ${marker}`);
  return matches[0];
}

(async () => {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const cameraChunk = chunkWith('화면이 가려져 카메라를 멈췄습니다');
  const skipChunk = chunkWith('본문으로 건너뛰기');
  const fixture = await startAuditFixture();
  const results = [], expectedBrowserErrors = [], unexpectedBrowserErrors = [], writes = [];
  let browser, finished = false;
  const check = (name, ok, detail = null) => {
    results.push({ name, ok: Boolean(ok), detail });
    if (!baseline) assert.ok(ok, `${name}: ${JSON.stringify(detail)}`);
  };
  const observe = (page) => {
    page.on('pageerror', (error) => {
      const expected = error.message.includes(SECRET) || /chunkloaderror|failed to load chunk|loading chunk .+ failed|failed to fetch dynamically imported module|importing a module script failed/i.test(error.message);
      (expected ? expectedBrowserErrors : unexpectedBrowserErrors).push(error.message);
    });
    page.on('request', (request) => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
  };
  const cookie = { name: 'etko_session', value: decodeURIComponent(fixture.staff.cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' };
  const staffUrl = `${fixture.baseUrl}/staff/events/${fixture.eventId}`;
  try {
    browser = await launchBrowser();
    // Client render exception inside a lazy child, caught by app/error.tsx.
    const runtime = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await runtime.addCookies([cookie]);
    const runtimePage = await runtime.newPage();
    observe(runtimePage);
    let injectedRender = 0;
    await runtimePage.route(`**/_next/static/chunks/${cameraChunk}`, async (route) => {
      const original = await route.fetch();
      const source = await original.text();
      const anchor = /function\(\{onDetected:[^}]+\}\)\{/;
      assert.ok(anchor.test(source), 'fixture locates the built camera component function');
      const body = source.replace(anchor, `$&if(window.__fixtureRuntimeFault!==false){const fault=new Error(${JSON.stringify(SECRET)});fault.digest=${JSON.stringify(PRIVATE_DIGEST)};throw fault;}`);
      injectedRender += 1;
      await route.fulfill({ response: original, body });
    });
    await runtimePage.goto(staffUrl);
    await runtimePage.locator('#staff-desk').waitFor();
    await runtimePage.getByRole('button', { name: '카메라로 스캔', exact: true }).click();
    await runtimePage.getByRole('heading', { name: '화면을 불러오다 문제가 생겼습니다', exact: true }).waitFor();
    check('render exception reaches Korean route boundary', injectedRender === 1);
    check('render boundary exposes neither private message nor arbitrary digest', !(await runtimePage.locator('body').innerText()).includes(SECRET) && !(await runtimePage.locator('body').innerText()).includes(PRIVATE_DIGEST));
    await runtimePage.screenshot({ path: `${OUT}/route-render-error-1280.png`, fullPage: true });
    await runtimePage.evaluate(() => { window.__fixtureRuntimeFault = false; });
    await runtimePage.getByRole('button', { name: '다시 시도', exact: true }).click();
    await runtimePage.locator('#staff-desk').waitFor();
    check('route retry restores real assigned staff workflow', await runtimePage.locator('#staff-desk').isEnabled());
    await runtime.close();

    // Failed dynamic chunk, not an API error. User-triggered full navigation
    // must clear the rejected module import without an automatic reload loop.
    const chunk = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await chunk.addCookies([cookie]);
    const chunkPage = await chunk.newPage();
    observe(chunkPage);
    let healthyChunk = false, chunkFailures = 0, recoveredChunks = 0, documents = 0;
    chunkPage.on('request', (request) => { if (request.isNavigationRequest() && request.frame() === chunkPage.mainFrame()) documents += 1; });
    await chunkPage.route(`**/_next/static/chunks/${cameraChunk}`, async (route) => {
      if (!healthyChunk) {
        chunkFailures += 1;
        await route.fulfill({ status: 503, contentType: 'text/javascript', body: '/* fixture-only chunk outage */' });
      } else { recoveredChunks += 1; await route.continue(); }
    });
    await chunkPage.goto(staffUrl);
    await chunkPage.locator('#staff-desk').waitFor();
    await chunkPage.getByRole('button', { name: '카메라로 스캔', exact: true }).click();
    await chunkPage.getByRole('heading', { name: /화면.*불러오/ }).waitFor();
    const navigationCount = documents;
    // Deliberate observation window, not a readiness sleep: prove the
    // delivered fallback initiates no idle document reloads or retry loop.
    await chunkPage.waitForTimeout(800);
    check('failed chunk causes no automatic document reload loop', documents === navigationCount, { documents, chunkFailures });
    await chunkPage.screenshot({ path: `${OUT}/chunk-error-390.png`, fullPage: true });
    const reload = chunkPage.getByRole('button', { name: '화면 새로 불러오기', exact: true });
    check('failed chunk offers explicit same-context reload', await reload.count() === 1);
    if (await reload.count()) {
      healthyChunk = true;
      await reload.click();
      await chunkPage.locator('#staff-desk').waitFor();
      await chunkPage.getByRole('button', { name: '카메라로 스캔', exact: true }).click();
      await chunkPage.getByRole('region', { name: '카메라 스캔', exact: true }).waitFor();
      check('explicit reload clears rejected chunk and preserves staff route', chunkPage.url() === staffUrl && recoveredChunks > 0);
    }
    await chunk.close();

    // SkipLink is a real Client Component ABOVE app/error in the root layout.
    // A render fault there must reach global-error without router context.
    const global = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const globalPage = await global.newPage();
    observe(globalPage);
    let healthyRoot = false, rootInjections = 0;
    await globalPage.route(`**/_next/static/chunks/${skipChunk}`, async (route) => {
      if (healthyRoot) return route.continue();
      const original = await route.fetch();
      const source = await original.text();
      const anchor = 'className:"skip-link",href:"#main-content"';
      assert.ok(source.includes(anchor), 'fixture locates root-layout SkipLink rendering');
      rootInjections += 1;
      await route.fulfill({ response: original, body: source.replace(anchor, `className:(()=>{const fault=new Error(${JSON.stringify(SECRET)});fault.digest=${JSON.stringify(PRIVATE_GLOBAL_DIGEST)};throw fault;})(),href:"#main-content"`) });
    });
    await globalPage.goto(fixture.baseUrl + '/login');
    await globalPage.getByRole('heading', { name: /화면.*불러오/ }).waitFor();
    check('root-layout exception reaches standalone global document', rootInjections > 0 && await globalPage.locator('body').getAttribute('class') !== 'app-body');
    const globalText = await globalPage.locator('body').innerText();
    check('global fallback exposes no private message or arbitrary digest', !globalText.includes(SECRET) && !globalText.includes(PRIVATE_GLOBAL_DIGEST));
    check('global fallback uses native start link without router permission promise', await globalPage.getByRole('link', { name: '처음으로', exact: true }).getAttribute('href') === '/');
    await globalPage.screenshot({ path: `${OUT}/global-render-error-390.png`, fullPage: true });
    const globalReload = globalPage.getByRole('button', { name: '화면 새로 불러오기', exact: true });
    check('global fallback has a recovery independent of router context', await globalReload.count() === 1);
    if (await globalReload.count()) {
      healthyRoot = true;
      await globalReload.click();
      await globalPage.getByLabel('이메일', { exact: true }).waitFor();
      check('global native reload restores actual login form', await globalPage.getByRole('button', { name: '로그인', exact: true }).isEnabled());
    }
    await global.close();
    check('fault recovery sends no writes or replays commands', writes.length === 0, writes);
    check('only injected faults cause browser page errors', unexpectedBrowserErrors.length === 0, unexpectedBrowserErrors);
    finished = true;
  } finally {
    if (!finished && browser) {
      for (const [contextIndex, context] of browser.contexts().entries()) {
        for (const [pageIndex, page] of context.pages().entries()) {
          await page.screenshot({ path: `${OUT}/failure-context-${contextIndex}-page-${pageIndex}.png`, fullPage: false }).catch((error) => console.error('Failure capture unavailable:', error.message));
        }
      }
    }
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8'), phase: baseline ? 'baseline' : 'verified', results, expectedBrowserErrors, unexpectedBrowserErrors, writes, simulation: 'Browser-response-only mutation of real camera/SkipLink chunks; one HTTP503 lazy chunk outage; actual isolated Next/API/task PG. No production fault switch.' }, null, 2), { mode: 0o600 });
    console.log(`Error recovery evidence: ${OUT}`);
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
