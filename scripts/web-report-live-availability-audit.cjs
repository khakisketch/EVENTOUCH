'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'report-live-availability');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const save = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    const send = async (command, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
    });
    const created = await send('report.create', { title: '합성 공유 보고서' });
    assert.equal(created.status, 201);
    assert.equal((await send('report.publish', { id: created.json.report.id })).status, 200);
    const original = await read();
    const damaged = structuredClone(original);
    damaged.participants = { original: '참가자 원본' }; damaged.modules = { original: '콘텐츠 원본' };
    damaged.photos = { original: '사진 원본' }; damaged.booths = [{ name: '합성 부스', used: 'broken', capacity: 10 }];
    await save(damaged);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `${f.baseUrl}/console/events/${f.eventId}/reports`;
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '결과 분석', exact: true }).click();
    const analysis = page.locator('[data-workspace-section="reports-analysis"]');
    await analysis.waitFor();
    if (process.argv.includes('--baseline')) {
      await page.screenshot({ path: path.join(out, 'before-analysis-1280.png'), fullPage: true });
      assert.match(await analysis.innerText(), /취소 제외 등록 \(명\)/);
      assert.match(await analysis.innerText(), /누적 입장률/);
      assert.doesNotMatch(await analysis.innerText(), /확인할 수 없/);
      await page.getByRole('tab', { name: '행사 마감' }).click();
      assert.match(await page.innerText('body'), /승인 대기\s*0명/);
      await page.screenshot({ path: path.join(out, 'before-close-1280.png'), fullPage: true });
      console.log('REPRODUCED: malformed sources become zero in live analysis and event close');
      return;
    }
    assert.match(await analysis.innerText(), /참가.*확인할 수 없/);
    assert.doesNotMatch(await analysis.innerText(), /누적 입장률 \(%\)/);
    await analysis.locator('summary').filter({ hasText: '그룹·부스·프로그램별 상세 집계' }).click();
    const text = await analysis.innerText();
    assert.match(text, /부스.*확인할 수 없/);
    assert.match(text, /참여 콘텐츠.*확인할 수 없/);
    assert.match(text, /사진.*확인할 수 없/);
    assert.doesNotMatch(text, /승인 사진 0건|부스 데이터가 없습니다|참여 기록이 없습니다/);
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `after-analysis-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('tab', { name: '행사 마감' }).click();
    assert.match(await page.innerText('body'), /마감.*확인할 수 없/);
    assert.doesNotMatch(await page.innerText('body'), /승인 대기\s*0명/);
    await page.screenshot({ path: path.join(out, 'after-close-1280.png'), fullPage: true });
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().isDisabled(), true);
    assert.match(await page.innerText('body'), /보고서를 만들 수 없/);
    assert.deepEqual(await read(), damaged, 'read and blocked actions preserve source data');
    await page.locator('li').filter({ hasText: '합성 공유 보고서' }).getByRole('button', { name: '내용 보기' }).click();
    assert.match(await page.innerText('body'), /최근 참가·입장 집계를 확인할 수 없어 저장된 보고서와 비교할 수 없습니다/);
    await page.getByRole('button', { name: '새 버전 만들기', exact: true }).click();
    assert.equal(await page.getByRole('radio', { name: '현재 집계를 새로 반영' }).isDisabled(), true);
    assert.equal(await page.getByRole('radio', { name: '이 보고서의 집계 유지' }).isChecked(), true);
    await page.getByRole('button', { name: '새 버전 만들기', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('새 보고서 버전을 만들었습니다'));
    let afterCopy = await read();
    const copy = afterCopy.reports.find(report => report.parentId === created.json.report.id);
    assert.deepEqual(copy.snapshot, created.json.report.snapshot, 'the existing frozen report remains reusable');
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    await page.locator('li').filter({ hasText: '합성 공유 보고서' }).filter({ hasText: '초안' }).getByRole('button', { name: '내용 보기' }).click();
    await page.getByRole('button', { name: '내용 편집', exact: true }).click();
    await page.locator('#report-subtitle').fill('합성 변경');
    await page.getByRole('dialog').getByRole('button', { name: '수정 저장', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    afterCopy = await read();
    assert.equal(afterCopy.reports.find(report => report.id === copy.id).subtitle, '합성 변경');
    assert.deepEqual(afterCopy.reports.find(report => report.id === copy.id).snapshot, copy.snapshot, 'editing a draft leaves its frozen snapshot untouched');
    const partlyRepaired = structuredClone(afterCopy);
    partlyRepaired.participants = original.participants; partlyRepaired.modules = original.modules;
    partlyRepaired.booths = original.booths; partlyRepaired.photos = { original: '사진 원본' };
    await save(partlyRepaired);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '결과 분석' }).click();
    assert.match(await analysis.innerText(), /취소 제외 등록 \(명\)/, 'available attendance remains visible');
    assert.match(await analysis.innerText(), /사진 자료를 확인할 수 없습니다/, 'partial availability is visible without expanding details');
    await analysis.locator('summary').filter({ hasText: '그룹·부스·프로그램별 상세 집계' }).click();
    assert.match(await analysis.innerText(), /사진.*확인할 수 없/);
    await page.screenshot({ path: path.join(out, 'after-partial-1280.png'), fullPage: true });
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().isDisabled(), true);
    const restored = await read(); restored.photos = original.photos; await save(restored);
    await page.getByRole('button', { name: '보고서 자료 다시 확인', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '보고서 만들기' && !button.disabled));
    await page.getByRole('tab', { name: '결과 분석', exact: true }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('사진 자료를 확인할 수 없'));
    assert.match(await analysis.innerText(), /취소 제외 등록 \(명\)/);
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().isEnabled(), true);
    for (const missing of ['participants', 'reportSourceAvailability']) {
      const bootstrap = `**/api/events/${f.eventId}/bootstrap`;
      await page.route(bootstrap, async route => {
        const response = await route.fetch(); const data = await response.json();
        delete data.state.workspaces[f.eventId][missing];
        await route.fulfill({ response, json: data });
      });
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: '결과 분석', exact: true }).click();
      assert.match(await analysis.innerText(), /참가.*확인할 수 없/, `${missing} must not become zero`);
      await page.getByRole('tab', { name: '보고서', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().isDisabled(), true);
      await page.unroute(bootstrap);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: live partial availability, blocked unsafe close/create, restoration');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
