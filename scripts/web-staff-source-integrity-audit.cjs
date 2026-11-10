'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk } = require('./audit-staff-direction.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'staff-source-integrity');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const save = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    const original = await read();
    const damaged = structuredClone(original); damaged.participants = { original: '합성 명단 원본' }; damaged.checks = { original: '합성 출입 기록' };
    await save(damaged);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    await confirmInitialStaffDesk(page);
    if (process.argv.includes('--baseline')) {
      await page.getByText('카메라가 안 될 때 · 참가자 명단 확인').click();
      await page.locator('#staff-manual-search').fill('합성');
      assert.match(await page.innerText('body'), /일치하는 참가자가 없습니다/);
      assert.match(await page.innerText('body'), /아직 처리 기록이 없습니다/);
      await page.screenshot({ path: path.join(out, 'before-390.png'), fullPage: true });
      console.log('REPRODUCED: missing staff roster and checks appear empty');
      return;
    }
    const warning = page.getByRole('alert').filter({ hasText: '입퇴장을 잠시 멈췄습니다' });
    await warning.waitFor();
    assert.match(await warning.innerText(), /참가자 명단 · 출입 기록/);
    assert.equal(await page.getByRole('button', { name: '카메라로 스캔' }).isDisabled(), true);
    assert.equal(await page.locator('#staff-manual-search').isDisabled(), true);
    assert.match(await page.innerText('body'), /출입 기록을 확인할 수 없습니다/);
    assert.doesNotMatch(await page.innerText('body'), /아직 처리 기록이 없습니다/);
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `unavailable-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await save(original);
    await warning.getByRole('button', { name: '업무 정보 다시 확인' }).click();
    await warning.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '카메라로 스캔' }).isEnabled(), true);
    const bootstrapRoute = '**/api/bootstrap';
    await page.route(bootstrapRoute, async route => {
      const response = await route.fetch(); const body = await response.json();
      delete body.state.workspaces[f.eventId].participantsAvailable;
      delete body.state.workspaces[f.eventId].checksAvailable;
      await route.fulfill({ response, json: body });
    });
    await page.reload(); await confirmInitialStaffDesk(page);
    await warning.waitFor();
    assert.equal(await page.getByRole('button', { name: '카메라로 스캔' }).isDisabled(), true, 'older servers without source markers fail closed');
    await page.unroute(bootstrapRoute);
    await warning.getByRole('button', { name: '업무 정보 다시 확인' }).click();
    await warning.waitFor({ state: 'hidden' });
    await page.getByText('카메라가 안 될 때 · 참가자 명단 확인').click();
    const person = original.participants.find(item => item.name.startsWith('감사 참가자') && item.status === 'APPROVED' && item.company);
    assert.ok(person, 'fixture has a uniquely identifiable participant');
    await page.locator('#staff-manual-search').fill(person.name);
    await page.getByRole('button', { name: `${person.name} ${person.company} 선택`, exact: true }).click();
    await page.getByLabel('이름·소속을 직접 확인했습니다').check();
    const changed = await read(); changed.checks = [{}]; await save(changed);
    const [denied] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.command === 'check.scan'),
      page.getByRole('button', { name: '확인한 참가자 입장 처리' }).click(),
    ]);
    assert.equal(denied.status(), 409); assert.equal((await denied.json()).code, 'CHECK_SOURCE_UNAVAILABLE');
    assert.deepEqual((await read()).checks, [{}]);
    assert.equal(await page.locator('#staff-manual-search').inputValue(), person.name);
    const failure = page.getByRole('region', { name: '스캔 실패와 복구' });
    await failure.getByRole('button', { name: '업무 정보 다시 확인' }).click();
    await warning.waitFor();
    assert.match(await warning.innerText(), /출입 기록/);
    assert.equal(await page.getByRole('button', { name: '카메라로 스캔' }).isDisabled(), true);
    assert.equal(await page.locator('#staff-manual-search').inputValue(), person.name);
    await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    await warning.getByRole('button', { name: '업무 정보 다시 확인' }).click();
    await page.getByText(/업무 정보를 불러오지 못했습니다/).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '카메라로 스캔' }).isDisabled(), true);
    const repaired = await read(); repaired.checks = original.checks; await save(repaired);
    await warning.getByRole('button', { name: '업무 정보 다시 확인' }).click();
    await warning.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#staff-manual-search').inputValue(), person.name);
    await page.getByLabel('이름·소속을 직접 확인했습니다').check();
    const [applied] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.command === 'check.scan'),
      page.getByRole('button', { name: '확인한 참가자 입장 처리' }).click(),
    ]);
    assert.equal(applied.status(), 200);
    assert.equal((await read()).checks.filter(item => item?.participantId === person.id).length, 1);
    await page.getByText('다음 참가자를 스캔하세요.').waitFor();
    await page.screenshot({ path: path.join(out, 'recovered-390.png'), fullPage: true });
    console.log('PASS: staff source unavailable, preserved input, failed refresh, repair and single check-in');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
