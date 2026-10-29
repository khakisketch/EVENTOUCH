'use strict';

// Participant theme editor -> real API -> isolated PostgreSQL -> independent
// public browsers. The gateway may lose committed responses, never invent data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, ensureCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const { startOwnedNext, ensureAuditDatabaseEnv } = require('./audit-fixture.cjs');
ensureAuditDatabaseEnv();
const { chromium } = require('playwright');
const axeSource = require('axe-core').source;
const { emptyWorkspace } = require('../server/state');
const { startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('../tests/helpers/postgres-api-server.cjs');
const { startWebApiGateway } = require('../tests/helpers/web-api-gateway.cjs');

const directory = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'theme-real')
  : defaultCaptureDir(`theme-real-${runStamp()}`);

async function commandClick(page, button, name) {
  const pending = page.waitForResponse((response) => {
    if (response.request().method() !== 'POST' || !response.url().includes('/commands')) return false;
    try { return response.request().postDataJSON().command === name; } catch { return false; }
  });
  pending.catch(() => {});
  await button.click();
  if (name === 'attendee.page.publish') {
    await page.getByRole('group', { name: '실행 확인', exact: true })
      .getByRole('button', { name: '게시하기', exact: true }).click();
  }
  const response = await pending;
  const data = await response.json();
  assert.ok(response.ok(), `${name}: ${response.status()} ${JSON.stringify(data)}`);
  await page.waitForLoadState('networkidle');
  return data;
}

async function assertAxe(page, name) {
  // Inject test instrumentation through the browser protocol without changing
  // the page's production CSP or disabling it for application scripts.
  await page.evaluate(axeSource);
  const findings = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    return result.violations.filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => ({ id: item.id, nodes: item.nodes.map((node) => node.html) }));
  });
  assert.deepEqual(findings, [], `${name}: blocking accessibility findings`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: horizontal overflow`);
}

async function main() {
  prepareCaptureDir(directory);
  // Uploaded banners and browser profiles stay under this run's
  // private tree, never the shared /tmp/opencode directory.
  process.env.TMPDIR = ensureRunTmpDir(directory);
  let harness, owned, gateway, browser;
  const pages = [];
  const errors = [];
  let phase = 'setup';
  try {
    harness = await startApiHarness();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const managerId = `theme-manager-${suffix}`;
    const eventA = `theme-a-${suffix}`, eventB = `theme-b-${suffix}`;
    await insertAccount(harness.database, { orgId: LEGACY_ORG, id: `theme-owner-${suffix}`, role: 'AGENCY', name: '디자인 검증 소유자', email: `theme-owner-${suffix}@example.test` });
    await insertAccount(harness.database, { orgId: LEGACY_ORG, id: managerId, role: 'MANAGER', name: '디자인 검증 운영자', email: `${managerId}@example.test` });
    for (const [id, name] of [[eventA, '디자인 검증 행사 A'], [eventB, '변경하지 않은 행사 B']]) {
      await insertEvent(harness.database, { orgId: LEGACY_ORG, id, slug: id, payload: { id, slug: id, name, stage: 'LIVE', date: '2027-01-17', start: '09:00', end: '17:00', capacity: 100, features: ['draw', 'poll', 'screen'] }, workspace: emptyWorkspace() });
    }
    await insertMembership(harness.database, managerId, eventA, ['all']);
    const cookie = await sessionCookie(harness, managerId);
    const imported = await requestJson(harness.baseUrl, `/api/events/${eventA}/commands`, {
      method: 'POST', cookie,
      body: { commandId: `theme-person-${crypto.randomUUID()}`, command: 'participant.import', payload: { rows: [{ name: '디자인 검증 참가자', phone: '01000000001', company: '검증 업체' }] } },
    });
    assert.equal(imported.status, 200);
    owned = await startOwnedNext({ apiBase: harness.baseUrl });
    gateway = await startWebApiGateway({ apiBase: harness.baseUrl, webBase: owned.baseUrl, loseFirstResponseFor: ['attendee.page.save', 'attendee.page.publish'] });
    browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
    const newPage = async (context) => {
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('dialog', (dialog) => dialog.accept());
      return page;
    };
    const operatorContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await operatorContext.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), url: gateway.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const editor = await newPage(operatorContext);
    const attendee = await newPage(await browser.newContext({ viewport: { width: 390, height: 844 } }));
    const second = await newPage(await browser.newContext({ viewport: { width: 320, height: 568 } }));
    const readPublic = async (id = eventA) => {
      const result = await requestJson(harness.baseUrl, `/api/public/events/${id}`);
      assert.equal(result.status, 200); return result.json.workspace.pageExperience.published;
    };
    const readWorkspace = async () => (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventA])).rows[0].payload;
    const before = await readPublic();
    const beforeB = await readPublic(eventB);
    await attendee.goto(`${gateway.baseUrl}/event/${eventA}/home`, { waitUntil: 'networkidle' });
    await attendee.getByRole('heading', { name: '디자인 검증 행사 A', exact: true }).waitFor();

    phase = 'open existing event editor';
    await editor.goto(`${gateway.baseUrl}/console/events/${eventA}/page`, { waitUntil: 'networkidle' });
    await editor.getByRole('button', { name: '초안 저장', exact: true }).waitFor();

    phase = 'custom image and text preview';
    // A genuine PNG made locally; no tracking URL or SVG is uploaded.
    const image = await newPage(await browser.newContext({ viewport: { width: 640, height: 336 } }));
    await image.setContent('<html><body style="margin:0;background:#21433a"><div style="position:absolute;inset:32px;border:6px solid #dcbf7d;border-radius:72px;background:#326253"></div></body></html>');
    const banner = await image.screenshot({ type: 'png' });
    await image.close(); pages.splice(pages.indexOf(image), 1);
    const uploaded = editor.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/api/events/${eventA}/files`) && response.ok());
    uploaded.catch(() => {});
    await editor.locator('input[type=file]').first().setInputFiles({ name: '행사-배너.png', mimeType: 'image/png', buffer: banner });
    await uploaded;
    await editor.locator('input[type=color]').first().fill('#e8efe9');
    await editor.getByLabel(/배너 제목|상단 제목/).fill('우리의 새로운 행사');
    await editor.getByLabel(/보조 문구|보조 설명/).fill('함께 만드는 특별한 하루');
    await editor.locator('summary', { hasText: '배치·색상 상세 설정' }).click();
    await editor.locator('summary', { hasText: '이미지 상세 설정' }).click();
    await editor.locator('select').filter({ has: editor.locator('option[value="bottom-overlay"]') }).selectOption('bottom-overlay');
    await editor.locator('select').filter({ has: editor.locator('option[value="strong"]') }).selectOption('strong');
    await editor.locator('select').filter({ has: editor.locator('option[value="left"]') }).selectOption('left');
    await editor.locator('select').filter({ has: editor.locator('option[value="top"]') }).selectOption('top');
    await editor.locator('select').filter({ has: editor.locator('option[value="large"]') }).selectOption('large');
    await editor.getByRole('heading', { name: '우리의 새로운 행사', exact: true }).waitFor();
    await editor.screenshot({ path: path.join(directory, 'editor-unsaved-1440.png'), fullPage: true });
    assert.deepEqual(await readPublic(), before, 'unsaved preview must never alter attendee content');

    phase = 'draft save with lost committed response';
    const save = editor.getByRole('button', { name: '초안 저장', exact: true });
    await save.click();
    await gateway.waitForResponseLoss('attendee.page.save');
    await editor.getByRole('alert').filter({ hasText: /응답|연결|저장/ }).waitFor();
    await commandClick(editor, save, 'attendee.page.save');
    const saveCalls = gateway.commands.filter((call) => call.command === 'attendee.page.save');
    assert.equal(saveCalls.length, 2); assert.equal(saveCalls[0].commandId, saveCalls[1].commandId);
    let state = await readWorkspace();
    assert.equal(state.pageExperience.draftVersion, 1);
    assert.equal(state.pageExperience.draft.homeStyle.heroTitle, '우리의 새로운 행사');
    const fileId = state.pageExperience.draft.keyvisual.fileId;
    const privateRead = await operatorContext.request.get(`${gateway.baseUrl}/api/events/${eventA}/files/${fileId}`);
    assert.equal(privateRead.status(), 200);
    const unpublishedRead = await attendee.request.get(`${gateway.baseUrl}/api/public/events/${eventA}/files/${fileId}`);
    assert.equal(unpublishedRead.status(), 404);
    assert.deepEqual(await readPublic(), before, 'saved draft must remain private');
    await editor.reload({ waitUntil: 'networkidle' });
    await editor.getByRole('heading', { name: '우리의 새로운 행사', exact: true }).waitFor();
    await attendee.reload({ waitUntil: 'networkidle' });
    await attendee.getByRole('heading', { name: '디자인 검증 행사 A', exact: true }).waitFor();

    phase = 'publish with lost committed response';
    const publish = editor.getByRole('button', { name: /^(게시|게시하기|변경사항 게시)$/ });
    const publishCount = gateway.commands.filter((call) => call.command === 'attendee.page.publish').length;
    await publish.click();
    assert.equal(gateway.commands.filter((call) => call.command === 'attendee.page.publish').length, publishCount, 'opening review never publishes');
    await editor.getByRole('group', { name: '실행 확인', exact: true })
      .getByRole('button', { name: '게시하기', exact: true }).click();
    await gateway.waitForResponseLoss('attendee.page.publish');
    await editor.getByRole('alert').filter({ hasText: /응답|연결|게시/ }).waitFor();
    await commandClick(editor, publish, 'attendee.page.publish');
    const publishCalls = gateway.commands.filter((call) => call.command === 'attendee.page.publish');
    assert.equal(publishCalls.length, 2);
    assert.equal(publishCalls[0].commandId, publishCalls[1].commandId);
    let published = await readPublic();
    assert.equal(published.homeStyle.backgroundColor, '#E8EFE9');
    assert.equal(published.homeStyle.heroTitle, '우리의 새로운 행사');
    assert.equal(published.homeStyle.heroSubtitle, '함께 만드는 특별한 하루');
    assert.equal(published.homeStyle.textAlign, 'left');
    assert.equal(published.homeStyle.heroLayout, 'bottom-overlay');
    assert.equal(published.homeStyle.imageFocus, 'top');
    assert.equal(published.homeStyle.titleScale, 'large');
    assert.equal(published.keyvisual.fileId, fileId);
    assert.deepEqual(await readPublic(eventB), beforeB, 'event A appearance must not change B');
    assert.equal((await attendee.request.get(`${gateway.baseUrl}/api/public/events/${eventA}/files/${fileId}`)).status(), 200);
    for (const page of [attendee, second]) {
      await page.goto(`${gateway.baseUrl}/event/${eventA}/home`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '우리의 새로운 행사', exact: true }).waitFor();
      await page.getByText('함께 만드는 특별한 하루', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: '우리의 새로운 행사', exact: true }).evaluate((element) => getComputedStyle(element).textAlign), 'left');
      assert.equal(await page.getByRole('main').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(232, 239, 233)');
      assert.equal(await page.getByRole('button', { name: '순위 투표', exact: true }).count(), 1);
    }
    await attendee.screenshot({ path: path.join(directory, 'published-390.png'), fullPage: true });
    await second.screenshot({ path: path.join(directory, 'published-320.png'), fullPage: true });
    const person = (await readWorkspace()).participants[0];
    const ticketView = await requestJson(harness.baseUrl, `/api/public/events/${eventA}/ticket`, { bearer: person.ticket });
    assert.deepEqual(ticketView.json.workspace.pageExperience.published.homeStyle, published.homeStyle);
    await attendee.goto(`${gateway.baseUrl}/event/${eventA}/home?ticket=${encodeURIComponent(person.ticket)}`, { waitUntil: 'networkidle' });
    await attendee.getByRole('heading', { name: '우리의 새로운 행사', exact: true }).waitFor();
    assert.equal(new URL(attendee.url()).searchParams.has('ticket'), false);
    assert.equal(await attendee.getByRole('main').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(232, 239, 233)');
    await attendee.getByRole('button', { name: '공지사항', exact: true }).click();
    assert.equal(await attendee.getByRole('main').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(232, 239, 233)');
    await attendee.getByRole('button', { name: '참가 메뉴', exact: true }).click();
    await attendee.getByRole('heading', { name: '우리의 새로운 행사', exact: true }).waitFor();
    await second.goto(`${gateway.baseUrl}/event/${eventB}/home`, { waitUntil: 'networkidle' });
    await second.getByRole('heading', { name: '변경하지 않은 행사 B', exact: true }).waitFor();
    assert.equal(await second.getByRole('main').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(185, 222, 240)');

    phase = 'image-only layout and image removal';
    await editor.locator('summary', { hasText: '배치·색상 상세 설정' }).click();
    await editor.locator('#home-layout').selectOption('image-only');
    await commandClick(editor, save, 'attendee.page.save');
    await commandClick(editor, publish, 'attendee.page.publish');
    await attendee.reload({ waitUntil: 'networkidle' });
    const headingVisuallyHidden = await attendee.getByRole('heading', { name: '우리의 새로운 행사', exact: true }).evaluate((element) => {
      for (let parent = element; parent && parent.tagName !== 'SECTION'; parent = parent.parentElement) {
        const rect = parent.getBoundingClientRect(); const style = getComputedStyle(parent);
        if (rect.width <= 1 && rect.height <= 1 && (style.overflow === 'hidden' || style.clipPath !== 'none')) return true;
      }
      return false;
    });
    assert.ok(headingVisuallyHidden, 'image-only must hide the overlay visually while retaining its semantic heading');
    await attendee.screenshot({ path: path.join(directory, 'published-image-only-390.png'), fullPage: true });
    await editor.getByRole('button', { name: '배너 이미지 제거', exact: true }).click();
    assert.equal((await readWorkspace()).pageExperience.draft.keyvisual.fileId, fileId, 'opening removal review must preserve the saved image');
    await editor.getByRole('group', { name: '실행 확인', exact: true })
      .getByRole('button', { name: '연결 해제하기', exact: true }).click();
    await editor.getByRole('button', { name: '기본 이미지 사용 중', exact: true }).waitFor();
    await editor.locator('#home-layout').selectOption('centered');
    await editor.locator('#home-hero-title').fill('');
    await editor.locator('#home-hero-subtitle').fill('');
    await commandClick(editor, save, 'attendee.page.save');
    assert.equal((await attendee.request.get(`${gateway.baseUrl}/api/public/events/${eventA}/files/${fileId}`)).status(), 200, 'a draft removal must not remove the published image');
    await commandClick(editor, publish, 'attendee.page.publish');
    published = await readPublic();
    assert.equal(published.keyvisual, null);
    assert.equal(published.homeStyle.heroTitle, null);
    assert.equal((await attendee.request.get(`${gateway.baseUrl}/api/public/events/${eventA}/files/${fileId}`)).status(), 404, 'an unreferenced image must become private after removal is published');
    await attendee.reload({ waitUntil: 'networkidle' });
    await attendee.getByRole('heading', { name: '디자인 검증 행사 A', exact: true }).waitFor();
    assert.equal(await attendee.getByRole('region', { name: /참가자 홈$/ }).locator('img').getAttribute('src'), '/attendee-home-banner.png');
    assert.deepEqual(await readPublic(eventB), beforeB);

    phase = 'concurrent draft recovery';
    const stale = await newPage(operatorContext);
    await stale.goto(`${gateway.baseUrl}/console/events/${eventA}/page`, { waitUntil: 'networkidle' });
    await stale.locator('#home-hero-title').fill('이전 창에서 편집 중인 문구');
    await editor.locator('#home-hero-title').fill('다른 창에서 저장한 최신 초안');
    await commandClick(editor, save, 'attendee.page.save');
    const conflictResponse = stale.waitForResponse((response) => {
      try { return response.request().method() === 'POST' && response.request().postDataJSON().command === 'attendee.page.save'; } catch { return false; }
    });
    await stale.getByRole('button', { name: '초안 저장', exact: true }).click();
    assert.equal((await conflictResponse).status(), 409);
    assert.equal(await stale.locator('#home-hero-title').inputValue(), '이전 창에서 편집 중인 문구');
    await stale.getByRole('button', { name: '최신 초안 확인', exact: true }).click();
    await stale.getByRole('button', { name: /최신 초안.*불러오기/ }).click();
    assert.equal(await stale.locator('#home-hero-title').inputValue(), '이전 창에서 편집 중인 문구', 'opening replacement review keeps unsaved input');
    await stale.getByRole('group', { name: '실행 확인', exact: true })
      .getByRole('button', { name: '최신 초안으로 바꾸기', exact: true }).click();
    await stale.getByRole('heading', { name: '다른 창에서 저장한 최신 초안', exact: true }).waitFor();
    assert.equal(await stale.locator('#home-hero-title').inputValue(), '다른 창에서 저장한 최신 초안');
    assert.deepEqual(await readPublic(), published, 'a recovered newer draft must still not change published content');
    await stale.screenshot({ path: path.join(directory, 'conflict-recovered-1440.png'), fullPage: true });

    phase = 'responsive and accessibility';
    await assertAxe(editor, 'theme editor'); await assertAxe(attendee, 'published home');
    await editor.setViewportSize({ width: 390, height: 844 });
    await editor.screenshot({ path: path.join(directory, 'editor-390.png'), fullPage: true });
    await assertAxe(editor, 'mobile editor');
    await harness.restartHttp();
    assert.deepEqual(await readPublic(), published, 'published style and banner must survive API recreation');
    state = await readWorkspace(); assert.equal(state.pageExperience.publishedVersion, 3); assert.equal(state.pageExperience.draftVersion, 4);
    assert.equal((await harness.database.query('SELECT COUNT(*) AS total FROM stored_files WHERE event_id=$1', [eventA])).rows[0].total, '1');
    assert.deepEqual(errors, []);
    const result = { outcome: 'passed', apiResponsesMocked: false, draftPrivate: true, draftReloaded: true, sameSaveReceiptOnResponseLoss: true, samePublishReceiptOnResponseLoss: true, independentBrowsersSamePublishedTheme: true, ticketHolderSameTheme: true, detailsRetainEventBackground: true, anotherEventUnchanged: true, uploadedFiles: 1, unpublishedFilePrivate: true, publishedFileAccessible: true, imageOnlyRetainsSemanticHeading: true, imageRemovalPublishedAndPrivateAgain: true, staleDraftRejectedAndRecoveredWithoutPublishing: true, persistedAfterHttpRestart: true, seriousCriticalAxe: 0, pageErrors: 0, captures: directory };
    fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Failed phase: ${phase}`);
    for (let index = 0; index < pages.length; index += 1) await pages[index].screenshot({ path: path.join(directory, `failure-${index}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close(); if (gateway) await gateway.close(); if (owned) await owned.close(); if (harness) await harness.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
