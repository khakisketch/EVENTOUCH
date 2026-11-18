'use strict';
const { messageStep } = require('./ui-journey-helpers.cjs');

const { chooseRadio, openStudioPanel } = require('./ui-journey-helpers.cjs');

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
        ['theme', '/page', '#theme-save-draft'],
        ['overview-live', '', '#event-metrics-heading'],
        ['operations', '/operations', '#ops-desks'],
        ['settings', '/settings', '#settings-intake'],
      ]) {
        await page.goto(base + route);
        await page.locator(marker).waitFor({ state: 'attached' });
        await page.locator('h1').waitFor();
        if (PHASE === 'after' && name === 'overview-live') {
          // The LIVE board must prioritize both current work and real entry
          // data before the schedule at every viewport, in DOM as well as
          // painted order. Compare section bounds, not just heading positions.
          const order = await page.evaluate(() => {
            const get = id => document.querySelector(`:is(section,[role=region])[aria-labelledby="${id}"]`);
            const queue = get('event-now-heading'), metric = get('event-metrics-heading'), schedule = get('event-runbook-heading');
            if (!queue || !metric || !schedule) return null;
            const q = queue.getBoundingClientRect(), m = metric.getBoundingClientRect(), s = schedule.getBoundingClientRect();
            return {
              // The confirmed overview puts the numbers and the live queue side by
              // side; what must hold is that both come before the schedule.
              dom: Boolean(metric.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING)
                && Boolean(queue.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING),
              queue: { top: q.top, bottom: q.bottom, left: q.left },
              metric: { top: m.top, bottom: m.bottom, left: m.left },
              schedule: { top: s.top },
            };
          });
          check(`LIVE overview prioritizes work and entry before the schedule at ${width}`,
            Boolean(order && order.dom && order.schedule.top >= order.queue.bottom - 1 && order.schedule.top > order.metric.top
              && (Math.abs(order.queue.left - order.metric.left) > 40
                ? Math.abs(order.queue.top - order.metric.top) <= 2
                : order.schedule.top >= Math.max(order.queue.bottom, order.metric.bottom) - 1)), order);
        }
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
      // On a short phone with the representative single pending-approval
      // item, the operator should see both the next action and entry count
      // without scrolling. Long names or multiple work items may legitimately
      // require scrolling and are not collapsed or hidden to meet this check.
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto(base);
      await page.locator('#event-metrics-heading').waitFor();
      const firstOverview = await page.evaluate(() => {
        const queue = document.querySelector(':is(section,[role=region])[aria-labelledby="event-now-heading"]');
        const metric = document.querySelector(':is(section,[role=region])[aria-labelledby="event-metrics-heading"]');
        const action = queue?.querySelector('[data-task="approval"] a');
        const count = metric?.querySelector('strong');
        const probe = element => {
          if (!element) return null;
          const r = element.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { top: r.top, bottom: r.bottom, height: r.height, width: r.width, hit: hit === element || element.contains(hit), text: element.textContent };
        };
        return { action: probe(action), count: probe(count) };
      });
      check('short-phone overview exposes the entry count', Boolean(firstOverview.count && firstOverview.count.top >= 0 && firstOverview.count.bottom <= 568), firstOverview);
      const priority = page.locator(':is(section,[role=region])[aria-labelledby="event-now-heading"] [data-task="approval"] a').first();
      await priority.scrollIntoViewIfNeeded();
      const actionSize = await priority.boundingBox();
      check('short-phone approval is reachable and meets the touch target', Boolean(await priority.isVisible() && actionSize && actionSize.width >= 44 && actionSize.height >= 44), actionSize);
      check('short-phone approval still points to pending participants', (await page.locator(':is(section,[role=region])[aria-labelledby="event-now-heading"] [data-task="approval"] a').first().getAttribute('href')).endsWith('/participants?status=PENDING'));
      await page.screenshot({ path: `${OUT}/overview-live-320-short.png` });
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(base + '/participants');
        const firstRow = rowFor(people[0].name);
        await firstRow.waitFor({ state: 'visible' });
        const rowTop = (await firstRow.boundingBox()).y;
        check(`mobile roster starts within the working viewport at ${width}`, rowTop <= 600, rowTop);
        const picker = page.getByRole('combobox', { name: '빠른 상태 보기', exact: true });
        const tools = page.locator('summary[aria-label="명단 도구"]');
        const add = page.getByRole('button', { name: '참가자 추가', exact: true });
        const controls = await Promise.all([picker.boundingBox(), tools.boundingBox(), add.boundingBox(), page.getByRole('button', { name: '명단 가져오기', exact: true }).boundingBox()]);
        check(`mobile roster keeps lookup controls together and touch sized at ${width}`,
          controls.every(box => box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= width)
          && Math.max(...controls.map(box => box.y)) - Math.min(...controls.map(box => box.y)) <= 52, controls);
        await picker.selectOption('pending');
        check(`mobile status picker changes the current view at ${width}`, await picker.inputValue() === 'pending');
        await picker.selectOption('all');
        const scope = page.locator('details').filter({ has: page.getByText('여러 명 선택', { exact: true }) });
        const summary = scope.locator('summary');
        await summary.focus();
        await page.keyboard.press('Enter');
        check(`mobile scope opens by keyboard at ${width}`, await scope.evaluate(node => node.open));
        await scope.getByRole('button', { name: '이 페이지 25명 선택', exact: true }).click();
        check(`mobile page choice closes its menu and restores focus at ${width}`, !(await scope.evaluate(node => node.open)) && await summary.evaluate(node => node === document.activeElement));
        const counts = page.locator('#roster-selection-count');
        check(`mobile page selection remains page-scoped at ${width}`, (await counts.textContent()).includes('선택 25명') && (await counts.textContent()).includes('이 페이지 25명'));
        await page.getByRole('button', { name: '선택 해제', exact: true }).click();
        await summary.focus();
        await page.keyboard.press('Enter');
        await scope.getByRole('button', { name: '필터 결과 전체 100명 선택', exact: true }).click();
        check(`mobile filter choice exposes its results at ${width}`, !(await scope.evaluate(node => node.open)) && await summary.evaluate(node => node === document.activeElement));
        check(`mobile filter selection includes the other pages at ${width}`, (await counts.textContent()).includes('선택 100명') && (await counts.textContent()).includes('다른 페이지 75명'));
        const brokenWords = [...await splitKoreanWords(counts), ...await splitKoreanWords(page.locator('#roster-approve-selected'))];
        check(`mobile selection text keeps Korean words intact at ${width}`, brokenWords.length === 0, brokenWords);
        const selectionPanel = page.locator('[aria-label="선택한 참가자 작업"]');
        check(`selection actions need no disclosure at ${width}`, await selectionPanel.locator('details').count() === 0);
        for (const label of ['그룹 변경', '신청 취소', '선택 해제']) check(`${label} is immediately available at ${width}`, await selectionPanel.getByRole('button', { name: label, exact: true }).isVisible());
        check(`group action names its current-filter scope at ${width}`, (await page.locator('#roster-group-scope').textContent()).includes('현재 필터에서 선택한 100명 대상'));
        check(`message action names its full selection at ${width}`, (await page.locator('#roster-message-scope').textContent()).includes('필터 밖을 포함한 선택 100명 대상'));
        const bounds = await selectionPanel.boundingBox();
        check(`selection actions fit the phone at ${width}`, bounds.x >= 0 && bounds.x + bounds.width <= width, bounds);
        await page.screenshot({ path: `${OUT}/roster-mobile-selection-${width}.png` });
        await selectionPanel.getByRole('button', { name: '선택 해제', exact: true }).focus();
        await page.keyboard.press('Enter');
        check(`clearing selection restores the roster focus at ${width}`, await page.evaluate(() => document.activeElement?.id === 'participants-list-heading'));
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
      check('page selection separated from full selection', await page.locator('#roster-selection-count').textContent().then(t => t.includes('선택 2명') && t.includes('현재 필터 2명') && t.includes('이 페이지 1명') && t.includes('다른 페이지 1명')));
      await act(roster, () => page.getByRole('button', { name: '검색으로 이동', exact: true }).click());
      check('return focuses search', await page.locator('#roster-search').evaluate(e => e === document.activeElement));
      check('return also exposes search in viewport', await page.locator('#roster-search').evaluate(e => { const r = e.getBoundingClientRect(); const rail = document.querySelector('.console-sidebar')?.getBoundingClientRect(); return r.top >= (innerWidth <= 768 ? rail?.bottom ?? 0 : 0) && r.bottom <= innerHeight; }));
    }
    await finish(roster, 'roster-selection');

    if (PHASE === 'after') {
      await page.getByRole('searchbox', { name: '이름·소속·연락처 검색', exact: true }).fill(later.name);
      check('filter retains hidden selection', await page.locator('#roster-selection-count').textContent().then(t => t.includes('선택 2명') && t.includes('현재 필터 1명') && t.includes('필터 밖 1명')));
      // The reset lives inside the advanced-filters disclosure, which starts
      // collapsed at every width: a real operator opens the disclosure to
      // reach it. The check below still clicks the real reset control.
      if ((await page.locator('#roster-filter-toggle').getAttribute('aria-expanded')) !== 'true') {
        await page.locator('#roster-filter-toggle').click();
      }
      await page.getByRole('button', { name: '검색·필터 초기화', exact: true }).click();
      check('filter reset retains selection', (await page.locator('#roster-selection-count').textContent()).includes('선택 2명'));
      const row = rowFor(first.name);
      await row.getByRole('button', { name: `${first.name} 참가자 상세`, exact: true }).click();
      const detail = page.getByRole('dialog');
      await detail.getByRole('combobox', { name: `${first.name} 상태 변경`, exact: true }).selectOption('CANCELLED');
      check('cancel remains explicit before write', (await bootstrap()).workspaces[f.eventId].participants.find(p => p.id === first.id).status === 'APPROVED');
      await detail.getByRole('button', { name: '취소', exact: true }).click();
      await page.keyboard.press('Escape');
      check('cancel review dismissal preserves selection', (await page.locator('#roster-selection-count').textContent()).includes('선택 2명'));
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
    await act(messaging, () => messageStep(page, 3));
    await act(messaging, () => page.getByLabel('모의 발송으로 기록', { exact: false }).check());
    await act(messaging, () => page.locator('#campaign-submit').click());
    check('review does not send automatically', (await bootstrap()).workspaces[f.eventId].messages.length === 0);
    await act(messaging, () => page.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click());
    await page.getByText('모의 발송을 기록했습니다', { exact: false }).first().waitFor();
    const messages = (await bootstrap()).workspaces[f.eventId].messages;
    check('simulated send persisted once with exact selection', messages.length === 1 && messages[0].simulate === true && JSON.stringify([...messages[0].recipientIds].sort()) === JSON.stringify([first.id, later.id].sort()));
    await finish(messaging, 'message-simulated');

    const theme = await newTask('배경 수정 → 초안 저장 → 명시적 게시', '/page');
    await page.locator('#theme-save-draft').waitFor();
    // The studio lists four rows; an edited row carries a "미저장 변경" dot, and
    // the background (above the rows) carries its own.
    const studioRow = name => page.locator('#theme-edit').getByRole('button', { name });
    const rowDirty = async name => await studioRow(name).getByRole('img', { name: '미저장 변경' }).count() === 1;
    const backgroundDirty = async () => await page.locator('#studio-background').getByRole('img', { name: '미저장 변경' }).count() === 1;
    const backToList = async () => { if (await page.locator('#theme-panel-title').isVisible().catch(() => false)) await page.locator('#theme-edit').getByRole('button', { name: '설정', exact: true }).click(); };
    const backgroundCode = async () => {
      await backToList();
      const code = page.getByLabel('배경색 색 코드', { exact: true });
      if (!await code.count()) await page.getByRole('radiogroup', { name: '배경색', exact: true }).getByRole('button', { name: '직접 고르기' }).click();
      return code;
    };
    const previewRegion = () => page.getByRole('region', { name: /홈 디자인 미리보기$/ }).first();
    if (PHASE === 'after') {
      await openStudioPanel(page, 'exposure');
      const intro = page.locator('#home-intro');
      const originalIntro = await intro.inputValue();
      const introOnly = '검증용 소개 변경 — 미리보기에는 표시되지 않음';
      await intro.fill(introOnly);
      await backToList();
      check('intro-only edit marks its own row', await rowDirty(/^소개와 공개 범위/));
      check('intro-only edit does not mark unrelated design rows',
        !await rowDirty(/^배너/) && !await rowDirty(/^제목과 문구/) && !await rowDirty(/^홈 메뉴/) && !await backgroundDirty());
      check('intro-only edit is not shown in the preview', !(await previewRegion().innerText()).includes(introOnly));
      await openStudioPanel(page, 'exposure');
      await page.locator('#home-intro').fill(originalIntro);
      await backToList();
      check('reverting intro clears that row marker', !await rowDirty(/^소개와 공개 범위/));
    }
    await act(theme, async () => { await (await backgroundCode()).fill('#FFF1E8'); });
    if (PHASE === 'after') {
      check('background edit marks its own section', await backgroundDirty());
      check('background edit leaves the rows unmarked', !await rowDirty(/^소개와 공개 범위/) && !await rowDirty(/^제목과 문구/));
      const status = page.locator('#theme-save [aria-live="polite"]');
      const announced = await status.allTextContents();
      check('the save area announces the unsaved change once', announced.filter(text => text.includes('저장되지 않은 변경')).length === 1, announced);
      await page.screenshot({ path: `${OUT}/theme-dirty-1280.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${OUT}/theme-dirty-390.png`, fullPage: true });
      check('the unsaved background survives the phone width and the save area is reachable',
        (await (await backgroundCode()).inputValue()).toLowerCase() === '#fff1e8'
        && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#theme-save-draft').scrollIntoViewIfNeeded();
      check('the save action is visible on a phone', await page.locator('#theme-save-draft').isVisible() && await page.locator('#theme-save-draft').isEnabled());
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await act(theme, () => page.locator('#theme-save-draft').click());
    await page.getByText('초안을 저장했습니다', { exact: false }).first().waitFor();
    let pageExperience = (await bootstrap()).workspaces[f.eventId].pageExperience;
    check('saved draft stays unpublished', !pageExperience.publishedAt && pageExperience.draft.homeStyle.backgroundColor === '#FFF1E8');
    await act(theme, () => page.getByRole('button', { name: '게시 검토', exact: true }).click());
    check('publish review does not publish automatically', !(await bootstrap()).workspaces[f.eventId].pageExperience.publishedAt);
    await act(theme, () => page.getByRole('button', { name: '게시하기', exact: true }).click());
    await page.getByText('게시했습니다. 이 행사를 보는 참가자에게', { exact: false }).first().waitFor();
    pageExperience = (await bootstrap()).workspaces[f.eventId].pageExperience;
    check('published background matches saved draft', pageExperience.published.homeStyle.backgroundColor === '#FFF1E8');
    await act(theme, () => page.getByRole('button', { name: '게시본', exact: true }).click());
    if (PHASE === 'after') {
      await openStudioPanel(page, 'text');
      const title = page.locator('#home-hero-title');
      const originalTitle = await title.inputValue();
      await title.fill('검증용 미게시 배너 제목');
      check('published preview does not show an unsaved banner title', !(await previewRegion().innerText()).includes('검증용 미게시 배너 제목'));
      await title.fill(originalTitle);
    }
    await finish(theme, 'theme-published');

    if (PHASE === 'before') return;
    await page.getByRole('button', { name: '편집 중', exact: true }).click();
    await openStudioPanel(page, 'banner');
    const pick = (group, name) => page.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name, exact: true });
    await pick('사진 초점', '위').click();
    check('photo focus is chosen from its radio group', await pick('사진 초점', '위').getAttribute('aria-checked') === 'true');
    await pick('글 위치', '아래').click();
    check('text position is chosen in the same panel', await pick('글 위치', '아래').getAttribute('aria-checked') === 'true');
    await pick('읽기 배경', '부드럽게').click();
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
    await page.locator('#recipient-status-filter').waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'recipient-status-filter');
    check('opening the composer focuses recipient selection', true);
    await page.locator('#message-compose-close').click();
    await page.waitForFunction(() => document.activeElement?.id === 'message-compose-open');
    check('closing the composer restores focus to the history action', true);
    await page.evaluate(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 0)));
    check('skip-link focus is not stolen back by composer closing',
      await page.evaluate(() => document.activeElement?.id === 'main-content'));
    await page.locator('#message-compose-open').click();
    await page.waitForFunction(() => document.activeElement?.id === 'recipient-status-filter');
    await page.evaluate(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); });
    await page.keyboard.press('Tab');
    check('global skip link is reached after opening the composer',
      await page.evaluate(() => document.activeElement?.textContent?.trim() === '본문으로 건너뛰기'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 0)));
    check('skip-link focus is not stolen back by composer opening',
      await page.evaluate(() => document.activeElement?.id === 'main-content'));
    check('zero recipients disables review with visible reason', await page.locator('#campaign-submit').isDisabled() && (await page.locator('#campaign-submit-warning').textContent()).includes('수신자를 먼저 고르세요'));
    // The top review jump must not strand keyboard focus on its old button
    // when the real submit is disabled. Returning to the picker is still an
    // explicit action and neither jump may create a message.
    const commandsBeforeJumps = f.gateway.commands.length;
    const scheduleDetails = page.locator('details').filter({ has: page.locator('#campaign-scheduled') });
    const scheduleSummary = scheduleDetails.locator('summary');
    check('future review controls are mounted and the optional schedule starts closed', !await scheduleDetails.evaluate(element => element.open));
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await page.getByRole('button', { name: '내용 작성', exact: true }).press('Enter');
      await page.waitForFunction(() => document.activeElement?.id === 'recipient-status-filter').catch(async e => { console.error('recipient focus diagnostic', await page.evaluate(() => ({ active: document.activeElement?.outerHTML, open: document.querySelector('#campaign-recipients details')?.open, error: document.querySelector('#campaign-recipients-error')?.textContent, selection: document.querySelector('#recipient-summary')?.textContent }))); throw e; });
      check(`empty review stays at recipients with a visible error at ${width}`, await page.locator('#campaign-recipients-error').isVisible());
      await page.screenshot({ path: `${OUT}/state-message-empty-review-${width}.png` });
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
      check(`next Tab reaches the content continuation at ${width}`, await page.getByRole('button', { name: '내용 작성', exact: true }).evaluate(e => e === document.activeElement));
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
    await messageStep(page, 2);
    await page.locator('#campaign-title').fill('검토할 안내');
    await page.locator('#campaign-body').fill('실제 발송하지 않는 검토 검사입니다.');
    await messageStep(page, 3);
    check('simulation is visible at review', await page.getByLabel('모의 발송으로 기록', { exact: false }).isVisible());
    await scheduleSummary.focus(); await page.keyboard.press('Enter');
    check('keyboard opens schedule and help', await page.locator('#campaign-scheduled').isVisible() && await page.locator('#campaign-scheduled-help').isVisible());
    for (const width of [1280,390,320]) {
      await page.setViewportSize({width,height:844});
      check(`schedule help preserves words at ${width}`, (await splitKoreanWords(page.locator('#campaign-scheduled-help'))).length === 0);
    }
    await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
    const sendConfirmation = page.getByRole('group', { name: '실행 확인' });
    await page.locator('#campaign-submit').click();
    check('review is offered for an unchanged draft', await sendConfirmation.isVisible());
    await messageStep(page, 1);
    await safetyBoxes.nth(0).uncheck();
    await safetyBoxes.nth(1).check();
    check('changing the recipient invalidates the old confirmation even when the count is unchanged', !await sendConfirmation.isVisible() && (await page.locator('#campaign-review-status').textContent()).includes('발송 검토를 다시 눌러 주세요'));
    await messageStep(page, 3);
    await page.locator('#campaign-review-status').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/state-message-review-invalidated-320.png` });
    check('changing recipients never sends', f.gateway.commands.length === commandsBeforeJumps);
    await page.locator('#campaign-submit').click();
    check('changed recipient requires and permits a fresh review', await sendConfirmation.isVisible());
    await messageStep(page, 2);
    await page.locator('#campaign-title').fill('수정된 안내');
    check('changing the message invalidates the old confirmation', !await sendConfirmation.isVisible() && (await page.locator('#campaign-review-status').textContent()).includes('발송 검토를 다시 눌러 주세요'));
    await page.locator('#campaign-title').fill('검토할 안내');
    check('returning to the previous text does not resurrect the old confirmation', !await sendConfirmation.isVisible());
    await messageStep(page, 3);
    await page.locator('#campaign-submit').click();
    check('the edited draft can be reviewed afresh', await sendConfirmation.isVisible());
    await page.getByLabel('모의 발송으로 기록', { exact: false }).uncheck();
    check('changing simulation mode invalidates its earlier confirmation', !await sendConfirmation.isVisible());
    await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
    check('restoring simulation mode does not revive the earlier confirmation', !await sendConfirmation.isVisible());
    await page.locator('#campaign-submit').click();
    await page.locator('#campaign-scheduled').fill('2028-01-16T10:00');
    check('changing the manual schedule invalidates its earlier confirmation', !await sendConfirmation.isVisible());
    await scheduleSummary.click();
    check('closed schedule retains its value and shows that execution is manual',
      !await page.locator('#campaign-scheduled').isVisible()
      && (await page.locator('#campaign-scheduled').inputValue()) === '2028-01-16T10:00'
      && (await scheduleSummary.innerText()).includes('수동 실행')
      && (await page.locator('[aria-label="작성 요약"]').innerText()).includes('수동 실행'));
    await scheduleSummary.click();
    await page.getByLabel('모의 발송으로 기록', { exact: false }).uncheck();
    await scheduleSummary.click();
    check('real scheduled draft defaults to manual execution even when folded',
      (await scheduleSummary.innerText()).includes('수동 실행')
      && (await page.locator('#campaign-review-heading').locator('..').locator('..').innerText()).includes('이 예약은 자동 발송되지 않습니다'));
    await page.locator('#campaign-submit').click();
    check('manual reservation confirmation names the mode and action',
      (await sendConfirmation.innerText()).includes('수동 실행')
      && (await sendConfirmation.innerText()).includes('직접 발송 실행을 눌러야 합니다')
      && (await sendConfirmation.innerText()).includes('예약 시각:')
      && (await sendConfirmation.innerText()).includes('2028'));
    await sendConfirmation.getByRole('button', { name: '취소', exact: true }).click();
    await scheduleSummary.click();
    await chooseRadio(page, 'campaign-schedule-mode', 'AUTO');
    await scheduleSummary.click();
    await page.locator('#campaign-submit').click();
    check('explicit auto reservation confirmation names the mode and future activation',
      (await sendConfirmation.innerText()).includes('자동 실행')
      && (await sendConfirmation.innerText()).includes('나중에 설정을 켜면 발송될 수 있습니다'));
    await sendConfirmation.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/state-real-scheduled-review-320.png` });
    await sendConfirmation.getByRole('button', { name: '취소', exact: true }).click();
    await scheduleSummary.click();
    await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
    await page.locator('#campaign-scheduled').fill('');
    check('removing the new schedule does not revive the earlier confirmation', !await sendConfirmation.isVisible());
    await page.locator('#campaign-submit').click();
    await sendConfirmation.getByRole('button', { name: '취소', exact: true }).click();
    check('message navigation does not send or change server state', f.gateway.commands.length === commandsBeforeJumps);

    // Replacing an MMS attachment invalidates review even when the new file
    // is rejected and the previous valid attachment remains in the draft.
    // Only the disposable fixture receives the synthetic JPG upload.
    await messageStep(page, 2);
    await chooseRadio(page, 'campaign-channel', 'SMS'); // The attachment switches the new request to MMS.
    const jpeg = Buffer.alloc(1024);
    Buffer.from('ffd8ffc0000b080001000a01011100ffd9', 'hex').copy(jpeg);
    await page.locator('#campaign-image').setInputFiles({ name: 'review-test.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await page.waitForFunction(() => document.querySelector('#campaign-image-help')?.textContent?.includes('첨부됨:'));
    await messageStep(page, 3);
    await page.locator('#campaign-submit').click();
    check('the original MMS attachment can be reviewed in simulation', await sendConfirmation.isVisible());
    await page.locator('#campaign-image').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
    check('even a rejected attachment selection invalidates the older review', !await sendConfirmation.isVisible() && (await page.locator('#campaign-review-status').textContent()).includes('발송 검토를 다시 눌러 주세요'));
    check('rejected attachment does not transmit a message', f.gateway.commands.filter(command => ['message.create', 'message.create-reviewed'].includes(command.command)).length === f.gateway.commands.slice(0, commandsBeforeJumps).filter(command => ['message.create', 'message.create-reviewed'].includes(command.command)).length);
    await messageStep(page, 2);
    await page.getByRole('button', { name: '사진 첨부 해제', exact: true }).click();
    // A real validation response must reopen a closed schedule and return
    // focus to the field without creating a message or losing its value.
    await messageStep(page, 3);
    const beforePastSchedule = (await bootstrap()).workspaces[f.eventId].messages.length;
    await page.locator('#campaign-scheduled').fill('2020-01-16T10:00');
    await scheduleSummary.click();
    await page.locator('#campaign-submit').click();
    // The form now refuses a past time before any confirmation; a server refusal would still arrive after one.
    if (await sendConfirmation.isVisible().catch(() => false)) await sendConfirmation.getByRole('button', { name: '예약 등록한다', exact: true }).click();
    await page.locator('#campaign-scheduled-error').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'campaign-scheduled');
    check('schedule error reopens and focuses the original value without creating a message',
      await scheduleDetails.evaluate(node => node.open)
      && (await page.locator('#campaign-scheduled').inputValue()) === '2020-01-16T10:00'
      && (await bootstrap()).workspaces[f.eventId].messages.length === beforePastSchedule);
    await page.locator('#campaign-scheduled').fill('');
    check('editing the invalid schedule clears its field error', await page.locator('#campaign-scheduled-error').count() === 0);
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
    await page.locator('#recipient-status-filter').waitFor({ state: 'visible' });
    check('a fresh draft starts by choosing recipients', !await page.locator('#campaign-title').isVisible());
    await safetyPicker.locator('ul input[type="checkbox"]').first().check();
    await messageStep(page, 2);
    await page.locator('#campaign-title').fill('선택한 대상에게 작성');
    check('content opens after selecting a recipient', await page.locator('#campaign-title').inputValue() === '선택한 대상에게 작성');
    await page.locator('#campaign-title').fill('');
    await messageStep(page, 1);
    await page.locator('#recipient-clear-all').click();
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
    await page.waitForFunction(() => document.querySelector(':is(section,[role=region])[aria-labelledby="ops-booth-mode"] details')?.open === true);
    check('preset anchor opens its controls', await page.locator(':is(section,[role=region])[aria-labelledby="ops-booth-mode"] details').evaluate(e => e.open));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + '/operations');
    await page.locator('#ops-desks').waitFor();
    check('desktop presets start folded', await page.locator('main details').evaluateAll(nodes => nodes.length === 2 && nodes.every(e => !e.open)));
    // Every permitted destination is available without opening another group.
    const hubLabels = await page.locator('.desktop-side-nav .console-nav-group > .nav-section-label').allTextContents();
    check('event rail keeps four work groups', hubLabels.join('|') === '운영|현장·참여|행사 준비|결과', hubLabels);
    const hubDestinations = await page.locator('.desktop-side-nav .console-workspace-link').evaluateAll(nodes => nodes.map(e => ({ label: e.querySelector(':scope > span')?.textContent?.trim(), href: e.getAttribute('href') })));
    const eventBasePath = `/console/events/${f.eventId}`;
    const approvedDestinations = [
      {label:'운영 현황',href:eventBasePath},
      ...[['참가자 명단','participants'],['메시지','messages'],['현장 운영','operations'],['추첨·투표','draws'],['경품 지급 현황','rewards'],['현장 사진','photos'],['참가자 페이지','page'],['공지·안내','content'],['참여 콘텐츠','programs'],['행사 설정','settings'],['결과 보고서','reports'],['기간 분석','analysis']].map(([label,route])=>({label,href:`${eventBasePath}/${route}`})),
    ];

    check(
      'all event destinations remain in approved hub order with working routes',
      hubDestinations.length === approvedDestinations.length
        // Rail links carry live state (participants keeps ?status=PENDING
        // while approvals wait, messages keeps ?attention=1): the route
        // path must match exactly, the query is working state, not drift.
        && hubDestinations.every((entry, i) => entry.label.replace(/\d+$/u, '') === approvedDestinations[i].label && entry.href !== null && new URL(entry.href, f.baseUrl).pathname === approvedDestinations[i].href),
      hubDestinations,
    );
    check('rail grouping chrome carries no fake controls', await page.locator('.desktop-side-nav .nav-event-card, .desktop-side-nav .nav-section-label').evaluateAll(nodes => nodes.length > 0 && nodes.every(e => e.querySelector('a, button, [tabindex]') === null && !e.hasAttribute('tabindex'))));
    await page.goto(base + '/participants?status=PENDING');
    // Bulk scope names its filter-wide meaning in the accessible
    // description (roster-select-all-help); the visible label is concise.
    // Page scope and filter scope are independent behaviors: the current
    // page select takes only the visible 25, an explicit deselect clears
    // them, and the filter-wide select then takes all 49 across pages.
    // On a wide screen the page scope is the header checkbox; the phone list offers scope buttons.
    await page.getByRole('checkbox', { name: '이 페이지 전체 선택', exact: true }).check();
    check('page-scope selection stays on the current page', await page.locator('#roster-selection-count').textContent().then(t => t.includes('선택 25명') && t.includes('현재 필터 25명') && t.includes('이 페이지 25명') && !t.includes('다른 페이지')));
    await page.getByRole('button', { name: '선택 해제', exact: true }).click();
    check('explicit deselect clears the page-scope selection', await page.locator('#roster-selection-count').count() === 0);
    // The filter-wide scope is offered beside an existing selection, so select the page again first.
    await page.getByRole('checkbox', { name: '이 페이지 전체 선택', exact: true }).check();
    await page.getByRole('button', { name: '필터 결과 전체 49명 선택', exact: true }).waitFor();
    await page.getByRole('button', { name: '필터 결과 전체 49명 선택', exact: true }).click();
    check('bulk selection includes other pages without changing displayed count', await page.locator('#roster-selection-count').textContent().then(t => t.includes('선택 49명') && t.includes('현재 필터 49명') && t.includes('이 페이지 25명') && t.includes('다른 페이지 24명')));
    check('bulk approval names its pending target count', (await page.locator('#roster-approve-selected').innerText()).includes('신청 승인 49'));
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
      const upcoming = page.locator(':is(section,[role=region])[aria-labelledby="event-schedule-heading"]');
      await upcoming.waitFor({ state: 'visible' });
      check(`overview@${width} retains upcoming schedules from other dates`,
        (await upcoming.innerText()).includes(upcomingTitle)
          && !(await page.locator(':is(section,[role=region])[aria-labelledby="event-runbook-heading"]').innerText()).includes(upcomingTitle));
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
        // Work and metrics share the first work row; the schedule follows
        // both, matching the actual DOM and the approved priority.
        const geometry = await page.evaluate(() => {
          const rect = id => document.querySelector(`:is(section,[role=region])[aria-labelledby="${id}"]`)?.getBoundingClientRect();
          const queue = rect('event-now-heading'), metric = rect('event-metrics-heading'), schedule = rect('event-runbook-heading');
          return { queueTop: queue?.top, queueBottom: queue?.bottom, metricTop: metric?.top, metricBottom: metric?.bottom, queueLeft: queue?.left, metricLeft: metric?.left, scheduleTop: schedule?.top };
        });
        check(`${stage} presents its work and metrics ahead of the schedule`, headings[0] === '지금 할 일' && headings[1] === '주요 지표' && headings[2] === '행사 일정' && headings[3] === '행사 준비 확인' && Math.abs(geometry.queueTop - geometry.metricTop) <= 2 && geometry.scheduleTop >= Math.max(geometry.queueBottom, geometry.metricBottom) - 1, { headings, geometry });
      } else {
        check(`${stage} prioritizes its real task`, headings[0] === (stage === 'ARCHIVED' ? '보관된 행사 마감 확인' : '행사 마감'), headings[0]);
        check(`${stage} retains summary ahead of the schedule`, headings.indexOf('최종 요약') > 0 && headings.indexOf('최종 요약') < headings.indexOf('행사 일정'), headings);
        if (stage === 'ARCHIVED') check('archived overview does not show an empty work queue', await page.locator('#event-now-heading').count() === 0);
      }
      if (stage === 'DRAFT') {
        // The entry CTA repeats inside the readiness checklist: every
        // same-named link must keep the exact deep anchor, not just one.
        const intakeHrefs = await page.getByRole('link', { name: '접수 설정', exact: true }).evaluateAll(nodes => nodes.map(e => e.getAttribute('href')));
        check('preparation links preserve exact settings anchors', intakeHrefs.length >= 1 && intakeHrefs.every(href => href === `/console/events/${id}/settings#settings-intake`), intakeHrefs);
        check('unpublished page reads as the basic design in use', (await page.locator(':is(section,[role=region])[aria-labelledby="event-readiness-heading"]').textContent()).includes('기본 디자인 사용 중'));
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
