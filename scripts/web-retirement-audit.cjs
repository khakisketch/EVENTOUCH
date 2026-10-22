'use strict';

// Install a simulated previously cached shell worker in a real Chromium
// profile, then replace it with the actual retirement worker served by Next.
// No API response is fabricated; the API uses an isolated PostgreSQL schema.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
process.env.TMPDIR = '/tmp/opencode';
const { chromium } = require('playwright');
const { startApiHarness, insertAccount } = require('../tests/helpers/postgres-api-server.cjs');
const { startWebApiGateway } = require('../tests/helpers/web-api-gateway.cjs');

const directory = '/tmp/opencode/eventouch-captures/retirement-real';
const fixtureWorker = `
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open('eventouch-shell-retirement-fixture');
  await cache.put('/', new Response('<!doctype html><html lang="ko"><body><h1>은퇴 셸 검증</h1></body></html>', {headers:{'Content-Type':'text/html;charset=utf-8'}}));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(caches.open('eventouch-shell-retirement-fixture').then(cache => cache.match('/')));
});`;

async function main() {
  fs.mkdirSync(directory, { recursive: true });
  let api, gateway, proxy, browser, page;
  let oldMode = true;
  try {
    api = await startApiHarness();
    const email = `retirement-${crypto.randomUUID()}@example.test`;
    gateway = await startWebApiGateway({ apiBase: api.baseUrl, webBase: process.env.WEB_BASE || 'http://127.0.0.1:8777' });
    proxy = http.createServer((request, response) => {
      if (oldMode && request.url === '/sw.js') {
        response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store', 'service-worker-allowed': '/' });
        response.end(fixtureWorker); return;
      }
      if (oldMode && request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><html lang="ko"><body><h1>은퇴 셸 검증</h1></body></html>'); return;
      }
      const upstream = http.request(new URL(request.url, gateway.baseUrl), { method: request.method, headers: request.headers }, (reply) => {
        response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
      });
      upstream.on('error', () => { response.writeHead(502); response.end('upstream unavailable'); });
      request.pipe(upstream);
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${proxy.address().port}`;
    browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      localStorage.setItem('retirement-user-value', 'keep-local');
      sessionStorage.setItem('retirement-tab-value', 'keep-tab');
      document.cookie = 'retirement_user_cookie=keep-cookie; SameSite=Lax; Path=/';
      await caches.open('unrelated-cache-keep');
      await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '은퇴 셸 검증', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
    oldMode = false;
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration('/'); await registration.update(); }).catch((error) => {
      if (!error.message.includes('Execution context was destroyed')) throw error;
    });
    await page.waitForFunction(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const keys = await caches.keys();
      return registrations.length === 0 && !keys.some((key) => key.startsWith('eventouch-shell-'));
    }, null, { timeout: 20000 });
    // Worker activation should navigate already-controlled product documents.
    await page.getByRole('link', { name: /로그인/ }).first().waitFor({ timeout: 20000 });
    const retained = await page.evaluate(async () => ({
      local: localStorage.getItem('retirement-user-value'),
      tab: sessionStorage.getItem('retirement-tab-value'),
      cookie: document.cookie.includes('retirement_user_cookie=keep-cookie'),
      unrelatedCache: (await caches.keys()).includes('unrelated-cache-keep'),
    }));
    assert.deepEqual(retained, { local: 'keep-local', tab: 'keep-tab', cookie: true, unrelatedCache: true });
    const documentResponse = await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    const headers = documentResponse.headers();
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-frame-options']?.toUpperCase(), 'SAMEORIGIN');
    assert.ok(headers['referrer-policy']);
    const csp = headers['content-security-policy'];
    assert.ok(csp, 'the sole product HTML must retain an explicit production CSP');
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce, 'Next HTML needs a request-bound script nonce');
    const scriptPolicy = csp.match(/(?:^|;)\s*script-src\s+([^;]+)/)?.[1] || '';
    assert.equal(scriptPolicy.includes("'unsafe-inline'"), false);
    assert.equal(scriptPolicy.includes("'unsafe-eval'"), false);
    const scriptNonces = await page.locator('script:not([src])').evaluateAll((scripts) => scripts.filter((script) => !script.type || script.type === 'text/javascript').map((script) => script.nonce));
    assert.ok(scriptNonces.length > 0); assert.ok(scriptNonces.every((value) => value === nonce));
    const nextRequest = await page.request.get(`${base}/login`);
    assert.notEqual(nextRequest.headers()['content-security-policy'].match(/'nonce-([^']+)'/)?.[1], nonce, 'HTML requests must not reuse a build-time nonce');
    await page.getByRole('alert').filter({ hasText: '운영자 계정이 아직 설정되지 않았습니다.' }).waitFor();
    assert.equal(await page.locator('#login-password').count(), 0, 'an unconfigured install must explain setup before collecting credentials');
    await page.screenshot({ path: `${directory}/unconfigured-new-app.png`, fullPage: true });
    await insertAccount(api.database, { id: 'retirement-manager', role: 'AGENCY', name: '새 앱 검증 운영자', email });
    await page.getByRole('button', { name: '설정 상태 다시 확인', exact: true }).click();
    await page.fill('#login-email', email); await page.fill('#login-password', 'not-a-real-test-password');
    await page.getByRole('button', { name: /로그인/ }).click();
    await page.waitForURL(/\/console(?:\/|$)/, { timeout: 15000 });
    await page.screenshot({ path: `${directory}/new-console-after-worker-retirement.png`, fullPage: true });
    assert.deepEqual(errors, []);
    const result = { outcome: 'passed', installedSimulatedLegacyWorker: true, actualRetirementWorkerFromNewApp: true, oldCacheRemoved: true, workerUnregistered: true, controlledPageRefreshedIntoNext: true, userStorageAndCookieRetained: true, unrelatedCacheRetained: true, productionCspAndNonces: true, unconfiguredInstallExplainedBeforeCredentials: true, configuredInstallRecoveredWithoutReload: true, realApiLoginHydrated: true, apiResponsesMocked: false, pageErrors: 0 };
    fs.writeFileSync(`${directory}/verification.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) {
    if (page) await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
    if (gateway) await gateway.close(); if (api) await api.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
