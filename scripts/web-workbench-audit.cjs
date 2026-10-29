'use strict';

// Real UI workbench journeys. Every write uses a disposable PostgreSQL schema
// through the existing API; messages are explicitly simulated. No deployed or
// review data is used. Run before/after with the corresponding built artifact.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const PHASE = process.env.WORKBENCH_PHASE === 'before' ? 'before' : 'after';
const OUT = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'workbench', PHASE)
  : path.join(defaultCaptureDir(`workbench-${runStamp()}`), PHASE);

// Compare the painted glyphs rather than bounding boxes: the manual-send
// explanation must wrap at Korean word boundaries on small screens.
async function splitKoreanWords(locator) {
  return locator.evaluate((node) => {
    const range = document.createRange(), chars = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      for (let i = 0; i < text.data.length; i++) {
        range.setStart(text, i); range.setEnd(text, i + 1);
        const rect = range.getClientRects()[0];
        chars.push({ char: text.data[i], top: rect ? Math.round(rect.top) : null });
      }
    }
    return chars.flatMap((char, index) => {
      const previous = chars[index - 1];
      return previous && char.top !== null && previous.top !== null && char.top !== previous.top && /[가-힣]/.test(previous.char) && /[가-힣]/.test(char.char)
        ? [`${previous.char}/${char.char}`] : [];
    });
  });
}

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const f = await startAuditFixture();
  const checks = [], metrics = [], errors = [], journeys = [];
  const check = (name, ok, detail = null) => {
    checks.push({ name, ok: Boolean(ok), detail });
    assert.ok(ok, `${name}: ${JSON.stringify(detail)}`);
  };
  const command = async (command, payload) => {
    const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(r.status >= 200 && r.status < 300, `${command}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const bootstrap = async () => (await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: f.manager.cookie })).json.state;
  let browser;
  try {
    await command('event.features', { features: ['poll', 'quiz', 'qa', 'draw', 'survey', 'stamp', 'photo', 'board', 'venue', 'screen', 'reward'] });
    let state = await bootstrap();
    const initial = state.workspaces[f.eventId].participants.length;
    await command('participant.import', { rows: Array.from({ length: 100 - initial }, (_, i) => ({
      name: `작업대 참가자 ${String(i + initial + 1).padStart(3, '0')}`,
      phone: `0108${String(i + initial + 1).padStart(7, '0')}`,
      company: i % 2 ? '파트너 운영팀' : '행사 기획팀',
    })) });
    state = await bootstrap();
    const people = state.workspaces[f.eventId].participants;
    await command('participant.status', { ids: people.slice(0, 50).map(p => p.id), status: 'PENDING' });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(f.manager.cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    // Roster renders twice in the DOM: a table (desktop) and a list (mobile);
    // CSS shows exactly one per viewport (participantList CSS: .tableScroll
    // hidden at <=768px, .participantList hidden above). getByRole excludes
    // the display:none copy from the accessibility tree, so the checkbox
    // resolves to the visible copy and the row below is the visible container.
    const checkboxFor = (name) => page.getByRole('checkbox', { name: `${name} 선택`, exact: true });
    const rowFor = (name) => page.locator('tbody tr, ul > li').filter({ has: checkboxFor(name) });
    page.on('pageerror', error => errors.push(error.message));
    const base = `${f.baseUrl}/console/events/${f.eventId}`;
    for (const width of [1280, ...(PHASE === 'after' ? [1024, 800, 768] : []), 390, ...(PHASE === 'after' ? [320] : [])]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const [name, route, marker] of [
        ['participants-100', '/participants', '#roster-search-label'],
        ['messages', '/messages', '#history-heading'],
        ['theme', '/page', '#home-intro'],
        ['overview-live', '', '#event-metrics-heading'],
        ['operations', '/operations', '#ops-desks'],
        ['settings', '/settings', '#set-name'],
      ]) {
        await page.goto(base + route);
        await page.locator(marker).waitFor({ state: 'attached' });
        await page.locator('h1').waitFor();
        if (name === 'participants-100' && (width === 1280 || width === 390)) {
          // Both the desktop table and phone list exist in the DOM. The
          // visible approval must keep its action name and describe exactly
          // its own participant without duplicate ids across those copies.
          const approve = page.getByRole('button', { name: '승인', exact: true }).first();
          const described = await approve.evaluate((button) => {
            const id = button.getAttribute('aria-describedby');
            const matches = [...document.querySelectorAll('[id]')].filter((element) => element.id === id);
            const row = button.closest('tr, li');
            return { id, count: matches.length, text: matches[0]?.textContent, name: row?.querySelector('strong')?.textContent };
          });
          check(`approval describes its own participant at ${width}`, described.count === 1 && Boolean(described.name) && described.text === described.name, described);
        }
        await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true });
        await page.screenshot({ path: `${OUT}/${name}-${width}-viewport.png`, fullPage: false });
        metrics.push({ name, width, ...await page.evaluate(() => {
          // Visible copy only: the roster keeps both a desktop table and a
          // mobile list in the DOM and CSS shows exactly one. Hidden inputs
          // (display:none) must not inflate the row count, and the measured
          // row is the visible container (tr on desktop, li on mobile) of the
          // first visible row checkbox — never the thead select-all.
          const visibleBoxes = [...document.querySelectorAll('main input[aria-label$=" 선택"]')].filter(e => e.getClientRects().length);
          const rowBoxes = visibleBoxes.filter(e => e.closest('tbody tr, ul li'));
          const firstRow = rowBoxes[0]?.closest('tr, li') ?? null;
          return {
            height: document.documentElement.scrollHeight,
            overflow: document.documentElement.scrollWidth - innerWidth,
            rosterRows: rowBoxes.length,
            firstRosterRowHeight: firstRow?.getBoundingClientRect().height ?? null,
            firstRosterIdentityWidth: firstRow?.querySelector('strong')?.parentElement?.getBoundingClientRect().width ?? null,
            visibleButtons: [...document.querySelectorAll('main button, main summary')].filter(e => e.getClientRects().length).length,
            sections: [...document.querySelectorAll('main h2')].filter(e => e.getClientRects().length).map(e => ({ title: e.textContent, y: Math.round(e.getBoundingClientRect().top + scrollY) })),
          };
        }) });
      }
    }
    fs.writeFileSync(`${OUT}/metrics.json`, JSON.stringify(metrics, null, 2), { mode: 0o600 });
    if (PHASE === 'after') {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(base + '/participants');
        const firstRow = rowFor(people[0].name);
        await firstRow.waitFor({ state: 'visible' });
        const rowTop = (await firstRow.boundingBox()).y;
        check(`mobile roster starts within the working viewport at ${width}`, rowTop <= 600, rowTop);
        const scope = page.locator('details').filter({ has: page.getByText('여러 명 선택', { exact: true }) });
        const summary = scope.locator('summary');
        await summary.focus();
        await page.keyboard.press('Enter');
        check(`mobile scope opens by keyboard at ${width}`, await scope.evaluate(node => node.open));
        await scope.getByRole('button', { name: '이 페이지 25명 선택', exact: true }).click();
        check(`mobile page choice closes its menu and restores focus at ${width}`, !(await scope.evaluate(node => node.open)) && await summary.evaluate(node => node === document.activeElement));
        const counts = page.locator('#roster-selection-count');
        check(`mobile page selection remains page-scoped at ${width}`, (await counts.textContent()).includes('선택한 참가자 25명') && (await counts.textContent()).includes('이 페이지 25명'));
        await page.getByRole('button', { name: '선택 해제', exact: true }).click();
        await summary.focus();
        await page.keyboard.press('Enter');
        await scope.getByRole('button', { name: '필터 결과 전체 100명 선택', exact: true }).click();
        check(`mobile filter choice exposes its results at ${width}`, !(await scope.evaluate(node => node.open)) && await summary.evaluate(node => node === document.activeElement));
        check(`mobile filter selection includes the other pages at ${width}`, (await counts.textContent()).includes('선택한 참가자 100명') && (await counts.textContent()).includes('다른 페이지 75명 포함'));
        const brokenWords = [...await splitKoreanWords(counts), ...await splitKoreanWords(page.locator('#roster-approve-selected'))];
        check(`mobile selection text keeps Korean words intact at ${width}`, brokenWords.length === 0, brokenWords);
        await page.screenshot({ path: `${OUT}/roster-mobile-selection-${width}.png` });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const act = async (task, action) => { task.operations += 1; await action(); };
    const newTask = async (name, route) => {
      await page.goto(base + route);
      await page.locator('h1').waitFor();
      await page.evaluate(() => { window.__workbenchScrolls = 0; window.addEventListener('scroll', () => window.__workbenchScrolls += 1); });
      const task = { name, operations: 0, scrollEvents: null };
      journeys.push(task);
      return task;
    };
    const finish = async (task, name) => {
      task.scrollEvents = await page.evaluate(() => window.__workbenchScrolls);
      await page.screenshot({ path: `${OUT}/journey-${name}.png`, fullPage: true });
    };
    const roster = await newTask('100명 명단: 1명 승인 → 두 위치에서 2명 선택', '/participants');
    const first = people[0], later = people[25];
    await page.getByRole('checkbox', { name: `${first.name} 선택`, exact: true }).waitFor();
    const firstRow = rowFor(first.name);
    await act(roster, () => firstRow.getByRole('button', { name: '승인', exact: true }).click());
    await page.getByText(`${first.name} 상태를 참가 확정`, { exact: false }).waitFor();
    check('single approval persisted', (await bootstrap()).workspaces[f.eventId].participants.find(p => p.id === first.id).status === 'APPROVED');
    await act(roster, () => page.getByRole('checkbox', { name: `${first.name} 선택`, exact: true }).check());
    if (PHASE === 'after') {
      // Visible container only: desktop renders the page as tbody rows,
      // mobile as list items; the DOM keeps both and CSS shows one.
      check('only 25 roster rows rendered', await page.locator('tbody tr, ul > li').evaluateAll(nodes => nodes.filter(e => e.getClientRects().length).length) === 25);
      await act(roster, () => page.getByRole('button', { name: '다음', exact: true }).click());
      await page.waitForFunction(() => document.activeElement?.id === 'participants-list-heading');
      check('paging starts at the new slice rather than old scroll offset', await page.getByRole('checkbox', { name: `${later.name} 선택`, exact: true }).evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
    }
    await act(roster, () => page.getByRole('checkbox', { name: `${later.name} 선택`, exact: true }).check());
    if (PHASE === 'after') {
      check('page selection separated from full selection', await page.locator('#roster-selection-count').textContent().then(t => t.includes('선택한 참가자 2명') && t.includes('현재 필터 2명') && t.includes('이 페이지 1명') && t.includes('다른 페이지 1명 포함')));
      await act(roster, () => page.getByRole('button', { name: '검색으로 이동', exact: true }).click());
      check('return focuses search', await page.locator('#roster-search').evaluate(e => e === document.activeElement));
      check('return also exposes search in viewport', await page.locator('#roster-search').evaluate(e => { const r = e.getBoundingClientRect(); const rail = document.querySelector('.console-sidebar')?.getBoundingClientRect(); return r.top >= (innerWidth <= 768 ? rail?.bottom ?? 0 : 0) && r.bottom <= innerHeight; }));
    }
    await finish(roster, 'roster-selection');

    if (PHASE === 'after') {
      await page.getByRole('searchbox', { name: '이름·소속·연락처 검색', exact: true }).fill(later.name);
      check('filter retains hidden selection', await page.locator('#roster-selection-count').textContent().then(t => t.includes('선택한 참가자 2명') && t.includes('현재 필터 1명') && t.includes('숨김 1명')));
      // The reset lives inside the advanced-filters disclosure, which starts
      // collapsed at every width: a real operator opens the disclosure to
      // reach it. The check below still clicks the real reset control.
      if ((await page.locator('#roster-filter-toggle').getAttribute('aria-expanded')) !== 'true') {
        await page.locator('#roster-filter-toggle').click();
      }
      await page.getByRole('button', { name: '검색·필터 초기화', exact: true }).click();
      check('filter reset retains selection', (await page.locator('#roster-selection-count').textContent()).includes('선택한 참가자 2명'));
      const row = rowFor(first.name);
      await row.getByRole('button', { name: `${first.name} 참가자 상세`, exact: true }).click();
      const detail = page.getByRole('dialog');
      await detail.getByRole('combobox', { name: `${first.name} 상태 변경`, exact: true }).selectOption('CANCELLED');
      check('cancel remains explicit before write', (await bootstrap()).workspaces[f.eventId].participants.find(p => p.id === first.id).status === 'APPROVED');
      await detail.getByRole('button', { name: '취소', exact: true }).click();
      await page.keyboard.press('Escape');
      check('cancel review dismissal preserves selection', (await page.locator('#roster-selection-count').textContent()).includes('선택한 참가자 2명'));
    }

    const messaging = { name: '선택 명단 → 안내 작성 → 명시적 검토 → 모의 발송', operations: 0, scrollEvents: null };
    journeys.push(messaging);
    await act(messaging, () => page.locator('#roster-send-message').click());
    await page.locator('#campaign-title').waitFor();
    await page.evaluate(() => { window.__workbenchScrolls = 0; window.addEventListener('scroll', () => window.__workbenchScrolls += 1); });
    check('handoff retains two known recipients', (await page.locator('#recipient-summary').textContent()).includes('선택 2명'));
    check('handoff never schedules', await page.locator('#campaign-scheduled').inputValue() === '');
    await act(messaging, () => page.locator('#campaign-title').fill('선택 명단 안내'));
    await act(messaging, () => page.locator('#campaign-body').fill('행사 안내를 확인해 주세요.'));
    await act(messaging, () => page.getByLabel('모의 발송으로 기록', { exact: false }).check());
    await act(messaging, () => page.locator('#campaign-submit').click());
    check('review does not send automatically', (await bootstrap()).workspaces[f.eventId].messages.length === 0);
    await act(messaging, () => page.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click());
    await page.getByText('모의 발송을 기록했습니다', { exact: false }).first().waitFor();
    const messages = (await bootstrap()).workspaces[f.eventId].messages;
    check('simulated send persisted once with exact selection', messages.length === 1 && messages[0].simulate === true && JSON.stringify([...messages[0].recipientIds].sort()) === JSON.stringify([first.id, later.id].sort()));
    await finish(messaging, 'message-simulated');

    const theme = await newTask('배경 수정 → 초안 저장 → 명시적 게시', '/page');
    await page.locator('#home-background').waitFor();
    if (PHASE === 'after') check('desktop preview does not rename edit location', await page.locator('nav[aria-label="참가자 페이지 구역"] a[href="#theme-edit"]').getAttribute('aria-current') === 'location');
    if (PHASE === 'after') {
      const intro = page.locator('#home-intro');
      const originalIntro = await intro.inputValue();
      const introOnly = '검증용 소개 변경 — 미리보기에는 표시되지 않음';
      await intro.fill(introOnly);
      check('intro-only edit marks its own group', (await intro.locator('xpath=ancestor::fieldset[1]/legend').innerText()).includes('미저장 변경'));
      check('intro-only edit does not mark unrelated design groups',
        !(await page.locator('#home-background').locator('xpath=ancestor::fieldset[1]/legend').innerText()).includes('미저장 변경')
        && !(await page.locator('#home-hero-title').locator('xpath=ancestor::fieldset[1]/legend').innerText()).includes('미저장 변경'));
      check('intro-only edit is not described as immediately previewed',
        await page.getByText('미저장 변경이 미리보기에 바로 반영됩니다.', { exact: true }).count() === 0
        && !(await page.locator('[aria-labelledby="home-preview-heading"]').innerText()).includes(introOnly));
      await intro.fill(originalIntro);
      check('reverting intro clears that group marker', !(await intro.locator('xpath=ancestor::fieldset[1]/legend').innerText()).includes('미저장 변경'));
    }
    await act(theme, () => page.locator('#home-background').fill('#FFF1E8'));
    if (PHASE === 'after') {
      const mirror = page.locator('#theme-edit > div:first-child > span:first-child');
      const live = page.locator('#theme-save [aria-live="polite"]');
      check('background edit marks its group', (await page.locator('#home-background').locator('xpath=ancestor::fieldset[1]/legend').innerText()).includes('미저장 변경'));
      const editorStatus = { mirrors: await mirror.count(), visible: await mirror.first().isVisible(), live: await live.count(), mirror: await mirror.first().textContent(), announcement: await live.first().textContent() };
      check('visible editor status matches the single save announcement', editorStatus.mirrors === 1 && editorStatus.visible && editorStatus.live === 1 && editorStatus.announcement.includes(editorStatus.mirror), editorStatus);
      await page.screenshot({ path: `${OUT}/theme-dirty-1280.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${OUT}/theme-dirty-390.png`, fullPage: true });
      const previewJump = page.getByRole('button', { name: '현재 디자인 미리보기', exact: true }).first();
      await previewJump.focus();
      await page.keyboard.press('Enter');
      await page.locator('#home-preview-heading').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.activeElement?.id === 'home-preview-heading');
      check('mobile preview replaces the editor without discarding it', !(await page.locator('#theme-edit').isVisible()) && await page.locator('#home-preview-heading').isVisible());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const previewPosition = await page.locator('#home-preview-heading').evaluate(e => ({ top: e.getBoundingClientRect().top, barBottom: document.querySelector('.console-sidebar')?.getBoundingClientRect().bottom ?? 0 }));
      check('mobile preview focus is not under the console header', previewPosition.top >= previewPosition.barBottom, previewPosition);
      await page.screenshot({ path: `${OUT}/theme-mobile-preview-390.png` });
      await page.getByRole('button', { name: '편집하던 곳으로 돌아가기', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '현재 디자인 미리보기');
      check('mobile preview returns to its initiating control with unsaved edit intact', await previewJump.evaluate(e => e === document.activeElement) && (await page.locator('#home-background').inputValue()).toLowerCase() === '#fff1e8');
      const saveJump = page.getByRole('link', { name: '저장·게시 검토', exact: true });
      await saveJump.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.id === 'theme-save-draft');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const savePosition = await page.locator('#theme-save-draft').evaluate(e => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom, viewport: innerHeight, barBottom: document.querySelector('.console-sidebar')?.getBoundingClientRect().bottom ?? 0 }));
      check('mobile review jump moves keyboard focus below the console header', savePosition.top >= savePosition.barBottom && savePosition.bottom <= savePosition.viewport, savePosition);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await act(theme, () => page.locator('#theme-save-draft').click());
    await page.getByText('초안을 저장했습니다', { exact: false }).first().waitFor();
    let pageExperience = (await bootstrap()).workspaces[f.eventId].pageExperience;
    check('saved draft stays unpublished', !pageExperience.publishedAt && pageExperience.draft.homeStyle.backgroundColor === '#FFF1E8');
    await act(theme, () => page.getByRole('button', { name: '게시', exact: true }).click());
    check('publish review does not publish automatically', !(await bootstrap()).workspaces[f.eventId].pageExperience.publishedAt);
    await act(theme, () => page.getByRole('button', { name: '게시하기', exact: true }).click());
    await page.getByText('게시했습니다. 이 행사를 보는 참가자에게', { exact: false }).first().waitFor();
    pageExperience = (await bootstrap()).workspaces[f.eventId].pageExperience;
    check('published background matches saved draft', pageExperience.published.homeStyle.backgroundColor === '#FFF1E8');
    await act(theme, () => page.getByRole('button', { name: '게시본', exact: true }).click());
    if (PHASE === 'after') check('preview source switch preserves editing position', await page.locator('nav[aria-label="참가자 페이지 구역"] a[href="#home-preview-heading"]').getAttribute('aria-current') === null && await page.locator('nav[aria-label="참가자 페이지 구역"] a[aria-current="location"]').count() === 1);
    if (PHASE === 'after') {
      const title = page.locator('#home-hero-title');
      const originalTitle = await title.inputValue();
      await title.fill('검증용 미게시 배너 제목');
      check('published preview does not show an unsaved banner title', !(await page.locator('[aria-labelledby="home-preview-heading"]').innerText()).includes('검증용 미게시 배너 제목'));
      await title.fill(originalTitle);
    }
    await finish(theme, 'theme-published');

    if (PHASE === 'before') return;
    await page.getByRole('button', { name: '편집 중', exact: true }).click();
    const imageDetails = page.locator('summary', { hasText: '이미지 상세 설정' });
    await imageDetails.focus();
    await page.keyboard.press('Enter');
    check('image details reveal with keyboard', await page.locator('#home-image-focus').isVisible());
    await page.locator('#home-image-focus').selectOption('top');
    const layoutDetails = page.locator('summary', { hasText: '배치·색상 상세 설정' });
    await layoutDetails.focus();
    await page.keyboard.press('Enter');
    check('layout details reveal with keyboard', await page.locator('#home-layout').isVisible());
    await page.locator('#home-layout').selectOption('bottom-overlay');
    await page.locator('#home-overlay').selectOption('soft');
    await page.locator('#theme-save-draft').click();
    await page.getByText('초안을 저장했습니다', { exact: false }).first().waitFor();
    const advancedPage = (await bootstrap()).workspaces[f.eventId].pageExperience;
    check('advanced changes save to draft only', advancedPage.draft.homeStyle.imageFocus === 'top' && advancedPage.draft.homeStyle.heroLayout === 'bottom-overlay' && advancedPage.draft.homeStyle.overlay === 'soft' && advancedPage.published.homeStyle.imageFocus === 'center');
    const savedDifference = page.locator('#theme-save summary', { hasText: '게시본과 다른 저장된 변경' });
    await savedDifference.focus();
    await page.keyboard.press('Enter');
    const differenceCopy = savedDifference.locator('..').locator('p');
    check('saved versus published difference stays discoverable', await savedDifference.locator('..').evaluate(e => e.open) && await differenceCopy.isVisible() && (await differenceCopy.textContent()).includes('게시본과 다른 저장된 변경:'));
    const detailedReview = page.locator('#theme-save summary', { hasText: '게시할 변경 내용 확인' });
    await detailedReview.click();
    check('saved changes compare published and draft values', await detailedReview.locator('..').evaluate(e => e.open) && (await detailedReview.locator('..').innerText()).includes('게시본 → 저장된 초안') && await detailedReview.locator('..').locator('dl > div').count() > 0);
    await page.screenshot({ path: `${OUT}/state-theme-advanced-draft-1280.png`, fullPage: true });
    // Surrounding states and entry/exit: no selection, pending deep link,
    // mobile keyboard paging, empty search, grouped nav and preset anchors.
    await page.goto(base + '/messages');
    await page.locator('#message-compose-open').click();
    await page.locator('#campaign-title').waitFor();
    check('zero recipients disables review with visible reason', await page.locator('#campaign-submit').isDisabled() && (await page.locator('#campaign-submit-warning').textContent()).includes('수신자를 먼저 고르세요'));
    // The top review jump must not strand keyboard focus on its old button
    // when the real submit is disabled. Returning to the picker is still an
    // explicit action and neither jump may create a message.
    const commandsBeforeJumps = f.gateway.commands.length;
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      const scheduleBreaks = await splitKoreanWords(page.locator('#campaign-scheduled-help'));
      check(`manual schedule help keeps Korean words intact at ${width}`, scheduleBreaks.length === 0, scheduleBreaks);
      await page.locator('#campaign-send-skip').focus();
      await page.keyboard.press('Enter');
      const reviewPosition = await page.locator('#campaign-submit-warning').evaluate(e => {
        const rect = e.getBoundingClientRect();
        const mobileBar = document.querySelector('.console-sidebar')?.getBoundingClientRect();
        return { focused: e === document.activeElement, top: rect.top, bottom: rect.bottom, viewport: innerHeight, minimum: innerWidth <= 768 ? mobileBar?.bottom ?? 0 : 0 };
      });
      check(`empty review focuses its visible blocker at ${width}`, reviewPosition.focused && reviewPosition.top >= reviewPosition.minimum && reviewPosition.bottom <= reviewPosition.viewport, reviewPosition);
      await page.screenshot({ path: `${OUT}/state-message-empty-review-${width}.png` });
      await page.keyboard.press('Tab');
      check(`empty review reaches the recipient return by keyboard at ${width}`, await page.evaluate(() => document.activeElement?.textContent?.trim() === '수신자 다시 확인'));
      await page.keyboard.press('Enter');
      // The return opens a native disclosure before focusing its filter.
      // Wait for that real focus transition; never focus the target in test.
      await page.waitForFunction(() => document.activeElement?.id === 'recipient-status-filter');
      check(`recipient return focuses the status filter at ${width}`, await page.locator('#recipient-status-filter').evaluate(e => e === document.activeElement));
      await page.locator('#recipient-status-filter').selectOption('ALL');
      const picker = page.locator('#campaign-recipients details');
      const summary = picker.locator('summary');
      if (!(await picker.evaluate(e => e.open))) await summary.click();
      // The browser opens native <details> immediately; its asynchronous
      // toggle event subsequently synchronizes the React description.
      await page.waitForFunction(() => document.querySelector('#recipient-list-summary')?.getAttribute('aria-describedby') === 'recipient-list-keyboard-help');
      check(`recipient shortcut is explained at ${width}`, await page.locator('#recipient-list-keyboard-help').isVisible() && (await summary.getAttribute('aria-describedby')) === 'recipient-list-keyboard-help');
      const boxes = picker.locator('ul[aria-label="참가자 선택"] input[type="checkbox"]');
      const count = await boxes.count();
      check(`long recipient list is present at ${width}`, count >= 50, count);
      const chosen = boxes.nth(Math.floor(count / 2));
      // Focus setup is explicit; the selection, close, continuation and
      // reopen below are real Space/Escape/Tab/Enter keystrokes.
      await chosen.focus();
      await page.keyboard.press('Space');
      check(`keyboard selection is retained at ${width}`, await chosen.isChecked() && (await page.locator('#recipient-summary').innerText()).includes('선택 1명'));
      await page.keyboard.press('Escape');
      check(`Escape closes the list and focuses its summary at ${width}`, !(await picker.evaluate(e => e.open)) && await summary.evaluate(e => e === document.activeElement));
      // The application aligns focus on the next frame, after closing the
      // long list has changed the page height and browser scroll position.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const focusPosition = await summary.evaluate(e => {
        const rect = e.getBoundingClientRect();
        const mobileBar = document.querySelector('.console-sidebar')?.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, viewport: innerHeight, minimum: innerWidth <= 768 ? mobileBar?.bottom ?? 0 : 0 };
      });
      check(`focused recipient summary is in the viewport at ${width}`, focusPosition.top >= focusPosition.minimum && focusPosition.bottom <= focusPosition.viewport, focusPosition);
      await page.screenshot({ path: `${OUT}/state-message-keyboard-${width}.png` });
      await page.keyboard.press('Tab');
      check(`next Tab reaches the message title at ${width}`, await page.locator('#campaign-title').evaluate(e => e === document.activeElement));
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter');
      check(`reopening keeps the exact selection at ${width}`, await picker.evaluate(e => e.open) && await chosen.isChecked());
      await page.locator('#recipient-clear-all').click();
      await summary.click();
    }
    // The compact visible-set control replaces separate add/remove buttons.
    // Exercise its tri-state semantics against a real 100-person workspace:
    // a filtered deselection must never clear the selected person outside it.
    const bulkPicker = page.locator('#campaign-recipients details');
    if (!(await bulkPicker.evaluate(e => e.open))) await bulkPicker.locator('summary').click();
    const bulk = page.getByRole('checkbox', { name: /표시 \d+명 모두 선택/ });
    const peopleBoxes = bulkPicker.locator('ul[aria-label="참가자 선택"] input[type="checkbox"]');
    const firstBulkName = await peopleBoxes.nth(0).evaluate(e => e.closest('label')?.querySelector('span')?.textContent?.trim());
    const secondBulkName = await peopleBoxes.nth(1).evaluate(e => e.closest('label')?.querySelector('span')?.textContent?.trim());
    check('bulk-selection fixture has two distinct names', Boolean(firstBulkName && secondBulkName && firstBulkName !== secondBulkName));
    await peopleBoxes.nth(0).check();
    await peopleBoxes.nth(1).check();
    check('partial visible selection is indeterminate', await bulk.evaluate(e => e.indeterminate && !e.checked));
    await page.locator('#recipient-search').fill(firstBulkName);
    check('filtered bulk checkbox represents just the visible selection', await peopleBoxes.count() === 1 && await bulk.isChecked() && (await page.locator('#recipient-summary').innerText()).includes('화면 밖 선택 1명'));
    await bulk.focus();
    await page.keyboard.press('Space');
    check('keyboard bulk deselection preserves hidden selection', !(await bulk.isChecked()) && (await page.locator('#recipient-summary').innerText()).includes('선택 1명') && (await page.locator('#recipient-summary').innerText()).includes('화면 밖 선택 1명'));
    await page.keyboard.press('Space');
    check('keyboard bulk selection unions visible and hidden recipients', await bulk.isChecked() && (await page.locator('#recipient-summary').innerText()).includes('선택 2명') && (await page.locator('#recipient-summary').innerText()).includes('화면 밖 선택 1명'));
    await page.locator('#recipient-search').clear();
    check('both exact recipients remain selected after clearing the filter', await bulk.evaluate(e => e.indeterminate) && await peopleBoxes.nth(0).isChecked() && await peopleBoxes.nth(1).isChecked());
    const visibleCount = await peopleBoxes.count();
    await bulk.focus();
    await page.keyboard.press('Space');
    check('indeterminate Space selects all visible recipients', await bulk.isChecked() && (await page.locator('#recipient-summary').innerText()).includes(`선택 ${visibleCount}명`));
    await page.keyboard.press('Space');
    check('second Space clears the visible set', !(await bulk.isChecked()) && (await page.locator('#recipient-summary').innerText()).includes('선택 0명'));
    await peopleBoxes.nth(0).check();
    await peopleBoxes.nth(1).check();
    await page.locator('#recipient-search').fill(firstBulkName);
    await page.locator('#recipient-clear-all').click();
    check('explicit full clear removes even hidden selections', (await page.locator('#recipient-summary').innerText()).includes('선택 0명'));
    await page.locator('#recipient-search').fill('검색 결과 없는 고유 수신자 999');
    check('bulk checkbox is disabled when no recipients match', await bulk.isDisabled() && await peopleBoxes.count() === 0);
    await page.locator('#recipient-search').clear();
    // A confirmation is a snapshot, not authority to send after the visible
    // selection or draft changes. Keep the count at one while changing who
    // is selected, then also check edits and a return to the old text.
    const safetyPicker = page.locator('#campaign-recipients details');
    if (!(await safetyPicker.evaluate(e => e.open))) await safetyPicker.locator('summary').click();
    const safetyBoxes = safetyPicker.locator('ul[aria-label="참가자 선택"] input[type="checkbox"]');
    const changedRecipientName = await safetyBoxes.nth(1).evaluate(e => e.closest('label')?.querySelector('span')?.textContent?.trim());
    const changedRecipient = people.find(person => person.name === changedRecipientName);
    check('the second safety recipient is known', Boolean(changedRecipient));
    await safetyBoxes.nth(0).check();
    await page.locator('#campaign-title').fill('검토할 안내');
    await page.locator('#campaign-body').fill('실제 발송하지 않는 검토 검사입니다.');
    await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
    const sendConfirmation = page.getByRole('group', { name: '실행 확인' });
    await page.locator('#campaign-submit').click();
    check('review is offered for an unchanged draft', await sendConfirmation.isVisible());
    await safetyBoxes.nth(0).uncheck();
    await safetyBoxes.nth(1).check();
    check('changing the recipient invalidates the old confirmation even when the count is unchanged', !await sendConfirmation.isVisible() && (await page.locator('#campaign-review-status').textContent()).includes('발송 검토를 다시 눌러 주세요'));
    await page.locator('#campaign-review-status').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/state-message-review-invalidated-320.png` });
    check('changing recipients never sends', f.gateway.commands.length === commandsBeforeJumps);
    await page.locator('#campaign-submit').click();
    check('changed recipient requires and permits a fresh review', await sendConfirmation.isVisible());
    await page.locator('#campaign-title').fill('수정된 안내');
    check('changing the message invalidates the old confirmation', !await sendConfirmation.isVisible() && (await page.locator('#campaign-review-status').textContent()).includes('발송 검토를 다시 눌러 주세요'));
    await page.locator('#campaign-title').fill('검토할 안내');
    check('returning to the previous text does not resurrect the old confirmation', !await sendConfirmation.isVisible());
    await page.locator('#campaign-submit').click();
    check('the edited draft can be reviewed afresh', await sendConfirmation.isVisible());
    await page.getByLabel('모의 발송으로 기록', { exact: false }).uncheck();
    check('changing simulation mode invalidates its earlier confirmation', !await sendConfirmation.isVisible());
    await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
    check('restoring simulation mode does not revive the earlier confirmation', !await sendConfirmation.isVisible());
    await page.locator('#campaign-submit').click();
    await page.locator('#campaign-scheduled').fill('2028-01-16T10:00');
    check('changing the manual schedule invalidates its earlier confirmation', !await sendConfirmation.isVisible());
    await page.locator('#campaign-scheduled').fill('');
    check('removing the new schedule does not revive the earlier confirmation', !await sendConfirmation.isVisible());
    await page.locator('#campaign-submit').click();
    await sendConfirmation.getByRole('button', { name: '취소', exact: true }).click();
    check('message navigation does not send or change server state', f.gateway.commands.length === commandsBeforeJumps);

    // Replacing an MMS attachment invalidates review even when the new file
    // is rejected and the previous valid attachment remains in the draft.
    // Only the disposable fixture receives the synthetic JPG upload.
    await page.locator('#campaign-channel').selectOption('MMS');
    const jpeg = Buffer.alloc(1024);
    Buffer.from('ffd8ffc0000b080001000a01011100ffd9', 'hex').copy(jpeg);
    await page.locator('#campaign-image').setInputFiles({ name: 'review-test.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await page.waitForFunction(() => document.querySelector('#campaign-image-help')?.textContent?.includes('첨부됨:'));
    await page.locator('#campaign-submit').click();
    check('the original MMS attachment can be reviewed in simulation', await sendConfirmation.isVisible());
    await page.locator('#campaign-image').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
    check('even a rejected attachment selection invalidates the older review', !await sendConfirmation.isVisible() && (await page.locator('#campaign-review-status').textContent()).includes('발송 검토를 다시 눌러 주세요'));
    check('rejected attachment does not transmit a message', f.gateway.commands.filter(command => command.command === 'message.create').length === f.gateway.commands.slice(0, commandsBeforeJumps).filter(command => command.command === 'message.create').length);
    await page.locator('#campaign-channel').selectOption('SMS');
    await page.locator('#campaign-submit').click();
    const countBeforeFreshReview = (await bootstrap()).workspaces[f.eventId].messages.length;
    await sendConfirmation.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
    await page.getByText('모의 발송을 기록했습니다', { exact: false }).first().waitFor();
    const afterFreshReview = (await bootstrap()).workspaces[f.eventId].messages;
    const freshReviewMessage = afterFreshReview.find(message => message.title === '검토할 안내');
    check('fresh review records exactly the new recipient once and only in simulation', afterFreshReview.length === countBeforeFreshReview + 1 && freshReviewMessage?.simulate === true && JSON.stringify(freshReviewMessage.recipientIds) === JSON.stringify([changedRecipient.id]));
    // Proven success returns to history. Verify the recorded row and its focus
    // before opening a fresh draft; the composer remains mounted but hidden.
    await page.locator(`#campaign-${freshReviewMessage.id}`).waitFor({ state: 'visible' });
    await page.waitForFunction(id => document.activeElement?.id === `campaign-${id}`, freshReviewMessage.id);
    check('proven simulation returns focus to its history record', !await page.locator('#campaign-title').isVisible());
    await page.locator('#message-compose-open').click();
    await page.locator('#campaign-title').waitFor({ state: 'visible' });
    if (await safetyPicker.evaluate(e => e.open)) await safetyPicker.locator('summary').click();
    await page.locator('#campaign-title').fill('대상을 고르기 전에 작성');
    check('writing never requires recipient first', await page.locator('#campaign-title').inputValue() === '대상을 고르기 전에 작성');
    await page.locator('#campaign-title').fill('');
    await page.goto(base + '/participants?status=PENDING');
    await page.getByRole('combobox', { name: '상태별 보기', exact: true }).waitFor();
    check('pending deep link restores filter', await page.getByRole('combobox', { name: '상태별 보기', exact: true }).inputValue() === 'PENDING');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
    await page.keyboard.press('Tab');
    check('global keyboard skip is first', await page.evaluate(() => document.activeElement?.getAttribute('href') === '#main-content'));
    await page.keyboard.press('Enter');
    let pagingStops = 1;
    while (pagingStops < 40) {
      await page.keyboard.press('Tab');
      pagingStops += 1;
      const current = await page.evaluate(() => ({ id: document.activeElement?.id, skip: document.activeElement?.getAttribute('data-skip-to') }));
      if (current.skip === 'roster-next-page') await page.keyboard.press('Enter');
      if (await page.evaluate(() => document.activeElement?.id === 'roster-next-page')) break;
    }
    check('mobile next page reachable within unchanged 40 keyboard stops', pagingStops <= 40 && await page.evaluate(() => document.activeElement?.id === 'roster-next-page'), { stops: pagingStops });
    await page.keyboard.press('Enter');
    check('mobile paging works with keyboard', (await page.locator('nav[aria-label="참가자 목록 페이지"]').textContent()).includes('2 / 2'));
    await page.getByRole('button', { name: '검색으로 이동', exact: true }).click();
    await page.locator('#roster-search').fill('없는 사람 찾기');
    check('empty filter has truthful count', (await page.locator('.participant-count').textContent()).includes('0명 / 전체 100명'));
    await page.screenshot({ path: `${OUT}/state-empty-roster-390.png`, fullPage: true });
    await page.goto(base + '/operations#ops-booth-mode');
    await page.locator('#ops-booth-mode').waitFor();
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="ops-booth-mode"] details')?.open === true);
    check('preset anchor opens its controls', await page.locator('section[aria-labelledby="ops-booth-mode"] details').evaluate(e => e.open));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + '/operations');
    await page.locator('#ops-desks').waitFor();
    check('desktop presets start folded', await page.locator('main details').evaluateAll(nodes => nodes.length === 2 && nodes.every(e => !e.open)));
    // Event rail regrouped into five hubs (console-navigation.ts EVENT_HUBS):
    // the old flat .console-subnav-item list and .nav-work-group-label spans
    // no longer exist. Walk every hub through its real link and prove no
    // destination was lost in the regrouping; hub subnavs render only for
    // the active hub, so each hub is actually visited.
    const hubLabels = await page.locator('.desktop-side-nav .console-hub-item > span:first-child').allTextContents().then(ts => ts.map(t => t.trim()));
    check('event rail keeps the five approved hubs in order', hubLabels.join('|') === '오늘|준비|참가자|현장|결과', hubLabels);
    const hubDestinations = [];
    for (const hub of ['오늘', '준비', '참가자', '현장', '결과']) {
      // Client-side hub navigation lags the heading: the rail still names
      // the previous hub until the route actually changes, so the subnav is
      // read only after the URL and the hub's active mark catch up.
      const before = page.url();
      await page.locator('.desktop-side-nav .console-hub-item', { hasText: hub }).click();
      await page.waitForFunction((u) => location.href !== u, before);
      await page.locator('h1').first().waitFor();
      if (hub !== '오늘') {
        await page.waitForFunction((name) => document.querySelector('.desktop-side-nav .console-hub-item[data-active="true"]')?.textContent?.includes(name), hub);
      }
      const entries = await page.locator('.desktop-side-nav .console-hub-subitem').evaluateAll(nodes => nodes.map(e => ({
        // First span is the destination label; badges append counts after it.
        label: e.querySelector(':scope > span')?.textContent?.trim() ?? e.textContent.trim(),
        href: e.getAttribute('href'),
      })));
      const headerHref = await page.locator('.desktop-side-nav .console-hub-item', { hasText: hub }).first().getAttribute('href');
      hubDestinations.push(...(entries.length ? entries : [{ label: `hub:${hub}`, href: headerHref }]));
    }
    const eventBasePath = `/console/events/${f.eventId}`;
    const approvedDestinations = [
      { label: 'hub:오늘', href: eventBasePath },
      { label: '행사 설정', href: `${eventBasePath}/settings` },
      { label: '참가자 페이지', href: `${eventBasePath}/page` },
      { label: '콘텐츠', href: `${eventBasePath}/content` },
      { label: '참여 프로그램', href: `${eventBasePath}/programs` },
      { label: '참가자 명단', href: `${eventBasePath}/participants` },
      { label: '명단 가져오기', href: `${eventBasePath}/participants/import` },
      { label: '메시지', href: `${eventBasePath}/messages` },
      { label: '현장 운영', href: `${eventBasePath}/operations` },
      { label: '현장 사진', href: `${eventBasePath}/photos` },
      { label: '추첨·투표', href: `${eventBasePath}/draws` },
      { label: '경품', href: `${eventBasePath}/rewards` },
      { label: '결과 보고서', href: `${eventBasePath}/reports` },
    ];
    check(
      'all event destinations remain in approved hub order with working routes',
      hubDestinations.length === approvedDestinations.length
        // Rail links carry live state (participants keeps ?status=PENDING
        // while approvals wait, messages keeps ?attention=1): the route
        // path must match exactly, the query is working state, not drift.
        && hubDestinations.every((entry, i) => entry.label === approvedDestinations[i].label && entry.href !== null && new URL(entry.href, f.baseUrl).pathname === approvedDestinations[i].href),
      hubDestinations,
    );
    check('rail grouping chrome carries no fake controls', await page.locator('.desktop-side-nav .nav-event-card, .desktop-side-nav .nav-section-label').evaluateAll(nodes => nodes.length > 0 && nodes.every(e => e.querySelector('a, button, [tabindex]') === null && !e.hasAttribute('tabindex'))));
    await page.goto(base + '/participants?status=PENDING');
    // Bulk scope names its filter-wide meaning in the accessible
    // description (roster-select-all-help); the visible label is concise.
    // Page scope and filter scope are independent behaviors: the current
    // page select takes only the visible 25, an explicit deselect clears
    // them, and the filter-wide select then takes all 49 across pages.
    await page.getByRole('button', { name: '이 페이지 25명 선택', exact: true }).first().click();
    check('page-scope selection stays on the current page', await page.locator('#roster-selection-count').textContent().then(t => t.includes('선택한 참가자 25명') && t.includes('현재 필터 25명') && t.includes('이 페이지 25명') && !t.includes('다른 페이지')));
    await page.getByRole('button', { name: '선택 해제', exact: true }).click();
    check('explicit deselect clears the page-scope selection', await page.locator('#roster-selection-count').count() === 0);
    await page.getByRole('button', { name: '필터 결과 전체 49명 선택', exact: true }).waitFor();
    await page.getByRole('button', { name: '필터 결과 전체 49명 선택', exact: true }).click();
    check('bulk selection includes other pages without changing displayed count', await page.locator('#roster-selection-count').textContent().then(t => t.includes('선택한 참가자 49명') && t.includes('현재 필터 49명') && t.includes('이 페이지 25명') && t.includes('다른 페이지 24명 포함')));
    check('bulk approval names its pending target count', (await page.locator('#roster-approve-selected').innerText()).includes('승인 대기 49명 승인'));
    await page.locator('#roster-approve-selected').click();
    await page.locator('#roster-approved-message').waitFor();
    check('bulk approval settles all filtered pages', (await bootstrap()).workspaces[f.eventId].participants.every(p => p.status === 'APPROVED'));
    check('bulk follow-up includes exactly this approval', new URL(await page.locator('#roster-approved-message').getAttribute('href'), f.baseUrl).searchParams.get('to').split(',').length === 49);
    // The runbook covers the event day; the separate current/next rail may
    // contain another date. A narrow layout must not hide that unique data.
    const upcomingTitle = '다른 날짜의 검수 일정';
    await command('program.save', { title: upcomingTitle, date: '2099-01-17', start: '09:00', end: '10:00', place: '검수 장소', published: true });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(base);
      const upcoming = page.locator('section[aria-labelledby="event-schedule-heading"]');
      await upcoming.waitFor({ state: 'visible' });
      check(`overview@${width} retains upcoming schedules from other dates`,
        (await upcoming.innerText()).includes(upcomingTitle)
          && !(await page.locator('section[aria-labelledby="event-runbook-heading"]').innerText()).includes(upcomingTitle));
      await page.screenshot({ path: `${OUT}/state-overview-upcoming-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const stage of ['DRAFT', 'READY', 'ENDED', 'ARCHIVED']) {
      const id = `${f.eventId}-${stage.toLowerCase()}`;
      await f.helpers.insertEvent(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id, slug: id,
        payload: { id, slug: id, name: `작업대 ${stage} 상태`, stage, date: '2027-01-16', start: '09:00', end: '17:00', capacity: 100, features: [] },
        workspace: f.helpers.emptyWorkspace(),
      });
      // Hold the roster scope on purpose: the scope-denial copy must not
      // mask the stage lock — only the stage may explain the gate below.
      await f.helpers.insertMembership(f.harness.database, f.manager.id, id, ['participants']);
      await page.goto(`${f.baseUrl}/console/events/${id}`);
      await page.locator('#event-metrics-heading').waitFor();
      const headings = await page.locator('main h2').evaluateAll(nodes => nodes.map(e => (e.textContent ?? '').trim()));
      if (['DRAFT', 'READY'].includes(stage)) {
        // Independent desktop columns avoid a tall metric pushing the
        // schedule down. Reading order follows the task column first.
        const geometry = await page.evaluate(() => {
          const rect = id => document.querySelector(`#${id}`)?.getBoundingClientRect();
          const queue = rect('event-now-heading'), metric = rect('event-metrics-heading'), schedule = rect('event-runbook-heading');
          return { queueTop: queue?.top, metricTop: metric?.top, queueLeft: queue?.left, metricLeft: metric?.left, scheduleTop: schedule?.top };
        });
        check(`${stage} leads with actions and presents metrics alongside`, headings[0] === '지금 할 일' && headings[1] === '행사 일정' && headings[2] === '행사 준비 확인' && headings[3] === '주요 지표' && Math.abs(geometry.queueTop - geometry.metricTop) <= 8 && geometry.metricLeft > geometry.queueLeft && geometry.scheduleTop > geometry.queueTop, { headings, geometry });
      } else {
        check(`${stage} prioritizes its real task`, headings[0] === (stage === 'ARCHIVED' ? '보관된 행사 마감 확인' : '행사 마감'), headings[0]);
      }
      if (stage === 'DRAFT') {
        // The entry CTA repeats inside the readiness checklist: every
        // same-named link must keep the exact deep anchor, not just one.
        const intakeHrefs = await page.getByRole('link', { name: '접수 설정', exact: true }).evaluateAll(nodes => nodes.map(e => e.getAttribute('href')));
        check('preparation links preserve exact settings anchors', intakeHrefs.length >= 1 && intakeHrefs.every(href => href === `/console/events/${id}/settings#settings-intake`), intakeHrefs);
        check('unpublished page reads as the basic design in use', (await page.locator('section[aria-labelledby="event-readiness-heading"]').textContent()).includes('기본 디자인 사용 중'));
      }
      await page.screenshot({ path: `${OUT}/state-overview-${stage.toLowerCase()}-1280.png`, fullPage: true });
      if (['ENDED', 'ARCHIVED'].includes(stage)) {
        await page.goto(`${f.baseUrl}/console/events/${id}/participants`);
        await page.getByText(stage === 'ENDED' ? '종료된 행사는 참가자를 변경할 수 없습니다.' : '보관된 행사는 변경할 수 없습니다.', { exact: false }).waitFor();
        check(`${stage} participant writes stay gated`, await page.getByRole('button', { name: '참가자 추가', exact: true }).count() === 0 && await page.getByRole('button', { name: '승인', exact: true }).count() === 0);
      }
    }
    // Journey assertions are kept alongside the before/after measurement so
    // a smaller render can never stand in for verified task completion.
    check('100-person fixture', people.length === 100);
    check('800px roster keeps a readable identity column', metrics.find(m => m.name === 'participants-100' && m.width === 800)?.firstRosterIdentityWidth >= 100);
    check('all captured layouts fit', metrics.every(m => m.overflow === 0), metrics.filter(m => m.overflow));
    check('no browser runtime error', errors.length === 0, errors);
  } finally {
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ phase: PHASE, checks, metrics, journeys, scrollMeasurement: 'Raw browser scroll events during explicit actions, not normalized manual scroll counts; no task-time or human comprehension claim.', errors, build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim() }, null, 2), { mode: 0o600 });
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
