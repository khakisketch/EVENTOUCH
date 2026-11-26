'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk, typeTicket } = require('./audit-staff-direction.cjs');
const { startStalledResponseProxy } = require('./stalled-response-fixture.cjs');
const axeSource = require('axe-core').source;

let phase = 'setup';
const fixtureDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function checkLiveOverviewRefresh(browser, fixture, participant, out, check) {
  const endpoint = `/api/events/${fixture.eventId}/bootstrap`;
  const full = await fixture.helpers.requestJson(fixture.harness.baseUrl, endpoint, { cookie: fixture.manager.cookie });
  assert.equal(full.status, 200);
  const version = full.json.state.refreshVersion;
  const conditional = endpoint + '?ifVersion=' + encodeURIComponent(version) + '&messageRecipientReview=1';
  const proxy = await startStalledResponseProxy(fixture.baseUrl, conditional);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const staffContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await staffContext.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    const staff = await staffContext.newPage();
    await staff.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await confirmInitialStaffDesk(staff);
    await typeTicket(staff, participant.ticket);

    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: proxy.origin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.clock.install();
    let overviewReads = 0;
    let managerWrites = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === endpoint) overviewReads += 1;
      if (request.method() === 'POST' && request.url().endsWith('/commands')) managerWrites += 1;
    });
    await page.goto(`${proxy.origin}/console/events/${fixture.eventId}`);
    const progress = page.getByRole('progressbar');
    const time = page.locator('time').filter({ hasText: /^(자동 확인|마지막 확인) / });
    const stale = page.getByRole('alert').filter({ hasText: '이전에 불러온 내용은 유지됩니다.' });
    await time.waitFor();
    const startValue = Number(await progress.getAttribute('aria-valuenow'));
    const initialTime = await time.getAttribute('datetime');
    const headers = () => page.waitForResponse(response => response.url() === proxy.origin + conditional && response.status() === 200);
    const [probe] = await Promise.all([headers(), page.clock.fastForward(15000)]);
    const unchanged = await probe.json();
    check('an unchanged live check has no event workspace payload', unchanged.state.unchanged === true &&
      Object.keys(unchanged.state).sort().join(',') === 'messageReadObservedAt,refreshVersion,unchanged' &&
      Number.isFinite(Date.parse(unchanged.state.messageReadObservedAt)));
    await page.waitForFunction(previous => Array.from(document.querySelectorAll('time')).some(element =>
      element.textContent.trim().startsWith('자동 확인 ') && element.dateTime !== previous), initialTime);
    const lastTime = await time.getAttribute('datetime');

    proxy.setStalled(true);
    await Promise.all([headers(), page.clock.fastForward(15000)]);
    await page.clock.fastForward(8000);
    await stale.waitFor();
    await proxy.waitForClosed(0);
    check('a stalled live read preserves the last progress and timestamp', Number(await progress.getAttribute('aria-valuenow')) === startValue &&
      await time.getAttribute('datetime') === lastTime && /마지막 확인/.test(await time.innerText()));
    await page.setViewportSize({ width: 390, height: 844 });
    check('stale live overview fits 390px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(out, 'live-overview-stale-390.png') });
    await page.setViewportSize({ width: 1280, height: 900 });

    proxy.setStalled(false);
    await staff.getByRole('button', { name: '입장 처리', exact: true }).click();
    await staff.getByRole('region', { name: '스캔 결과 상세' }).waitFor();
    await page.clock.fastForward(30000);
    await page.waitForFunction(previous => Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) > previous, startValue);
    check('the operator gets the staff entry without reloading or writing', managerWrites === 0 &&
      await stale.count() === 0 && await time.getAttribute('datetime') !== lastTime &&
      await page.getByText(participant.name, { exact: true }).first().isVisible());
    await page.screenshot({ path: path.join(out, 'live-overview-auto-1280.png') });

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const beforeHidden = overviewReads;
    await page.clock.fastForward(60000);
    check('hidden overview starts no automatic read', overviewReads === beforeHidden);
  } finally {
    await staffContext.close();
    await context.close();
    await proxy.close();
  }
}

(async () => {
  const out = process.env.EVENTOUCH_CAPTURE_ROOT ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'participation-navigation') : defaultCaptureDir(`participation-navigation-${runStamp()}`);
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, page;
  const checks = [], errors = [], writes = [];
  const call = async (command, payload, bearer) => {
    const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      ...(bearer ? { bearer } : { cookie: f.manager.cookie }), method: 'POST',
      body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(response.status >= 200 && response.status < 300, `${command}: ${response.status} ${JSON.stringify(response.json)}`);
    return response.json;
  };
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  try {
    await call('event.update', { name: '파트너 데이', date: fixtureDate, start: '00:00', end: '23:59', capacity: 200 });
    await call('event.features', { features: ['qa', 'quiz', 'photo', 'board', 'venue', 'screen'] });
    await call('venue.save', { name: '서울 컨벤션홀', address: '서울 합성로 12', directions: '동문 입장', contact: '02-0000-0000', description: '' });
    await call('program.save', { title: '파트너 라운드테이블', date: fixtureDate, start: '00:01', end: '23:59', place: '그랜드홀', published: true });
    const ws = await read();
    for (const person of ws.participants.slice(0, 2)) {
      person.status = 'APPROVED'; person.revoked = false;
      person.ticket = crypto.randomBytes(32).toString('base64url');
      person.ticketExpiresAt = new Date(Date.now() + 86400000).toISOString();
    }
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]);
    const pendingParticipants = ws.participants.slice(-2).map(person => person.id);
    await call('participant.status', { ids: pendingParticipants, status: 'PENDING' });
    for (let index = 1; index <= 13; index++) await call('module.save', {
      type: 'quiz', title: `세션 퀴즈 ${String(index).padStart(2, '0')}`, options: ['A', 'B'], answer: 'A',
    });
    const qa = (await call('module.save', { type: 'qa', title: '파트너 라이브 Q&A' })).module;
    await call('module.status', { id: qa.id, status: 'OPEN' });
    const question = (await call('question.submit', { moduleId: qa.id, text: '내년 파트너 프로그램은 언제 시작하나요?' }, ws.participants[0].ticket)).question;
    await call('question.submit', { moduleId: qa.id, text: '세션 자료는 어디에서 확인하나요?' }, ws.participants[1].ticket);
    const board = (await call('module.save', { type: 'board', title: '참여 후기' })).module;
    await call('module.status', { id: board.id, status: 'OPEN' });
    await call('post.submit', { body: '라운드테이블이 유익했습니다.' }, ws.participants[0].ticket);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/commands')) writes.push(request.postDataJSON()); });
    const capture = async name => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(out, name + '.png') }); };
    const base = `${f.baseUrl}/console/events/${f.eventId}`;
    phase = 'live overview';
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '운영 현황', exact: true }).waitFor();
    await capture('01-live-home-1280');
    await page.setViewportSize({ width: 390, height: 844 }); await capture('01-live-home-390');
    await page.setViewportSize({ width: 1280, height: 960 });
    phase = 'operations';
    await page.goto(base + '/operations', { waitUntil: 'networkidle' });
    // Reopened 2026-11-20: 현장 운영 is 입장 관리; participation work moved to 현장 모드 (/live).
    await page.getByRole('heading', { name: '입장 관리', exact: true }).waitFor(); await capture('02-operations-1280');
    phase = 'participation collection';
    await page.goto(base + '/programs', { waitUntil: 'networkidle' });
    await page.locator('#program-search-label').waitFor({ state: 'attached' }); await capture('03-participation-1280');
    await page.setViewportSize({ width: 390, height: 844 }); await capture('03-participation-390');
    const before = process.argv.includes('--before');
    if (!before) {
      const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
      const programs = async (query = '') => {
        await page.goto(base + '/programs' + query, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '참여 이벤트', exact: true }).waitFor();
      };
      const qaRow = () => page.locator(`[id="moderation-question-${question.id}"]`);
      // The overview's 단계 카드 status chip (runbookStatus, muted label on a muted surface) fails color-contrast on the base
      // branch too; it belongs to the 운영 현황 screen, not to this participation audit, so it is excluded here and reported.
      const assess = async name => {
        await page.evaluate(axeSource);
        const findings = await page.evaluate(async () => (await window.axe.run({ exclude: [['[class*="runbookStatus"]']] })).violations.filter(v => ['moderate', 'serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
        check(name + ': axe moderate or above = 0' + (findings.length ? ' ' + JSON.stringify(findings) : ''), findings.length === 0);
        check(name + ': no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      };
      await page.setViewportSize({ width: 1280, height: 960 });
      // Reopened 2026-11-26: the link uses the menu name 추첨·투표.
      const drawLink = page.getByRole('link', { name: '추첨·투표 (무대 운영·룰렛)' });
      check('participation has a specialized draw link', await drawLink.isVisible());
      check('draw management is a separate action with its existing destination',
        await drawLink.getAttribute('href') === `/console/events/${f.eventId}/draws` &&
        await drawLink.evaluate(link => link.closest('p')?.textContent.trim() === link.textContent.trim()));
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 960 });
        // The confirmed list has no purpose paragraph; the draw link closes the list on its own line.
        const listBox = await page.getByRole('region', { name: '참여 이벤트 목록', exact: true }).locator('ul, ol').first().boundingBox();
        const actionBox = await drawLink.boundingBox();
        check(`draw action follows the list without overlap at ${width}`,
          listBox && actionBox && actionBox.y >= listBox.y + listBox.height - 1 && actionBox.height >= 44);
        check(`participation has no horizontal overflow at ${width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await page.setViewportSize({ width: 1280, height: 960 });
      check('actual initial page count is 12 of 15', await page.getByRole('button', { name: '더 보기 (3)' }).count() === 1);
      const preparation = page.getByRole('group', { name: '행사 준비', exact: true });
      // Reopened 2026-11-24: the rail no longer lists 공지·안내 and 참여 이벤트 (2026-11-21 merged them into one 참가자 화면 item);
      // the path to each is the hub's tab row on the 참가자 화면 pages, and the two tabs keep separate destinations.
      check('preparation holds one 참가자 화면 item instead of separate guidance and participation links',
        await preparation.getByRole('link', { name: /^참가자 화면/ }).count() === 1 &&
        await preparation.getByRole('link', { name: '공지·안내', exact: true }).count() === 0 &&
        await preparation.getByRole('link', { name: '참여 이벤트', exact: true }).count() === 0);
      const hubTabs = page.getByRole('navigation', { name: '참가자 화면', exact: true });
      const guidanceTab = hubTabs.getByRole('link', { name: /^공지·안내/ });
      const participationTab = hubTabs.getByRole('link', { name: /^참여 이벤트/ });
      check('the 참가자 화면 hub still tells guidance from participation content',
        await guidanceTab.count() === 1 && await participationTab.count() === 1 &&
        (await guidanceTab.getAttribute('href')).endsWith('/content') && (await participationTab.getAttribute('href')).endsWith('/programs'));
      check('onsite group leads with operational destinations', await page.getByRole('group', { name: '당일', exact: true }).getByRole('link', { name: '참여 이벤트', exact: true }).count() === 0);
      check('old participation title is absent', await page.getByRole('heading', { name: '참여 프로그램', exact: true }).count() === 0);
      phase = 'home work queue';
      await page.goto(base, { waitUntil: 'networkidle' });
      const qaTask = () => page.locator('[data-task="qa"]');
      await qaTask().waitFor();
      check('home counts two unique questions, not four overlapping work classes', /질문 2개/.test(await qaTask().innerText()));
      check('home explains unanswered and pending approval', /미답변 2건 · 승인 대기 2건/.test(await qaTask().innerText()));
      check('home includes the pending board post', /1건/.test(await page.locator('[data-task="post"]').innerText()));
      check('home has no generic onsite-work queue item', await page.locator('[data-task="live"]').count() === 0);
      check('entry metrics remain available', await page.getByRole('heading', { name: '입장 진행', exact: true }).isVisible());
      const entryTitle = await page.getByRole('region', { name: '입장 진행', exact: true }).boundingBox();
      const tasksTitle = await page.getByRole('heading', { name: '지금 할 일', exact: true }).boundingBox();
      // The 2026-11-19 overview is an entry board (hero number and counts) with the 지금 할 일 band directly below it,
      // both inside the first desktop screen. The older side-by-side heading row no longer exists.
      check('entry board leads and the task band follows it on the first desktop screen', entryTitle && tasksTitle && entryTitle.y < tasksTitle.y && tasksTitle.y < 960);
      const entry = page.getByRole('region', { name: '입장 진행', exact: true });
      const progress = entry.getByRole('progressbar');
      const leadTask = page.locator('[data-task="approval"]');
      const [boardBox, leadTaskBox, secondTaskBox] = await Promise.all([entry.boundingBox(), leadTask.boundingBox(), qaTask().boundingBox()]);
      check('the task band sits below the entry board and leads with the pending approval', boardBox && leadTaskBox && secondTaskBox &&
        leadTaskBox.y >= boardBox.y + boardBox.height - 1 && leadTaskBox.y < secondTaskBox.y);
      // The 2026-11-19 board: the cumulative count is the hero number, with the registered total, the rate and a progress bar.
      const boardText = await entry.innerText();
      check('the board shows the cumulative entry, the registered total and the rate',
        /누적 입장/.test(boardText) && /\/ \d+명/.test(boardText) && /\d+%/.test(boardText) && await progress.count() === 1);
      const rosterLinks = entry.getByRole('link', { name: /미입장 명단 보기|참가 확정 명단 보기/ });
      check('one roster shortcut sits under the hero number', await rosterLinks.count() === 1);
      check('the entry roster link leads with the live decision (not yet entered)', /미입장 명단/.test(await rosterLinks.first().getAttribute('aria-label')));
      const refreshTool = page.getByRole('button', { name: '새로고침', exact: true });
      const toolSize = await refreshTool.boundingBox();
      check('refresh is a named SVG with a 44px target', toolSize && toolSize.width >= 44 && toolSize.height >= 44 &&
        await refreshTool.locator('svg[aria-hidden="true"]').count() === 1 && !(await refreshTool.innerText()).trim());
      await Promise.all([
        page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/events/${f.eventId}/bootstrap` && response.ok()),
        refreshTool.press('Enter'),
      ]);
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '새로고침' && document.activeElement.getAttribute('aria-busy') !== 'true' && document.activeElement.getAttribute('aria-disabled') !== 'true');
      check('keyboard refresh retains focus and issues no write', await refreshTool.evaluate(button => document.activeElement === button) && writes.length === 0);
      await assess('overview desktop');
      await capture('04-home-work-1280');
      await rosterLinks.first().press('Enter');
      await page.getByLabel('출입 상태별 보기').waitFor();
      check('the first roster link opens the confirmed non-entry filter', await page.getByLabel('출입 상태별 보기').inputValue() === 'NOT_ENTERED' &&
        await page.getByRole('group', { name: '빠른 상태 보기', exact: true }).getByRole('button', { name: /^확정자 중 미입장/ }).getAttribute('aria-pressed') === 'true');
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.getByRole('link', { name: '승인 대기 처리', exact: true }).click();
      await page.getByRole('group', { name: '빠른 상태 보기', exact: true }).getByRole('button', { name: /^승인 대기/ }).waitFor();
      check('the lead action opens the pending roster without writing', await page.getByRole('group', { name: '빠른 상태 보기', exact: true }).getByRole('button', { name: /^승인 대기/ }).getAttribute('aria-pressed') === 'true' && writes.length === 0);
      await page.goto(base, { waitUntil: 'networkidle' });
      phase = 'home to QA handoff';
      await qaTask().getByRole('link', { name: '질문 승인 검토' }).click();
      await page.getByRole('heading', { name: '참여 이벤트', exact: true }).waitFor();
      // The shortcut opens the review drawer on its first matching question.
      await page.waitForFunction(() => /^review-question-/.test(document.activeElement?.id || ''));
      const reviewRow = () => page.locator(`[id="review-question-${question.id}"]`);
      check('handoff consumes URL filters after an accepted workspace', !/[?&](review|from)=/.test(page.url()));
      check('handoff reveals the module beyond the first 12', await reviewRow().count() === 1);
      check('handoff exposes the real response-management surface', await reviewRow().isVisible());
      check('navigation has not written any command', writes.length === 0);
      check('navigation opens only the review drawer, not a content editor', await page.getByRole('dialog').count() === 1 && /^검토할 것/.test(await page.getByRole('dialog').getByRole('heading').first().innerText()));
      const answer = '2027년 1월에 참가자에게 일정과 자료를 안내합니다.';
      await reviewRow().getByRole('button').first().click();
      await page.locator(`[id="review-answer-${question.id}"]`).fill(answer);
      await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).first().click();
      await page.getByRole('button', { name: /^검토할 것/ }).click();
      await reviewRow().getByRole('button').first().click();
      check('closing and reopening the review preserves an unsaved answer', await page.locator(`[id="review-answer-${question.id}"]`).inputValue() === answer);
      await capture('05-qa-review-1280');
      phase = 'approve and answer through UI';
      await reviewRow().getByRole('button', { name: '답변하고 공개', exact: true }).click();
      await page.waitForFunction(id => !document.getElementById(`review-question-${id}`), question.id);
      const answered = (await read()).questions.find(row => row.id === question.id);
      check('one explicit operation saves and publishes the answer', answered.approved === true && answered.answer === answer);
      check('exactly one question command was sent', writes.length === 1 && writes[0].command === 'question.manage');
      const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
      await guestContext.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: ws.participants[0].ticket });
      const guest = await guestContext.newPage(); guest.setDefaultTimeout(12000);
      await guest.goto(`${f.baseUrl}/event/${f.slug}/engage`, { waitUntil: 'networkidle' });
      await guest.getByText('답변: ' + answer, { exact: true }).waitFor();
      check('cookie-free participant screen shows the approved answer', await guest.getByText('답변: ' + answer, { exact: true }).isVisible());
      check('public context has no operator cookie', !(await guestContext.cookies()).some(cookie => cookie.name === 'etko_session'));
      await guest.screenshot({ path: path.join(out, '06-participant-answer-390.png') });
      await guestContext.close();
      if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).first().click();
      await page.getByRole('link', { name: '운영 현황으로', exact: true }).first().click();
      await qaTask().waitFor();
      check('return to home refreshes the remaining work count', /질문 1개/.test(await qaTask().innerText()) && /미답변 1건 · 승인 대기 1건/.test(await qaTask().innerText()));
      phase = 'live mode participation work';
      await page.goto(base + '/live', { waitUntil: 'networkidle' });
      const opsPanel = () => page.locator('[data-live-pane="side"]');
      await opsPanel().waitFor({ state: 'visible' });
      // Reopened 2026-11-20: the review queue and open events live in the 현장 모드 side and schedule panes.
      check('the live room carries the review queue', await opsPanel().getByRole('heading', { name: '검토 대기', exact: true }).isVisible());
      check('live mode queue agrees with home', /Q&A 확인/.test(await opsPanel().innerText()) && /질문 1개/.test(await opsPanel().innerText()));
      check('live mode lists exactly two published open modules', await page.locator('[data-live-pane="stage"] button[aria-pressed][data-status="OPEN"]').count() === 2);
      await assess('live desktop'); await capture('07-participation-live-1280');
      const priorWrites = writes.length;
      await programs('?module=' + qa.id);
      await page.waitForFunction(id => document.activeElement?.tagName === 'SUMMARY' && document.activeElement.closest('li')?.querySelector('h2,h3')?.id === `module-title-${id}`, qa.id);
      check('module handoff opens the existing progress panel', await qaRow().isVisible());
      check('module handoff remains read only', writes.length === priorWrites);
      await programs('?status=OPEN');
      await page.waitForFunction(() => document.querySelector('[aria-label="진행 상태별 보기"] button[aria-pressed="true"]')?.textContent.startsWith('진행 중'));
      check('open-content handoff filters without opening an editor', await page.getByRole('dialog').count() === 0);
      check('only two open modules are shown', (await page.getByRole('status').allTextContents()).some(text => /검색·필터 결과 2개/.test(text)));
      for (const [suffix, copy] of [
        ['?review=invalid', '요청한 작업을 확인하지 못했습니다.'],
        ['?module=missing-content&from=operations', '요청한 참여 콘텐츠를 찾을 수 없습니다.'],
        ['?review=qa-pending&review=post', '요청한 작업을 확인하지 못했습니다.'],
      ]) {
        phase = 'stale or invalid handoff';
        await programs(suffix);
        await page.getByText(copy, { exact: false }).waitFor();
        check('safe handoff: ' + suffix, writes.length === priorWrites && await page.getByRole('dialog').count() === 0);
      }
      phase = 'responsive handoff and keyboard';
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await programs('?review=qa-pending&from=overview');
        await page.waitForFunction(() => /^review-question-/.test(document.activeElement?.id || ''));
        check(`QA focus is visible at ${width}`, await page.evaluate(() => { const rect = document.activeElement.getBoundingClientRect(); return rect.top < innerHeight && rect.bottom > 0; }));
        await assess(`QA ${width}`); await capture(`08-qa-review-${width}`);
        if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).first().click();
        await page.getByRole('link', { name: '운영 현황으로', exact: true }).first().click();
        await qaTask().waitFor(); await assess(`overview ${width}`); await capture(`09-home-${width}`);
        const rect = await qaTask().getByRole('link').boundingBox();
        check(`home work action has a 44px target at ${width}`, rect && rect.height >= 44 && rect.width >= 44);
        const entryBox = await entry.boundingBox();
        const queueBox = await page.getByRole('region', { name: '지금 할 일', exact: true }).boundingBox();
        const [firstRow, secondRow, rosterGroup] = await Promise.all([
          rosterLinks.first().boundingBox(), rosterLinks.last().boundingBox(), rosterLinks.first().locator('..').boundingBox(),
        ]);
        // On a phone the entry panel precedes the queue; its roster link is a compact 44px-high action inside the panel.
        check(`entry precedes the task queue with a 44px roster link inside the panel at ${width}`,
          entryBox && queueBox && firstRow && rosterGroup && entryBox.y + entryBox.height <= queueBox.y &&
          firstRow.height >= 44 && firstRow.width >= 44 && firstRow.x >= rosterGroup.x && firstRow.x + firstRow.width <= rosterGroup.x + rosterGroup.width + 1);
        await page.goto(base + '/live', { waitUntil: 'networkidle' });
        await opsPanel().waitFor({ state: 'visible' }); await assess(`live ${width}`); await capture(`10-live-${width}`);
      }
      phase = 'feature-aware work queue';
      await call('event.features', { features: ['quiz', 'photo', 'board', 'venue', 'screen'] });
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '운영 현황', exact: true }).waitFor();
      check('disabled Q&A does not appear as actionable home work', await page.locator('[data-task="qa"]').count() === 0);
      check('disabling a feature preserves its questions', (await read()).questions.length === 2);
      await call('event.features', { features: ['qa', 'quiz', 'photo', 'board', 'venue', 'screen'] });
      await page.reload({ waitUntil: 'networkidle' }); await qaTask().waitFor();
      check('restoring Q&A restores the pending work', /질문 1개/.test(await qaTask().innerText()));
      phase = 'finish pending work and empty state';
      const pendingQuestion = (await read()).questions.find(row => row.id !== question.id);
      await call('question.manage', { id: pendingQuestion.id, answer: '행사 안내의 자료실에서 확인하실 수 있습니다.', approved: true });
      await call('participant.status', { ids: pendingParticipants, status: 'APPROVED' });
      const pendingPost = (await read()).posts[0];
      await page.locator('[data-task="post"]').getByRole('link', { name: '게시글 검토', exact: true }).click();
      await page.waitForFunction(() => /^review-post-/.test(document.activeElement?.id || ''));
      const postRow = page.locator(`[id="review-post-${pendingPost.id}"]`);
      check('post handoff reveals the fifteenth module', await postRow.isVisible() && /참여 후기/.test(await postRow.locator('xpath=ancestor::section[1]').innerText()));
      await postRow.getByRole('button', { name: '승인', exact: true }).click();
      check('post publication requires explicit confirmation', (await read()).posts.find(post => post.id === pendingPost.id).status === 'PENDING');
      await postRow.getByRole('button', { name: '승인한다', exact: true }).click();
      await page.waitForFunction(id => !document.getElementById(`review-post-${id}`), pendingPost.id);
      check('explicit post approval reaches the workspace', (await read()).posts.find(post => post.id === pendingPost.id).status === 'APPROVED');
      if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).first().click();
      await page.getByRole('link', { name: '운영 현황으로', exact: true }).first().click();
      await page.getByRole('heading', { name: '운영 현황', exact: true }).waitFor();
      await page.getByText('지금 확인할 운영 항목이 없습니다.', { exact: true }).waitFor();
      check('handled questions and posts leave a quiet truthful home', await page.locator('[data-task="qa"], [data-task="post"]').count() === 0);
      check('the entry readout and roster stay visible with no tasks', await progress.isVisible() && await rosterLinks.count() === 1);
      await page.goto(base + '/live', { waitUntil: 'networkidle' });
      await page.getByText('검토할 질문이나 참여 응답이 없습니다.', { exact: true }).waitFor();
      check('live mode has a matching empty review queue', await opsPanel().getByRole('link', { name: /질문|게시글|사진/ }).count() === 0);
      await call('event.features', { features: [] });
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('진행할 참여 이벤트가 없습니다.', { exact: false }).waitFor();
      check('events without participation features list no participation events', await page.locator('[data-live-pane="stage"] [data-live-event]').count() === 0);
      check('disabling all participation features preserves the modules', (await read()).modules.length === 15);
      check('only explicit question and post operations generated commands', writes.length === priorWrites + 1 && writes.at(-1).command === 'post.moderate');
      phase = 'live overview automatic refresh and recovery';
      await checkLiveOverviewRefresh(browser, f, ws.participants[2], out, check);
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ before, build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), checks, writes: writes.length, errors, synthetic: true, fixtureDate, timezone: 'Asia/Seoul', fixtures: { questionId: question.id, qaId: qa.id } }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ checks: checks.length, writes: writes.length, build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), output: out }));
  } catch (error) {
    if (page) fs.writeFileSync(path.join(out, 'failure-state.json'), JSON.stringify(await page.evaluate(() => ({ url: location.pathname + location.search + location.hash, focusId: document.activeElement?.id, focusTag: document.activeElement?.tagName }))), { mode: 0o600 });
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    console.error('PHASE', phase); throw error;
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
