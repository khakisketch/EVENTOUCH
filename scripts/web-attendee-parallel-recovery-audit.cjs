'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { launchBrowser } = require(root + '/scripts/audit-browser.cjs');
const { startAuditFixture } = require(root + '/scripts/audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const axe = require(root + '/node_modules/axe-core').source;

async function main() {
  const out = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const codes = new Map();
  const supplier = http.createServer((req, res) => {
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      try {
        const message = JSON.parse(body).messages[0];
        const code = String(message.text).match(/인증번호 (\d{6})/)?.[1];
        if (!code) throw new Error('missing code');
        codes.set(String(message.to).replace(/\D/g, ''), code);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ groupInfo: { groupId: 'fixture-local' }, failedMessageList: [] }));
      } catch { res.writeHead(400); res.end(); }
    });
  });
  await new Promise(resolve => supplier.listen(0, '127.0.0.1', resolve));
  let fixture, browser;
  try {
    fixture = await startAuditFixture({ fixtureSolapiHost: `http://127.0.0.1:${supplier.address().port}` });
    const source = (await fixture.harness.database.query('SELECT e.payload AS event, w.payload AS workspace FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1', [fixture.eventId])).rows[0];
    const slug = `parallel-recovery-${fixture.suffix}`;
    await fixture.helpers.insertEvent(fixture.harness.database, { id: slug, slug, orgId: fixture.helpers.LEGACY_ORG,
      payload: { ...source.event, id: slug, slug, name: '합성 인증 행사' },
      workspace: { ...source.workspace, participants: [], checks: [], visits: [], assignments: [], messages: [], audit: [], verificationRequired: false },
    });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    const signup = async (ctx, name, phone) => {
      const tab = await ctx.newPage();
      await tab.goto(`${fixture.baseUrl}/event/${slug}/register`);
      await tab.locator('#field-name').fill(name);
      await tab.locator('#field-phone').fill(phone);
      if (await tab.locator('#consent').count()) await tab.locator('#consent').check();
      await tab.getByRole('button', { name: '신청하기', exact: true }).click();
      await tab.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
      await tab.close();
    };
    await signup(context, '합성 참가자 가', '01098002001');
    const other = await browser.newContext();
    await signup(other, '합성 참가자 나', '01098002002');
    await other.close();
    const a = await context.newPage(), b = await context.newPage();
    for (const [tab, phone] of [[a, '01098002001'], [b, '01098002002']]) {
      await tab.goto(`${fixture.baseUrl}/event/${slug}/ticket/recover`);
      await tab.getByLabel('신청할 때 입력한 연락처').fill(phone);
      const [challenge] = await Promise.all([tab.waitForResponse(response => response.url().includes('/verification/request')), tab.getByRole('button', { name: '인증번호 받기', exact: true }).click()]);
      assert.equal(challenge.status(), 200);
      await tab.getByLabel('인증번호 6자리').fill(codes.get(phone));
    }
    let releaseA;
    let confirmedA;
    const readyA = new Promise(resolve => { confirmedA = resolve; });
    const blockedA = new Promise(resolve => { releaseA = resolve; });
    await a.route('**/api/public/events/*/verification/confirm', async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      confirmedA();
      await blockedA;
      await route.fulfill({ response });
    });
    const clickA = a.getByRole('button', { name: '내 티켓 열기' }).click();
    await readyA;
    await b.getByRole('button', { name: '내 티켓 열기' }).click();
    await b.getByRole('heading', { name: '내 티켓' }).waitFor();
    releaseA();
    await clickA;
    await a.getByRole('heading', { name: '내 티켓' }).waitFor();
    const shownA = await a.locator('h2').first().innerText();
    const shownB = await b.locator('h2').first().innerText();
    await a.screenshot({ path: path.join(out, 'tab-a.png'), fullPage: true, mask: [a.getByRole('img', { name: /QR/ })] });
    await b.screenshot({ path: path.join(out, 'tab-b.png'), fullPage: true, mask: [b.getByRole('img', { name: /QR/ })] });
    const result = { intendedA: '합성 참가자 가', shownA, intendedB: '합성 참가자 나', shownB, responseOrder: 'A stored, B stored, B read, A response delivered', actualProvider: false };
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    assert.equal(shownB, '합성 참가자 나');
    assert.equal(shownA, '합성 참가자 가', '각 탭은 자신의 인증 대상 티켓을 표시해야 합니다');
    const registerMore = async (name, phone) => {
      const ctx = await browser.newContext();
      await signup(ctx, name, phone);
      await ctx.close();
    };
    await registerMore('합성 참가자 다', '01098002003');
    await registerMore('합성 참가자 라', '01098002004');
    await registerMore('합성 참가자 마', '01098002005');
    const prepare = async (tab, phone) => {
      await tab.goto(`${fixture.baseUrl}/event/${slug}/ticket/recover`);
      await tab.getByLabel('신청할 때 입력한 연락처').fill(phone);
      const [challenge] = await Promise.all([tab.waitForResponse(response => response.url().includes('/verification/request')), tab.getByRole('button', { name: '인증번호 받기', exact: true }).click()]);
      assert.equal(challenge.status(), 200);
      await tab.getByLabel('인증번호 6자리').fill(codes.get(phone));
    };
    const c = await context.newPage();
    const d = await context.newPage();
    await prepare(c, '01098002003');
    await prepare(d, '01098002004');
    await c.route('**/api/public/events/*/verification/confirm', async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort('failed');
    });
    await c.getByRole('button', { name: '내 티켓 열기' }).click();
    await c.getByText('인증 결과를 확인하지 못했습니다.', { exact: false }).waitFor();
    await d.getByRole('button', { name: '내 티켓 열기' }).click();
    await d.getByRole('img', { name: /합성 참가자 라님의/ }).waitFor();
    await c.getByRole('button', { name: '연결된 티켓 확인', exact: true }).click();
    await c.getByText('이 연락처로 연결된 티켓을 확인하지 못했습니다.', { exact: false }).waitFor();
    assert.equal(await c.getByRole('heading', { name: '내 티켓' }).count(), 0);

    const e = await context.newPage();
    await e.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith('eventouch.ticket.')) throw new DOMException('Blocked', 'SecurityError');
        return original.call(this, key, value);
      };
    });
    await prepare(e, '01098002005');
    let interrupted = false;
    await e.route('**/api/public/events/*/ticket', async route => {
      if (!interrupted) { interrupted = true; await route.abort('failed'); }
      else await route.continue();
    });
    await e.getByRole('button', { name: '내 티켓 열기' }).click();
    await e.getByRole('button', { name: '다시 시도', exact: true }).click();
    await e.getByRole('img', { name: /합성 참가자 마님의/ }).waitFor();
    await e.getByText('이 브라우저에서 탭 보관이 차단되어 있습니다.', { exact: false }).waitFor();
    assert.equal(interrupted, true);
    const pendingSlug = `pending-guidance-${fixture.suffix}`;
    await fixture.helpers.insertEvent(fixture.harness.database, { id: pendingSlug, slug: pendingSlug, orgId: fixture.helpers.LEGACY_ORG,
      payload: { ...source.event, id: pendingSlug, slug: pendingSlug, name: '합성 승인 대기 행사' },
      workspace: { ...source.workspace, participants: [], checks: [], visits: [], assignments: [], messages: [], audit: [], verificationRequired: false, approvalRequired: true },
    });
    const pendingContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await pendingContext.route('**/api/health', async route => {
      const original = await route.fetch();
      const payload = await original.json();
      await route.fulfill({ response: original, json: { ...payload, verification: 'none' } });
    });
    const pending = await pendingContext.newPage();
    await pending.goto(`${fixture.baseUrl}/event/${pendingSlug}/register`);
    await pending.locator('#field-name').fill('합성 승인 대기');
    await pending.locator('#field-phone').fill('01098002006');
    if (await pending.locator('#consent').count()) await pending.locator('#consent').check();
    await pending.getByRole('button', { name: '신청하기', exact: true }).click();
    await pending.getByRole('heading', { name: '내 티켓' }).waitFor();
    await pending.getByText('승인 대기', { exact: true }).first().waitFor();
    await pending.getByText('이 행사에서는 문자로 티켓을 다시 연결할 수 없어', { exact: false }).waitFor();
    await pending.getByText('탭을 찾을 수 없다면 행사 주최 측에 문의하세요.', { exact: false }).waitFor();
    assert.equal(await pending.getByRole('img', { name: /QR/ }).count(), 0);
    for (const width of [320, 390, 768, 1280]) {
      await pending.setViewportSize({ width, height: 900 });
      await pending.evaluate(axe);
      assert.equal(await pending.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(await pending.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
    }
    await pending.setViewportSize({ width: 390, height: 844 });
    await pending.screenshot({ path: path.join(out, 'pending-guidance-390.png'), fullPage: true });
    await pendingContext.close();
    fs.writeFileSync(path.join(out, 'additional.json'), JSON.stringify({ differentSessionRejected: true, blockedStorageInterruptedRequestRecovered: true, pendingWithoutSmsGuidance: true, actualProvider: false }, null, 2), { mode: 0o600 });
    console.log('both tabs match verified attendee');
  } finally {
    await browser?.close();
    await fixture?.close();
    await new Promise(resolve => supplier.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
