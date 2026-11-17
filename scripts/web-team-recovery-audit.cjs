'use strict';
// Faults affect only synthetic fixtures, after the isolated server commits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let stage = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'team-recovery-before' : 'team-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const cookie = await fixture.helpers.sessionCookie(fixture.harness, `audit-owner-${fixture.suffix}`);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), url: fixture.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${fixture.baseUrl}/console/team`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '구성원 초대', exact: true }).click();
    await page.locator('#invite-name').fill('합성 초대');
    await page.locator('#invite-email').fill('synthetic-invite@example.invalid');
    await page.screenshot({ path: path.join(out, 'invite-form-1280.png'), fullPage: true });
    if (before) {
      await page.route('**/api/auth/invitations', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        return route.abort('failed');
      });
      await page.getByRole('dialog').getByRole('button', { name: '초대 링크 발급', exact: true }).click();
      await page.getByRole('dialog').getByText(/연결하지 못했습니다/).waitFor();
      await page.screenshot({ path: path.join(out, 'before-invite-unconfirmed-1280.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-invite-unconfirmed-390.png'), fullPage: true });
      console.log('Team recovery before capture passed');
      return;
    }
    let inviteMode = 'lost', resetMode = 'pass', memberMode = 'pass';
    const inviteIds = [], resetIds = [], memberIds = [];
    const routes = [
      { pattern: '**/api/auth/invitations', type: 'invite', ids: inviteIds },
      { pattern: /\/api\/auth\/accounts\/[^/]+\/password$/, type: 'reset', ids: resetIds },
      { pattern: /\/api\/events\/[^/]+\/members$/, type: 'member', ids: memberIds },
    ];
    for (const { pattern, type, ids } of routes) await page.route(pattern, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      ids.push(route.request().postDataJSON().commandId);
      const mode = type === 'invite' ? inviteMode : type === 'reset' ? resetMode : memberMode;
      const setMode = (next) => { if (type === 'invite') inviteMode = next; else if (type === 'reset') resetMode = next; else memberMode = next; };
      if (mode === 'lost' || mode === 'malformed') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, `${type} committed before response fault`);
        setMode(mode === 'lost' ? 'rejected' : 'pass');
        return mode === 'lost' ? route.abort('failed') : route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
      }
      if (mode === 'rejected') { setMode('pass'); return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      return route.continue();
    });
    let dialog = page.getByRole('dialog');
    stage = 'invitation lost, rejected retry and once-only link';
    await dialog.getByRole('button', { name: '초대 링크 발급', exact: true }).click();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    assert.equal(await page.locator('#invite-email').isDisabled(), true);
    const pointer = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(pointer.includes('invitation.create') && !pointer.includes('synthetic-invite@example.invalid'));
    await page.screenshot({ path: path.join(out, 'invite-unconfirmed-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'invite-unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.getByText(/초대 결과를 확인하지 못했습니다/).waitFor();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText(/초대 발급이 반영되었습니다.*링크는 다시 볼 수 없으므로/).waitFor();
    assert.equal(new Set(inviteIds.slice(-3)).size, 1);
    assert.equal((await fixture.harness.database.query('SELECT count(*)::int AS n FROM invitations WHERE email=$1', ['synthetic-invite@example.invalid'])).rows[0].n, 1);
    assert.equal(await page.getByText('초대 링크는 지금 한 번만 표시됩니다. 복사해서 전달하세요.').count(), 0, 'a lost link is never fabricated');

    stage = 'invitation read-only status';
    await page.getByRole('button', { name: '구성원 초대', exact: true }).click();
    await page.locator('#invite-name').fill('합성 확인 초대');
    await page.locator('#invite-email').fill('synthetic-status@example.invalid');
    inviteMode = 'malformed';
    await dialog.getByRole('button', { name: '초대 링크 발급' }).click();
    await dialog.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const beforeInviteCheck = inviteIds.length;
    await dialog.getByRole('button', { name: '서버 처리 확인' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(inviteIds.length, beforeInviteCheck);
    assert.equal((await fixture.harness.database.query('SELECT count(*)::int AS n FROM invitations WHERE email=$1', ['synthetic-status@example.invalid'])).rows[0].n, 1);

    stage = 'invitation pointer after reload';
    await page.getByRole('button', { name: '구성원 초대', exact: true }).click();
    await page.locator('#invite-name').fill('합성 새로고침 초대');
    await page.locator('#invite-email').fill('synthetic-reload@example.invalid');
    inviteMode = 'malformed';
    await dialog.getByRole('button', { name: '초대 링크 발급' }).click();
    await dialog.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    assert.equal(await page.getByRole('button', { name: '구성원 초대', exact: true }).isDisabled(), true);
    const postsBeforeReloadCheck = inviteIds.length;
    let rateOnce = true;
    await page.route('**/api/command-receipts/*', async (route) => {
      if (rateOnce) { rateOnce = false; return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"제한"}' }); }
      return route.continue();
    });
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await shared.getByText(/일시적으로 처리 결과를 확인하지 못했습니다/).waitFor();
    assert.equal(await page.getByRole('button', { name: '구성원 초대', exact: true }).isDisabled(), true);
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '구성원 초대' && !button.disabled));
    assert.equal(inviteIds.length, postsBeforeReloadCheck);

    stage = 'password reset lost, rejected and replayed';
    // Account actions live in the member drawer; choosing 비밀번호 재설정 closes
    // it and opens the reset dialog, which keeps its own recovery contract.
    const openReset = async () => {
      await page.getByRole('list', { name: '구성원 목록' }).getByRole('button', { name: '감사 운영자', exact: true }).click();
      await page.getByRole('button', { name: '비밀번호 재설정', exact: true }).click();
    };
    await openReset();
    const password = 'synthetic-password-only';
    await page.locator('#reset-password').fill(password);
    await page.locator('#reset-confirm').fill(password);
    resetMode = 'lost';
    await dialog.getByRole('button', { name: '재설정', exact: true }).click();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    assert.equal(await page.locator('#reset-password').getAttribute('readonly'), '');
    assert.equal((await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '')).includes(password), false);
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.getByText(/재설정 결과를 확인하지 못했습니다/).waitFor();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(new Set(resetIds.slice(-3)).size, 1);
    const account = (await fixture.harness.database.query('SELECT password_hash FROM accounts WHERE id=$1', [fixture.manager.id])).rows[0];
    assert.equal(require('../server/auth').verifyPassword(password, account.password_hash), true);

    stage = 'password reset read-only confirmation';
    await openReset();
    const secondPassword = 'second-synthetic-password';
    await page.locator('#reset-password').fill(secondPassword);
    await page.locator('#reset-confirm').fill(secondPassword);
    resetMode = 'malformed';
    await dialog.getByRole('button', { name: '재설정', exact: true }).click();
    await dialog.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const beforeResetCheck = resetIds.length;
    await dialog.getByRole('button', { name: '서버 처리 확인' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(resetIds.length, beforeResetCheck);
    const currentAccount = (await fixture.harness.database.query('SELECT password_hash FROM accounts WHERE id=$1', [fixture.manager.id])).rows[0];
    assert.equal(require('../server/auth').verifyPassword(secondPassword, currentAccount.password_hash), true);

    stage = 'event permission malformed, rejected and replayed';
    await page.getByRole('tab', { name: '행사별 권한' }).click();
    const scopeList = page.getByRole('list', { name: /쓰기 권한 목록/ });
    await scopeList.getByRole('button', { name: '감사 운영자', exact: true }).click();
    const permissionDrawer = page.getByRole('dialog', { name: /감사 운영자 · 쓰기 권한/ });
    await permissionDrawer.getByText('읽기 전용', { exact: true }).click();
    memberMode = 'lost';
    await permissionDrawer.getByRole('button', { name: '권한 저장' }).click();
    await permissionDrawer.getByRole('button', { name: '같은 요청으로 다시 시도' }).waitFor();
    await permissionDrawer.getByRole('button', { name: '같은 요청으로 다시 시도' }).click();
    await page.getByText(/같은 요청으로 다시 시도하세요/).first().waitFor();
    await permissionDrawer.getByRole('button', { name: '같은 요청으로 다시 시도' }).click();
    await permissionDrawer.waitFor({ state: 'hidden' });
    assert.equal(new Set(memberIds.slice(-3)).size, 1);
    const granted = (await fixture.harness.database.query('SELECT write_permissions FROM memberships WHERE account_id=$1 AND event_id=$2', [fixture.manager.id, fixture.eventId])).rows[0];
    assert.deepEqual(granted.write_permissions, []);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, invitationLinkOnceOnly: true, sameIdAfterLossAnd403: true, passwordAndEmailAbsentFromStorage: true, statusOnly: true }, null, 2), { mode: 0o600 });
    console.log('Team: invitation, reset and event grant recovery passed with scoped receipts');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
