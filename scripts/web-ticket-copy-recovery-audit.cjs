'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const mode = process.argv[2] || 'direct';
  assert.ok(['direct', 'lost', 'storage', 'removed'].includes(mode));
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, `ticket-copy-recovery-${mode}`));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0];
  try {
    const initial = await read(), person = initial.payload.participants.find(p => p.status === 'APPROVED');
    assert.ok(person);
    const initialTicketRevision = Number.isSafeInteger(person.ticketRevision) ? person.ticketRevision : 0;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('clipboard denied'); } } }));
    const page = await context.newPage(), attempts = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'ticket.reissue-reviewed') return route.continue();
      attempts.push(body);
      if (mode === 'lost' && attempts.length === 1) {
        assert.equal((await route.fetch()).status(), 200);
        return route.abort('failed');
      }
      return route.continue();
    });
    const openRecovery = async () => {
      const panel = page.getByRole('region', { name: '처리 결과 확인' });
      await panel.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
      await panel.getByText(person.name, { exact: false }).waitFor();
      await panel.getByRole('button', { name: '발급된 링크 확인', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '티켓 재발급' });
      await dialog.getByRole('button', { name: '같은 요청으로 링크 받기', exact: true }).click();
      await dialog.getByRole('button', { name: '새 티켓 링크 복사', exact: true }).waitFor();
      return dialog;
    };
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    if (mode === 'storage') await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new Error('storage denied'); };
      Storage.prototype.removeItem = () => { throw new Error('storage denied'); };
    });
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).first().click();
    await page.getByRole('button', { name: '티켓 재발급', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '티켓 재발급' });
    await dialog.getByRole('button', { name: '기존 티켓 무효화 및 재발급' }).click();
    if (mode === 'lost') {
      await dialog.getByText(/재발급 결과를 확인하지 못했습니다/).waitFor();
      await page.reload();
      dialog = await openRecovery();
    } else await dialog.getByRole('button', { name: '새 티켓 링크 복사', exact: true }).waitFor();
    const issued = await read();
    const token = issued.payload.participants.find(p => p.id === person.id).ticket;
    assert.equal(issued.payload.participants.find(p => p.id === person.id).ticketRevision, initialTicketRevision + 1);
    await page.screenshot({ path: path.join(out, 'issued-before-reload.png'), fullPage: true });
    if (mode === 'removed') {
      const other = await context.newPage();
      await other.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
      await other.getByRole('region', { name: '처리 결과 확인' }).getByRole('button', { name: '목록에서 지우기' }).click();
      const removal = other.getByRole('dialog', { name: '처리 결과 확인에서 지우기' });
      await removal.getByRole('button', { name: '목록에서 지우기' }).click();
      await dialog.getByText(/복구 기록을 확인할 수 없습니다/).waitFor();
      assert.equal(await dialog.getByRole('button', { name: '링크 확인 완료' }).count(), 0);
      await dialog.getByRole('button', { name: '닫기', exact: true }).first().click();
      await dialog.getByText(/닫으면 이 링크를 다시 확인하기 어려울 수 있습니다/).waitFor();
      return;
    }
    if (mode === 'storage') {
      await dialog.getByText(/복구 기록을 확인할 수 없습니다/).waitFor();
      await dialog.getByRole('button', { name: '닫기', exact: true }).first().click();
      await dialog.getByText(/닫으면 이 링크를 다시 확인하기 어려울 수 있습니다/).waitFor();
      assert.equal((await read()).payload.participants.find(p => p.id === person.id).ticketRevision, initialTicketRevision + 1);
      return;
    }
    const storage = async () => page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    assert.equal((await storage()).includes(attempts[0].commandId), true, 'keep the original receipt until the operator finishes with the link');
    assert.equal((await storage()).includes(token), false, 'never persist bearer ticket');
    assert.equal((await storage()).includes(person.name), false, 'never persist participant name');
    await page.reload();
    dialog = await openRecovery();
    await dialog.getByRole('button', { name: '나중에 확인', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    dialog = await openRecovery();
    assert.deepEqual(attempts[attempts.length - 1], attempts[0], 'a repeated recovery uses the exact original request');
    assert.equal((await read()).revision, issued.revision, 'recovery does not issue a second ticket');
    await dialog.getByRole('button', { name: '새 티켓 링크 복사', exact: true }).click();
    await dialog.getByLabel('새 티켓 링크').waitFor();
    assert.ok((await dialog.getByLabel('새 티켓 링크').inputValue()).includes(encodeURIComponent(token)));
    await page.screenshot({ path: path.join(out, 'manual-copy-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(out, 'manual-copy-320.png'), fullPage: true });
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
    await dialog.getByRole('button', { name: '링크 확인 완료', exact: true }).click();
    await dialog.getByText(/링크를 복사하거나 보관했나요/).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '확인 완료');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
    assert.equal((await storage()).includes(attempts[0].commandId), true, 'the confirmation does not clear the recoverable request');
    await page.screenshot({ path: path.join(out, 'finish-confirmation-320.png'), fullPage: true });
    await dialog.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '취소', exact: true }).click();
    assert.equal((await storage()).includes(attempts[0].commandId), true, 'cancelling completion preserves recovery');
    await dialog.getByRole('button', { name: '링크 확인 완료', exact: true }).click();
    await dialog.getByRole('button', { name: '확인 완료', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await storage()).includes(attempts[0].commandId), false, 'explicit completion clears the receipt');
    await page.reload();
    assert.equal(await page.getByRole('region', { name: '처리 결과 확인' }).count(), 0);
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).first().click();
    assert.equal(await page.getByRole('button', { name: '티켓 재발급', exact: true }).isEnabled(), true, 'completion releases the ticket workflow');
    assert.deepEqual(errors, []);
    console.log(`ticket copy recovery ${mode}: passed`);
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
