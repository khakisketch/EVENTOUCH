'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const before = process.argv.includes('--before');
const unknownBefore = process.argv.includes('--unknown-before');
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, unknownBefore ? 'presence-unknown-before' : before ? 'presence-before' : 'presence-after');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const command = async (command, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
    method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
  });
  try {
    const person = (await read()).participants[0];
    if (unknownBefore) {
      const damaged = await read(); damaged.participants[0].inside = null;
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(damaged)]);
    }
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.locator('#roster-search').fill(person.name);
    await page.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: person.name });
    await dialog.getByLabel(`${person.name} 상태 변경`).waitFor();
    if (unknownBefore) {
      await dialog.getByText('미입장', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(out, 'unknown-shown-as-absent-1280.png'), fullPage: true });
      console.log('Confirmed prior behavior: unknown presence displayed as not entered'); return;
    }
    const enter = await command('check.scan', { deskId: f.deskId, ticket: person.ticket, expectedAction: 'IN' });
    assert.equal(enter.status, 200, JSON.stringify(enter.json));
    await dialog.getByLabel(`${person.name} 상태 변경`).selectOption('PENDING');
    if (before) {
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
      await page.waitForTimeout(300);
      const now = (await read()).participants.find(p => p.id === person.id);
      assert.equal(now.status, 'PENDING'); assert.equal(now.inside, true);
      await page.screenshot({ path: path.join(out, 'stale-status-1280.png'), fullPage: true });
      console.log('Confirmed prior behavior: approval changed while inside'); return;
    }
    await dialog.getByRole('alert').getByText(/입장 중/).waitFor();
    assert.equal((await read()).participants.find(p => p.id === person.id).status, 'APPROVED');
    assert.equal(await dialog.getByLabel(`${person.name} 상태 변경`).inputValue(), 'APPROVED');
    assert.equal(await dialog.getByRole('alert').count(), 1);
    const statusSelect = dialog.getByLabel(`${person.name} 상태 변경`);
    assert.equal(await statusSelect.getAttribute('aria-describedby'), 'roster-inspector-status-error');
    await statusSelect.focus();
    await page.keyboard.press('Tab');
    // Reopened 2026-11-24 (policy decision 4): the 개인정보 삭제 zone is the last control of the sheet, so it sits between the status select and 닫기 in Tab order.
    if (await dialog.getByRole('button', { name: /^개인정보 삭제/ }).evaluate(el => el === document.activeElement).catch(() => false)) await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: '닫기', exact: true }).evaluate(el => el === document.activeElement), true);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await dialog.getByRole('alert').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `overflow ${width}`);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), [], `axe ${width}`);
      await page.screenshot({ path: path.join(out, `guard-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByLabel(`${person.name} 상태 변경`).selectOption('CANCELLED');
    const cancelResponse = page.waitForResponse(response => response.url().endsWith(`/api/events/${f.eventId}/commands`) &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.payload?.status === 'CANCELLED');
    await dialog.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '신청 취소하기', exact: true }).click();
    assert.equal((await cancelResponse).status(), 409);
    await dialog.getByRole('alert').getByText(/먼저 퇴장/).waitFor();
    assert.equal((await read()).participants.find(p => p.id === person.id).status, 'APPROVED');
    const newDesk = await command('desk.save', { name: '합성 퇴장 데스크', action: 'OUT', mode: 'desk', open: true });
    assert.equal(newDesk.status, 201, JSON.stringify(newDesk.json));
    const exit = await command('check.scan', { deskId: newDesk.json.desk.id, ticket: person.ticket, expectedAction: 'OUT' });
    assert.equal(exit.status, 200, JSON.stringify(exit.json));
    const statusResponse = page.waitForResponse(response => response.url().endsWith(`/api/events/${f.eventId}/commands`) &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.command === 'participant.status');
    await dialog.getByLabel(`${person.name} 상태 변경`).selectOption('PENDING');
    assert.equal((await statusResponse).status(), 200);
    await dialog.getByLabel(`${person.name} 상태 변경`).waitFor();
    await page.waitForFunction(async (id) => {
      const select = document.querySelector(`select[aria-label="${id} 상태 변경"]`);
      return select && select.value === 'PENDING';
    }, person.name);
    const afterExit = (await read()).participants.find(p => p.id === person.id);
    assert.equal(afterExit.status, 'PENDING'); assert.equal(afterExit.inside, false);

    // A dropped response after a different person's committed change must
    // remain recoverable inside the inspector using the exact same request.
    const other = (await read()).participants[1];
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await page.locator('#roster-search').fill(other.name);
    await page.getByRole('button', { name: `${other.name} 참가자 상세`, exact: true }).click();
    const otherDialog = page.getByRole('dialog', { name: other.name });
    const ids = []; let drop = true;
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'participant.status') return route.continue();
      ids.push(body.commandId);
      if (!drop) return route.continue();
      drop = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      return route.abort('failed');
    });
    await otherDialog.getByLabel(`${other.name} 상태 변경`).selectOption('PENDING');
    const retry = otherDialog.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true });
    await retry.waitFor();
    await page.screenshot({ path: path.join(out, 'uncertain-1280.png'), fullPage: true });
    await retry.click();
    await retry.waitFor({ state: 'hidden' });
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
    assert.equal((await read()).participants.find(p => p.id === other.id).status, 'PENDING');
    await otherDialog.getByRole('button', { name: '닫기', exact: true }).click();
    const damaged = await read(); damaged.participants.find(p => p.id === other.id).inside = null;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(damaged)]);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.locator('#roster-search').fill(other.name);
    await page.getByRole('button', { name: `${other.name} 참가자 상세`, exact: true }).click();
    await otherDialog.getByText('확인 필요', { exact: true }).waitFor();
    await otherDialog.getByText(/출입 기록을 확인할 수 없습니다/).waitFor();
    await page.screenshot({ path: path.join(out, 'unknown-presence-1280.png'), fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await otherDialog.getByText(/출입 기록을 확인할 수 없습니다/).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `unknown-presence-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await otherDialog.getByRole('button', { name: '닫기', exact: true }).click();
    await page.locator('summary[aria-label="내보내기·가져오기"]').click();
    const csvDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: /CSV 내보내기 · 검색·필터 결과 1명/ }).click();
    const csv = fs.readFileSync(await (await csvDownload).path(), 'utf8');
    assert.match(csv, /확인 필요/);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?attendance=NOT_ENTERED&q=${encodeURIComponent(other.name)}`);
    await page.locator('#roster-search').waitFor();
    await page.getByRole('heading', { name: '조건에 맞는 참가자가 없습니다.', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: `${other.name} 참가자 상세`, exact: true }).count(), 0, 'unknown is excluded from the not-entered filter');
    assert.deepEqual(errors, []);
    console.log('Presence guard, recovery, retry, unknown presence and export passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
