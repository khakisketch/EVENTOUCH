'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';

async function verifyPhotoPrint(fixture, browser, out, workspace) {
  const { baseUrl, eventId, manager, harness, helpers } = fixture;
  const apiEvent = `${harness.baseUrl}/api/events/${eventId}`;
  const command = async (command, payload, bearer) => {
    const result = await helpers.requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
      ...(bearer ? { bearer } : { cookie: manager.cookie }), method: 'POST',
      body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(result.status === 200 || result.status === 201, `${command}: ${result.status}`);
    return result.json;
  };
  const bytes = fs.readFileSync(path.join(__dirname, '../tests/fixtures/booth-map/synthetic-demo-floorplan.png'));
  const upload = await fetch(`${apiEvent}/files?name=report-photo.png&commandId=${crypto.randomUUID()}`, {
    method: 'POST', headers: { cookie: manager.cookie, 'content-type': 'image/png' }, body: bytes,
  });
  assert.equal(upload.status, 201);
  const { file } = await upload.json();
  const person = (await workspace()).participants.find(person => person.status === 'APPROVED' && !person.revoked);
  assert.ok(person?.ticket);
  await command('event.features', { features: ['photo'] });
  const caption = '고객 인쇄에 포함할 합성 행사 사진';
  const { photo } = await command('photo.submit', { image: file, caption }, person.ticket);
  await command('photo.moderate', { id: photo.id, status: 'APPROVED' });
  const { report } = await command('report.create', { title: '인쇄 사진 검증', sections: ['overview', 'photos'] });
  await command('report.publish', { id: report.id });
  const otherReport = (await workspace()).reports.find(item => item.title === '새로 검토할 보고서');
  assert.ok(otherReport);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  try {
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/events/${eventId}/commands`) {
        writes.push(request.postDataJSON()?.command);
      }
    });
    let unavailable = false;
    let release;
    let held = new Promise(resolve => { release = resolve; });
    const assetPath = `/api/events/${eventId}/files/${file.fileId}`;
    await page.route(url => url.pathname === assetPath, async route => {
      if (unavailable) return route.fulfill({ status: 503, body: 'unavailable' });
      await held;
      return route.continue();
    });
    await page.addInitScript(() => {
      window.printCalls = [];
      window.print = () => {
        const source = document.getElementById('eventouch-report-print');
        window.printCalls.push({
          imageWidths: Array.from(source.querySelectorAll('img'), image => image.naturalWidth),
          text: source.textContent,
        });
      };
    });
    const print = page.getByRole('button', { name: '인쇄하기', exact: true });
    const preparing = page.getByRole('button', { name: '인쇄 준비 중', exact: true });
    const clone = page.locator('#eventouch-report-print');
    const calls = () => page.evaluate(() => window.printCalls);
    const afterPrint = () => page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    const url = `${baseUrl}/console/events/${eventId}/reports?closeReport=${report.id}#report-${report.id}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await print.press('Enter');
    await preparing.waitFor();
    assert.equal(await preparing.getAttribute('aria-disabled'), 'true');
    assert.equal(await preparing.evaluate(button => button === document.activeElement), true);
    assert.equal((await calls()).length, 0, 'printing waits for the photo');
    await preparing.evaluate(button => button.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(out, 'print-preparing-390.png') });
    release();
    await page.waitForFunction(() => window.printCalls.length === 1);
    const [printed] = await calls();
    assert.equal(printed.imageWidths.length, 1);
    assert.ok(printed.imageWidths[0] > 0);
    assert.ok(printed.text.includes(caption));
    const pdf = await page.pdf({ path: path.join(out, 'report-with-photo.pdf'), format: 'A4', printBackground: true });
    assert.match(pdf.toString('latin1'), /\/Subtype\s*\/Image/, 'the PDF contains the approved image');
    await afterPrint();
    assert.equal(await clone.count(), 0);

    unavailable = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await print.press('Enter');
    const photoError = page.getByRole('alert').filter({ hasText: '보고서 사진을 불러오지 못했습니다' });
    await photoError.waitFor();
    assert.equal((await calls()).length, 0, 'a failed photo does not silently open print');
    assert.equal(await clone.count(), 0);
    await photoError.evaluate(alert => alert.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(out, 'print-error-390.png') });
    await page.evaluate(axeSource);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations
        .filter(issue => ['serious', 'critical'].includes(issue.impact)).map(issue => issue.id)), []);
    }
    await page.getByRole('button', { name: '사진 제외하고 인쇄', exact: true }).press('Enter');
    await page.waitForFunction(() => window.printCalls.length === 1);
    const [withoutPhoto] = await calls();
    assert.deepEqual(withoutPhoto.imageWidths, []);
    assert.ok(withoutPhoto.text.includes(caption) && withoutPhoto.text.includes('사진은 제외했습니다'));
    await afterPrint();
    unavailable = false;
    await print.press('Enter');
    await page.waitForFunction(() => window.printCalls.length === 2);
    assert.ok((await calls())[1].imageWidths[0] > 0);
    await afterPrint();

    held = new Promise(resolve => { release = resolve; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await print.press('Enter');
    await preparing.waitFor();
    await page.getByRole('button', { name: '닫기', exact: true }).press('Enter');
    await clone.waitFor({ state: 'detached' });
    assert.equal((await calls()).length, 0);
    release();
    // Saved reports are picked through the ink-underline switcher now, not
    // a row list.
    await page.getByRole('tab', { name: '인쇄 사진 검증' }).click();
    await print.press('Enter');
    await page.waitForFunction(() => window.printCalls.length === 1);
    assert.ok((await calls())[0].imageWidths[0] > 0);
    await afterPrint();
    assert.equal(await clone.count(), 0);

    held = new Promise(resolve => { release = resolve; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await print.press('Enter');
    await preparing.waitFor();
    // 2026-11-15 redesign: 결과 분석/보고서 내용 are no longer separate tabs
    // next to 보고서 — both are inside the one always-visible 보고서 panel.
    // The only other top-level tab is 행사 마감, so that is what "leaving
    // the report panel" now means.
    const closeTab = page.getByRole('tab', { name: '행사 마감', exact: true });
    await closeTab.click();
    assert.equal(await clone.count(), 0, 'leaving the 보고서 panel cancels image preparation');
    assert.equal(new URL(page.url()).hash, '#event-close');
    release();
    const reportsTab = page.getByRole('tab', { name: '보고서', exact: true });
    await closeTab.press('ArrowRight');
    await print.waitFor();
    assert.equal(await reportsTab.evaluate(tab => tab === document.activeElement), true);
    assert.equal((await calls()).length, 0);
    const returnedUrl = new URL(page.url());
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reportsPanel = page.getByRole('tabpanel', { name: '보고서', exact: true });
    try {
      await reportsPanel.locator('article').getByRole('heading', { name: '인쇄 사진 검증', exact: true }).waitFor({ timeout: 8000 });
    } catch (error) {
      await page.screenshot({ path: path.join(out, 'report-tab-reload-failed.png') });
      throw new Error(`The reopened report was lost after reload from ${returnedUrl.hash}`, { cause: error });
    }
    assert.equal(returnedUrl.hash, `#report-${encodeURIComponent(report.id)}`);
    assert.equal(returnedUrl.searchParams.get('closeReport'), report.id);
    assert.match(await reportsPanel.locator('article').innerText(), /버전 1 · 공유 완료 기록/);
    assert.equal(await reportsTab.getAttribute('aria-selected'), 'true');
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await reportsPanel.locator('article').getByRole('heading', { name: '인쇄 사진 검증', exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, `report-tab-reloaded-${width}.png`) });
    }
    await page.evaluate(id => { window.location.hash = `report-${encodeURIComponent(id)}`; }, otherReport.id);
    await reportsPanel.locator('article').getByRole('heading', { name: otherReport.title, exact: true }).waitFor({ timeout: 8000 });
    assert.match(await reportsPanel.locator('article').innerText(), new RegExp(`버전 ${otherReport.version} · 공유 완료 기록`));
    await page.goBack();
    await reportsPanel.locator('article').getByRole('heading', { name: '인쇄 사진 검증', exact: true }).waitFor();
    await page.evaluate(() => { window.location.hash = 'report-%'; });
    await reportsPanel.waitFor();
    assert.equal(await reportsPanel.locator('article').count(), 0, 'a broken report link does not keep the last report open');

    held = new Promise(resolve => { release = resolve; });
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await print.press('Enter');
    await preparing.waitFor();
    await photoError.waitFor({ timeout: 12000 });
    assert.equal(await clone.count(), 0, 'a stalled image releases the print attempt');
    assert.equal((await calls()).length, 0);
    release();
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], 'restoring a report and printing do not issue event commands');
  } finally {
    await context.close();
  }
}

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'report-recovery-before' : 'report-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/reports`, { waitUntil: 'networkidle' });
    let mode = 'lost';
    const ids = { 'report.create': [], 'report.update': [], 'report.publish': [], 'report.successor': [] };
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (!Object.hasOwn(ids, body.command)) return route.continue();
      ids[body.command].push(body.commandId);
      if (mode === 'lost' || mode === 'malformed') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, `${body.command} committed before response fault`);
        if (mode === 'lost') { mode = 'rejected'; return route.abort('failed'); }
        mode = 'pass';
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"report":{"id":"wrong"}}' });
      }
      if (mode === 'rejected') { mode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      return route.continue();
    });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const dialog = page.getByRole('dialog');
    const create = async (title) => {
      await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
      await page.locator('#report-title').fill(title);
      await page.locator('#report-summary').fill('합성 운영 요약');
      await dialog.getByRole('button', { name: '보고서 만들기', exact: true }).click();
    };

    phase = 'lost create followed by rejection';
    await create('합성 복구 보고서');
    await dialog.getByRole('alert').first().waitFor();
    await page.screenshot({ path: path.join(out, 'unconfirmed-1280.png'), fullPage: true });
    if (before) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      console.log('Report recovery before capture passed');
      return;
    }
    assert.equal(await page.locator('#report-title').isDisabled(), true);
    assert.equal(await page.locator('#report-summary').getAttribute('maxlength'), '2000');
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.getByText(/결과를 아직 확인하지 못했습니다/).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(new Set(ids['report.create']).size, 1);
    assert.equal((await workspace()).reports.filter((item) => item.title === '합성 복구 보고서').length, 1);

    phase = 'status-only confirmation after malformed response';
    mode = 'malformed';
    await create('합성 확인 보고서');
    await dialog.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const beforeCheck = ids['report.create'].length;
    await dialog.getByRole('button', { name: '서버 처리 확인' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(ids['report.create'].length, beforeCheck);
    assert.equal((await workspace()).reports.filter((item) => item.title === '합성 확인 보고서').length, 1);

    phase = 'publish and successor recover without a second write';
    await page.getByRole('tab', { name: '합성 확인 보고서' }).click();
    await page.getByRole('button', { name: '공유 완료로 표시', exact: true }).click();
    mode = 'lost';
    await page.getByRole('button', { name: '공유 완료·잠금', exact: true }).click();
    const recovery = page.getByRole('region', { name: '보고서 처리 확인 필요' });
    await recovery.waitFor();
    const beforePublishCheck = ids['report.publish'].length;
    await recovery.getByRole('button', { name: '서버 처리 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(ids['report.publish'].length, beforePublishCheck);
    const published = (await workspace()).reports.find((item) => item.title === '합성 확인 보고서');
    assert.equal(published.status, 'PUBLISHED');
    await page.getByRole('button', { name: '새 버전 만들기', exact: true }).click();
    mode = 'malformed';
    await page.getByRole('button', { name: '새 버전 만들기', exact: true }).click();
    await recovery.waitFor();
    const beforeSuccessorCheck = ids['report.successor'].length;
    await recovery.getByRole('button', { name: '서버 처리 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(ids['report.successor'].length, beforeSuccessorCheck);
    assert.equal((await workspace()).reports.filter((item) => item.parentId === published.id).length, 1);

    phase = 'reload does not retain report content';
    mode = 'malformed';
    await create('합성 새로고침 보고서');
    await dialog.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('report.create') && !stored.includes('합성 새로고침') && !stored.includes('합성 운영 요약'));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    assert.equal(await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().isDisabled(), true);
    const beforeReloadCheck = ids['report.create'].length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '보고서 만들기' && !button.disabled));
    assert.equal(ids['report.create'].length, beforeReloadCheck);
    assert.equal((await workspace()).reports.filter((item) => item.title === '합성 새로고침 보고서').length, 1);

    phase = 'legacy summary cannot be silently truncated';
    const legacyId = crypto.randomUUID();
    const created = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie, body: { commandId: legacyId, command: 'report.create', payload: { title: '합성 기존 보고서', subtitle: '', coverNote: '', summary: '기존', color: '#E76D26', sections: ['overview'] } },
    });
    assert.equal(created.status, 201);
    const legacyWorkspace = await workspace();
    legacyWorkspace.reports.find((item) => item.id === legacyId).summary = '가'.repeat(2100);
    await fixture.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(legacyWorkspace)]);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '합성 기존 보고서' }).click();
    await page.getByRole('button', { name: '내용 편집' }).click();
    assert.equal((await page.locator('#report-summary').inputValue()).length, 2100);
    const beforeLegacySave = ids['report.update'].length;
    await dialog.getByRole('button', { name: '수정 저장' }).click();
    await dialog.getByRole('alert').filter({ hasText: /2,000자 이하로 줄여주세요/ }).waitFor();
    assert.equal(ids['report.update'].length, beforeLegacySave, 'oversized legacy text is never silently truncated');
    await page.locator('#report-summary').fill('가'.repeat(2000));
    await dialog.getByRole('button', { name: '수정 저장' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await workspace()).reports.find((item) => item.id === legacyId).summary.length, 2000);

    phase = 'concurrent report changes preserve the draft and require a new review';
    const commandPath = `/api/events/${fixture.eventId}/commands`;
    const remote = async (command, payload) => {
      const result = await fixture.helpers.requestJson(fixture.harness.baseUrl, commandPath, {
        method: 'POST', cookie: fixture.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.ok(result.status >= 200 && result.status < 300, command + ' ' + result.status);
      return result.json.report;
    };
    const sharedDraft = await remote('report.create', { title: '공동 작업 보고서', summary: '기본 요약' });
    const readDraft = async () => (await workspace()).reports.find((item) => item.id === sharedDraft.id);
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/reports?closeReport=${sharedDraft.id}#report-${sharedDraft.id}`);
    await page.locator('article').getByText('공동 작업 보고서', { exact: true }).waitFor();
    await page.getByRole('button', { name: '내용 편집', exact: true }).click();
    await page.locator('#report-title').fill('내가 작성한 제목');
    await page.locator('#report-summary').fill('내가 작성한 요약');
    await remote('report.update', { id: sharedDraft.id, title: '다른 탭 제목', subtitle: '다른 탭 부제', summary: '기본 요약' });
    await page.route(`**/api/events/${fixture.eventId}/bootstrap`, route => route.fulfill({
      status: 503, contentType: 'application/json', body: '{}',
    }), { times: 1 });
    const replyFor = (command) => page.waitForResponse(reply => {
      if (reply.request().method() !== 'POST' || !reply.url().endsWith(commandPath)) return false;
      const body = reply.request().postDataJSON();
      return body?.command === command && body.payload.id === sharedDraft.id;
    });
    const saveReply = replyFor('report.update');
    await dialog.getByRole('button', { name: '수정 저장', exact: true }).click();
    assert.equal((await saveReply).status(), 409);
    assert.equal((await readDraft()).title, '다른 탭 제목');
    await dialog.getByText(/작성한 입력은 유지됩니다/).waitFor();
    assert.equal(await page.locator('#report-summary').inputValue(), '내가 작성한 요약');
    await dialog.getByRole('button', { name: '최신 내용 다시 확인', exact: true }).click();
    const keep = dialog.getByRole('button', { name: '겹친 항목은 내 입력 유지', exact: true });
    await keep.waitFor();
    await dialog.getByText('최근 저장 · 다른 탭 제목', { exact: true }).waitFor();
    await dialog.getByText('내 입력 · 내가 작성한 제목', { exact: true }).waitFor();
    assert.equal(await page.locator('#report-summary').inputValue(), '내가 작성한 요약');
    assert.equal(await dialog.getByRole('button', { name: '수정 저장', exact: true }).isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await keep.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(out, 'report-edit-conflict-390.png') });
    await keep.click();
    await page.waitForFunction(() => document.activeElement?.textContent.trim() === '수정 저장');
    assert.equal(await page.locator('#report-title').inputValue(), '내가 작성한 제목');
    assert.equal(await page.locator('#report-subtitle').inputValue(), '다른 탭 부제');
    await dialog.getByRole('button', { name: '수정 저장', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await readDraft()).version, 3);
    assert.equal((await readDraft()).summary, '내가 작성한 요약');
    await page.locator('article').getByText('내가 작성한 제목', { exact: true }).waitFor();
    await page.getByRole('button', { name: '공유 완료로 표시', exact: true }).click();
    await remote('report.update', { id: sharedDraft.id, title: '새로 검토할 보고서', subtitle: '다른 탭 부제', summary: '내가 작성한 요약' });
    const lockReply = replyFor('report.publish');
    await page.getByRole('button', { name: '공유 완료·잠금', exact: true }).click();
    assert.equal((await lockReply).status(), 409);
    assert.equal((await readDraft()).status, 'DRAFT');
    await page.locator('article').getByText('새로 검토할 보고서', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '공유 완료·잠금', exact: true }).count(), 0);
    await page.getByRole('button', { name: '공유 완료로 표시', exact: true }).click();
    const reviewedLock = replyFor('report.publish');
    await page.getByRole('button', { name: '공유 완료·잠금', exact: true }).click();
    assert.equal((await reviewedLock).status(), 200);
    assert.equal((await readDraft()).status, 'PUBLISHED');
    assert.equal((await readDraft()).version, 4);

    phase = 'attendance review before freezing a report';
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/reports`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
    const source = dialog.getByRole('group', { name: '보고서에 반영할 참가 집계' });
    await source.waitFor();
    const title = '마감 집계 재검토';
    const summary = '집계가 바뀌어도 보존할 합성 요약';
    await page.locator('#report-title').fill(title);
    await page.locator('#report-summary').fill(summary);
    const beforeChange = await workspace();
    const person = beforeChange.participants.find(person => person.status === 'APPROVED');
    assert.ok(person);
    const initialTotal = beforeChange.participants.filter(person => person.status !== 'CANCELLED').length;
    assert.match(await source.innerText(), new RegExp(`${initialTotal}명`));
    await remote('participant.status', { ids: [person.id], status: 'CANCELLED' });
    await page.route(`**/api/events/${fixture.eventId}/bootstrap`, route => route.fulfill({
      status: 503, contentType: 'application/json', body: '{}',
    }), { times: 1 });
    const save = dialog.getByRole('button', { name: '보고서 만들기', exact: true });
    const [stale] = await Promise.all([
      page.waitForResponse(reply => reply.request().method() === 'POST' && reply.url().endsWith(commandPath)),
      save.click(),
    ]);
    assert.equal(stale.status(), 409);
    assert.equal((await stale.json()).field, 'expectedAttendance');
    assert.equal((await workspace()).reports.length, beforeChange.reports.length);
    await source.getByText(/작성한 입력은 유지됩니다/).waitFor();
    assert.equal(await save.isDisabled(), true);
    await source.getByRole('button', { name: '최신 집계 다시 불러오기', exact: true }).press('Enter');
    const accept = source.getByRole('button', { name: '최신 집계 사용', exact: true });
    await accept.waitFor();
    assert.match(await source.innerText(), new RegExp(`${initialTotal}명 → 최신 ${initialTotal - 1}명`));
    assert.equal(await page.locator('#report-title').inputValue(), title);
    assert.equal(await page.locator('#report-summary').inputValue(), summary);
    await page.evaluate(axeSource);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await source.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations
        .filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
      if ([390, 1280].includes(width)) await page.screenshot({ path: path.join(out, `attendance-review-${width}.png`) });
    }
    await accept.press('Enter');
    await page.waitForFunction(() => document.activeElement?.textContent.trim() === '보고서 만들기');
    await save.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    const saved = (await workspace()).reports.filter(report => report.title === title);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].summary, summary);
    assert.equal(saved[0].snapshot.metrics.total, initialTotal - 1);

    phase = 'approved photo print waits, recovers and cancels';
    await verifyPhotoPrint(fixture, browser, out, workspace);

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, originalRequestRetained: true, statusOnly: true, noReportTextPersisted: true, legacyLengthGuard: true, concurrentDraftRebase: true, staleLockRejected: true, staleAttendanceRejected: true, approvedPhotoPrint: true, duplicates: 0 }, null, 2), { mode: 0o600 });
    console.log('Reports: saved versions, recovery, attendance review, legacy text guard and approved photo print passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
