'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const mode = process.argv[2] || 'normal';
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, `ticket-reissue-resume-${mode}`));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload,revision FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0];
  try {
    const before = await read(); const person = before.payload.participants.find(p => p.status === 'APPROVED'); assert.ok(person);
    const initialRevision = Number.isSafeInteger(person.ticketRevision) ? person.ticketRevision : 0;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), attempts = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'ticket.reissue-reviewed') return route.continue();
      attempts.push(body);
      if (attempts.length === 1) {
        if (mode !== 'unconfirmed') assert.equal((await route.fetch()).status(), 200);
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).first().click();
    await page.getByRole('button', { name: '티켓 재발급', exact: true }).click();
    const first = page.getByRole('dialog', { name: '티켓 재발급' });
    await first.getByRole('button', { name: '기존 티켓 무효화 및 재발급' }).click();
    await first.getByText(/재발급 결과를 확인하지 못했습니다/).waitFor();
    const afterCommit = await read();
    if (mode !== 'unconfirmed') assert.equal(afterCommit.payload.participants.find(p => p.id === person.id).ticketRevision, initialRevision + 1);
    else assert.equal(afterCommit.payload.participants.find(p => p.id === person.id).ticket, person.ticket);
    await page.reload();
    if (mode === 'old') await page.route(url => url.pathname.includes('/command-receipts/') && url.searchParams.get('view') === 'ticket-reissue', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: JSON.stringify({ status: 'APPLIED', command: 'ticket.reissue-reviewed' }) });
    });
    const panel = page.getByRole('region', { name: '처리 결과 확인' });
    await panel.getByText('티켓 재발급', { exact: false }).waitFor();
    await panel.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    if (mode === 'unconfirmed') {
      await panel.getByText(/아직 처리 여부를 확인할 수 없습니다/).waitFor();
      assert.equal(await panel.getByRole('button', { name: '발급된 링크 확인' }).count(), 0);
      assert.equal(attempts.length, 1, 'status lookup never resends an uncommitted request');
      return;
    }
    if (mode === 'old') {
      await panel.getByText(/대상이나 현재 권한을 확인하지 못했습니다/).waitFor();
      assert.equal(await panel.getByRole('button', { name: '발급된 링크 확인' }).count(), 0);
      assert.equal(attempts.length, 1, 'an old status-only response cannot invent a target');
      return;
    }
    await panel.getByText(/서버에 티켓 재발급 기록이 있습니다/).waitFor();
    await page.screenshot({ path: path.join(out, 'recovery-before-1280.png'), fullPage: true });
    await panel.getByText(person.name, { exact: false }).waitFor({ timeout: 5000 });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, `recovery-${width}.png`), fullPage: true });
    }
    await page.addScriptTag({ content: axeSource });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
    if (mode === 'superseded') {
      const changed = await read(); changed.payload.participants.find(p => p.id === person.id).cancelled = true;
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb,revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(changed.payload)]);
    }
    if (mode === 'denied') await f.harness.database.query("UPDATE memberships SET write_permissions='[]'::jsonb WHERE account_id=$1 AND event_id=$2", [f.manager.id, f.eventId]);
    const open = panel.getByRole('button', { name: '발급된 링크 확인', exact: true });
    await open.focus(); await page.keyboard.press('Enter');
    const resumed = page.getByRole('dialog', { name: '티켓 재발급' });
    await resumed.getByRole('button', { name: '같은 요청으로 링크 받기', exact: true }).click();
    if (mode === 'superseded') {
      await resumed.getByText(/이 요청으로 발급한 티켓이 바뀌었거나 만료됐습니다/).waitFor();
      assert.equal(await resumed.getByRole('button', { name: '새 티켓 링크 복사' }).count(), 0);
      assert.equal((await read()).payload.participants.find(p => p.id === person.id).ticketRevision, initialRevision + 1);
      return;
    }
    if (mode === 'denied') {
      await resumed.getByText(/현재 권한으로 링크를 확인할 수 없습니다/).waitFor();
      assert.equal(await resumed.getByRole('button', { name: '새 티켓 링크 복사' }).count(), 0);
      assert.equal(await page.evaluate(id => [localStorage, sessionStorage].some(store => {
        for (let i = 0; i < store.length; i++) if ((store.getItem(store.key(i)) || '').includes(id)) return true;
        return false;
      }), attempts[0].commandId), true, 'revoked permission must not erase the unresolved pointer');
      return;
    }
    await resumed.getByRole('button', { name: '새 티켓 링크 복사', exact: true }).waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0], 'restored action repeats the original request exactly');
    const afterReplay = await read();
    assert.equal(afterReplay.revision, afterCommit.revision, 'recovering a committed link does not mint a second ticket');
    assert.equal(afterReplay.payload.participants.find(p => p.id === person.id).ticketRevision, initialRevision + 1);
    const persisted = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    assert.equal(persisted.includes(person.name), false, 'recovery pointers do not store names');
    assert.equal(persisted.includes(afterReplay.payload.participants.find(p => p.id === person.id).ticket), false, 'recovery pointers do not store bearer tickets');
    assert.deepEqual(errors, []);
    console.log(`ticket reissue resume ${mode}: passed`);
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
