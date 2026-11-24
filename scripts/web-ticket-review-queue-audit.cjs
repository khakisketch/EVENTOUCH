'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const mode = process.argv[2] || 'all';
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, `ticket-queue-${mode}`));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const w = await read();
    w.participants[0].ticketExpiresAt = '2020-01-01T00:00:00.000Z';
    w.participants[1].revoked = true;
    w.participants[2].ticket = 'malformed-synthetic';
    if (mode === 'reason') w.participants[6].cancelled = true;
    if (mode === 'unknown') w.participants[5].status = 'CANCELLED';
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(w)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors=[];
    page.on('pageerror', e => errors.push(e.message));
    if (mode === 'unknown') await page.route('**/api/events/*/bootstrap', async route => {
      const response = await route.fetch(); const body = await response.json();
      if (body.state?.workspaces?.[f.eventId]?.participants) {
        const people = body.state.workspaces[f.eventId].participants;
        delete people[3].ticketReview;
        people[4].ticketReview = 'NEW_SERVER_VALUE';
        delete people[5].ticketReview;
      }
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants${mode === 'concurrent' ? '' : '?ticket=review'}`);
    await page.getByRole('heading', { name: '참가자' }).first().waitFor();
    await page.getByText('감사 참가자 1', { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(out, 'before-1280.png'), fullPage: true });
    const row = name => page.getByRole('row').filter({ hasText: name });
    if (mode === 'unknown') {
      await page.getByText('감사 참가자 4', { exact: true }).first().waitFor({ timeout: 5000 });
      await row('감사 참가자 4').getByText('상태 확인 안 됨', { exact: true }).waitFor();
      await row('감사 참가자 5').getByText('상태 확인 안 됨', { exact: true }).waitFor();
      assert.equal(await row('감사 참가자 6').count(), 0, 'cancelled registrations are not presented as actionable ticket reviews');
      const search = page.getByPlaceholder('이름·소속·연락처 검색');
      await search.fill('감사 참가자 1');
      assert.equal(await page.getByText(/일부 티켓의 상태를 불러오지 못해 확인 목록에 함께 표시했습니다/).count(), 0, 'warning follows the active search scope');
      await search.fill('');
      await page.getByText(/일부 티켓의 상태를 불러오지 못해 확인 목록에 함께 표시했습니다/).waitFor();
      const details = page.getByRole('button', { name: '감사 참가자 4 참가자 상세' }).first();
      await details.focus();
      await page.keyboard.press('Enter');
      await page.getByText(/최신 목록을 새로고침한 뒤 다시 확인하세요/).waitFor();
      const reissue = page.getByRole('button', { name: '티켓 재발급', exact: true });
      assert.equal(await reissue.isDisabled(), true);
      assert.ok(await reissue.getAttribute('aria-describedby'));
      await page.screenshot({ path: path.join(out, 'unknown-details-1280.png'), fullPage: true });
    } else if (mode === 'reason') {
      await row('감사 참가자 1').getByText('티켓 만료', { exact: true }).waitFor({ timeout: 5000 });
      await row('감사 참가자 2').getByText('티켓 철회', { exact: true }).waitFor();
      await row('감사 참가자 3').getByText('티켓 정보 확인 필요', { exact: true }).waitFor();
      await row('감사 참가자 7').getByText('취소 상태 확인 필요', { exact: true }).waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: '감사 참가자 7 참가자 상세' }).first().click();
      await page.getByText(/신청 상태와 취소 기록이 일치하지 않습니다/).waitFor();
      assert.equal(await page.getByRole('button', { name: '티켓 재발급', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '닫기', exact: true }).last().click();
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const label = width === 1280 ? row('감사 참가자 1').getByText('티켓 만료', { exact: true })
          : page.locator('li').filter({ hasText: '감사 참가자 1' }).getByText('티켓 만료', { exact: true });
        await label.waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: path.join(out, `review-${width}.png`), fullPage: true });
      }
      const readerId = `ticket-reader-${randomUUID()}`;
      await f.helpers.insertAccount(f.harness.database, { id: readerId, role: 'MANAGER', name: '읽기 전용 담당자', email: `${readerId}@example.test`, orgId: f.helpers.LEGACY_ORG });
      await f.helpers.insertMembership(f.harness.database, readerId, f.eventId, []);
      const readerCookie = (await f.helpers.sessionCookie(f.harness, readerId)).split('=');
      const reader = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR' });
      await reader.addCookies([{ name: readerCookie[0], value: readerCookie.slice(1).join('='), url: f.baseUrl }]);
      const readerPage = await reader.newPage();
      await readerPage.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?ticket=review`);
      await readerPage.locator('li').filter({ hasText: '감사 참가자 1' }).getByText('티켓 만료', { exact: true }).waitFor();
      assert.equal(await readerPage.getByRole('button', { name: '티켓 재발급' }).count(), 0, 'read-only operators can review reasons without reissue authority');
      await reader.close();
    } else if (mode === 'concurrent') {
      await page.getByRole('button', { name: '감사 참가자 4 참가자 상세' }).first().click();
      await page.getByRole('button', { name: '티켓 재발급', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '티켓 재발급' });
      const changed = await read(), originalTicket = changed.participants[3].ticket;
      changed.participants[3].cancelled = true;
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(changed)]);
      await dialog.getByRole('button', { name: '기존 티켓 무효화 및 재발급' }).click();
      await dialog.getByText(/티켓이나 참가 상태가 바뀌어 이 재발급 요청을 중단했습니다/).waitFor();
      assert.equal((await read()).participants[3].ticket, originalTicket, 'concurrent cancellation flag cannot mint a ticket');
      await dialog.getByRole('button', { name: '최신 참가자 정보 보기' }).click();
      await page.getByText(/신청 상태와 취소 기록이 일치하지 않습니다/).waitFor();
      assert.equal(await page.getByRole('button', { name: '티켓 재발급', exact: true }).isDisabled(), true);
    } else {
      await page.getByRole('button', { name: '감사 참가자 1 참가자 상세' }).first().click();
      await page.getByRole('button', { name: '티켓 재발급', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '티켓 재발급' });
      let oldServer = true;
      await page.route('**/api/events/*/commands', route => {
        const body = route.request().postDataJSON();
        if (oldServer && body.command === 'ticket.reissue-reviewed') {
          oldServer = false;
          return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '지원하지 않는 참가자 작업입니다' }) });
        }
        return route.continue();
      });
      await dialog.getByRole('button', { name: '기존 티켓 무효화 및 재발급' }).click();
      await dialog.getByText('현재 서버에서는 티켓 상태를 확인해 재발급할 수 없습니다. 조직 관리자에게 업데이트를 문의하세요.').waitFor();
      assert.equal((await read()).participants[0].ticket, w.participants[0].ticket, 'an old server rejects before reissue');
      await dialog.getByRole('button', { name: '기존 티켓 무효화 및 재발급' }).click();
      await dialog.getByText('새 티켓을 발급했습니다. 링크를 복사해 해당 참가자에게 전달하세요.').waitFor();
      await dialog.getByRole('button', { name: '링크 확인 완료', exact: true }).click();
      await dialog.getByRole('button', { name: '확인 완료', exact: true }).click();
      await row('감사 참가자 1').waitFor({ state: 'hidden', timeout: 5000 });
      await page.getByText('감사 참가자 2', { exact: true }).first().waitFor();
      assert.equal(await page.getByText('티켓이 만료됐습니다.', { exact: false }).count(), 0, 'successful reload does not retain stale ticket state in the inspector');
    }
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
    assert.deepEqual(errors, []);
    console.log(`ticket review queue ${mode}: passed`);
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
