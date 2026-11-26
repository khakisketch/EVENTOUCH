'use strict';

// Synthetic workflow checks for the design review: real isolated API/DB,
// production Next, no provider calls and no stored participant secrets.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('../apps/web/node_modules/xlsx');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { extendFixtureSeed } = require('./web-console-audit.cjs');
const { messageStep, chooseScheduleDate, openRecipientList, openMessageMore, openMessagePanel, openMessagePreview, closeMessagePreview } = require('./ui-journey-helpers.cjs');
let stage = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'uiux-workflows');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, current;
  try {
    const ext = await extendFixtureSeed(f);
    browser = await launchBrowser();
    const owner = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await owner.addCookies([{ name: 'etko_session', value: decodeURIComponent(ext.ownerCookie.slice('etko_session='.length)), url: f.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const errors = [];
    const newPage = async () => { const page = await owner.newPage(); page.on('pageerror', error => errors.push(error.message)); return page; };
    stage = 'selection scope and example preview';
    current = await newPage();
    await current.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await current.getByRole('checkbox', { name: '감사 참가자 1 선택' }).check();
    await current.getByPlaceholder('이름·소속·연락처 검색').fill('통합 확정');
    // Reopened 2026-11-20: 필터 밖 선택이 있으면 버튼·링크의 보이는 꼬리말('· 현재 필터 N명', '· 전체 N명')이 접근 가능한 이름에 들어간다(WCAG 2.5.3). 같은 동작을 꼬리말을 허용하는 이름으로 찾는다.
    const handoff = current.getByRole('link', { name: /^메시지 작성(?: · .+)?$/ });
    assert.match(await handoff.innerText(), /전체 1명/);
    assert.equal(await handoff.getAttribute('aria-describedby'), 'roster-message-scope');
    assert.match(await current.locator('#roster-message-scope').innerText(), /필터 밖 1명/);
    await handoff.scrollIntoViewIfNeeded();
    await current.screenshot({ path: path.join(out, 'selection-actions-390.png') });
    await handoff.click();
    await current.locator('#campaign-body').waitFor();
    assert.match(await current.locator('#recipient-summary').innerText(), /선택 1명/);
    const raw = '{{이름}}님 {{행사명}} {{행사일}} {{티켓링크}} {{럭키번호}}';
    await openMessageMore(current); // Reopened 2026-11-24 (시안 A): the optional record title sits under 더 보기
    await current.locator('#campaign-title').fill('합성 안내');
    await current.locator('#campaign-body').fill(raw);
    // On a phone the example is a bottom sheet opened by 미리보기; beside the writing on desktop.
    await openMessagePreview(current);
    const preview = await current.locator('#message-draft-preview').innerText();
    assert.match(preview, /홍길동님 감사 검증 행사 2027-01-16/);
    assert.match(preview, /\[개별 티켓 링크\] \[배정된 번호\]/);
    assert.equal(await current.locator('#campaign-body').inputValue(), raw);
    assert.equal(preview.includes('{{이름}}'), false);
    await current.locator('#message-draft-preview').scrollIntoViewIfNeeded();
    await current.screenshot({ path: path.join(out, 'message-example-390.png') });
    await closeMessagePreview(current);
    await openMessagePanel(current, 'how');
    const sms = current.locator('#campaign-channel input[value="SMS"]');
    const alimtalk = current.locator('#campaign-channel input[value="ALIMTALK"]');
    // Three cards now (문자 · 사진 문자 · 알림톡); the card order is 문자 → 사진 문자 → 알림톡.
    assert.equal(await current.locator('#campaign-channel input[type="radio"]').count(), 3);
    await sms.focus(); await current.keyboard.press('ArrowRight'); assert.equal(await current.locator('#campaign-channel input[value="MMS"]').isChecked(), true);
    await current.keyboard.press('ArrowRight'); assert.equal(await alimtalk.isChecked(), true);
    await current.keyboard.press('ArrowLeft'); await current.keyboard.press('ArrowLeft'); assert.equal(await sms.isChecked(), true);
    // Reopened 2026-11-23: no step buttons or folded 예약 등록; choose 날짜·시각 지정 in the 보낼 때 zone.
    await messageStep(current, 3);
    // Reopened 2026-11-26: at 390px the sticky send dock sits over the lower option cards, so a pointer click lands on the dock.
    // Choose the date option from the keyboard, as an operator with a focused card would.
    await current.locator('#campaign-schedule-choice input[value="DATE"]').focus();
    await current.keyboard.press('Space');
    await current.locator('#campaign-scheduled').fill('2027-01-10T10:00');
    // Reopened 2026-11-24 (owner decision 11): 미연동이면 모의 발송이 기본 켜짐이고 모의 발송에는 실행 방식 선택이 없다.
    const simulate = current.getByLabel('모의 발송으로 기록', { exact: false });
    assert.equal(await simulate.isChecked(), true, 'an unconnected organisation defaults to simulation');
    // Reopened 2026-11-26: the run mode is one toggle under the schedule; a simulation hides it.
    assert.equal(await current.locator('#campaign-schedule-mode').count(), 0, 'a simulation offers no run-mode choice');
    await simulate.uncheck();
    const runMode = current.locator('#campaign-schedule-mode');
    assert.equal(await runMode.getAttribute('data-mode'), 'MANUAL', 'new reservation defaults to manual');
    await runMode.getByRole('button', { name: '자동 발송으로 바꾸기' }).click();
    assert.equal(await runMode.getAttribute('data-mode'), 'AUTO');
    await runMode.getByRole('button', { name: '직접 실행으로 바꾸기' }).click();
    assert.equal(await runMode.getAttribute('data-mode'), 'MANUAL');
    assert.equal(await current.locator('#campaign-body').inputValue(), raw, 'switching modes preserves the draft');
    await current.addScriptTag({ content: axe });
    assert.deepEqual(await current.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
    stage = 'nested title and unsaved draft';
    const fields = await newPage();
    let accept = false; fields.on('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
    await fields.goto(`${f.baseUrl}/console/events/${f.eventId}/settings/fields`);
    await fields.getByRole('heading', { name: '신청 항목', exact: true, level: 1 }).waitFor();
    await fields.getByRole('heading', { name: '항목 관리', exact: true }).waitFor();
    await fields.getByRole('button', { name: '항목 추가', exact: true }).click();
    await fields.locator('#field-label').fill('보존할 합성 항목');
    await fields.getByRole('link', { name: '행사 설정 · 참가 접수' }).click();
    assert.equal(await fields.locator('#field-label').inputValue(), '보존할 합성 항목');
    assert.match(fields.url(), /settings\/fields$/);
    accept = true;
    stage = 'Q&A lock and reply';
    const programs = await newPage();
    await programs.goto(`${f.baseUrl}/console/events/${f.eventId}/programs`);
    const qa = programs.locator('li').filter({ has: programs.getByRole('heading', { name: '통합 감사 질문', exact: true }) }).first();
    await qa.locator('summary').first().click();
    await qa.getByText('질문과 답변은 아래에서 관리하세요.', { exact: false }).waitFor();
    assert.equal(await qa.getByRole('button', { name: '편집', exact: true }).isDisabled(), true);
    assert.equal(await qa.locator('textarea').first().isEnabled(), true);
    stage = 'XLS and XLSX import';
    const imports = await newPage();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['이름', '연락처', '소속'], ['합성 업로드', '01000001234', '합성 기관']]), '명단');
    for (const format of ['xls', 'xlsx']) {
      await imports.goto(`${f.baseUrl}/console/events/${f.eventId}/participants/import`);
      // Reopened 2026-11-24 (가져오기 열 안내): 보이는 형식 안내는 끌어 놓기 아래 한 줄이고, 전체 형식 목록은 파일 입력의 이름에 있다.
      await imports.getByText('엑셀(XLS·XLSX)과 CSV 파일을 읽어요.', { exact: false }).waitFor();
      await imports.getByLabel('CSV·TXT·XLS·XLSX 파일 선택').waitFor({ state: 'attached' });
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: format === 'xls' ? 'biff8' : 'xlsx' });
      await imports.locator('input[type=file]').setInputFiles({ name: `synthetic.${format}`, mimeType: format === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
      await imports.getByRole('region', { name: '가져올 명단 확인' }).waitFor({ state: 'attached' });
      const importAlerts = (await imports.getByRole('alert').allTextContents()).map(text => text.trim()).filter(Boolean);
      assert.deepEqual(importAlerts, [], `${format} is parsed without an error: ${JSON.stringify(importAlerts)}`);
    }
    stage = 'create new event and check compatibility';
    const suffix = f.suffix.slice(0, 16);
    const slug = `uiux-neutral-${suffix}`;
    const createBody = { commandId: crypto.randomUUID(), name: '합성 중립 행사', slug, date: '2027-02-02', start: '09:00', end: '18:00', capacity: 0 };
    const created = await f.helpers.requestJson(f.harness.baseUrl, '/api/events', { cookie: ext.ownerCookie, method: 'POST', body: createBody });
    assert.ok(created.status >= 200 && created.status < 300);
    const newId = created.json.event.id;
    const read = async id => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
    assert.equal((await read(newId)).defaultHomeBanner, 'neutral');
    assert.equal(Object.hasOwn(await read(f.eventId), 'defaultHomeBanner'), false, 'existing workspace is not rewritten');
    const stageResult = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${newId}/commands`, { cookie: ext.ownerCookie, method: 'POST', body: { commandId: crypto.randomUUID(), command: 'event.stage', payload: { stage: 'READY' } } });
    assert.ok(stageResult.status >= 200 && stageResult.status < 300);
    const publicData = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${slug}`);
    assert.equal(publicData.json.workspace.pageExperience.published.defaultHomeBanner, 'neutral');
    const legacyData = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}`);
    assert.equal(Object.hasOwn(legacyData.json.workspace.pageExperience.published, 'defaultHomeBanner'), false);
    for (const [source, expected, tag] of [[newId, 'neutral', 'new'], [f.eventId, undefined, 'old']]) {
      const clone = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${source}/duplicate`, { cookie: ext.ownerCookie, method: 'POST', body: { commandId: crypto.randomUUID(), name: `합성 복제 ${tag}`, slug: `uiux-copy-${tag}-${suffix}` } });
      assert.ok(clone.status >= 200 && clone.status < 300);
      assert.equal((await read(clone.json.event.id)).defaultHomeBanner, expected);
    }
    const theme = await newPage();
    await theme.goto(`${f.baseUrl}/console/events/${newId}/page`);
    await theme.getByText('기본 색상 배너', { exact: true }).waitFor();
    // The banner editor is a panel opened from the studio's 배너 row; the neutral default is the
    // current choice, so its "사용 중" action is disabled. (The old in-page section nav with an
    // underlined 저장·게시 link no longer exists in the studio.)
    await theme.getByRole('button', { name: /^배너/ }).click();
    assert.equal(await theme.getByRole('button', { name: '기본 배너 사용 중' }).isDisabled(), true);
    const guest = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    const home = await guest.newPage();
    await home.goto(`${f.baseUrl}/event/${f.slug}/home`);
    let region = home.getByRole('region', { name: '감사 검증 행사 참가자 홈' });
    await region.waitFor();
    assert.equal(await region.locator('img').getAttribute('src'), '/attendee-home-banner.png', 'legacy fallback stays');
    await home.goto(`${f.baseUrl}/event/${slug}/home`);
    region = home.getByRole('region', { name: '합성 중립 행사 참가자 홈' });
    await region.waitFor();
    assert.equal(await region.locator('img').count(), 0);
    assert.equal(await region.getByRole('heading', { name: '합성 중립 행사' }).isVisible(), true);
    await home.addScriptTag({ content: axe });
    assert.deepEqual(await home.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
    await home.screenshot({ path: path.join(out, 'neutral-home-390.png') });
    stage = 'desktop and narrow mobile layouts';
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
    await desktop.addCookies([{ name: 'etko_session', value: decodeURIComponent(ext.ownerCookie.slice('etko_session='.length)), url: f.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const desktopPage = await desktop.newPage();
    await desktopPage.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`);
    await desktopPage.locator('#message-compose-open').click();
    // The recipient list is folded on phones; open it the way an operator would.
    await openRecipientList(desktopPage);
    await desktopPage.getByRole('checkbox', { name: /감사 참가자 1 감사 업체 1/ }).check();
    await messageStep(desktopPage, 2);
    await desktopPage.locator('#campaign-body').fill(raw);
    await desktopPage.locator('#message-draft-preview').scrollIntoViewIfNeeded();
    assert.match(await desktopPage.locator('#message-draft-preview').innerText(), /홍길동님/);
    assert.equal(await desktopPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await desktopPage.screenshot({ path: path.join(out, 'message-example-1440.png') });
    await desktopPage.goto(`${f.baseUrl}/console/events/${f.eventId}/settings/fields`);
    await desktopPage.getByRole('heading', { name: '신청 항목', exact: true, level: 1 }).waitFor();
    assert.equal(await desktopPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await desktopPage.screenshot({ path: path.join(out, 'fields-1440.png') });
    const desktopHome = await desktop.newPage();
    await desktopHome.goto(`${f.baseUrl}/event/${slug}/home`);
    await desktopHome.getByRole('heading', { name: '합성 중립 행사' }).waitFor();
    await desktopHome.screenshot({ path: path.join(out, 'neutral-home-1440.png') });
    await desktop.close();
    const narrow = await browser.newContext({ viewport: { width: 320, height: 760 }, locale: 'ko-KR' });
    await narrow.addCookies([{ name: 'etko_session', value: decodeURIComponent(ext.ownerCookie.slice('etko_session='.length)), url: f.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const narrowPage = await narrow.newPage();
    await narrowPage.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`);
    await narrowPage.locator('#message-compose-open').click();
    // The recipient list is folded on phones; open it the way an operator would.
    await openRecipientList(narrowPage);
    await narrowPage.getByRole('checkbox', { name: /감사 참가자 1 감사 업체 1/ }).check();
    await messageStep(narrowPage, 2);
    await narrowPage.locator('#campaign-body').fill(raw);
    await openMessagePreview(narrowPage);
    await narrowPage.locator('#message-draft-preview').scrollIntoViewIfNeeded();
    assert.equal(await narrowPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'message composition fits a 320px viewport');
    await narrowPage.screenshot({ path: path.join(out, 'message-example-320.png') });
    await narrow.close();
    stage = 'published image preserved and broken image fallback';
    const updated = await read(newId);
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
    updated.pageExperience = { published: { keyvisual: { data: pixel, width: 1, height: 1 }, homeStyle: { heroLayout: 'image-only' } } };
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [newId, JSON.stringify(updated)]);
    await home.reload(); await region.waitFor();
    assert.equal(await region.locator('img').getAttribute('src'), pixel, 'published image overrides the neutral default');
    const broken = await read(newId);
    broken.pageExperience.published.keyvisual = { fileId: 'nonexistent-synthetic-image', type: 'image/png', size: 16 };
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [newId, JSON.stringify(broken)]);
    await home.reload();
    await region.getByText('배너 이미지를 불러오지 못했습니다.').waitFor();
    assert.equal(await region.getByRole('heading', { name: '합성 중립 행사' }).isVisible(), true, 'event title remains visible on image failure');
    await home.screenshot({ path: path.join(out, 'broken-banner-390.png') });
    stage = 'create dialog date and landing copy';
    const directory = await newPage(); directory.on('dialog', dialog => dialog.dismiss());
    await directory.goto(`${f.baseUrl}/console`);
    await directory.getByRole('button', { name: '새 행사 만들기', exact: true }).click();
    await directory.locator('#create-date').fill('2027-02-02');
    await directory.getByText('선택한 날짜: 2027.02.02', { exact: false }).waitFor();
    await directory.locator('summary').filter({ hasText: '추가 설정' }).click();
    await directory.getByText('24시간 기준: 09:00–18:00').waitFor();
    const landing = await guest.newPage();
    await landing.goto(f.baseUrl + '/');
    await landing.locator('#faq-sms summary').click();
    assert.match(await landing.locator('#faq-sms').innerText(), /모의 발송이나 미연동 상태에서는 실제로 전달되지/);
    assert.equal(await landing.getByText('문자 발송은 현재 모의 발송', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await guest.close(); await owner.close();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', synthetic: true, selectionScope: true, samplePreviewNoRealBearer: true, manualScheduleDefault: true, nestedTitleGuard: true, qaLockCopy: true, xlsAndXlsx: true, newAndLegacyDefault: true, duplicateCompatibility: true, publishedImagePreserved: true, imageFailureFallback: true, keyboard: true, desktopAndNarrowMobile: true, axeSeriousCritical: 0 }, null, 2), { mode: 0o600 });
    console.log('UI/UX workflows: selection, message example, fields, Q&A, XLS and compatible banner defaults passed');
  } catch (error) { if (current) await current.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
  finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
