'use strict';

// Missing workflow-stage journeys with exact operator step counts.
// Boots the same isolated shape as the other web audits: a random
// PostgreSQL schema, a real API harness, an owned Next server bound to
// that harness, and a same-origin gateway. No mocked API, no protected
// data, no shared/production database.
//
// Step rule: each click/fill/select/check is 1 step. page.goto navigation
// and readiness waits are setup and never counted. Scrolls are counted
// with a document listener (one gesture = one scroll after settle) and
// reported, not capped. Every small task stays within 12 operator steps.
//
// Tasks (owner unless noted):
//   1. event-create      create an event (client preseeded via REST when
//                        available, date always typed in the form)
//   2. program-add       add a schedule program, date deliberately blank
//                        (falls back to the event date)
//   3. notice-publish    write and publish a notice
//   4. intake-publish    fill consent text, publish the form / open intake
//   5. intake-close      close registration
//   6. stage-end         LIVE fixture event -> ENDED (expand, transition,
//                        confirm each count; expansion counts when required)
//   7. stage-archive     ENDED -> ARCHIVED with registration closed
//   8. desk-checkin      staff manual desk check-in on the LIVE fixture
//                        event (desk select, ticket fill, 입장 처리)
//   9. booth-visit       staff booth certification in STAFF mode with the
//                        same ticket (switch, booth select, ticket, 부스 인증)
//  10. reward-fulfill    owner on-site reward fulfil (수령 처리 + 처리한다)
//
// Tasks 2-5 run on the event created in task 1. Tasks 8-10 run on the
// fixture seed event BEFORE stage-end, while it is still LIVE (check.scan
// and booth.visit both require LIVE), then tasks 6-7 close it out.
// Role cookie swaps and all seeding are setup and never counted; every
// counted step is an actual UI operation verified against the bootstrap.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const before = process.argv.includes('--before');
const out = `/tmp/opencode/eventouch-captures/task-flow/${before ? 'before' : 'after'}`;
fs.mkdirSync(out, { recursive: true });

const STEP_CAP = 12;
const EVENT_DATE = '2027-04-15';
const PROGRAM_TITLE = '여정 오프닝';
const PROGRAM_START = '10:00';
const PROGRAM_END = '11:00';
const NOTICE_TITLE = '여정 공지';
const NOTICE_BODY = '여정 참가자는 동문으로 입장합니다.';
const CONSENT_TEXT = '여정 측정: 이름·연락처를 행사 운영에만 씁니다.';
const BOOTH_NAME = '여정 체험 부스';
const REWARD_NAME = '여정 현장 경품';

function buildId() {
  try {
    return fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

function sessionValue(cookie) {
  return decodeURIComponent(String(cookie).slice('etko_session='.length));
}

async function readBootstrap(helpers, baseUrl, cookie) {
  const response = await helpers.requestJson(baseUrl, '/api/bootstrap', { cookie });
  if (response.status !== 200) throw new Error(`bootstrap: ${response.status}`);
  return response.json.state;
}

async function apiCommand(helpers, baseUrl, cookie, eventId, command, payload) {
  const response = await helpers.requestJson(baseUrl, `/api/events/${eventId}/commands`, {
    cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`setup ${command}: ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

async function main() {
  let fixture = null;
  let browser = null;
  const errors = [];
  const results = [];
  try {
    fixture = await startAuditFixture();
    const { harness, helpers } = fixture;
    const baseUrl = fixture.baseUrl;
    const { suffix } = fixture;

    const ownerId = `audit-owner-${suffix}`;
    const ownerCookie = await helpers.sessionCookie(harness, ownerId);

    // Preseed one client through the real organization REST path so the
    // creation task selects an existing customer. This must succeed: a
    // silent fallback would turn the explicit existing-client selection
    // into an unasserted pass.
    const clientSeed = { ok: false, id: null, name: '여정 고객사', error: null };
    {
      const response = await helpers.requestJson(harness.baseUrl, '/api/clients', {
        cookie: ownerCookie,
        method: 'POST',
        body: { commandId: crypto.randomUUID(), name: clientSeed.name, contact: '여정 담당' },
      });
      assert.ok(response.status >= 200 && response.status < 300,
        `client seed REST failed: ${response.status} ${JSON.stringify(response.json)}`);
      clientSeed.id = String(response.json.client && response.json.client.id || '');
      assert.ok(clientSeed.id, 'client seed REST returned no client id');
      clientSeed.ok = true;
    }

    browser = await launchBrowser();
    const context = await browser.newContext();
    await context.addCookies([{
      name: 'etko_session', value: sessionValue(ownerCookie),
      url: baseUrl, httpOnly: true, sameSite: 'Lax',
    }]);

    // Scroll counting survives navigation: the document listener is
    // installed via addInitScript (runs on every navigation, including the
    // go() navigations inside measured tasks), while the counter lives
    // Node-side. go() pauses counting during navigation + readiness and
    // re-enables afterwards, so setup scrolling is never counted and the
    // same mechanism measures every task in before/after runs.
    // One gesture = one scroll: counted only after >80px movement and
    // >400ms since the previous count.
    let scrollCounter = null; // { count, lastY, lastTime, paused }
    await context.exposeFunction('__journeyScrollTick', (y, now) => {
      try {
        const counter = scrollCounter;
        if (!counter || counter.paused) return;
        const yy = Number(y);
        const tt = Number(now);
        if (counter.lastY === null || counter.lastY === undefined) {
          counter.lastY = yy;
          return;
        }
        if (Math.abs(yy - counter.lastY) > 80 && tt - counter.lastTime > 400) {
          counter.count += 1;
          counter.lastTime = tt;
        }
        counter.lastY = yy;
      } catch {
        // Scroll accounting must never break the measured flow.
      }
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.addEventListener('scroll', () => {
        try {
          window.__journeyScrollTick(window.scrollY, Date.now());
        } catch {
          // Fire-and-forget accounting; the flow does not depend on it.
        }
      }, { passive: true });
    });
    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${String((error && error.message) || error).split('\n')[0]}`);
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      if (!url.startsWith(baseUrl)) return;
      if (url.includes('/api/') || response.request().resourceType() === 'document') {
        errors.push(`http ${status}: ${url.split('?')[0].slice(url.indexOf('/', 8))}`);
      }
    });

    const go = async (target, marker) => {
      if (scrollCounter) scrollCounter.paused = true;
      try {
        await page.goto(baseUrl + target, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator(marker).first().waitFor({ state: 'visible', timeout: 15000 });
      } finally {
        // Re-enable after the target screen is ready; reset the gesture
        // baseline so post-navigation settling is never counted.
        if (scrollCounter) {
          scrollCounter.paused = false;
          scrollCounter.lastY = null;
          scrollCounter.lastTime = 0;
        }
      }
    };
    const shot = async (name) => {
      await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    };
    const shotBoth = async (name) => {
      // Viewport resizes can fire scroll events; pause accounting during
      // captures and reset the baseline on resume.
      if (scrollCounter) scrollCounter.paused = true;
      try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await shot(`${name}-1280`);
        await page.setViewportSize({ width: 390, height: 844 });
        await shot(`${name}-390`);
      } finally {
        if (scrollCounter) {
          scrollCounter.paused = false;
          scrollCounter.lastY = null;
          scrollCounter.lastTime = 0;
        }
      }
    };

    const measure = async (key, title, fn) => {
      const task = {
        key, title, actor: 'owner', stepCap: STEP_CAP,
        steps: 0, scrolls: 0, writes: 0,
        scrollNote: 'Node-side counter fed by an addInitScript document listener (survives navigation); >80px and >400ms settle = 1 scroll; paused during goto/ready and captures',
        screens: [], fields: [], state: null, serverNote: '',
        passed: false, errors: [],
      };
      scrollCounter = { count: 0, lastY: null, lastTime: 0, paused: true };
      const onRequest = (request) => {
        if (request.method() === 'POST' && request.url().includes('/api/')) task.writes += 1;
      };
      page.on('request', onRequest);
      const act = async (fn2) => { task.steps += 1; await fn2(); };
      try {
        await fn(act, task);
        task.scrolls = scrollCounter ? scrollCounter.count : 0;
        assert.ok(task.steps <= STEP_CAP, `${key}: ${task.steps} steps exceed cap ${STEP_CAP}`);
        task.passed = true;
      } catch (error) {
        task.scrolls = scrollCounter ? scrollCounter.count : 0;
        task.errors.push(String((error && error.message) || error).split('\n')[0]);
        throw error;
      } finally {
        page.off('request', onRequest);
        scrollCounter = null;
        results.push(task);
      }
      return task;
    };

    await page.setViewportSize({ width: 1280, height: 900 });
    let createdEventId = null;
    let createdEventName = `여정 측정 행사 ${suffix.slice(0, 6)}`;

    // ---- Task 1: owner creates an event ----
    await measure('event-create', '행사 만들기 (고객사 선택·날짜 입력)', async (act, task) => {
      task.screens = ['/console (#console-event-directory)', '새 행사 만들기 dialog', '/console/events/:id overview (#event-metrics-heading)'];
      task.fields = ['#create-name', '#create-client', '#create-date', 'submit 행사 만들기'];
      await go('/console', '#console-event-directory');
      await act(() => page.getByRole('button', { name: '새 행사 만들기', exact: true }).click());
      await page.locator('#create-name').waitFor({ state: 'visible', timeout: 10000 });
      await act(() => page.locator('#create-name').fill(createdEventName));
      // Existing-client selection is mandatory: the seeded client must be
      // offered as an exact option and must be selected. Fail loudly when
      // it is missing instead of passing client-less.
      {
        const values = await page.locator('#create-client option').evaluateAll((nodes) => nodes.map((node) => node.value));
        assert.ok(values.includes(clientSeed.id),
          `seeded client ${clientSeed.id} missing from #create-client options: ${JSON.stringify(values)}`);
        await act(() => page.locator('#create-client').selectOption(clientSeed.id));
      }
      await act(() => page.locator('#create-date').fill(EVENT_DATE));
      await act(() => page.getByRole('button', { name: '행사 만들기', exact: true }).click());
      await page.waitForURL(/\/console\/events\/[^/?#]+/, { timeout: 15000 });
      await page.locator('#event-metrics-heading').first().waitFor({ state: 'visible', timeout: 15000 });
      const match = page.url().match(/\/console\/events\/([^/?#]+)/);
      assert.ok(match, `creation did not land on an event overview: ${page.url()}`);
      createdEventId = decodeURIComponent(match[1]);
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const created = (state.events || []).find((item) => item.id === createdEventId);
      assert.ok(created, 'created event missing from bootstrap events');
      assert.equal(created.name, createdEventName);
      assert.equal(created.date, EVENT_DATE);
      assert.equal(created.clientId || null, clientSeed.id);
      task.state = `bootstrap events: id=${created.id} name=${created.name} date=${created.date} clientId=${created.clientId || 'null'} stage=${created.stage}`;
      task.serverNote = `client preseeded via POST /api/clients (${clientSeed.id}) and selected in #create-client`;
      await shotBoth('journey-event-created');
    });
    assert.ok(createdEventId, 'task 1 must produce an event id for tasks 2-5');

    // ---- Task 2: content program schedule, date blank -> event date ----
    await measure('program-add', '프로그램 일정 추가 (날짜 비움)', async (act, task) => {
      task.screens = [`/console/events/${createdEventId}/content (#content-notices)`];
      task.fields = ['#content-program-title', '#content-program-date (blank)', '#content-program-start', '#content-program-end', 'submit 만들기'];
      await go(`/console/events/${createdEventId}/content`, '#content-notices');
      await act(() => page.getByRole('button', { name: '일정 추가', exact: true }).click());
      await page.locator('#content-program-title').waitFor({ state: 'visible', timeout: 10000 });
      await act(() => page.locator('#content-program-title').fill(PROGRAM_TITLE));
      await act(() => page.locator('#content-program-start').fill(PROGRAM_START));
      await act(() => page.locator('#content-program-end').fill(PROGRAM_END));
      assert.equal(await page.locator('#content-program-date').inputValue(), '', 'program date must stay blank (event date fallback)');
      await act(() => page.getByRole('dialog').getByRole('button', { name: '만들기', exact: true }).click());
      await page.getByRole('heading', { name: PROGRAM_TITLE, exact: true }).first().waitFor({ timeout: 15000 });
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const program = (state.workspaces[createdEventId].program || []).find((item) => item.title === PROGRAM_TITLE);
      assert.ok(program, 'program missing from workspace.program');
      assert.equal(program.date, EVENT_DATE, 'blank program date must resolve to the event date');
      assert.equal(program.start, PROGRAM_START);
      assert.equal(program.end, PROGRAM_END);
      task.state = `workspace.program: title=${program.title} date=${program.date} start=${program.start} end=${program.end}`;
      await shotBoth('journey-program-added');
    });

    // ---- Task 3: publish a notice ----
    await measure('notice-publish', '공지 작성·게시', async (act, task) => {
      task.screens = [`/console/events/${createdEventId}/content (#content-notices)`];
      task.fields = ['#content-notice-title', '#content-notice-body', 'checkbox 게시함 (참가자 화면에 보임)', 'submit 만들기'];
      await go(`/console/events/${createdEventId}/content`, '#content-notices');
      await act(() => page.getByRole('button', { name: '공지 작성', exact: true }).click());
      await page.locator('#content-notice-title').waitFor({ state: 'visible', timeout: 10000 });
      await act(() => page.locator('#content-notice-title').fill(NOTICE_TITLE));
      await act(() => page.locator('#content-notice-body').fill(NOTICE_BODY));
      await act(() => page.getByRole('dialog').getByRole('checkbox', { name: /게시함/ }).check());
      await act(() => page.getByRole('dialog').getByRole('button', { name: '만들기', exact: true }).click());
      await page.getByRole('heading', { name: NOTICE_TITLE, exact: true }).first().waitFor({ timeout: 15000 });
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const notice = (state.workspaces[createdEventId].notices || []).find((item) => item.title === NOTICE_TITLE);
      assert.ok(notice, 'notice missing from workspace.notices');
      assert.equal(notice.published, true);
      task.state = `workspace.notices: title=${notice.title} published=${notice.published}`;
    });

    // ---- Task 4: registration consent publish ----
    let publishedBefore = null;
    await measure('intake-publish', '동의 안내 입력·양식 게시·접수 열기', async (act, task) => {
      task.screens = [`/console/events/${createdEventId}/settings (#settings-intake)`];
      task.fields = ['#set-name (readiness marker, not edited)', '#set-consent', 'button 양식 게시·접수 열기'];
      await go(`/console/events/${createdEventId}/settings`, '#set-name');
      await page.locator('#settings-intake').waitFor({ state: 'visible', timeout: 15000 });
      publishedBefore = (await readBootstrap(helpers, harness.baseUrl, ownerCookie))
        .workspaces[createdEventId].publishedVersion;
      await act(() => page.locator('#set-consent').fill(CONSENT_TEXT));
      await act(() => page.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click());
      await page.getByText('접수 중', { exact: false }).first().waitFor({ timeout: 15000 });
      const workspace = (await readBootstrap(helpers, harness.baseUrl, ownerCookie)).workspaces[createdEventId];
      assert.equal(workspace.registrationOpen, true);
      assert.ok(Number(workspace.publishedVersion) > Number(publishedBefore || 0),
        `publishedVersion must advance (was ${publishedBefore}, now ${workspace.publishedVersion})`);
      // Server truth per server/commands/preparation.js form.publish: the
      // command writes workspace.consentText, sets publishedVersion from
      // formVersion, and sets registrationOpen true. Assert those exact
      // fields, not an assumed shape.
      assert.equal(workspace.consentText, CONSENT_TEXT);
      task.state = `workspace: registrationOpen=${workspace.registrationOpen} publishedVersion=${publishedBefore}->${workspace.publishedVersion}`;
    });

    // ---- Task 5: close registration ----
    await measure('intake-close', '접수 닫기', async (act, task) => {
      task.screens = [`/console/events/${createdEventId}/settings (#settings-intake)`];
      task.fields = ['button 접수 닫기'];
      await go(`/console/events/${createdEventId}/settings`, '#settings-intake');
      await act(() => page.getByRole('button', { name: '접수 닫기', exact: true }).click());
      await page.getByText('접수 닫힘', { exact: false }).first().waitFor({ timeout: 15000 });
      const workspace = (await readBootstrap(helpers, harness.baseUrl, ownerCookie)).workspaces[createdEventId];
      assert.equal(workspace.registrationOpen, false);
      task.state = `workspace: registrationOpen=${workspace.registrationOpen} publishedVersion=${workspace.publishedVersion}`;
    });

    // ---- Setup for tasks 8-10 (real commands/helpers, NOT counted) ----
    // The fixture seed event is LIVE with an open IN desk, a DESK
    // assignment for the fixture staff, and the reward feature on. Staff
    // booth work additionally needs the stamp feature, an OPEN booth,
    // STAFF booth mode, and a BOOTH assignment for the same staff
    // account (server/commands/operations.js visitBooth/scanCheck).
    const staffSetup = [];
    await apiCommand(helpers, harness.baseUrl, ownerCookie, fixture.eventId, 'event.features', {
      features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp'],
    });
    staffSetup.push('event.features +stamp on fixture event');
    const journeyBooth = (await apiCommand(helpers, harness.baseUrl, ownerCookie, fixture.eventId, 'booth.save', {
      name: BOOTH_NAME, zone: '동문', status: 'OPEN', capacity: 100, limit: 1,
    })).booth;
    staffSetup.push(`booth.save ${journeyBooth.id}`);
    await apiCommand(helpers, harness.baseUrl, ownerCookie, fixture.eventId, 'booth.mode', {
      mode: 'STAFF', acknowledge: true,
    });
    staffSetup.push('booth.mode STAFF');
    await helpers.insertAssignment(harness.database, {
      id: `audit-boothassign-${suffix}`.toLowerCase(),
      accountId: fixture.staff.id, eventId: fixture.eventId, type: 'BOOTH', targetId: journeyBooth.id,
    });
    staffSetup.push(`BOOTH assignment ${fixture.staff.id}->${journeyBooth.id}`);
    let ticketPerson = null;
    {
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      ticketPerson = (state.workspaces[fixture.eventId].participants || [])
        .find((person) => person && person.status === 'APPROVED' && person.ticket && person.inside !== true);
      assert.ok(ticketPerson && ticketPerson.ticket,
        'BLOCKER: no APPROVED participant with a bootstrap ticket on the fixture event; cannot drive staff UI without fabricating a code');
      staffSetup.push(`ticket participant ${ticketPerson.id}`);
    }
    // reward.create needs only an APPROVED participant (server/commands/
    // content-results.js createReward -> READY); seeding it here keeps the
    // fulfil task UI-only. Seeded after the check-in precondition is known
    // so the same participant flows through check-in -> booth -> reward.
    const journeyReward = (await apiCommand(helpers, harness.baseUrl, ownerCookie, fixture.eventId, 'reward.create', {
      participantId: ticketPerson.id, method: 'ONSITE', name: REWARD_NAME,
    })).reward;
    assert.equal(journeyReward.status, 'READY');
    staffSetup.push(`reward.create ${journeyReward.id} READY`);

    // Role swap is setup, never counted: same context (keeps the
    // addInitScript scroll listener), session cookie replaced because
    // auth is same-origin cookie based. Restored to owner after task 9.
    const useCookie = async (cookie) => {
      await context.clearCookies();
      await context.addCookies([{
        name: 'etko_session', value: sessionValue(cookie),
        url: baseUrl, httpOnly: true, sameSite: 'Lax',
      }]);
    };
    await useCookie(fixture.staff.cookie);

    // ---- Task 8: staff manual desk check-in ----
    const commandsResponse = () => page.waitForResponse(
      (response) => response.url().includes('/commands') && response.request().method() === 'POST',
      { timeout: 15000 },
    );
    await measure('desk-checkin', '스태프 데스크 체크인 (수동 입장 처리)', async (act, task) => {
      task.screens = [`/staff/events/${fixture.eventId} (staff, 데스크 체크인)`];
      task.fields = ['#staff-desk', '#staff-ticket', 'submit 입장 처리'];
      await go(`/staff/events/${fixture.eventId}`, '#staff-desk');
      assert.equal(await page.locator('#staff-desk').inputValue(), '', 'desk must not be preselected (StaffEventWork defaults deskId "")');
      await act(() => page.locator('#staff-desk').selectOption(fixture.deskId));
      await act(() => page.locator('#staff-ticket').fill(ticketPerson.ticket));
      const submitted = commandsResponse();
      await act(() => page.locator('form.scan-form').getByRole('button', { name: '입장 처리', exact: true }).click());
      await submitted;
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const check = (state.workspaces[fixture.eventId].checks || [])
        .find((row) => row && String(row.participantId) === String(ticketPerson.id) && String(row.action).toUpperCase() === 'IN');
      assert.ok(check, 'IN check missing from workspace.checks');
      const person = (state.workspaces[fixture.eventId].participants || [])
        .find((row) => row && String(row.id) === String(ticketPerson.id));
      assert.equal(person.inside, true);
      task.state = `workspace.checks: participantId=${check.participantId} action=${check.action} deskId=${check.deskId}; inside=true`;
    });

    // ---- Task 9: staff booth certification in STAFF mode ----
    await measure('booth-visit', '스태프 부스 인증 (STAFF 모드, 티켓)', async (act, task) => {
      task.screens = [`/staff/events/${fixture.eventId} (staff, 부스 인증)`];
      task.fields = ['group 업무 종류 button 부스 인증', '#staff-booth', '#staff-ticket', 'submit 부스 인증'];
      // Fresh page load is setup (go resets state, no stale result to clear
      // inside the counted flow).
      await go(`/staff/events/${fixture.eventId}`, '#staff-desk');
      await act(() => page.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click());
      await page.locator('#staff-booth').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await page.locator('#staff-booth').inputValue(), '', 'booth must not be preselected (StaffEventWork defaults boothId "")');
      await act(() => page.locator('#staff-booth').selectOption(journeyBooth.id));
      await act(() => page.locator('#staff-ticket').fill(ticketPerson.ticket));
      const submitted = commandsResponse();
      await act(() => page.locator('form.scan-form').getByRole('button', { name: '부스 인증', exact: true }).click());
      await submitted;
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const visit = (state.workspaces[fixture.eventId].visits || [])
        .find((row) => row && String(row.boothId) === String(journeyBooth.id) && String(row.participantId) === String(ticketPerson.id));
      assert.ok(visit, 'visit missing from workspace.visits');
      task.state = `workspace.visits: boothId=${visit.boothId} participantId=${visit.participantId} mode=${visit.mode}`;
    });

    await useCookie(ownerCookie);

    // ---- Task 10: owner on-site reward fulfil ----
    await measure('reward-fulfill', '현장 경품 수령 처리 (owner)', async (act, task) => {
      task.screens = [`/console/events/${fixture.eventId}/rewards (#rewards-list)`];
      task.fields = ['button 수령 처리', 'group 실행 확인 button 처리한다'];
      await go(`/console/events/${fixture.eventId}/rewards`, '#rewards-list');
      const row = page.locator('ul[aria-label="경품 목록"] li').filter({ hasText: REWARD_NAME }).first();
      await row.getByRole('button', { name: '수령 처리', exact: true }).waitFor({ timeout: 10000 });
      await act(() => row.getByRole('button', { name: '수령 처리', exact: true }).click());
      await row.getByRole('group', { name: '실행 확인' }).waitFor({ timeout: 10000 });
      const submitted = commandsResponse();
      await act(() => row.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '처리한다', exact: true }).click());
      await submitted;
      await page.getByText('지급 처리했습니다.', { exact: true }).first().waitFor({ timeout: 15000 });
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const done = (state.workspaces[fixture.eventId].rewards || [])
        .find((row2) => row2 && String(row2.id) === String(journeyReward.id));
      assert.ok(done, 'reward missing from workspace.rewards');
      assert.equal(done.status, 'RECEIVED');
      task.state = `workspace.rewards: name=${done.name} participantId=${done.participantId} method=${done.method} status=${done.status}`;
    });

    // Setup for tasks 6-7 (real command, not counted): the ARCHIVED
    // precondition needs registration closed on the LIVE fixture event.
    // The fixture seed published the form, so close it directly.
    await apiCommand(helpers, harness.baseUrl, ownerCookie, fixture.eventId, 'form.close', {});
    {
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const seed = (state.events || []).find((item) => item.id === fixture.eventId);
      assert.ok(seed, 'fixture seed event missing from bootstrap');
      assert.equal(String(seed.stage).toUpperCase(), 'LIVE', 'task 6 needs the fixture event at LIVE');
      assert.equal(state.workspaces[fixture.eventId].registrationOpen, false, 'fixture registration must be closed before END/ARCHIVE');
    }

    // ---- Task 6: end the LIVE fixture event ----
    await measure('stage-end', '종료(으)로 전환 (LIVE -> ENDED)', async (act, task) => {
      task.screens = [`/console/events/${fixture.eventId}/settings (#settings-stage)`];
      task.fields = ['summary[data-settings-collapse-summary=stage]', 'button 종료(으)로 전환', 'group 단계 전환 확인 / button aria 정말 종료 단계로 전환합니다'];
      await go(`/console/events/${fixture.eventId}/settings`, '#settings-basics');
      await page.locator('summary[data-settings-collapse-summary="stage"]').waitFor({ state: 'visible', timeout: 15000 });
      await act(() => page.locator('summary[data-settings-collapse-summary="stage"]').click());
      await page.getByRole('button', { name: '종료(으)로 전환', exact: true }).waitFor({ timeout: 10000 });
      await act(() => page.getByRole('button', { name: '종료(으)로 전환', exact: true }).click());
      await page.getByRole('group', { name: '단계 전환 확인' }).waitFor({ timeout: 10000 });
      const endConfirm = page.getByRole('button', { name: '정말 종료 단계로 전환합니다', exact: true });
      await act(async () => ((await endConfirm.count() ? endConfirm : page.getByRole('group', { name: '단계 전환 확인' }).getByRole('button', { name: '정말 전환합니다', exact: true })).click()));
      await page.getByText(/종료\(으\)로 전환했습니다/, { exact: false }).first().waitFor({ timeout: 15000 });
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const stage = String((state.events || []).find((item) => item.id === fixture.eventId).stage).toUpperCase();
      assert.equal(stage, 'ENDED');
      task.state = `events: id=${fixture.eventId} stage=${stage}`;
      task.serverNote = 'fixture LIVE event, no program modules; registration closed via real form.close setup';
      await shotBoth('journey-stage-ended');
    });

    // ---- Task 7: archive next, registration already closed ----
    await measure('stage-archive', '보관(으)로 전환 (ENDED -> ARCHIVED)', async (act, task) => {
      task.screens = [`/console/events/${fixture.eventId}/settings (#settings-stage)`];
      task.fields = ['summary[data-settings-collapse-summary=stage] (only when collapsed)', 'button 보관(으)로 전환', 'group 단계 전환 확인 / button aria 정말 보관 단계로 전환합니다'];
      await go(`/console/events/${fixture.eventId}/settings`, '#settings-basics');
      await page.locator('summary[data-settings-collapse-summary="stage"]').waitFor({ state: 'visible', timeout: 15000 });
      const open = await page.locator('details[data-settings-collapse="stage"]').evaluate((el) => el.open).catch(() => false);
      if (!open) {
        await act(() => page.locator('summary[data-settings-collapse-summary="stage"]').click());
        task.serverNote = 'details were collapsed after reload; expansion counted as 1 step. ';
      } else {
        task.serverNote = 'details stayed expanded after reload; no expansion step needed. ';
      }
      await page.getByRole('button', { name: '보관(으)로 전환', exact: true }).waitFor({ timeout: 10000 });
      await act(() => page.getByRole('button', { name: '보관(으)로 전환', exact: true }).click());
      await page.getByRole('group', { name: '단계 전환 확인' }).waitFor({ timeout: 10000 });
      const archiveConfirm = page.getByRole('button', { name: '정말 보관 단계로 전환합니다', exact: true });
      await act(async () => ((await archiveConfirm.count() ? archiveConfirm : page.getByRole('group', { name: '단계 전환 확인' }).getByRole('button', { name: '정말 전환합니다', exact: true })).click()));
      await page.getByText(/보관\(으\)로 전환했습니다/, { exact: false }).first().waitFor({ timeout: 15000 });
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const seed = (state.events || []).find((item) => item.id === fixture.eventId);
      assert.equal(String(seed.stage).toUpperCase(), 'ARCHIVED');
      task.serverNote += `registration stayed closed (${state.workspaces[fixture.eventId].registrationOpen}); precondition held.`;
      task.state = `events: id=${fixture.eventId} stage=${seed.stage}`;
      await shotBoth('journey-stage-archived');
    });

    if (errors.length) throw new Error(`browser errors: ${errors.join(' | ').slice(0, 500)}`);
    const report = {
      before, build: buildId(),
      fixture: 'isolated random schema; client seeded via real REST; staff booth/mode/reward via real owner commands, BOOTH assignment via scoped fixture helper; role swaps via same-context cookie replace; all counted steps are real UI ops verified by bootstrap re-read',
      setupNotMetrics: staffSetup,
      clientSeed, createdEventId, createdEventName,
      journeyBoothId: journeyBooth.id, journeyRewardId: journeyReward.id,
      ticketParticipantId: ticketPerson.id,
      results, errors,
    };
    fs.writeFileSync(path.join(out, 'journey-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(results.map((task) => ({
      key: task.key, steps: task.steps, scrolls: task.scrolls, writes: task.writes,
      screens: task.screens, fields: task.fields, state: task.state,
    })), null, 2));
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
