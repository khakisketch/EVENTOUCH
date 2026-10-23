'use strict';

// Real UI workbench journeys. Every write uses a disposable PostgreSQL schema
// through the existing API; messages are explicitly simulated. No deployed or
// review data is used. Run before/after with the corresponding built artifact.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const PHASE = process.env.WORKBENCH_PHASE === 'before' ? 'before' : 'after';
const OUT = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'workbench', PHASE)
  : `/tmp/opencode/eventouch-captures/workbench/${PHASE}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
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
    page.on('pageerror', error => errors.push(error.message));
    const base = `${f.baseUrl}/console/events/${f.eventId}`;
    for (const width of [1280, ...(PHASE === 'after' ? [1024, 800, 768] : []), 390, ...(PHASE === 'after' ? [320] : [])]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const [name, route, marker] of [
        ['participants-100', '/participants', '#roster-search-label'],
        ['messages', '/messages', '#campaign-title'],
        ['theme', '/page', '#home-intro'],
        ['overview-live', '', '#event-metrics-heading'],
        ['operations', '/operations', '#ops-desks'],
        ['settings', '/settings', '#set-name'],
      ]) {
        await page.goto(base + route);
        await page.locator(marker).waitFor({ state: 'attached' });
        await page.locator('h1').waitFor();
        await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true });
        await page.screenshot({ path: `${OUT}/${name}-${width}-viewport.png`, fullPage: false });
        metrics.push({ name, width, ...await page.evaluate(() => ({
          height: document.documentElement.scrollHeight,
          overflow: document.documentElement.scrollWidth - innerWidth,
          rosterRows: document.querySelectorAll('main input[aria-label$=" 선택"]').length,
          firstRosterRowHeight: document.querySelector('main input[aria-label$=" 선택"]')?.closest('li')?.getBoundingClientRect().height ?? null,
          firstRosterIdentityWidth: document.querySelector('main input[aria-label$=" 선택"]')?.closest('li')?.querySelector('strong')?.parentElement?.getBoundingClientRect().width ?? null,
          visibleButtons: [...document.querySelectorAll('main button, main summary')].filter(e => e.getClientRects().length).length,
          sections: [...document.querySelectorAll('main h2')].filter(e => e.getClientRects().length).map(e => ({ title: e.textContent, y: Math.round(e.getBoundingClientRect().top + scrollY) })),
        })) });
      }
    }
    fs.writeFileSync(`${OUT}/metrics.json`, JSON.stringify(metrics, null, 2));
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
    const firstRow = page.locator('li').filter({ has: page.getByRole('checkbox', { name: `${first.name} 선택`, exact: true }) });
    await act(roster, () => firstRow.getByRole('button', { name: '승인', exact: true }).click());
    await page.getByText(`${first.name} 상태를 참가 확정`, { exact: false }).waitFor();
    check('single approval persisted', (await bootstrap()).workspaces[f.eventId].participants.find(p => p.id === first.id).status === 'APPROVED');
    await act(roster, () => page.getByRole('checkbox', { name: `${first.name} 선택`, exact: true }).check());
    if (PHASE === 'after') {
      check('only 25 roster rows rendered', await page.locator('ul').filter({ has: page.getByRole('checkbox', { name: `${first.name} 선택`, exact: true }) }).locator(':scope > li').count() === 25);
      await act(roster, () => page.getByRole('button', { name: '다음', exact: true }).click());
      await page.waitForFunction(() => document.activeElement?.id === 'participants-list-heading');
      check('paging starts at the new slice rather than old scroll offset', await page.getByRole('checkbox', { name: `${later.name} 선택`, exact: true }).evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
    }
    await act(roster, () => page.getByRole('checkbox', { name: `${later.name} 선택`, exact: true }).check());
    if (PHASE === 'after') {
      check('page selection separated from full selection', await page.locator('#roster-selection-count').textContent().then(t => t.includes('현재 표시 1명 선택') && t.includes('전체 선택 2명')));
      await act(roster, () => page.getByRole('button', { name: '검색으로 이동', exact: true }).click());
      check('return focuses search', await page.locator('#roster-search').evaluate(e => e === document.activeElement));
      check('return also exposes search in viewport', await page.locator('#roster-search').evaluate(e => { const r = e.getBoundingClientRect(); const rail = document.querySelector('.console-sidebar')?.getBoundingClientRect(); return r.top >= (innerWidth <= 768 ? rail?.bottom ?? 0 : 0) && r.bottom <= innerHeight; }));
    }
    await finish(roster, 'roster-selection');

    if (PHASE === 'after') {
      await page.getByRole('searchbox', { name: '이름·소속·연락처 검색', exact: true }).fill(later.name);
      check('filter retains hidden selection', await page.locator('#roster-selection-count').textContent().then(t => t.includes('전체 선택 2명') && t.includes('숨김 1명')));
      await page.getByRole('button', { name: '검색·필터 초기화', exact: true }).click();
      check('filter reset retains selection', (await page.locator('#roster-selection-count').textContent()).includes('전체 선택 2명'));
      const row = page.locator('li').filter({ has: page.getByRole('checkbox', { name: `${first.name} 선택`, exact: true }) });
      await row.getByRole('button', { name: `${first.name} 참가자 작업 더보기`, exact: true }).click();
      await row.getByRole('combobox', { name: `${first.name} 상태 변경`, exact: true }).selectOption('CANCELLED');
      check('cancel remains explicit before write', (await bootstrap()).workspaces[f.eventId].participants.find(p => p.id === first.id).status === 'APPROVED');
      await row.getByRole('button', { name: '취소', exact: true }).click();
      check('cancel review dismissal preserves selection', (await page.locator('#roster-selection-count').textContent()).includes('전체 선택 2명'));
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
    if (PHASE === 'after') check('desktop preview does not rename edit location', (await page.locator('[class*="navNow"]').textContent()).includes('편집'));
    await act(theme, () => page.locator('#home-background').fill('#FFF1E8'));
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
    if (PHASE === 'after') check('preview source switch preserves editing position', !(await page.locator('[class*="navNow"]').textContent()).includes('미리보기'));
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
    check('saved versus published difference stays discoverable', await savedDifference.locator('..').evaluate(e => e.open) && await page.locator('#theme-save details p').isVisible() && (await page.locator('#theme-save details p').textContent()).includes('게시본과 다른 저장된 변경:'));
    await page.screenshot({ path: `${OUT}/state-theme-advanced-draft-1280.png`, fullPage: true });
    // Surrounding states and entry/exit: no selection, pending deep link,
    // mobile keyboard paging, empty search, grouped nav and preset anchors.
    await page.goto(base + '/messages');
    await page.locator('#campaign-title').waitFor();
    check('zero recipients disables review with visible reason', await page.locator('#campaign-submit').isDisabled() && (await page.locator('#campaign-submit-warning').textContent()).includes('수신자를 먼저 고르세요'));
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
    const nav = await page.locator('.desktop-side-nav .console-subnav-item').allTextContents();
    check('all 12 destinations remain in approved work order', nav.length === 12 && nav.findIndex(t => t.includes('콘텐츠')) < nav.findIndex(t => t.includes('현장 운영')) && nav.at(-1).includes('행사 설정'), nav);
    check('group labels are not interactive', await page.locator('.desktop-side-nav .nav-work-group-label').evaluateAll(nodes => nodes.length === 2 && nodes.every(e => e.tagName === 'SPAN' && !e.hasAttribute('tabindex'))));
    await page.goto(base + '/participants?status=PENDING');
    await page.getByRole('button', { name: '표시 49명 선택', exact: true }).waitFor();
    await page.getByRole('button', { name: '표시 49명 선택', exact: true }).click();
    check('bulk selection includes other pages without changing displayed count', await page.locator('#roster-selection-count').textContent().then(t => t.includes('현재 표시 25명 선택') && t.includes('전체 선택 49명') && t.includes('필터 범위 49명')));
    await page.getByRole('button', { name: '선택 승인', exact: true }).click();
    await page.locator('#roster-approved-message').waitFor();
    check('bulk approval settles all filtered pages', (await bootstrap()).workspaces[f.eventId].participants.every(p => p.status === 'APPROVED'));
    check('bulk follow-up includes exactly this approval', new URL(await page.locator('#roster-approved-message').getAttribute('href'), f.baseUrl).searchParams.get('to').split(',').length === 49);
    for (const stage of ['DRAFT', 'READY', 'ENDED', 'ARCHIVED']) {
      const id = `${f.eventId}-${stage.toLowerCase()}`;
      await f.helpers.insertEvent(f.harness.database, { id, slug: id,
        payload: { id, slug: id, name: `작업대 ${stage} 상태`, stage, date: '2027-01-16', start: '09:00', end: '17:00', capacity: 100, features: [] },
        workspace: f.helpers.emptyWorkspace(),
      });
      await f.helpers.insertMembership(f.harness.database, f.manager.id, id);
      await page.goto(`${f.baseUrl}/console/events/${id}`);
      await page.locator('#event-metrics-heading').waitFor();
      const firstHeading = await page.locator('main h2').first().textContent();
      check(`${stage} prioritizes its real task`, firstHeading === (['DRAFT', 'READY'].includes(stage) ? '주요 지표' : stage === 'ARCHIVED' ? '보관된 행사 마감 확인' : '행사 마감'), firstHeading);
      if (['DRAFT', 'READY'].includes(stage)) {
        const secondHeading = await page.locator('main h2').nth(1).textContent();
        check(`${stage} follows metrics with preparation`, secondHeading === '행사 준비 확인', secondHeading);
      }
      if (stage === 'DRAFT') {
        check('preparation links preserve exact settings anchors', await page.getByRole('link', { name: '접수 설정', exact: true }).getAttribute('href') === `/console/events/${id}/settings#settings-intake`);
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
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ phase: PHASE, checks, metrics, journeys, scrollMeasurement: 'Raw browser scroll events during explicit actions, not normalized manual scroll counts; no task-time or human comprehension claim.', errors, build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim() }, null, 2));
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
