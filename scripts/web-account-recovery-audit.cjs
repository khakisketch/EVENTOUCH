'use strict';

// Verified-email account recovery ("이메일+수동 예외") browser regression.
//
// Real isolated PostgreSQL/API + the built Next app + real Chromium through
// the same-origin test gateway — never a mocked API. Outbound mail is
// mock-only: no provider is selected here, no credentials are held, and no
// real delivery is claimed. SOLAPI keys are deleted on entry so a ambient
// environment can never turn a fixture send into a real one.
//
// Covers, rendered: login self-service pointer; /recover request generic
// shape + same-tab fragment entry + confirm + replay + token stripping;
// /account/email unauth prompt, unverified request/confirm lifecycle incl.
// the mock-mode note, verified panel, console operator-menu entry; honest
// no-provider (real unconfigured fixture) and unavailable/malformed/5xx
// panels with retries; staff draft/busy/unknown-verdict guards and allowed
// navigation; 390/1280 renders, keyboard order, axe, overflow, 44px targets.
//
// Every response-loss/token-replay path is disclosed; tokens travel in URL
// fragments stripped client-side and never reach the server. Fixture data is
// synthetic; no PII or raw tokens are logged or written to verification.json.

for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID', 'SOLAPI_API_HOST']) delete process.env[key];
process.env.EVENTOUCH_MAIL_MOCK = '1';
// Link-shape placeholder only: recovery links need an absolute base to be
// built, but this audit asserts path contracts (#t= fragments) and never
// fetches the placeholder origin. Real deployments set EVENTOUCH_PUBLIC_URL.
if (!process.env.EVENTOUCH_PUBLIC_URL) process.env.EVENTOUCH_PUBLIC_URL = 'http://127.0.0.1:1';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { mockOutbox, clearMockOutbox } = require('../server/email-transport');

const OUT = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'account-recovery')
  : defaultCaptureDir(`account-recovery-${runStamp()}`);
const AXE_SCRIPT = path.join(__dirname, '..', 'node_modules', 'axe-core', 'axe.min.js');

function tokenOf(link) {
  const hash = new URL(link).hash;
  const match = /^#t=([A-Za-z0-9_-]{32,})$/.exec(hash);
  assert.ok(match, 'recovery link carries a fragment bearer');
  return match[1];
}

async function axeSeriousOrCritical(page) {
  await page.addScriptTag({ path: AXE_SCRIPT });
  const violations = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const result = await axe.run(document, { resultTypes: ['violations'] });
    return result.violations
      .filter((item) => item.impact === 'serious' || item.impact === 'critical')
      .map((item) => item.id);
  });
  return violations;
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// Read actual painted character positions: normal Korean words should not
// split at a syllable boundary, while long unbroken tokens may still wrap.
async function splitKoreanWords(locator) {
  return locator.evaluate((node) => {
    const range = document.createRange(), chars = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      for (let i = 0; i < text.data.length; i++) {
        range.setStart(text, i); range.setEnd(text, i + 1);
        const rect = range.getClientRects()[0];
        chars.push({ char: text.data[i], top: rect ? Math.round(rect.top) : null });
      }
    }
    return chars.flatMap((char, index) => {
      const previous = chars[index - 1];
      return previous && char.top !== null && previous.top !== null && char.top !== previous.top && /[가-힣]/.test(previous.char) && /[가-힣]/.test(char.char)
        ? [`${previous.char}/${char.char}`] : [];
    });
  });
}

async function runAccountRecoveryAudit() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const checks = [];
  const errors = [];
  const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); assert.ok(ok, name); };
  const fixtures = [];
  let browser;
  let completed = false;
  try {
    const fixture = await startAuditFixture();
    fixtures.push(fixture);
    const base = fixture.baseUrl;
    const { insertAccount, LEGACY_ORG } = fixture.helpers;
    await insertAccount(fixture.harness.database, { orgId: LEGACY_ORG, id: 'ar-owner', role: 'AGENCY', name: '복구검증 소유자', email: 'ar-owner@example.test' });
    await insertAccount(fixture.harness.database, { orgId: LEGACY_ORG, id: 'ar-member', role: 'MANAGER', name: '복구검증 구성원', email: 'ar-member@example.test' });
    await insertAccount(fixture.harness.database, { orgId: LEGACY_ORG, id: 'ar-loss', role: 'MANAGER', name: '응답유실 검증', email: 'ar-loss@example.test' });
    await insertAccount(fixture.harness.database, { orgId: LEGACY_ORG, id: 'ar-verify-loss', role: 'MANAGER', name: '인증응답 검증', email: 'ar-verify-loss@example.test' });
    // Owner starts verified (DB fixture mirrors a completed proof; the live
    // request/confirm lifecycle is driven below for the member).
    await fixture.harness.database.query(
      "UPDATE accounts SET email_verified_email = lower(email), email_verified_at = now() WHERE id IN ('ar-owner', 'ar-loss')"
    );

    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => errors.push(String((error && error.message) || error)));

    // 1. Login renders the self-service pointer inside the existing disclosure.
    await page.goto(`${base}/login`, { waitUntil: 'load' });
    await page.getByLabel('이메일').waitFor();
    await page.screenshot({ path: path.join(OUT, 'login-first-1280.png') });
    await page.getByRole('button', { name: '재설정 요청' }).click();
    const resetHelp = page.locator('#login-reset-help');
    await resetHelp.getByRole('link', { name: '이메일로 직접 재설정' }).waitFor();
    check('login points at verified-email self-service', true);
    // 표현 갱신: 공유 계정은 소유자가 전역 재설정할 수 없으므로 단일 조직
    // 관리자 경로와 공유 계정 제한을 구분한다. 기존 연락처 경로는 유지한다.
    check('login explains owner reset and the shared-account restriction',
      (await resetHelp.getByText('한 조직에만 속한 계정은').count()) === 1 &&
      (await resetHelp.getByText('여러 조직에 속한 계정은 한 조직의 관리자가 재설정할 수 없습니다.').count()) === 1);
    check('login keeps the admin-contact fallback',
      (await resetHelp.getByText(/설정된 관리자 연락처|등록된 관리자 연락처가 없습니다/).count()) === 1);
    check('login keeps the no-channel limitation', (await resetHelp.getByText(/별도 본인확인 절차가 정해질 때까지/).count()) === 1);
    await page.screenshot({ path: path.join(OUT, 'login-reset-help-1280.png') });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      const paragraphs = await resetHelp.locator('p').all();
      const broken = (await Promise.all(paragraphs.map(splitKoreanWords))).flat();
      check(`login recovery help keeps Korean words intact at ${width}`, paragraphs.length >= 4 && broken.length === 0);
      check(`login recovery help has no horizontal overflow at ${width}`, (await overflowX(page)) <= 0);
      if (width !== 1280) await page.screenshot({ path: path.join(OUT, `login-reset-help-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    check('axe login serious/critical 0', (await axeSeriousOrCritical(page)).length === 0);
    check('overflow login 1280 = 0', (await overflowX(page)) <= 0);

    // 2. /recover request: identical generic shapes, never an oracle.
    await page.goto(`${base}/recover`, { waitUntil: 'load' });
    const recoverSubmit = page.locator('.auth-form button[type="submit"]').first();
    await recoverSubmit.waitFor();
    const submitBox = await recoverSubmit.boundingBox().catch(() => null);
    check('recover submit target >=44px high', submitBox !== null && submitBox.height >= 44 && submitBox.width >= 24);
    await page.mouse.move(0, 0);
    const resting = await recoverSubmit.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
    await recoverSubmit.hover();
    await page.waitForFunction((base) => {
      const button = document.querySelector('.auth-form button[type="submit"]');
      if (!button) return false;
      const computed = getComputedStyle(button);
      return computed.backgroundColor !== base.background && computed.color !== base.color;
    }, resting);
    const hovered = await recoverSubmit.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
    check('recover submit retains a distinct desktop hover state', resting.background !== hovered.background && resting.color !== hovered.color);
    // Keyboard order: email field tabs straight into the submit button.
    await page.getByLabel('계정 이메일').click();
    await page.keyboard.press('Tab');
    check('recover request keyboard order reaches submit', await page.getByRole('button', { name: '복구 메일 요청' }).evaluate((el) => el === document.activeElement));
    await page.getByLabel('계정 이메일').fill('nobody-here@example.test');
    await page.getByRole('button', { name: '복구 메일 요청' }).click();
    await page.getByText('복구 메일 요청을 접수했습니다.').waitFor();
    const unknownText = await page.locator('.auth-form').first().innerText();
    check('recover request generic for unknown', unknownText.includes('복구 메일 요청을 접수했습니다.')
      && unknownText.includes('사전에 인증된 이메일이고 발송이 가능한 경우'));
    check('recover request keeps the manual-process limitation', unknownText.includes('별도 본인확인 절차가 정해질 때까지'));
    check('received panel offers an explicit retry action',
      (await page.getByRole('button', { name: '복구 메일 다시 요청' }).count()) === 1);
    await page.screenshot({ path: path.join(OUT, 'recover-requested-1280.png') });
    const received = page.locator('.auth-form p[role="status"]');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      check(`recover received notice keeps Korean words intact at ${width}`, (await splitKoreanWords(received)).length === 0);
      check(`recover received notice has no horizontal overflow at ${width}`, (await overflowX(page)) <= 0);
      if (width !== 1280) await page.screenshot({ path: path.join(OUT, `recover-requested-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    // Same-tab mailed-link click: no remount, the hash listener must pick it up.
    await page.evaluate((t) => { window.location.hash = `#t=${t}`; }, 'C'.repeat(43));
    await page.getByLabel('새 비밀번호 (8자 이상)').waitFor({ timeout: 15000 });
    check('same-tab fragment link enters confirm mode without reload', true);
    check('axe recover serious/critical 0', (await axeSeriousOrCritical(page)).length === 0);

    // 3. /recover confirm with a live token: strip + success + replay generic.
    clearMockOutbox();
    const reqRes = await fetch(`${fixture.harness.baseUrl}/api/auth/recovery/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ar-owner@example.test' }),
    });
    check('recover request reaches the isolated API', reqRes.status === 200);
    check('recover mail sent for the verified owner', mockOutbox.length === 1);
    // The raw link never reaches check output: only the boolean shape is recorded.
    const ownerLinkIsFragment = /\/recover#t=[A-Za-z0-9_-]{32,}/.test(mockOutbox[0].link);
    check('recover link carries a fragment bearer, never a query', ownerLinkIsFragment);
    const ownerToken = tokenOf(mockOutbox[0].link);
    await page.goto(`${base}/recover#t=${ownerToken}`, { waitUntil: 'load' });
    await page.getByLabel('새 비밀번호 (8자 이상)').waitFor();
    const stripped = new URL(page.url());
    check('recover token stripped from URL into memory', stripped.search === '' && stripped.hash === '' && stripped.pathname === '/recover');
    await page.getByLabel('새 비밀번호 (8자 이상)').fill('audit-new-password-1');
    await page.getByLabel('새 비밀번호 확인').fill('audit-new-password-1');
    await page.getByRole('button', { name: '비밀번호 바꾸기' }).click();
    await page.getByText('비밀번호를 바꿨습니다.').waitFor({ timeout: 15000 });
    check('recover confirm success panel', true);
    await page.screenshot({ path: path.join(OUT, 'recover-done-1280.png') });
    // Reuse the same token: generic denial, no new info.
    await page.goto(`${base}/recover#t=${ownerToken}`, { waitUntil: 'load' });
    await page.getByLabel('새 비밀번호 (8자 이상)').fill('audit-new-password-2');
    await page.getByLabel('새 비밀번호 확인').fill('audit-new-password-2');
    await page.getByRole('button', { name: '비밀번호 바꾸기' }).click();
    await page.getByText('복구 링크를 확인하세요.').waitFor({ timeout: 15000 });
    check('recover replay is a generic denial', true);
    await page.screenshot({ path: path.join(OUT, 'recover-replay-denied-1280.png') });

    // A real committed password change whose response is replaced by 502:
    // the user can check the new password in a new tab without losing the
    // original form or treating an unknown result as a failed reset.
    clearMockOutbox();
    const lossRequest = await fetch(`${fixture.harness.baseUrl}/api/auth/recovery/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ar-loss@example.test' }),
    });
    check('response-loss fixture requests a real recovery link', lossRequest.status === 200 && mockOutbox.length === 1);
    const lossToken = tokenOf(mockOutbox[0].link);
    let committedStatus = 0;
    await page.route('**/api/auth/recovery/confirm', async (route) => {
      const actual = await route.fetch();
      committedStatus = actual.status();
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture response lost"}' });
    });
    await page.goto(`${base}/recover#t=${lossToken}`, { waitUntil: 'load' });
    await page.getByLabel('새 비밀번호 (8자 이상)').fill('audit-loss-password-1');
    await page.getByLabel('새 비밀번호 확인').fill('audit-loss-password-1');
    await page.getByRole('button', { name: '비밀번호 바꾸기' }).click();
    await page.getByText('비밀번호 변경 결과를 확인하지 못했습니다.').waitFor({ timeout: 15000 });
    check('response loss occurs after the real reset committed', committedStatus === 200);
    check('unknown reset result keeps the new password in the original tab',
      await page.getByLabel('새 비밀번호 (8자 이상)').inputValue() === 'audit-loss-password-1');
    const loginLink = page.getByRole('link', { name: '새 비밀번호로 로그인 확인 (새 탭)' });
    check('unknown reset result offers a separate login check', await loginLink.getAttribute('target') === '_blank');
    await page.screenshot({ path: path.join(OUT, 'recover-response-unknown-1280.png') });
    const popupPromise = page.waitForEvent('popup');
    await loginLink.click();
    const loginPage = await popupPromise;
    await loginPage.getByLabel('이메일').fill('ar-loss@example.test');
    await loginPage.getByLabel('비밀번호').fill('audit-loss-password-1');
    await loginPage.getByRole('button', { name: '로그인', exact: true }).click();
    await loginPage.waitForURL(/\/console/, { timeout: 15000 });
    check('new password logs in after the lost response', true);
    check('login check leaves the original reset form intact',
      await page.getByLabel('새 비밀번호 (8자 이상)').inputValue() === 'audit-loss-password-1');
    await loginPage.close();
    await page.context().clearCookies();
    await page.unroute('**/api/auth/recovery/confirm');

    // A proxy can also return 200 with no usable receipt after the commit.
    // That is still unknown, not a successful reset screen.
    clearMockOutbox();
    const emptyRequest = await fetch(`${fixture.harness.baseUrl}/api/auth/recovery/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ar-loss@example.test' }),
    });
    check('empty-receipt fixture requests a real recovery link', emptyRequest.status === 200 && mockOutbox.length === 1);
    const emptyToken = tokenOf(mockOutbox[0].link);
    let emptyCommittedStatus = 0;
    await page.route('**/api/auth/recovery/confirm', async (route) => {
      const actual = await route.fetch();
      emptyCommittedStatus = actual.status();
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`${base}/recover#t=${emptyToken}`, { waitUntil: 'load' });
    await page.getByLabel('새 비밀번호 (8자 이상)').fill('audit-empty-password-1');
    await page.getByLabel('새 비밀번호 확인').fill('audit-empty-password-1');
    await page.getByRole('button', { name: '비밀번호 바꾸기' }).click();
    await page.getByText('비밀번호 변경 결과를 확인하지 못했습니다.').waitFor({ timeout: 15000 });
    check('empty reset receipt follows a real commit', emptyCommittedStatus === 200);
    check('empty reset receipt is unknown, with a login check and retained input',
      await page.getByRole('link', { name: '새 비밀번호로 로그인 확인 (새 탭)' }).isVisible() &&
      await page.getByLabel('새 비밀번호 (8자 이상)').inputValue() === 'audit-empty-password-1');
    await page.unroute('**/api/auth/recovery/confirm');

    // 4. /account/email unauthenticated: sign-in prompt, no status leak.
    const anon = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await anon.goto(`${base}/account/email`, { waitUntil: 'load' });
    await anon.getByText('이메일 인증은 로그인한 본인만 할 수 있습니다.').waitFor();
    check('account/email unauth prompt', true);
    await anon.screenshot({ path: path.join(OUT, 'account-email-signin-390.png') });
    await anon.close();

    // 5. Member lifecycle: request -> mailed (mock note) -> confirm -> verified.
    await page.goto(`${base}/login`, { waitUntil: 'load' });
    await page.getByLabel('이메일').fill('ar-member@example.test');
    await page.getByLabel('비밀번호').fill('not-a-real-test-password');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.waitForURL(/\/console/, { timeout: 15000 });
    check('member login reaches console', true);
    await page.goto(`${base}/account/email`, { waitUntil: 'load' });
    await page.getByText('초대를 수락한 것만으로는').waitFor();
    check('account/email unverified explainer', true);
    await page.screenshot({ path: path.join(OUT, 'account-email-unverified-1280.png') });
    clearMockOutbox();
    await page.getByLabel('현재 비밀번호').fill('not-a-real-test-password');
    await page.getByRole('button', { name: '인증 메일 보내기' }).click();
    await page.getByText('모의 인증 요청을 기록했습니다.').waitFor({ timeout: 15000 });
    check('account/email mailed panel names mock mode honestly', true);
    const memberLinkIsFragment = /\/account\/email#t=[A-Za-z0-9_-]{32,}/.test(mockOutbox[0].link);
    check('verify link targets the signed-in account page', memberLinkIsFragment);
    const memberToken = tokenOf(mockOutbox[0].link);
    await page.goto(`${base}/account/email#t=${memberToken}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: '이메일 인증하기' }).waitFor();
    const stripped2 = new URL(page.url());
    check('verify token stripped from URL', stripped2.search === '' && stripped2.hash === '');
    await page.getByRole('button', { name: '이메일 인증하기' }).click();
    await page.getByText('이메일 인증을 마쳤습니다.').waitFor({ timeout: 15000 });
    await page.getByText(/인증됨 ·/).waitFor();
    check('account/email verified panel', (await page.getByText(/인증됨 ·/).count()) === 1);
    check('masked address hides the local part', !(await page.getByText(/인증됨 ·/).innerText()).includes('ar-member'));
    await page.getByText('모의 발송 모드입니다. 실제 복구 메일은 발송되지 않습니다.').waitFor({ timeout: 15000 });
    check('verified panel names mock delivery honestly', true);
    await page.screenshot({ path: path.join(OUT, 'account-email-verified-1280.png') });
    check('axe account/email serious/critical 0', (await axeSeriousOrCritical(page)).length === 0);
    check('overflow account/email 1280 = 0', (await overflowX(page)) <= 0);

    // 6. Console operator menu carries the account-level entry.
    await page.goto(`${base}/console`, { waitUntil: 'load' });
    await page.getByRole('button', { name: /복구검증 구성원|운영자/ }).first().click();
    await page.getByRole('link', { name: '내 계정 이메일 인증' }).waitFor();
    check('console operator menu links to account/email', true);
    await page.getByRole('link', { name: '내 계정 이메일 인증' }).click();
    await page.waitForURL(/\/account\/email/, { timeout: 15000 });
    await page.getByText(/인증됨 ·/).waitFor({ timeout: 15000 });
    check('menu entry lands on the verified panel', (await page.getByText(/인증됨 ·/).count()) === 1);
    await page.screenshot({ path: path.join(OUT, 'account-email-from-menu-1280.png') });

    // Malformed 2xx replies must not claim that verification mail was sent
    // or that verification finished. A real confirm can have committed;
    // reopening the status is then the safe way to discover its result.
    const verifyLoss = await browser.newPage({ viewport: { width: 390, height: 844 } });
    verifyLoss.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
    await verifyLoss.goto(`${base}/login`, { waitUntil: 'load' });
    await verifyLoss.getByLabel('이메일').fill('ar-verify-loss@example.test');
    await verifyLoss.getByLabel('비밀번호').fill('not-a-real-test-password');
    await verifyLoss.getByRole('button', { name: '로그인', exact: true }).click();
    await verifyLoss.waitForURL(/\/console/, { timeout: 15000 });
    await verifyLoss.goto(`${base}/account/email`, { waitUntil: 'load' });
    await verifyLoss.getByLabel('현재 비밀번호').fill('not-a-real-test-password');
    await verifyLoss.route('**/api/auth/email/verify/request', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: '{}',
    }));
    await verifyLoss.getByRole('button', { name: '인증 메일 보내기' }).click();
    await verifyLoss.getByText('인증 메일 요청 결과를 확인하지 못했습니다.').waitFor({ timeout: 15000 });
    check('empty verify-request receipt stays uncertain and retains the input',
      await verifyLoss.getByLabel('현재 비밀번호').inputValue() === 'not-a-real-test-password');
    await verifyLoss.unroute('**/api/auth/email/verify/request');
    clearMockOutbox();
    await verifyLoss.getByRole('button', { name: '인증 메일 보내기' }).click();
    await verifyLoss.getByText('모의 인증 요청을 기록했습니다.').waitFor({ timeout: 15000 });
    const verifyLossToken = tokenOf(mockOutbox[0].link);
    // A delivered link is still valid if the delivery service becomes
    // unavailable afterward: only the status reply is faulted here.
    let offlineStatusReplies = 0;
    await verifyLoss.route('**/api/auth/email/status', async (route) => {
      const actual = await route.fetch();
      const body = await actual.json();
      offlineStatusReplies += 1;
      await route.fulfill({ response: actual, json: { ...body, delivery: { mode: 'none', connected: false } } });
    });
    const offlineResponse = verifyLoss.waitForResponse(
      (response) => response.url().includes('/api/auth/email/status'), { timeout: 15000 }
    );
    // A query change forces a new document: hash-only navigation would
    // retain the previous connected status without fetching our fault.
    await verifyLoss.goto(`${base}/account/email?delivery-audit=offline#t=${verifyLossToken}`, { waitUntil: 'load' });
    await offlineResponse;
    check('delivery-unavailable status fault actually reached the page', offlineStatusReplies > 0);
    await verifyLoss.getByRole('alert').or(verifyLoss.getByRole('button', { name: '이메일 인증하기' })).first().waitFor({ timeout: 15000 });
    await verifyLoss.screenshot({ path: path.join(OUT, 'account-email-issued-link-delivery-off-390.png'), mask: [verifyLoss.locator('#verify-token')] });
    await verifyLoss.getByRole('button', { name: '이메일 인증하기' }).waitFor({ timeout: 15000 });
    check('issued email link remains confirmable when delivery later becomes unavailable', true);
    check('outage does not offer a resend that cannot work',
      await verifyLoss.getByText('현재 이메일 발송을 사용할 수 없어 새 메일을 요청할 수 없습니다.').isVisible() &&
      await verifyLoss.getByRole('button', { name: '다시 보내기' }).count() === 0);
    const offlineTokenField = verifyLoss.getByLabel('인증 토큰');
    await offlineTokenField.fill('');
    check('editing an issued token to empty preserves the confirmation form', await offlineTokenField.isVisible());
    await offlineTokenField.fill(verifyLossToken);
    let verifiedCommit = 0;
    await verifyLoss.route('**/api/auth/email/verify/confirm', async (route) => {
      const actual = await route.fetch();
      verifiedCommit = actual.status();
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await verifyLoss.getByRole('button', { name: '이메일 인증하기' }).click();
    await verifyLoss.getByText('이메일 인증 결과를 확인하지 못했습니다.').waitFor({ timeout: 15000 });
    check('empty verify-confirm receipt follows a real commit but is not presented as success', verifiedCommit === 200);
    await verifyLoss.unroute('**/api/auth/email/verify/confirm');
    await verifyLoss.unroute('**/api/auth/email/status');
    await verifyLoss.goto(`${base}/account/email`, { waitUntil: 'load' });
    await verifyLoss.getByText(/인증됨 ·/).waitFor({ timeout: 15000 });
    check('reopening email status reveals the committed verification', true);
    await verifyLoss.close();

    // 7. Staff journey on real event work through the account gate.
    const staffTicket = await fixture.harness.database.query(
      "SELECT payload->'participants'->0->>'ticket' AS t FROM event_workspaces WHERE event_id = $1",
      [fixture.eventId]
    ).then((r) => r.rows[0].t);
    assert.ok(staffTicket, 'fixture seeds a scannable ticket');
    const staffPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    staffPage.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
    await staffPage.goto(`${base}/login`, { waitUntil: 'load' });
    await staffPage.getByLabel('이메일').fill(fixture.staff.email);
    await staffPage.getByLabel('비밀번호').fill(fixture.staff.password);
    await staffPage.getByRole('button', { name: '로그인', exact: true }).click();
    await staffPage.waitForURL(/\/staff\/events\//, { timeout: 15000 });
    check('staff login reaches assigned event work', true);
    await staffPage.getByRole('button', { name: /감사 스태프/ }).click();
    await staffPage.getByRole('link', { name: '내 계정 이메일 인증' }).waitFor();
    check('staff account menu links to account/email', true);
    await staffPage.getByRole('link', { name: '내 계정 이메일 인증' }).click();
    await staffPage.waitForURL(/\/account\/email/, { timeout: 15000 });
    await staffPage.getByRole('button', { name: '인증 메일 보내기' }).waitFor({ timeout: 15000 });
    check('clean staff screen reaches the usable account/email form', true);
    const staffVerifyButton = await staffPage.getByRole('button', { name: '인증 메일 보내기' }).boundingBox();
    check('staff email submit target >=44px high',
      staffVerifyButton !== null && staffVerifyButton.height >= 44 && staffVerifyButton.width >= 24);
    check('staff account/email 390 has no overflow', (await overflowX(staffPage)) <= 0);
    check('axe staff account/email serious/critical 0', (await axeSeriousOrCritical(staffPage)).length === 0);
    await staffPage.screenshot({ path: path.join(OUT, 'account-email-staff-390.png') });
    await staffPage.goto(`${base}/staff/events/${fixture.eventId}`, { waitUntil: 'load' });
    await staffPage.locator('#staff-ticket').waitFor({ timeout: 15000 });
    // Draft: typed but unsubmitted input asks with account wording; cancel
    // preserves the draft and stays.
    await staffPage.locator('#staff-ticket').fill('DRAFT-KEEP-1');
    let dialogText = '';
    staffPage.once('dialog', async (dialog) => {
      dialogText = dialog.message();
      await dialog.dismiss();
    });
    await staffPage.getByRole('button', { name: /감사 스태프/ }).click();
    await staffPage.getByRole('link', { name: '내 계정 이메일 인증' }).click();
    await staffPage.waitForTimeout(500);
    check('draft confirm names the account page, never an org switch',
      dialogText.includes('내 계정 페이지로 이동하면') && !dialogText.includes('조직을 전환'));
    check('draft cancel preserves input and stays',
      new URL(staffPage.url()).pathname.includes('/staff/events/')
      && (await staffPage.locator('#staff-ticket').inputValue()) === 'DRAFT-KEEP-1');
    staffPage.once('dialog', async (dialog) => { await dialog.accept(); });
    await staffPage.getByRole('link', { name: '내 계정 이메일 인증' }).click();
    await staffPage.waitForURL(/\/account\/email/, { timeout: 15000 });
    check('draft accept navigates to account/email', true);
    await staffPage.goto(`${base}/staff/events/${fixture.eventId}`, { waitUntil: 'load' });
    await staffPage.locator('#staff-ticket').waitFor({ timeout: 15000 });
    // Busy: delay the scan response, click the link mid-flight → blocked.
    await staffPage.route('**/api/events/*/commands', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await staffPage.locator('#staff-ticket').fill(staffTicket);
    await staffPage.getByRole('button', { name: '입장 처리' }).click().catch(() => {});
    await staffPage.waitForTimeout(400);
    await staffPage.getByRole('button', { name: /감사 스태프/ }).click();
    await staffPage.getByRole('link', { name: '내 계정 이메일 인증' }).click();
    await staffPage.waitForTimeout(500);
    check('in-flight scan blocks the account navigation',
      new URL(staffPage.url()).pathname.includes('/staff/events/'));
    check('blocked account navigation explains what to do',
      await staffPage.getByRole('status').filter({ hasText: '이 화면을 떠나지 않았습니다.' }).isVisible());
    check('blocked navigation keeps the menu usable',
      (await staffPage.getByRole('link', { name: '내 계정 이메일 인증' }).count()) === 1);
    await staffPage.unrouteAll({ behavior: 'wait' }).catch(() => {});
    await staffPage.getByText('다음 참가자를 스캔하세요.').waitFor({ timeout: 15000 });
    await staffPage.goto(`${base}/staff/events/${fixture.eventId}`, { waitUntil: 'load' });
    await staffPage.getByRole('button', { name: /감사 스태프/ }).click();
    await staffPage.getByRole('link', { name: '내 계정 이메일 인증' }).click();
    await staffPage.waitForURL(/\/account\/email/, { timeout: 15000 });
    check('settled work allows the account navigation', true);
    await staffPage.close();

    // 8. Response-unknown: the gateway loses the first scan response, the
    // receipt stays retained, and the account navigation stays blocked until
    // the same-request retry confirms the outcome.
    const faulted = await startAuditFixture({ loseFirstResponseFor: ['check.scan'] });
    fixtures.push(faulted);
    const faultTicket = await faulted.harness.database.query(
      "SELECT payload->'participants'->0->>'ticket' AS t FROM event_workspaces WHERE event_id = $1",
      [faulted.eventId]
    ).then((r) => r.rows[0].t);
    assert.ok(faultTicket, 'faulted fixture seeds a scannable ticket');
    const faultPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    faultPage.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
    await faultPage.goto(`${faulted.baseUrl}/login`, { waitUntil: 'load' });
    await faultPage.getByLabel('이메일').fill(faulted.staff.email);
    await faultPage.getByLabel('비밀번호').fill(faulted.staff.password);
    await faultPage.getByRole('button', { name: '로그인', exact: true }).click();
    await faultPage.waitForURL(/\/staff\/events\//, { timeout: 15000 });
    await faultPage.locator('#staff-ticket').waitFor({ timeout: 15000 });
    await faultPage.locator('#staff-ticket').fill(faultTicket);
    await faultPage.getByRole('button', { name: '입장 처리' }).click().catch(() => {});
    await faultPage.getByText('연결하지 못했습니다. 같은 업무·티켓으로 다시 시도하세요.').waitFor({ timeout: 15000 });
    check('lost scan response surfaces as retryable unknown', true);
    await faultPage.getByRole('button', { name: /감사 스태프/ }).click();
    await faultPage.getByRole('link', { name: '내 계정 이메일 인증' }).click();
    await faultPage.waitForTimeout(500);
    check('unknown-verdict receipt blocks the account navigation',
      new URL(faultPage.url()).pathname.includes('/staff/events/'));
    check('unknown-verdict block explains the next action',
      await faultPage.getByRole('status').filter({ hasText: '결과를 확인한 뒤 다시 이동하세요.' }).isVisible());
    await faultPage.screenshot({ path: path.join(OUT, 'staff-unknown-blocked-390.png') });
    // Same-request retry confirms the committed outcome; the gate reopens.
    await faultPage.locator('#staff-ticket').fill(faultTicket);
    await faultPage.getByRole('button', { name: '입장 처리' }).click().catch(() => {});
    await faultPage.getByText('다음 참가자를 스캔하세요.').waitFor({ timeout: 15000 });
    await faultPage.getByRole('button', { name: /감사 스태프/ }).click();
    await faultPage.getByRole('link', { name: '내 계정 이메일 인증' }).click();
    await faultPage.waitForURL(/\/account\/email/, { timeout: 15000 });
    check('confirmed retry reopens the account navigation', true);
    await faultPage.close();

    // 9. Simulated failures: honest panels, never a fake signed-out state.
    const failPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    failPage.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
    await failPage.goto(`${base}/login`, { waitUntil: 'load' });
    await failPage.getByLabel('이메일').fill('ar-member@example.test');
    await failPage.getByLabel('비밀번호').fill('not-a-real-test-password');
    await failPage.getByRole('button', { name: '로그인', exact: true }).click();
    await failPage.waitForURL(/\/console/, { timeout: 15000 });
    await failPage.route('**/api/auth/me', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }),
    }));
    await failPage.goto(`${base}/account/email`, { waitUntil: 'load' });
    await failPage.getByText('인증 상태를 확인하지 못했습니다.').waitFor({ timeout: 15000 });
    check('account/email me-failure is retryable, not signed-out', true);
    await failPage.unroute('**/api/auth/me');
    await failPage.getByRole('button', { name: '인증 상태 다시 확인' }).click();
    await failPage.getByText(/인증됨 ·/).waitFor({ timeout: 15000 });
    check('account/email retry after me-failure recovers', true);
    await failPage.route('**/api/auth/email/status', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }),
    }));
    await failPage.goto(`${base}/account/email`, { waitUntil: 'load' });
    await failPage.getByText('인증 상태를 확인하지 못했습니다.').waitFor({ timeout: 15000 });
    check('account/email failure keeps the session and offers retry', true);
    await failPage.screenshot({ path: path.join(OUT, 'account-email-failed-1280.png') });
    await failPage.setViewportSize({ width: 390, height: 844 });
    const statusRetry = await failPage.getByRole('button', { name: '인증 상태 다시 확인' }).boundingBox();
    check('email status retry target >=44px high on mobile',
      statusRetry !== null && statusRetry.height >= 44 && statusRetry.width >= 24);
    check('email status failure 390 has no overflow', (await overflowX(failPage)) <= 0);
    await failPage.screenshot({ path: path.join(OUT, 'account-email-failed-390.png') });
    await failPage.setViewportSize({ width: 1280, height: 900 });
    await failPage.unroute('**/api/auth/email/status');
    await failPage.getByRole('button', { name: '인증 상태 다시 확인' }).click();
    await failPage.getByText(/인증됨 ·/).waitFor({ timeout: 15000 });
    check('account/email retry recovers without re-login', true);
    await failPage.route('**/api/auth/recovery/request', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, delivery: { mode: 'none', connected: false } }),
    }));
    await failPage.goto(`${base}/recover`, { waitUntil: 'load' });
    await failPage.getByLabel('계정 이메일').fill('anyone@example.test');
    await failPage.getByRole('button', { name: '복구 메일 요청' }).click();
    await failPage.getByText('현재 이메일 발송이 설정되지 않아 복구 메일을 보낼 수 없습니다.').waitFor({ timeout: 15000 });
    check('recover names unavailable delivery instead of promising mail', true);
    // Next also owns an off-screen route announcer with role=alert; measure
    // only the actual error within the recover form, never the announcer.
    const deliveryError = failPage.locator('.auth-form p[role="alert"]');
    for (const width of [1280, 390, 320]) {
      await failPage.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      check(`recover delivery error keeps Korean words intact at ${width}`, (await splitKoreanWords(deliveryError)).length === 0);
      check(`recover delivery error has no horizontal overflow at ${width}`, (await overflowX(failPage)) <= 0);
      await failPage.screenshot({ path: path.join(OUT, `recover-unavailable-${width}.png`), fullPage: width !== 1280 });
    }
    await failPage.setViewportSize({ width: 1280, height: 900 });
    await failPage.unroute('**/api/auth/recovery/request');
    await failPage.route('**/api/auth/recovery/request', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }),
    }));
    await failPage.goto(`${base}/recover`, { waitUntil: 'load' });
    await failPage.getByLabel('계정 이메일').fill('anyone@example.test');
    await failPage.getByRole('button', { name: '복구 메일 요청' }).click();
    await failPage.getByText('요청을 접수하지 못했습니다.').waitFor({ timeout: 15000 });
    check('recover 5xx is retryable, never a success', true);
    check('failed recover keeps the address for retry',
      (await failPage.getByLabel('계정 이메일').inputValue()) === 'anyone@example.test');
    // The failure alert takes keyboard focus for screen-reader operators.
    check('failed recover moves focus to the alert',
      await failPage.evaluate(() => document.activeElement && document.activeElement.getAttribute('role') === 'alert'));
    await failPage.unroute('**/api/auth/recovery/request');
    await failPage.route('**/api/auth/recovery/request', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: 'not-json{',
    }));
    await failPage.goto(`${base}/recover`, { waitUntil: 'load' });
    await failPage.getByLabel('계정 이메일').fill('anyone@example.test');
    await failPage.getByRole('button', { name: '복구 메일 요청' }).click();
    await failPage.getByText('요청을 접수하지 못했습니다.').waitFor({ timeout: 15000 });
    check('recover malformed body is retryable, never a success', true);
    await failPage.unroute('**/api/auth/recovery/request');
    // The failure kept the typed address: resubmitting against the real
    // (mock-enabled) API reaches the received panel.
    await failPage.getByRole('button', { name: '복구 메일 요청' }).click();
    await failPage.getByText('복구 메일 요청을 접수했습니다.').waitFor({ timeout: 15000 });
    check('recover retry after failure reaches the received panel', true);
    await failPage.close();

    // 10. Real no-provider run: mock off, no public base. The disabled panel
    // and the honest 503 are rendered from a genuinely unconfigured server.
    const savedMailMock = process.env.EVENTOUCH_MAIL_MOCK;
    const savedPublicUrl = process.env.EVENTOUCH_PUBLIC_URL;
    delete process.env.EVENTOUCH_MAIL_MOCK;
    process.env.EVENTOUCH_PUBLIC_URL = '';
    let offFixture;
    try {
      offFixture = await startAuditFixture();
      fixtures.push(offFixture);
      const offPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      offPage.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
      await offPage.goto(`${offFixture.baseUrl}/login`, { waitUntil: 'load' });
      await offPage.getByLabel('이메일').fill(offFixture.manager.email);
      await offPage.getByLabel('비밀번호').fill(offFixture.manager.password);
      await offPage.getByRole('button', { name: '로그인', exact: true }).click();
      await offPage.waitForURL(/\/console/, { timeout: 15000 });
      await offPage.goto(`${offFixture.baseUrl}/account/email`, { waitUntil: 'load' });
      await offPage.getByText('현재 이메일 발송이 설정되지 않아 인증 메일을 보낼 수 없습니다.').waitFor({ timeout: 15000 });
      check('real no-provider run renders the disabled panel', true);
      await offPage.screenshot({ path: path.join(OUT, 'account-email-disabled-1280.png') });
      // The disabled panel offers no request form by design; the honest 503
      // behind it is asserted against the same unconfigured API instead.
      const offReq = await fetch(`${offFixture.harness.baseUrl}/api/auth/email/verify/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: offFixture.manager.cookie },
        body: JSON.stringify({ currentPassword: offFixture.manager.password }),
      }).then((r) => r.json().catch(() => null));
      check('real no-provider request answers honest 503, not a silent drop',
        offReq && offReq.code === 'EMAIL_NOT_CONFIGURED');
      check('no-provider axe serious/critical 0', (await axeSeriousOrCritical(offPage)).length === 0);
      check('no-provider overflow 1280 = 0', (await overflowX(offPage)) <= 0);
      await offPage.close();
    } finally {
      if (savedMailMock === undefined) delete process.env.EVENTOUCH_MAIL_MOCK;
      else process.env.EVENTOUCH_MAIL_MOCK = savedMailMock;
      if (savedPublicUrl === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
      else process.env.EVENTOUCH_PUBLIC_URL = savedPublicUrl;
    }

    // 11. Mobile viewport for the request panel.
    const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mob.goto(`${base}/login`, { waitUntil: 'load' });
    await mob.getByLabel('이메일').waitFor();
    check('overflow login 390 = 0', (await overflowX(mob)) <= 0);
    await mob.screenshot({ path: path.join(OUT, 'login-first-390.png') });
    await mob.goto(`${base}/recover`, { waitUntil: 'load' });
    await mob.getByLabel('계정 이메일').waitFor();
    check('overflow recover 390 = 0', (await overflowX(mob)) <= 0);
    await mob.screenshot({ path: path.join(OUT, 'recover-request-390.png') });
    await mob.setViewportSize({ width: 320, height: 568 });
    check('overflow recover 320 = 0', (await overflowX(mob)) <= 0);
    const recoveryHint = mob.locator('.auth-form .auth-help[role="status"]').first();
    check('recover instructions keep Korean words intact at 320', (await splitKoreanWords(recoveryHint)).length === 0);
    const mobileSubmit = await mob.getByRole('button', { name: '복구 메일 요청' }).boundingBox();
    check('recover submit target at 320 is at least 44px high', mobileSubmit !== null && mobileSubmit.height >= 44);
    await mob.screenshot({ path: path.join(OUT, 'recover-request-320.png') });
    const recoverAction = mob.getByRole('button', { name: '복구 메일 요청' });
    await recoverAction.scrollIntoViewIfNeeded();
    check('recover submit is not obscured at 320', await recoverAction.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.top >= 0 && rect.bottom <= innerHeight && (hit === element || element.contains(hit));
    }));
    await mob.close();

    check('no unexpected browser runtime errors', errors.length === 0);
    completed = true;
    console.log(`[account-recovery] ${checks.length} checks passed`);
  } finally {
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({
      completed,
      checks: checks.map((entry) => ({ name: entry.name, ok: entry.ok })),
      errors,
      disclosures: [
        'isolated synthetic events and PostgreSQL; loopback only',
        'real Chromium against the built Next app through the same-origin test gateway',
        'mock email only: EVENTOUCH_MAIL_MOCK=1, no provider selected, SOLAPI keys stripped',
        'scan response-loss and /api failure states are injected and disclosed',
        'one no-provider run uses a genuinely unconfigured fixture (mock off, no public base)',
        'tokens travel in URL fragments stripped client-side; no raw tokens or addresses in this file',
        'manual ticket input, not a physical scanner',
      ],
    }, null, 2), { mode: 0o600 });
    if (browser) await browser.close();
    for (const owned of fixtures.reverse()) {
      await owned.close().catch(() => {});
    }
  }
  return { completed, checks };
}

async function main() {
  const result = await runAccountRecoveryAudit();
  if (!result.completed || result.checks.some((entry) => !entry.ok)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { runAccountRecoveryAudit };
