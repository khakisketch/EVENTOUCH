'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startStalledResponseProxy } = require('./stalled-response-fixture.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const axeSource = require('axe-core').source;

let phase = 'setup';

async function checkDisplayRecovery(page, baseUrl, slug, body, out, check) {
  const apiPath = `/api/public/events/${slug}`;
  const screenPath = `/screen/${slug}`;
  const proxy = await startStalledResponseProxy(baseUrl, apiPath);
  const { origin, setStalled, waitForClosed } = proxy;
  const lastFrame = page.getByText(body, { exact: true });
  const stale = page.getByText('연결 확인 중 · 마지막 화면입니다', { exact: true });
  const stalledHeaders = () => page.waitForResponse(response => response.url() === origin + apiPath && response.status() === 200);
  try {
    await page.bringToFront();
    await page.goto(origin + screenPath);
    await lastFrame.waitFor();
    setStalled(true);
    await stalledHeaders();
    await stale.waitFor({ timeout: 11000 });
    await waitForClosed(0);
    check('a stalled response body preserves the published frame and marks it stale', await lastFrame.isVisible());
    await page.screenshot({ path: path.join(out, 'screen-stale-1280.png') });

    await stalledHeaders();
    setStalled(false);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await stale.waitFor({ state: 'hidden', timeout: 3000 });
    await waitForClosed(1);
    check('manual refresh cancels the hung poll and restores the same frame', await lastFrame.isVisible());

    setStalled(true);
    await Promise.all([stalledHeaders(), page.goto(origin + screenPath, { waitUntil: 'domcontentloaded' })]);
    const retry = page.getByRole('button', { name: '다시 시도', exact: true });
    await retry.waitFor({ timeout: 11000 });
    await waitForClosed(2);
    check('a stalled first load offers a retry instead of loading forever', await retry.isVisible());
    await page.screenshot({ path: path.join(out, 'screen-first-timeout-1280.png') });
    setStalled(false);
    await retry.click();
    await lastFrame.waitFor();
    check('first-load retry restores the actual published frame', await lastFrame.isVisible());
    await page.screenshot({ path: path.join(out, 'screen-recovered-1280.png') });
    await page.goto(baseUrl + screenPath, { waitUntil: 'networkidle' });
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'screen-recovery-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await proxy.close();
  }
}

(async () => {
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'content-publication');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, page, publicContext, screenPage;
  const checks = [], errors = [], writes = [], accessibility = [];
  const run = async (command, payload) => {
    const result = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.json));
    return result.json;
  };
  try {
    const notice = (await run('notice.save', { title: '행사 입장 안내', body: '동문에서 QR 티켓을 보여 주세요.', published: true })).notice;
    await run('program.save', { title: '파트너 세션', date: '2027-01-16', start: '10:00', end: '11:00', place: '컨벤션홀 A', description: '새로운 협업 사례를 소개합니다.', published: true });
    await run('venue.save', { name: '서울 컨벤션홀', address: '서울 합성로 12', directions: '지하철 2번 출구', contact: '02-0000-0000', description: '등록 데스크는 동문에 있습니다.' });
    if (!process.argv.includes('--before')) await run('display.set', { type: 'notice', noticeId: notice.id });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/commands')) writes.push(request.postDataJSON());
    });
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const publicRead = async () => (await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}`)).json.workspace;
    const check = (name, result) => { assert.ok(result, name); checks.push(name); };
    const audit = async name => {
      await page.evaluate(axeSource);
      const findings = await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['moderate', 'serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
      accessibility.push({ name, findings }); assert.deepEqual(findings, []);
      check(name + ' has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    };
    const capture = async name => {
      await page.evaluate(() => document.fonts.ready);
      const inDialog = Boolean(await page.getByRole('dialog').count());
      if (!inDialog) await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(out, name + '.png'), fullPage: !inDialog });
    };
    phase = 'content list';
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/content`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '공지', exact: true }).waitFor();
    await capture('01-list-1280');
    const row = page.locator('li').filter({ has: page.getByRole('heading', { name: notice.title, exact: true }) }).last();
    await row.getByRole('button', { name: '편집', exact: true }).click();
    await page.locator('#content-notice-title').waitFor();
    await capture('02-notice-edit-1280');
    if (process.argv.includes('--before')) {
      checks.push('baseline content list and published notice editor captured');
      if (process.argv.includes('--theme-before')) {
        await page.keyboard.press('Escape');
        await page.goto(`${f.baseUrl}/console/events/${f.eventId}/page`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: '게시', exact: true }).click();
        await page.getByRole('group', { name: '실행 확인', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'theme-review-before.png') });
      }
    } else {
      const dialog = page.getByRole('dialog');
      const rowNamed = title => page.locator('li').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
      const openReview = async title => { await rowNamed(title).getByRole('button', { name: '게시 검토', exact: true }).click(); await dialog.getByRole('heading', { name: '공지 게시 검토', exact: true }).waitFor(); };
      publicContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
      screenPage = await publicContext.newPage();
      await screenPage.goto(`${f.baseUrl}/screen/${f.slug}`, { waitUntil: 'networkidle' });
      await screenPage.getByText(notice.body, { exact: true }).waitFor();
      phase = 'display recovery from a stalled response body';
      await checkDisplayRecovery(screenPage, f.baseUrl, f.slug, notice.body, out, check);
      phase = 'save draft without changing live notice';
      check('editing does not expose a publication checkbox', await dialog.getByRole('checkbox', { name: /게시함/ }).count() === 0);
      await page.locator('#content-notice-title').fill('입장 장소 변경 안내');
      await page.locator('#content-notice-body').fill('서문 데스크에서 QR 티켓을 보여 주세요.');
      await dialog.getByRole('button', { name: '초안 저장', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('draft save leaves the public notice unchanged', (await publicRead()).notices.find(n => n.id === notice.id).body === notice.body);
      await screenPage.reload({ waitUntil: 'networkidle' });
      check('the selected public screen keeps its published notice during drafting', await screenPage.getByText(notice.body, { exact: true }).isVisible());
      check('saved draft survives canonical reload', (await read()).notices.find(n => n.id === notice.id).draft.title === '입장 장소 변경 안내');
      await rowNamed('입장 장소 변경 안내').getByText('수정 초안 있음', { exact: true }).waitFor();
      await openReview('입장 장소 변경 안내');
      check('review compares live and draft content together', await dialog.locator('dd').filter({ hasText: notice.body }).isVisible() && await dialog.locator('dd').filter({ hasText: '서문 데스크에서 QR 티켓을 보여 주세요.' }).isVisible());
      check('review names actual participant and screen destinations', await dialog.getByText('행사 안내 · 공지', { exact: true }).isVisible() && await dialog.getByText('참가자 홈 · 공지', { exact: true }).isVisible() && await dialog.getByText('행사장 전광판', { exact: true }).isVisible());
      check('review warns about an already selected public screen', await dialog.getByText(/전광판 내용도 즉시 바뀝니다/).isVisible());
      check('destination links lead to existing routes without bearer data', (await dialog.getByRole('link').evaluateAll(links => links.map(a => a.getAttribute('href')))).every(url => /^\/(event|screen)\//.test(url) && !/ticket|token|session/.test(url)));
      await capture('03-review-1280'); await audit('notice review 1280');
      for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); await capture(`03-review-${width}`); await audit('notice review ' + width); }
      await page.setViewportSize({ width: 1280, height: 1000 });
      const countBeforeCancel = writes.length;
      await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
      check('cancel review performs no write and restores focus', writes.length === countBeforeCancel && await rowNamed('입장 장소 변경 안내').getByRole('button', { name: '게시 검토', exact: true }).evaluate(el => el === document.activeElement));
      await openReview('입장 장소 변경 안내'); await dialog.getByRole('button', { name: '게시하기', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('publishing changes the actual public projection', (await publicRead()).notices.find(n => n.id === notice.id).title === '입장 장소 변경 안내');
      const publicPage = await publicContext.newPage(); await publicPage.goto(`${f.baseUrl}/event/${f.slug}`, { waitUntil: 'networkidle' });
      await publicPage.getByRole('heading', { name: '입장 장소 변경 안내', exact: true }).waitFor();
      check('the real participant page renders published content', await publicPage.getByText('서문 데스크에서 QR 티켓을 보여 주세요.', { exact: true }).isVisible());
      await publicPage.close();
      await screenPage.reload({ waitUntil: 'networkidle' });
      check('publishing updates the notice on the actual selected screen', await screenPage.getByText('서문 데스크에서 QR 티켓을 보여 주세요.', { exact: true }).isVisible());
      phase = 'program schedule and venue drafts';
      await page.getByRole('tab', { name: '프로그램 일정', exact: true }).click();
      await rowNamed('파트너 세션').getByRole('button', { name: '편집', exact: true }).click();
      await page.locator('#content-program-title').fill('파트너 협업 세션');
      await dialog.getByRole('button', { name: '초안 저장', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('schedule draft leaves live program unchanged', (await publicRead()).program.some(p => p.title === '파트너 세션'));
      await rowNamed('파트너 협업 세션').getByRole('button', { name: '게시 검토', exact: true }).click();
      await dialog.getByText('행사 안내 · 프로그램', { exact: true }).waitFor(); await capture('04-program-review-1280');
      await dialog.getByRole('button', { name: '게시하기', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('schedule review publishes only the saved revision', (await publicRead()).program.some(p => p.title === '파트너 협업 세션'));
      await page.getByRole('tab', { name: '장소 안내', exact: true }).click();
      await page.locator('#content-venue-name').fill('서울 파트너 컨벤션홀');
      check('unsaved venue cannot be published', await page.getByRole('button', { name: '게시 검토', exact: true }).isDisabled());
      await page.getByRole('button', { name: '초안 저장', exact: true }).click();
      await page.getByText('장소 안내 초안을 저장했습니다. 게시 검토 후 참가자 화면에 반영할 수 있습니다.', { exact: true }).waitFor();
      check('venue draft leaves the public venue unchanged', (await publicRead()).venue.name === '서울 컨벤션홀');
      await page.getByRole('button', { name: '게시 검토', exact: true }).click(); await capture('05-venue-review-1280');
      await dialog.getByRole('button', { name: '게시하기', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('venue review publishes saved text', (await publicRead()).venue.name === '서울 파트너 컨벤션홀');
      phase = 'venue save response loss';
      let loseVenueSave = true;
      const lostVenueSave = async route => {
        const body = route.request().postDataJSON();
        if (body.command !== 'venue.save' || !loseVenueSave) return route.continue();
        loseVenueSave = false; const response = await route.fetch(); assert.ok(response.ok()); return route.abort('failed');
      };
      await page.route('**/api/events/*/commands', lostVenueSave);
      await page.locator('#content-venue-name').fill('서울 파트너 컨벤션홀 · 서문');
      const venueWritesBefore = writes.filter(w => w.command === 'venue.save').length;
      await page.getByRole('button', { name: '초안 저장', exact: true }).click();
      const venueRecovery = page.getByRole('region', { name: '콘텐츠 저장 확인 필요', exact: true }); await venueRecovery.waitFor();
      check('lost venue save retains input and keeps the published venue', await page.locator('#content-venue-name').inputValue() === '서울 파트너 컨벤션홀 · 서문' && await page.locator('#content-venue-name').isDisabled() && (await publicRead()).venue.name === '서울 파트너 컨벤션홀');
      await venueRecovery.getByRole('button', { name: '서버 처리 확인', exact: true }).click(); await venueRecovery.waitFor({ state: 'hidden' });
      check('status-only venue recovery adopts the canonical draft revision', writes.filter(w => w.command === 'venue.save').length === venueWritesBefore + 1 && await page.getByRole('button', { name: '게시 검토', exact: true }).isEnabled());
      await page.getByRole('button', { name: '게시 검토', exact: true }).click();
      await dialog.getByRole('button', { name: '게시하기', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('a recovered venue draft can be reviewed and published without a stale revision', (await publicRead()).venue.name === '서울 파트너 컨벤션홀 · 서문');
      await page.unroute('**/api/events/*/commands', lostVenueSave);
      phase = 'publish receipt recovery';
      await page.getByRole('tab', { name: '공지', exact: true }).click();
      let faultId = '', faultMode = '', faultCount = 0, holdRefresh = false;
      await page.route('**/api/events/*/bootstrap', async route => {
        if (!holdRefresh) return route.continue();
        if (['missing-event', 'partial-workspace'].includes(faultMode)) {
          const response = await route.fetch(); const body = await response.json();
          if (faultMode === 'missing-event') body.state.events = [];
          else delete body.state.workspaces[f.eventId].venue;
          // Keep the real authority headers; only the synthetic read body is incomplete.
          return route.fulfill({ response, body: JSON.stringify(body) });
        }
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"합성 조회 오류"}' });
      });
      await page.route('**/api/events/*/commands', async route => {
        const body = route.request().postDataJSON();
        if (body.command !== 'notice.publish-reviewed' || body.payload.id !== faultId) return route.continue();
        faultCount++;
        if (faultCount === 1) {
          const response = await route.fetch(); assert.ok(response.ok());
          if (faultMode === 'partial') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notice: { id: faultId, published: true, version: body.payload.expectedVersion + 1 } }) });
          if (faultMode === 'missing-review-context') {
            const data = await response.json(); delete data.reviewedDestinations;
            return route.fulfill({ response, body: JSON.stringify(data) });
          }
          if (['refresh', 'missing-event', 'partial-workspace'].includes(faultMode)) { holdRefresh = true; return route.fulfill({ response }); }
          return route.abort('failed');
        }
        if (faultCount === 2 && faultMode === 'lost') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"합성 권한 확인"}' });
        return route.continue();
      });
      const recovery = dialog.getByRole('region', { name: '콘텐츠 저장 확인 필요', exact: true });
      for (const mode of ['lost', 'partial', 'missing-review-context', 'refresh', 'missing-event', 'partial-workspace']) {
        const title = `게시 복구 ${mode}`;
        const draft = (await run('notice.save', { title, body: '서버에 저장한 합성 초안입니다.', mode: 'draft' })).notice;
        await page.reload({ waitUntil: 'networkidle' });
        faultId = draft.id; faultMode = mode; faultCount = 0;
        await openReview(title); await dialog.getByRole('button', { name: '게시하기', exact: true }).click();
        await recovery.waitFor();
        check(mode + ' keeps the publication locked until verified', await dialog.getByRole('button', { name: '게시하기', exact: true }).isDisabled());
        if (mode === 'lost') {
          await recovery.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click(); await recovery.getByRole('alert').waitFor();
          check('a later denial cannot erase the earlier uncertain publication', await dialog.getByRole('button', { name: '게시하기', exact: true }).isDisabled());
          await recovery.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
        } else {
          holdRefresh = false;
          await recovery.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
        }
        await dialog.waitFor({ state: 'hidden' });
        const attempts = writes.filter(write => write.command === 'notice.publish-reviewed' && write.payload.id === draft.id);
        check(mode + ' never creates a second publication command', new Set(attempts.map(write => write.commandId)).size === 1 && attempts.length === (mode === 'lost' ? 3 : 1));
        check(mode + ' refreshes the actual published state', (await publicRead()).notices.some(n => n.id === draft.id));
      }
      phase = 'reload an uncertain publication';
      const reloadDraft = (await run('notice.save', { title: '새로고침 게시 복구', body: '보관하지 않을 합성 게시 내용', mode: 'draft' })).notice;
      await page.reload({ waitUntil: 'networkidle' }); faultId = reloadDraft.id; faultMode = 'partial'; faultCount = 0;
      await openReview('새로고침 게시 복구'); await dialog.getByRole('button', { name: '게시하기', exact: true }).click(); await recovery.waitFor();
      const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
      check('publication recovery stores no title or body', stored.includes('notice.publish-reviewed') && !stored.includes('보관하지 않을') && !stored.includes('새로고침 게시 복구'));
      await page.reload({ waitUntil: 'networkidle' });
      const shared = page.getByRole('region', { name: '처리 결과 확인', exact: true }); await shared.waitFor();
      check('reload blocks new content until the scoped publication is checked', await page.getByRole('button', { name: '공지 작성', exact: true }).isDisabled());
      const beforeStatus = writes.filter(w => w.command === 'notice.publish-reviewed' && w.payload.id === reloadDraft.id).length;
      await shared.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '공지 작성' && !b.disabled));
      check('reload status lookup refreshes without republishing', writes.filter(w => w.command === 'notice.publish-reviewed' && w.payload.id === reloadDraft.id).length === beforeStatus);
      phase = 'concurrent publication revision';
      const concurrent = (await run('notice.save', { title: '버전 충돌 공지', body: '검토 당시 내용', mode: 'draft' })).notice;
      await page.reload({ waitUntil: 'networkidle' }); await openReview('버전 충돌 공지');
      await run('notice.save', { id: concurrent.id, title: '버전 충돌 공지', body: '다른 운영자가 저장한 새 내용', mode: 'draft', expectedVersion: concurrent.version });
      await dialog.getByRole('button', { name: '게시하기', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: '검토 중 내용이 바뀌었습니다' }).waitFor();
      check('stale review cannot publish a concurrent draft', !(await publicRead()).notices.some(n => n.id === concurrent.id) && await dialog.getByRole('button', { name: '게시하기', exact: true }).isDisabled());
      await dialog.getByRole('button', { name: '돌아가기', exact: true }).click(); await openReview('버전 충돌 공지');
      check('returning to review presents the refreshed draft', await dialog.locator('dd').filter({ hasText: '다른 운영자가 저장한 새 내용' }).isVisible());
      await dialog.getByRole('button', { name: '게시하기', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('a newly reviewed revision can be explicitly published', (await publicRead()).notices.find(n => n.id === concurrent.id).body === '다른 운영자가 저장한 새 내용');
      phase = 'unpublish review';
      await rowNamed('입장 장소 변경 안내').getByRole('button', { name: '게시 내리기', exact: true }).click();
      await dialog.getByRole('heading', { name: '공지 게시 내리기', exact: true }).waitFor(); await capture('06-unpublish-review-1280');
      await dialog.getByRole('button', { name: '게시 내리기', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('unpublish removes public content and keeps the editable draft', !(await publicRead()).notices.some(n => n.id === notice.id) && (await read()).notices.find(n => n.id === notice.id).draft.title === '입장 장소 변경 안내');
      await screenPage.reload({ waitUntil: 'networkidle' });
      check('unpublishing removes the notice from the selected screen', await screenPage.getByText('서문 데스크에서 QR 티켓을 보여 주세요.', { exact: true }).count() === 0);
      await capture('07-list-after-1280'); await audit('final content list');
      phase = 'participant page review and effective visibility';
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/page`, { waitUntil: 'networkidle' });
      const previousIntro = (await publicRead()).pageExperience.published.intro;
      await page.locator('#home-intro').fill('파트너와 함께 만드는 새로운 연결');
      await page.getByRole('checkbox', { name: '공지 보기', exact: true }).uncheck();
      await page.getByRole('button', { name: '초안 저장', exact: true }).click();
      await page.getByText('초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.', { exact: true }).waitFor();
      check('participant page draft stays private', (await publicRead()).pageExperience.published.intro === previousIntro);
      await page.getByRole('button', { name: '게시 검토', exact: true }).click();
      await dialog.getByRole('heading', { name: '참가자 페이지 게시 검토', exact: true }).waitFor();
      check('page review compares saved design and names its two actual surfaces', await dialog.locator('dd').filter({ hasText: '파트너와 함께 만드는 새로운 연결' }).isVisible() && await dialog.getByText('참가자 홈', { exact: true }).isVisible() && await dialog.getByText('행사 안내', { exact: true }).isVisible());
      await capture('08-theme-review-1280'); await audit('participant page review');
      await page.setViewportSize({ width: 320, height: 844 }); await capture('08-theme-review-320'); await audit('participant page review 320');
      await page.keyboard.press('Tab');
      check('keyboard focus remains inside the publication dialog', await dialog.evaluate(el => el.contains(document.activeElement)));
      const beforeEscape = writes.length;
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      check('escape exits page review without publishing', writes.length === beforeEscape);
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.getByRole('button', { name: '게시 검토', exact: true }).click();
      await dialog.getByRole('button', { name: '게시하기', exact: true }).click();
      await page.getByText('게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.', { exact: true }).waitFor();
      check('page review publishes the saved design and visibility settings', (await publicRead()).pageExperience.published.intro === '파트너와 함께 만드는 새로운 연결' && (await publicRead()).pageExperience.published.showAnnouncements === false);
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/content`, { waitUntil: 'networkidle' });
      await rowNamed('입장 장소 변경 안내').getByRole('button', { name: '게시 검토', exact: true }).click();
      check('content review explains why published notices can remain hidden', await dialog.getByText(/참가자 페이지 설정에서 공지 표시가 꺼져/).isVisible() && await dialog.getByText(/공지 메뉴가 숨겨져/).isVisible());
      await capture('09-hidden-destinations-1280');

    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ phase: process.argv.includes('--before') ? 'before' : 'after', accessibility, build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), checks, writes: writes.length, errors }, null, 2), { mode: 0o600 });
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    console.error('PHASE', phase); throw error;
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
