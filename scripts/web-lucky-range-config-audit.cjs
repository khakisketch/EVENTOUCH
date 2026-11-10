'use strict';
// Real UI and command path with isolated synthetic event data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'lucky-range-config'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, page;
  try {
    const db = f.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const reset = async () => { const ws = await read(); ws.luckyNumbers = []; ws.luckyConfig = { min: 1, max: 10 }; await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]); };
    const secondId = `range-manager-${crypto.randomUUID()}`;
    await f.helpers.insertAccount(db, { orgId: f.helpers.LEGACY_ORG, id: secondId, role: 'MANAGER', name: '다른 합성 운영자', email: `${secondId}@example.test` });
    await f.helpers.insertMembership(db, secondId, f.eventId, ['all']);
    const secondCookie = await f.helpers.sessionCookie(f.harness, secondId);
    const cmd = async (command, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie: secondCookie, body: { commandId: crypto.randomUUID(), command, payload } });
    await reset(); assert.equal((await cmd('event.features', { features: ['draw'] })).status, 200);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await context.newPage(); page.on('dialog', dialog => dialog.accept());
    const open = async () => { await page.goto(`${f.baseUrl}/console/events/${f.eventId}/draws`); await page.getByRole('tab', { name: '럭키번호', exact: true }).click(); const summary = page.locator('summary').filter({ hasText: '럭키번호 범위 설정' }); if (!await summary.locator('..').evaluate(el => el.open)) await summary.click(); };
    const input = () => page.getByLabel('최대 번호');
    const save = () => page.getByRole('button', { name: '번호 범위 저장', exact: true });
    const conflict = () => page.getByRole('region', { name: '번호 범위가 변경됐습니다' });
    await open(); await input().fill('15'); assert.equal((await cmd('lucky.config.save', { min: 1, max: 20 })).status, 200); await save().click();
    await conflict().getByText(/현재 저장된 범위는 1–20, 입력한 범위는 1–15/).waitFor();
    assert.equal((await read()).luckyConfig.max, 20); assert.equal(await input().inputValue(), '15'); assert.equal(await save().isDisabled(), true);
    await page.screenshot({ path: path.join(out, 'conflict-1280.png'), fullPage: true });
    await page.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      if (width === 390) await page.screenshot({ path: path.join(out, 'conflict-390.png'), fullPage: true });
    }
    await conflict().getByRole('button', { name: '최신 범위 사용' }).focus(); await page.keyboard.press('Enter');
    assert.equal(await input().inputValue(), '20'); assert.equal((await read()).luckyConfig.max, 20);
    // Keeping the edited draft is an explicit review step, not an automatic save.
    await input().fill('15'); assert.equal((await cmd('lucky.config.save', { min: 1, max: 25 })).status, 200); await save().click();
    await conflict().getByText(/현재 저장된 범위는 1–25, 입력한 범위는 1–15/).waitFor();
    await conflict().getByRole('button', { name: '입력 유지하고 다시 검토' }).click();
    assert.equal((await read()).luckyConfig.max, 25); assert.equal(await input().inputValue(), '15');
    await save().click(); await page.getByText('럭키번호 범위를 저장했습니다.').waitFor(); assert.equal((await read()).luckyConfig.max, 15);
    // A failed conflict refresh preserves the input until a successful retry.
    await reset(); await open(); await input().fill('14'); assert.equal((await cmd('lucky.config.save', { min: 1, max: 20 })).status, 200);
    let failRefresh = true;
    const failOnce = async route => { if (failRefresh) { failRefresh = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); } return route.continue(); };
    await page.route('**/api/events/*/bootstrap', failOnce); await save().click();
    await conflict().getByText('최신 범위를 불러오지 못했습니다. 입력한 값은 유지됩니다.').waitFor();
    assert.equal(await input().inputValue(), '14'); assert.equal((await read()).luckyConfig.max, 20);
    await conflict().getByRole('button', { name: '최신 범위 다시 확인' }).click(); await conflict().getByText(/현재 저장된 범위는 1–20, 입력한 범위는 1–14/).waitFor(); await page.unroute('**/api/events/*/bootstrap', failOnce);
    // A committed save with a lost response is replayed under the same ID;
    // if another operator subsequently changes the range, the clean form shows that latest value.
    await reset(); await open(); await input().fill('15'); const requests = []; let loseFirst = true;
    const lose = async route => { const body = route.request().postDataJSON(); if (body?.command !== 'lucky.config.save-reviewed') return route.continue(); requests.push(body); if (loseFirst) { loseFirst = false; await route.fetch(); return route.abort('failed'); } return route.continue(); };
    await page.route('**/commands', lose); await save().click(); const recovery = page.getByRole('region', { name: '추첨·투표 처리 확인 필요' }); await recovery.waitFor();
    assert.equal((await read()).luckyConfig.max, 15); assert.equal((await cmd('lucky.config.save', { min: 1, max: 20 })).status, 200);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click(); await recovery.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('#lucky-max')?.value === '20');
    assert.equal((await read()).luckyConfig.max, 20); assert.equal(requests.length, 2); assert.equal(requests[0].commandId, requests[1].commandId);
    await page.unroute('**/commands', lose);
    // Edits made while the response is missing must survive recovery even if
    // the operator typed the value that was saved before the request began.
    await reset(); await open(); await input().fill('15'); requests.length = 0; loseFirst = true;
    await page.route('**/commands', lose); await save().click(); await recovery.waitFor();
    await input().fill('10'); assert.equal((await cmd('lucky.config.save', { min: 1, max: 20 })).status, 200);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click(); await recovery.waitFor({ state: 'detached' });
    assert.equal(await input().inputValue(), '10'); assert.equal((await read()).luckyConfig.max, 20);
    await page.getByText('입력한 범위는 아직 저장되지 않았습니다. 현재 저장된 범위는 1–20입니다.').waitFor();
    await save().click(); await conflict().getByText(/현재 저장된 범위는 1–20, 입력한 범위는 1–10/).waitFor();
    assert.equal((await read()).luckyConfig.max, 20); await page.unroute('**/commands', lose);
    // A request dropped before it reaches the server remains unconfirmed even
    // when a retry encounters a changed range; it must not be treated as saved.
    await reset(); await open(); await input().fill('15'); requests.length = 0; let dropFirst = true;
    const drop = async route => { const body = route.request().postDataJSON(); if (body?.command !== 'lucky.config.save-reviewed') return route.continue(); requests.push(body); if (dropFirst) { dropFirst = false; return route.abort('failed'); } return route.continue(); };
    await page.route('**/commands', drop); await save().click(); await recovery.waitFor();
    assert.equal((await read()).luckyConfig.max, 10); assert.equal((await cmd('lucky.config.save', { min: 1, max: 20 })).status, 200);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await recovery.getByRole('alert').filter({ hasText: /이전 요청의 처리 여부를 확인하지 못했습니다/ }).waitFor();
    assert.equal((await read()).luckyConfig.max, 20); assert.equal(await input().inputValue(), '15'); assert.equal(requests[0].commandId, requests[1].commandId);
    await recovery.getByRole('button', { name: '확인 전 그만두기' }).click(); await recovery.getByRole('button', { name: '확인 그만두기', exact: true }).click();
    await recovery.waitFor({ state: 'detached' }); await page.unroute('**/commands', drop);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, conflictingSettings: true, keepOrDiscardDraft: true, failedRefresh: true, replayAfterChange: true, editedDuringRecovery: true, droppedBeforeServerRemainsUnconfirmed: true, widths: [320, 390, 1280], physicalDevices: false }, null, 2), { mode: 0o600 });
    console.log('PASS: lucky range conflict, explicit resolution, refresh failure and receipt replay');
  } catch (error) { if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
