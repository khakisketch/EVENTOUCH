'use strict';

// Frozen report rendering and print: genuine empty data differs from fields
// absent in an old or damaged synthetic snapshot. Never targets real data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'report-data-availability');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const save = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    const workspace = await read();
    workspace.modules = []; workspace.booths = []; workspace.photos = []; workspace.responses = [];
    await save(workspace);
    const create = async (title, sections = ['overview','attendance','programs','survey','photos']) => {
      const result = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: 'report.create', payload: { title, sections } },
      });
      assert.equal(result.status, 201); return result.json.report;
    };
    const empty = await create('합성 빈 보고서');
    assert.deepEqual([empty.snapshot.programs, empty.snapshot.booths, empty.snapshot.survey, empty.snapshot.photos], [[],[],[],[]]);
    const legacy = await create('합성 이전 보고서');
    const mixed = await create('합성 일부 확인 보고서');
    const overview = await create('합성 요약 전용 보고서', ['overview']);
    const changed = await read(); const old = changed.reports.find(item => item.id === legacy.id);
    delete old.snapshot.metrics; delete old.snapshot.programs; delete old.snapshot.booths;
    delete old.snapshot.survey; delete old.snapshot.photos;
    const partial = changed.reports.find(item => item.id === mixed.id).snapshot;
    partial.metrics = { total: '손상', checked: null, inside: 0, rate: 101, attendanceReview: 0, attendanceReviewVersion: 2 };
    partial.groups = [null, { name: '합성 게스트', count: 0 }];
    partial.programs = [{ name: '합성 질문', responses: 2 }, null, { name: '', responses: null }];
    partial.booths = '손상';
    partial.survey = [{ name: '합성 만족도', count: 1, average: 'NaN', questions: [null, { name: '진행 만족', count: null, average: null }] }];
    partial.photos = [null, { image: null, caption: '합성 사진 설명' }];
    await save(changed);
    const frozen = JSON.stringify((await read()).reports);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.__printText = ''; window.print = () => { window.__printText = document.getElementById('eventouch-report-print')?.textContent || ''; }; });
    const open = async report => {
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports#report-${report.id}`, { waitUntil: 'networkidle' });
      const article = page.locator('article'); await article.getByRole('heading', { name: report.title, exact: true }).waitFor(); return article;
    };
    let article = await open(empty);
    await article.screenshot({ path: path.join(out, 'empty-1280.png') });
    if (process.argv.includes('--baseline')) {
      article = await open(legacy);
      await article.screenshot({ path: path.join(out, 'baseline-unavailable-1280.png') });
      const baseline = await article.innerText();
      assert.match(baseline, /승인 사진 0건/, 'baseline incorrectly treats absent photo data as zero');
      assert.doesNotMatch(baseline, /참가·입장/, 'baseline omits unavailable attendance entirely');
      console.log('REPRODUCED: absent frozen values appear empty or are omitted');
      return;
    }
    assert.match(await article.innerText(), /기록된 참여 콘텐츠와 부스가 없습니다/);
    assert.match(await article.innerText(), /저장 시점에 만족도 조사가 없습니다/);
    assert.match(await article.innerText(), /승인 사진 0건/);
    const print = page.getByRole('button', { name: '인쇄하기', exact: true });
    await print.click();
    await page.waitForFunction(() => window.__printText.length > 0);
    assert.match(await page.evaluate(() => window.__printText), /기록된 참여 콘텐츠와 부스가 없습니다/);
    await page.evaluate(() => { window.dispatchEvent(new Event('afterprint')); window.__printText = ''; });
    article = await open(legacy);
    await article.screenshot({ path: path.join(out, 'unavailable-1280.png') });
    const body = await article.innerText();
    assert.match(body, /저장된 참가·입장 집계를 확인할 수 없습니다/);
    assert.match(body, /저장된 참여 콘텐츠와 부스 정보를 확인할 수 없습니다/);
    assert.match(body, /저장된 만족도 정보를 확인할 수 없습니다/);
    assert.match(body, /저장된 승인 사진 정보를 확인할 수 없습니다/);
    assert.doesNotMatch(body, /승인 사진 0건/);
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width === 390) await article.screenshot({ path: path.join(out, 'unavailable-390.png') });
    }
    await page.getByRole('button', { name: '인쇄하기', exact: true }).click();
    await page.waitForFunction(() => window.__printText.length > 0);
    const printed = await page.evaluate(() => window.__printText);
    assert.match(printed, /저장된 만족도 정보를 확인할 수 없습니다/);
    assert.doesNotMatch(printed, /승인 사진 0건/);
    await page.evaluate(() => { window.dispatchEvent(new Event('afterprint')); window.__printText = ''; });
    await page.setViewportSize({ width: 1280, height: 900 });
    article = await open(mixed);
    const partialText = await article.innerText();
    assert.match(partialText, /등록 확인 불가 · 누적 입장 확인 불가 · 현재 입장 0명 · 입장률 확인 불가/);
    assert.match(partialText, /합성 질문 · 2건/);
    assert.match(partialText, /일부 참여 콘텐츠 정보를 확인할 수 없습니다/);
    assert.match(partialText, /저장된 부스 정보를 확인할 수 없습니다/);
    assert.match(partialText, /합성 만족도 · 응답 1명 · 평균 확인 불가/);
    assert.match(partialText, /진행 만족 · 평균 없음 · 확인 불가/);
    assert.match(partialText, /만족도 항목의 전부 또는 일부를 확인할 수 없습니다/);
    assert.match(partialText, /확인 가능한 사진 기록 1건/);
    assert.match(partialText, /일부 승인 사진 정보를 확인할 수 없습니다/);
    assert.match(partialText, /원본 파일을 확인할 수 없습니다/);
    await article.screenshot({ path: path.join(out, 'partial-1280.png') });
    await page.getByRole('button', { name: '인쇄하기', exact: true }).click();
    await page.waitForFunction(() => window.__printText.length > 0);
    assert.match(await page.evaluate(() => window.__printText), /현재 입장 0명 · 입장률 확인 불가/);
    await page.evaluate(() => { window.dispatchEvent(new Event('afterprint')); window.__printText = ''; });
    article = await open(overview);
    assert.equal(await article.getByRole('heading', { name: '참여 콘텐츠', exact: true }).count(), 0, 'unselected sections remain excluded');
    assert.equal(await article.getByRole('heading', { name: '행사 사진', exact: true }).count(), 0);
    assert.equal(JSON.stringify((await read()).reports), frozen, 'viewing and printing must not change the frozen reports');

    // A damaged source must not become a new, apparently empty frozen report.
    const damaged = await read();
    const savedPhotos = damaged.photos;
    damaged.photos = { original: '복구할 사진 자료' };
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await page.locator('#report-title').fill('합성 자료 확인 보고서');
    // Corrupt after the dialog was opened: the authoritative write guard must
    // still catch a change newer than the client-side availability projection.
    await save(damaged);
    await dialog.getByRole('button', { name: '보고서 만들기', exact: true }).click();
    const failure = dialog.getByRole('alert').filter({ hasText: '사진 자료를 확인할 수 없어 보고서를 만들 수 없습니다' });
    await failure.waitFor();
    assert.equal(await page.locator('#report-title').inputValue(), '합성 자료 확인 보고서');
    assert.deepEqual((await read()).photos, damaged.photos, 'the unavailable source remains untouched');
    assert.equal((await read()).reports.some(report => report.title === '합성 자료 확인 보고서'), false);
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) {
        await failure.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, `source-unavailable-${width}.png`) });
      }
    }
    await dialog.getByRole('button', { name: '자료 다시 확인', exact: true }).click();
    await dialog.getByText(/사진 자료를 확인할 수 없어 현재 집계로 보고서를 만들 수 없습니다/).waitFor();
    assert.equal(await page.locator('#report-title').inputValue(), '합성 자료 확인 보고서');
    assert.equal(await dialog.getByRole('button', { name: '보고서 만들기', exact: true }).isDisabled(), true);
    const repaired = await read(); repaired.photos = savedPhotos; await save(repaired);
    await dialog.getByRole('button', { name: '자료 다시 확인', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === '보고서 만들기' && !button.disabled));
    await dialog.getByRole('button', { name: '보고서 만들기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await read()).reports.filter(report => report.title === '합성 자료 확인 보고서').length, 1);
    assert.deepEqual(errors, []);
    console.log('PASS: empty versus unavailable snapshots, frozen data, print and damaged source recovery');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
