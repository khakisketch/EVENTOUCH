'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'archive-preconditions');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const save = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    const event = (await f.harness.database.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    event.stage = 'ENDED'; await f.harness.database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [f.eventId, JSON.stringify(event)]);
    const source = await read(); const modules = source.modules, participants = source.participants, checks = source.checks;
    source.modules = { original: '합성 참여 콘텐츠 원본' }; source.registrationOpen = false; await save(source);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.argv.includes('--baseline') || process.argv.includes('--baseline-roster')) {
      const damaged = await read(); damaged.participants = { original: '합성 참가자 원본' }; await save(damaged);
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}`, { waitUntil: 'networkidle' });
      assert.doesNotMatch(await page.innerText('body'), /참가자 자료를 확인할 수 없/);
      await page.screenshot({ path: path.join(out, 'before-overview-1280.png'), fullPage: true });
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`, { waitUntil: 'networkidle' });
      assert.match(await page.innerText('body'), /아직 등록된 참가자가 없습니다/);
      await page.screenshot({ path: path.join(out, 'before-participants-1280.png'), fullPage: true });
      if (process.argv.includes('--baseline-roster')) { console.log('REPRODUCED: unreadable roster appears empty'); return; }
      damaged.participants = participants; await save(damaged);
    }
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/settings`, { waitUntil: 'networkidle' });
    const stage = page.locator('[data-workspace-section="settings-stage"]');
    await stage.waitFor();
    const archive = stage.getByRole('button', { name: '보관 단계로 전환', exact: true });
    if (process.argv.includes('--baseline')) {
      assert.equal(await archive.isEnabled(), true, 'baseline offers archive although module source is malformed');
      assert.doesNotMatch(await stage.innerText(), /확인할 수 없/);
      await page.screenshot({ path: path.join(out, 'before-settings-1280.png'), fullPage: true });
      console.log('REPRODUCED: settings offers archive when program state is unavailable'); return;
    }
    assert.equal(await archive.isDisabled(), true);
    assert.match(await stage.innerText(), /참여 콘텐츠 상태를 확인할 수 없어/);
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `settings-${width}.png`), fullPage: true });
    }
    const damaged = await read(); damaged.participants = { original: '합성 참가자 원본' }; await save(damaged);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`, { waitUntil: 'networkidle' });
    assert.match(await page.innerText('body'), /참가자.*참여 콘텐츠 자료를 확인할 수 없/);
    assert.match(await page.innerText('body'), /집계를 표시할 수 없습니다/);
    assert.equal(await page.getByRole('progressbar').count(), 0);
    await page.locator('summary').filter({ hasText: '기간 분석' }).click();
    assert.match(await page.innerText('body'), /기간 분석을 표시할 수 없습니다/);
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `overview-unavailable-${width}.png`), fullPage: true });
    }
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`, { waitUntil: 'networkidle' });
    assert.match(await page.innerText('body'), /참가자 명단을 확인할 수 없습니다/);
    assert.doesNotMatch(await page.innerText('body'), /아직 등록된 참가자가 없습니다/);
    await page.screenshot({ path: path.join(out, 'participants-unavailable-1280.png'), fullPage: true });
    damaged.participants = participants; damaged.modules = modules; damaged.checks = null; await save(damaged);
    await page.getByRole('button', { name: /다시 불러오기/ }).click();
    await page.getByRole('heading', { name: '참가자 목록', exact: true }).waitFor();
    const selected = page.getByRole('checkbox', { name: `${participants[0].name} 선택`, exact: true }).first();
    await selected.check();
    const stale = await read(); stale.participants = { original: '다시 확인할 참가자 원본' }; await save(stale);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByText(/이전에 확인한 목록을 표시합니다/).waitFor();
    assert.equal(await selected.isChecked(), true, 'a failed refresh preserves an existing selection');
    await page.locator('summary[aria-label="명단 도구"]').click();
    assert.equal(await page.getByRole('button', { name: /^엑셀 내보내기/ }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /^CSV 내보내기/ }).isDisabled(), true);
    stale.participants = participants; await save(stale);
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await page.getByText(/이전에 확인한 목록을 표시합니다/).waitFor({ state: 'hidden' });
    assert.equal(await selected.isChecked(), true);
    assert.equal(await page.getByRole('button', { name: /^엑셀 내보내기/ }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: /^CSV 내보내기/ }).isEnabled(), true);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`, { waitUntil: 'networkidle' });
    assert.match(await page.innerText('body'), /출입 기록.*확인할 수 없/);
    assert.equal(await page.getByRole('progressbar').count(), 0);
    damaged.checks = checks; damaged.modules = source.modules; await save(damaged);
    const closeReturn = encodeURIComponent(`/console/events/${f.eventId}/reports#event-close`);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/programs?closeReturn=${closeReturn}`, { waitUntil: 'networkidle' });
    const progress = page.locator('[data-close-progress]'); await progress.waitFor();
    assert.match(await progress.innerText(), /참여 콘텐츠.*확인할 수 없/);
    assert.doesNotMatch(await progress.innerText(), /진행 중 프로그램 없음|· 완료/);
    await page.screenshot({ path: path.join(out, 'programs-close-1280.png'), fullPage: true });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages?closeReturn=${closeReturn}`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('[data-close-inline-archive]').count(), 0);
    assert.match(await page.locator('[data-close-progress]').innerText(), /참여 콘텐츠.*확인할 수 없/);
    assert.deepEqual((await read()).modules, source.modules, 'unavailable data is not repaired by viewing');
    const repaired = await read(); repaired.modules = modules; await save(repaired);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/settings`, { waitUntil: 'networkidle' });
    assert.equal(await archive.isEnabled(), true, 'normal archive is available once sources are verified');
    const noIntake = await read(); noIntake.registrationOpen = null; await save(noIntake);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await archive.isDisabled(), true, 'an unknown intake state cannot become closed');
    noIntake.registrationOpen = false; await save(noIntake);
    await stage.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '보관 단계로 전환' && !button.disabled));
    const bootstrap = `**/api/events/${f.eventId}/bootstrap`;
    await page.route(bootstrap, async route => {
      const response = await route.fetch(); const body = await response.json();
      delete body.state.workspaces[f.eventId].archivePreconditions;
      await route.fulfill({ response, json: body });
    });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await archive.isDisabled(), true, 'an older server without proof is not assumed safe');
    await page.unroute(bootstrap);
    await stage.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '보관 단계로 전환' && !button.disabled));
    // A source may become unreadable after the confirmation is opened. The
    // transaction guards the actual click and the UI requires a fresh read.
    await archive.click();
    const changed = await read(); changed.modules = { original: '확인 중 변경된 자료' }; await save(changed);
    const [blocked] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/api/events/${f.eventId}/commands`) && response.request().method() === 'POST'),
      stage.getByRole('button', { name: '정말 전환합니다 · 보관 단계로', exact: true }).click(),
    ]);
    assert.equal(blocked.status(), 409); assert.equal((await blocked.json()).code, 'ARCHIVE_PRECONDITIONS_UNAVAILABLE');
    assert.equal(await archive.isDisabled(), true);
    const afterDenied = (await f.harness.database.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    assert.equal(afterDenied.stage, 'ENDED');
    await page.route(bootstrap, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    await stage.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '상태 다시 확인' && !button.disabled));
    assert.equal(await archive.isDisabled(), true);
    changed.modules = modules; await save(changed);
    await stage.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '보관 단계로 전환' && !button.disabled));
    await archive.click();
    await stage.getByRole('button', { name: '정말 전환합니다 · 보관 단계로', exact: true }).click();
    await page.getByText(/보관된 행사는 읽기 전용/).first().waitFor();
    const stored = (await f.harness.database.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    assert.equal(stored.stage, 'ARCHIVED');
    assert.deepEqual(errors, []);
    console.log('PASS: archive unavailable source, close navigation and repair-to-archive');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
