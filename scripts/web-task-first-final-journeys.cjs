'use strict';

// Task-first final journeys: the three workflow connections.
//
// Boots the same isolated shape as the other web audits: a random
// PostgreSQL schema, a real API harness, an owned Next server bound to
// that harness, and a same-origin gateway. No mocked API, no protected
// data, no shared/production database.
//
// Step rule: each click/fill/select/check is 1 step. page.goto navigation
// and readiness waits are setup and never counted. Role cookie swaps and
// all seeding are setup and never counted; every counted step is an actual
// UI operation verified against the bootstrap.
//
// Tasks (owner unless noted):
//   1. event-client-inline  create an event, registering the missing
//                           customer in-dialog (name/contact/email) with the
//                           first committed customer response lost on the
//                           wire: the retry replays the same receipt, then
//                           returns to the event draft unchanged with the
//                           new customer selected; the created event keeps
//                           that customer and no duplicate customer exists.
//   2. invite-manager-event MANAGER invite scoped to the task-1 event:
//                           accept in a fresh session, follow the role-aware
//                           login link, sign in, land on the assigned event.
//   3. invite-staff-hub     STAFF invite (no event by server rule; a
//                           scoped STAFF request must fail 400 first):
//                           accept, follow the hub link, sign in, land on
//                           /staff with no fabricated event assignment.
//   4. report-archive-bridge create a frozen report while intake is open
//                           and one program is OPEN: the detail shows the
//                           exact live remainders beside the next action and
//                           links to settings#settings-stage without firing
//                           any transition command.
//   5. team-staff-assignment owner picks the accepted STAFF member on the
//                           team screen, chooses the task-1 event, follows
//                           the operations assignment link, and assigns the
//                           offered staff to a desk explicitly.
//
// Usage (after a product build; the fixture audits the committed build):
//   npm run build
//   EVENTOUCH_A11Y_DATABASE_URL='postgres://user:pass@127.0.0.1:5432/db' \
//     node scripts/web-task-first-final-journeys.cjs
//
// Captures and results land in /tmp/opencode/eventouch-captures/task-first-final/.
// Set CAPTURE_DIR to redirect an isolated rerun elsewhere (existing
// evidence stays untouched); the default keeps the committed location.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const out = (process.env.CAPTURE_DIR || '').trim() || '/tmp/opencode/eventouch-captures/task-first-final';
fs.mkdirSync(out, { recursive: true });

const STEP_CAP = 12;
const EVENT_DATE = '2027-05-20';
const INVITE_PASSWORD = 'Final2026!journey';
const MODULE_TITLE = '최종 여정 투표';

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
    // The first committed in-dialog customer response is lost on the wire:
    // the UI must retry the stored receipt instead of minting a second
    // record. The fault fires once, on the first browser POST /api/clients.
    fixture = await startAuditFixture({ loseFirstResponseFor: 'client.save' });
    const { harness, helpers } = fixture;
    const baseUrl = fixture.baseUrl;
    const { suffix } = fixture;

    const ownerId = `audit-owner-${suffix}`;
    const ownerCookie = await helpers.sessionCookie(harness, ownerId);

    browser = await launchBrowser();
    const context = await browser.newContext();
    await context.addCookies([{
      name: 'etko_session', value: sessionValue(ownerCookie),
      url: baseUrl, httpOnly: true, sameSite: 'Lax',
    }]);
    const page = await context.newPage();
    // Anonymous windows (fresh invitee sessions with the cookie jar cleared)
    // legitimately answer the login form's session probe with 401: the form
    // stays put by design (LoginForm: `if (!res.ok) return;`). Only 401s on
    // exactly /api/auth/me inside such a window are expected; every other
    // status, path, or an authenticated 401 below stays a real error.
    let anonymousWindow = false;
    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${String((error && error.message) || error).split('\n')[0]}`);
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      if (!url.startsWith(baseUrl)) return;
      const pathname = url.split('?')[0].slice(url.indexOf('/', 8));
      if (anonymousWindow && status === 401 && pathname === '/api/auth/me') return;
      if (url.includes('/api/') || response.request().resourceType() === 'document') {
        errors.push(`http ${status}: ${pathname}`);
      }
    });

    const go = async (target, marker) => {
      await page.goto(baseUrl + target, { waitUntil: 'networkidle', timeout: 30000 });
      await page.locator(marker).first().waitFor({ state: 'visible', timeout: 15000 });
    };
    const shot = async (name) => {
      // Full-page captures should anchor sticky chrome at the real page top,
      // not bake the last focused element's scroll offset into the image.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      fs.mkdirSync(path.join(out, 'after'), { recursive: true });
      await page.screenshot({ path: path.join(out, 'after', `${name}.png`), fullPage: true });
    };
    const shotBoth = async (name) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await shot(`${name}-1280`);
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(`${name}-390`);
      await page.setViewportSize({ width: 1280, height: 900 });
    };
    const useCookie = async (cookie) => {
      anonymousWindow = !cookie;
      await context.clearCookies();
      if (!cookie) return;
      await context.addCookies([{
        name: 'etko_session', value: sessionValue(cookie),
        url: baseUrl, httpOnly: true, sameSite: 'Lax',
      }]);
    };
    // A signed-in session exists from here on: any further /api/auth/me
    // 401 would be real again, so the anonymous window closes.
    const signedIn = () => { anonymousWindow = false; };

    const measure = async (key, title, fn) => {
      const task = {
        key, title, actor: 'owner', stepCap: STEP_CAP,
        steps: 0, scrolls: null, writes: 0,
        scrollNote: '이 추가 연결 검사는 스크롤 수를 계측하지 않음. 기존 usability 및 task-flow 여정의 스크롤 검사는 유지.',
        screens: [], fields: [], state: null, serverNote: '',
        passed: false, errors: [],
      };
      const onRequest = (request) => {
        if (request.method() === 'POST' && request.url().includes('/api/')) task.writes += 1;
      };
      page.on('request', onRequest);
      const act = async (fn2) => { task.steps += 1; await fn2(); };
      try {
        await fn(act, task);
        assert.ok(task.steps <= STEP_CAP, `${key}: ${task.steps} steps exceed cap ${STEP_CAP}`);
        task.passed = true;
      } catch (error) {
        task.errors.push(String((error && error.message) || error).split('\n')[0]);
        throw error;
      } finally {
        page.off('request', onRequest);
        results.push(task);
      }
      return task;
    };

    await page.setViewportSize({ width: 1280, height: 900 });
    const createdEventName = `최종 여정 행사 ${suffix.slice(0, 6)}`;
    const inlineClientName = `최종 여정 고객사 ${suffix.slice(0, 6)}`;
    const inlineClientEmail = `final-client-${suffix.slice(0, 8).toLowerCase()}@example.com`;
    let createdEventId = null;
    let inlineClientId = null;

    // ---- Task 1: event creation with in-dialog customer registration ----
    await measure('event-client-inline', '행사 만들기 + 대화상자 안에서 고객사 등록 (응답 유실 재시도)', async (act, task) => {
      task.screens = ['/console (#console-event-directory)', '새 행사 만들기 dialog (customer subview)', '/console/events/:id overview (#event-metrics-heading)'];
      task.fields = ['#create-name', 'button 새 고객사 등록', '#create-new-client-name/contact/email', 'submit 고객사 등록 → 같은 요청 다시 시도', '#create-client', '#create-date', 'submit 행사 만들기'];
      await go('/console', '#console-event-directory');
      await act(() => page.getByRole('button', { name: '새 행사 만들기', exact: true }).click());
      await page.locator('#create-name').waitFor({ state: 'visible', timeout: 10000 });
      await act(() => page.locator('#create-name').fill(createdEventName));
      await act(() => page.locator('#create-date').fill(EVENT_DATE));
      const draftFields = ['#create-name', '#create-slug', '#create-client', '#create-date', '#create-start', '#create-end', '#create-capacity'];
      const draftValues = await Promise.all(draftFields.map(field => page.locator(field).inputValue()));
      await act(() => page.getByRole('button', { name: '새 고객사 등록', exact: true }).click());
      await page.locator('#create-new-client-name').waitFor({ state: 'visible', timeout: 10000 });
      await shotBoth('final-event-client-subview');
      await act(() => page.locator('#create-new-client-name').fill(inlineClientName));
      await act(() => page.locator('#create-new-client-contact').fill('최종 담당'));
      await act(() => page.locator('#create-new-client-email').fill(inlineClientEmail));
      await act(() => page.getByRole('dialog').getByRole('button', { name: '고객사 등록', exact: true }).click());
      // The committed first response never arrives: the dialog must offer
      // the same-request retry instead of claiming a cancel or a failure.
      await fixture.gateway.waitForResponseLoss('client.save');
      await page.getByText('연결하지 못했습니다. 같은 요청으로 다시 시도하세요.', { exact: true }).waitFor({ timeout: 15000 });
      await act(() => page.getByRole('dialog').getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click());
      // Back on the event form: the draft is untouched, the new customer is
      // registered and selected.
      await page.locator('#create-client').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await page.locator('#create-name').inputValue(), createdEventName, 'event draft must survive the customer subview');
      for (let index = 0; index < draftFields.length; index += 1) {
        if (draftFields[index] === '#create-client') continue; // intentionally selects the newly registered client
        assert.equal(await page.locator(draftFields[index]).inputValue(), draftValues[index], `${draftFields[index]} draft is retained`);
      }
      await page.getByText(`${inlineClientName} 고객사를 등록하고 선택했습니다.`, { exact: true }).waitFor({ timeout: 10000 });
      const selectedClientId = await page.locator('#create-client').inputValue();
      assert.ok(selectedClientId, 'new customer must be selected after registration');
      await act(() => page.getByRole('dialog').getByRole('button', { name: '행사 만들기', exact: true }).click());
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
      const matchingClients = (state.clients || []).filter((item) => item && item.name === inlineClientName);
      assert.equal(matchingClients.length, 1, `exactly one customer record expected, found ${matchingClients.length}`);
      inlineClientId = String(matchingClients[0].id);
      assert.equal(selectedClientId, inlineClientId, 'dialog selection must be the registered record');
      assert.equal(created.clientId || null, inlineClientId);
      task.state = `events: id=${createdEventId} clientId=${created.clientId}; clients named ${matchingClients.length}x`;
      task.serverNote = 'first customer POST committed but response lost on the wire; same-receipt retry replayed the record (no duplicate); event via dialog POST /api/events';
      await shot('final-event-client-inline');
    });
    assert.ok(createdEventId && inlineClientId, 'task 1 must produce an event and a customer');

    // ---- Task 2: MANAGER invite scoped to the new event ----
    const managerEmail = `final-manager-${suffix.slice(0, 8).toLowerCase()}@example.com`;
    let managerToken = null;
    {
      const response = await helpers.requestJson(harness.baseUrl, '/api/auth/invitations', {
        cookie: ownerCookie, method: 'POST',
        body: { commandId: crypto.randomUUID(), name: '최종 운영자', email: managerEmail, role: 'MANAGER', eventId: createdEventId },
      });
      assert.equal(response.status, 201, `manager invite failed: ${response.status} ${JSON.stringify(response.json)}`);
      assert.equal(response.json.invitation.eventId, createdEventId);
      managerToken = String(response.json.token || '');
      assert.ok(managerToken, 'manager invite returned no token');
    }
    await measure('invite-manager-event', '초대 수락 → 담당 행사로 로그인 (MANAGER)', async (act, task) => {
      task.actor = 'invitee';
      task.screens = [`/invite/<token> (public)`, `/login?next=/console/events/${createdEventId}`, `/console/events/${createdEventId} overview`];
      task.fields = ['#invite-password', '#invite-confirm', 'submit 초대 수락', 'link 로그인으로', '#login-email', '#login-password', 'submit 로그인'];
      await useCookie(null);
      await go(`/invite/${managerToken}`, 'text=팀 초대 수락');
      await page.getByText('수락 후 로그인하면 담당 행사로 이동합니다.', { exact: true }).waitFor({ timeout: 10000 });
      await shotBoth('invite-normal');
      await act(() => page.locator('#invite-password').fill(INVITE_PASSWORD));
      await act(() => page.locator('#invite-confirm').fill(INVITE_PASSWORD));
      await act(() => page.getByRole('button', { name: '초대 수락', exact: true }).click());
      await page.getByRole('heading', { name: '초대를 수락했습니다', exact: true }).waitFor({ timeout: 15000 });
      const loginHref = await page.getByRole('link', { name: '로그인으로', exact: true }).getAttribute('href');
      assert.ok(loginHref && loginHref.includes(`next=${encodeURIComponent(`/console/events/${createdEventId}`)}`),
        `manager login link must carry the event next, got ${loginHref}`);
      await shotBoth('invite-accepted');
      await act(() => page.getByRole('link', { name: '로그인으로', exact: true }).click());
      await page.locator('#login-email').waitFor({ state: 'visible', timeout: 15000 });
      await act(() => page.locator('#login-email').fill(managerEmail));
      await act(() => page.locator('#login-password').fill(INVITE_PASSWORD));
      await act(() => page.getByRole('button', { name: '로그인', exact: true }).click());
      await page.waitForURL(new RegExp(`/console/events/${createdEventId}`), { timeout: 15000 });
      signedIn();
      await page.locator('#event-metrics-heading').first().waitFor({ state: 'visible', timeout: 15000 });
      const login = await helpers.requestJson(harness.baseUrl, '/api/auth/login', {
        method: 'POST', body: { email: managerEmail, password: INVITE_PASSWORD },
      });
      assert.equal(login.status, 200);
      const managerId = String(login.json.user && login.json.user.id || '');
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const membership = (state.memberships || []).find((row) => row && row.accountId === managerId && row.eventId === createdEventId);
      assert.ok(membership, 'manager membership for the invited event missing from bootstrap');
      task.state = `memberships: accountId=${managerId} eventId=${createdEventId}`;
      task.serverNote = 'invite created with eventId via POST /api/auth/invitations; accept + login through the UI';
      await shot('final-invite-manager');
    });

    // ---- Task 3: STAFF invite lands on the assignment hub, no event ----
    const staffEmail = `final-staff-${suffix.slice(0, 8).toLowerCase()}@example.com`;
    let staffToken = null;
    {
      // A scoped STAFF request must fail first: assignments are never
      // fabricated at invite time.
      const scoped = await helpers.requestJson(harness.baseUrl, '/api/auth/invitations', {
        cookie: ownerCookie, method: 'POST',
        body: { commandId: crypto.randomUUID(), name: '최종 스태프', email: `scoped-${staffEmail}`, role: 'STAFF', eventId: createdEventId },
      });
      assert.equal(scoped.status, 400, `scoped STAFF invite must fail, got ${scoped.status}`);
      assert.match(String(scoped.json.error || ''), /수락 후 데스크·부스 배정으로 연결합니다/);
      const response = await helpers.requestJson(harness.baseUrl, '/api/auth/invitations', {
        cookie: ownerCookie, method: 'POST',
        body: { commandId: crypto.randomUUID(), name: '최종 스태프', email: staffEmail, role: 'STAFF' },
      });
      assert.equal(response.status, 201, `staff invite failed: ${response.status} ${JSON.stringify(response.json)}`);
      assert.equal(response.json.invitation.eventId, null);
      staffToken = String(response.json.token || '');
      assert.ok(staffToken, 'staff invite returned no token');
    }
    await measure('invite-staff-hub', '초대 수락 → 현장 허브로 로그인 (STAFF)', async (act, task) => {
      task.actor = 'invitee';
      task.screens = ['/invite/<token> (public)', '/login?next=/staff', '/staff hub (내 업무)'];
      task.fields = ['#invite-password', '#invite-confirm', 'submit 초대 수락', 'link 로그인으로', '#login-email', '#login-password', 'submit 로그인'];
      await useCookie(null);
      await go(`/invite/${staffToken}`, 'text=팀 초대 수락');
      // Current STAFF hint (no placement promise): the hub lists
      // operator-assigned work, waiting when nothing is assigned yet.
      await page.getByText('운영자가 배정한 업무 목록으로 이동합니다.', { exact: false }).first().waitFor({ timeout: 10000 });
      await act(() => page.locator('#invite-password').fill(INVITE_PASSWORD));
      await act(() => page.locator('#invite-confirm').fill(INVITE_PASSWORD));
      await act(() => page.getByRole('button', { name: '초대 수락', exact: true }).click());
      await page.getByRole('heading', { name: '초대를 수락했습니다', exact: true }).waitFor({ timeout: 15000 });
      const loginHref = await page.getByRole('link', { name: '로그인으로', exact: true }).getAttribute('href');
      assert.ok(loginHref && loginHref.includes(`next=${encodeURIComponent('/staff')}`),
        `staff login link must carry the hub next, got ${loginHref}`);
      await shotBoth('invite-staff-accepted');
      await act(() => page.getByRole('link', { name: '로그인으로', exact: true }).click());
      await page.locator('#login-email').waitFor({ state: 'visible', timeout: 15000 });
      await act(() => page.locator('#login-email').fill(staffEmail));
      await act(() => page.locator('#login-password').fill(INVITE_PASSWORD));
      await act(() => page.getByRole('button', { name: '로그인', exact: true }).click());
      await page.waitForURL(/\/staff\/?$/, { timeout: 15000 });
      signedIn();
      await page.locator('text=내 업무').first().waitFor({ state: 'visible', timeout: 15000 });
      const login = await helpers.requestJson(harness.baseUrl, '/api/auth/login', {
        method: 'POST', body: { email: staffEmail, password: INVITE_PASSWORD },
      });
      assert.equal(login.status, 200);
      const staffId = String(login.json.user && login.json.user.id || '');
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const assigned = (state.memberships || []).filter((row) => row && row.accountId === staffId);
      assert.equal(assigned.length, 0, `no event assignment may be fabricated for STAFF, found ${JSON.stringify(assigned)}`);
      task.state = `account ${staffId} has no memberships; hub reachable`;
      task.serverNote = 'scoped STAFF invite rejected 400 first; unscoped invite carries eventId null';
      await shot('final-invite-staff');
    });

    // ---- Task 4: frozen report with the live archive checklist ----
    await apiCommand(helpers, harness.baseUrl, ownerCookie, createdEventId, 'form.publish', {});
    await apiCommand(helpers, harness.baseUrl, ownerCookie, createdEventId, 'event.features', { features: ['poll'] });
    const journeyModule = (await apiCommand(helpers, harness.baseUrl, ownerCookie, createdEventId, 'module.save', {
      type: 'poll', title: MODULE_TITLE, options: ['선택지 가', '선택지 나'],
    })).module;
    await apiCommand(helpers, harness.baseUrl, ownerCookie, createdEventId, 'module.status', {
      id: journeyModule.id, status: 'OPEN',
    });
    const reportTitle = `최종 여정 보고서 ${suffix.slice(0, 6)}`;
    await measure('report-archive-bridge', '동결 보고서 → 보관 전제 확인 → 설정 단계 앵커', async (act, task) => {
      task.actor = 'owner';
      task.screens = [`/console/events/${createdEventId}/reports (#reports-list)`, 'report detail (frozen article + live checklist)', `/console/events/${createdEventId}/settings#settings-stage`];
      task.fields = ['button 보고서 만들기', '#report-title', 'button 내용 보기', 'link 진행 단계에서 확인·전환'];
      await useCookie(ownerCookie);
      await go(`/console/events/${createdEventId}/reports`, '#reports-list');
      await act(() => page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click());
      await page.locator('#report-title').waitFor({ state: 'visible', timeout: 10000 });
      await act(() => page.locator('#report-title').fill(reportTitle));
      await act(() => page.getByRole('dialog').getByRole('button', { name: '보고서 만들기', exact: true }).click());
      const row = page.locator('ul li').filter({ hasText: reportTitle }).first();
      await row.getByRole('button', { name: '내용 보기', exact: true }).waitFor({ timeout: 15000 });
      await act(() => row.getByRole('button', { name: '내용 보기', exact: true }).click());
      await page.getByText('보관 전제 · 조회 시점', { exact: false }).first().waitFor({ timeout: 10000 });
      await page.getByText('생성 시점 그대로 유지', { exact: false }).first().waitFor({ timeout: 10000 });
      await page.getByText('참가 접수 열림', { exact: false }).first().waitFor({ timeout: 10000 });
      await page.getByText(MODULE_TITLE, { exact: false }).first().waitFor({ timeout: 10000 });
      await shotBoth('final-report-archive-checklist');
      // Each checklist item owns its link (the old context-losing single
      // link is gone): the stage row offers 진행 단계에서 확인·전환.
      const settingsHref = await page.getByRole('link', { name: '진행 단계에서 확인·전환', exact: true }).getAttribute('href');
      assert.ok(settingsHref && settingsHref.endsWith(`/console/events/${createdEventId}/settings#settings-stage`),
        `archive link must land on the settings stage anchor, got ${settingsHref}`);
      let commandFired = false;
      const watch = (request) => {
        if (request.method() === 'POST' && request.url().includes('/commands')) commandFired = true;
      };
      page.on('request', watch);
      await act(() => page.getByRole('link', { name: '진행 단계에서 확인·전환', exact: true }).click());
      await page.waitForURL(/\/settings#settings-stage/, { timeout: 15000 });
      page.off('request', watch);
      await page.locator('#settings-stage').first().waitFor({ state: 'visible', timeout: 15000 });
      await page.getByRole('heading', { name: '진행 단계', exact: true }).waitFor({ timeout: 10000 });
      assert.equal(commandFired, false, 'following the archive link must not fire a transition command');
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const report = (state.workspaces[createdEventId].reports || []).find((item) => item && item.title === reportTitle);
      assert.ok(report && report.snapshot, 'frozen report with snapshot missing from workspace.reports');
      assert.equal(state.workspaces[createdEventId].registrationOpen, true);
      const openModule = (state.workspaces[createdEventId].modules || []).find((item) => item && item.id === journeyModule.id);
      assert.equal(openModule && openModule.status, 'OPEN');
      task.state = `reports: title=${report.title} snapshot captured; registrationOpen=true; module ${MODULE_TITLE} OPEN`;
      task.serverNote = 'intake + OPEN module seeded via real commands; link navigation fired no command';
      await shot('final-report-archive-bridge');
    });

    // ---- Task 5: team accepted-staff row -> event -> operations assignment --
    const journeyDesk = (await apiCommand(helpers, harness.baseUrl, ownerCookie, createdEventId, 'desk.save', {
      name: '최종 안내 데스크', action: 'IN',
    })).desk;
    const staffLogin = await helpers.requestJson(harness.baseUrl, '/api/auth/login', {
      method: 'POST', body: { email: staffEmail, password: INVITE_PASSWORD },
    });
    assert.equal(staffLogin.status, 200);
    const journeyStaffId = String(staffLogin.json.user && staffLogin.json.user.id || '');
    assert.ok(journeyStaffId, 'staff account id missing');
    await measure('team-staff-assignment', '팀 수락 구성원 → 행사 선택 → 현장 배정 (owner)', async (act, task) => {
      task.actor = 'owner';
      task.screens = ['/console/team (#team-members)', `/console/events/${createdEventId}/operations?assignAccount=<staff> (#ops-staff)`, '스태프 배정 dialog (#assign-account, 자동 선택)'];
      task.fields = ['button 행사 배정', 'select 최종 스태프 배정 행사 선택', 'link 스태프 배정으로 이동', '#assign-account', '#assign-target', 'submit 배정 저장'];
      await useCookie(ownerCookie);
      await go('/console/team', '#team-members');
      const row = page.locator('ul[aria-label="구성원 목록"] li').filter({ hasText: '최종 스태프' }).first();
      await row.getByRole('button', { name: '행사 배정', exact: true }).waitFor({ timeout: 10000 });
      await act(() => row.getByRole('button', { name: '행사 배정', exact: true }).click());
      const picker = row.locator('select[aria-label="최종 스태프 배정 행사 선택"]');
      await picker.waitFor({ state: 'visible', timeout: 10000 });
      await shotBoth('final-team-assign-panel');
      // The fixture holds several events, so no preselect may be assumed.
      assert.equal(await picker.inputValue(), '', 'event picker must not preselect with several events');
      await act(() => picker.selectOption(createdEventId));
      // The link hands the person off as a query before the staff anchor.
      const expectedHandoff = `/console/events/${createdEventId}/operations?assignAccount=${journeyStaffId}#ops-staff`;
      const opsHref = await row.getByRole('link', { name: '스태프 배정으로 이동', exact: false }).getAttribute('href');
      assert.equal(opsHref, expectedHandoff, `assignment link must hand off staff ${journeyStaffId}, got ${opsHref}`);
      await act(() => row.getByRole('link', { name: '스태프 배정으로 이동', exact: false }).click());
      // The handoff query is ephemeral (consumed on load), so arrival is
      // pinned on pathname + anchor only, never on the transient query.
      await page.waitForURL((url) => {
        const parsed = new URL(url);
        return parsed.pathname.endsWith(`/console/events/${createdEventId}/operations`) && parsed.hash === '#ops-staff';
      }, { timeout: 15000 });
      // The handoff auto-opens the existing dialog with the person already
      // chosen: no generic open click, no person reselect.
      await page.locator('#assign-account').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await page.locator('#assign-account').inputValue(), journeyStaffId, 'handoff must preselect the staff account');
      assert.equal(new URL(page.url()).searchParams.get('assignAccount'), null, 'ephemeral handoff query must be consumed');
      // A lone desk may arrive preselected (existing behavior); only choose
      // when the dialog leaves the target empty.
      if (!await page.locator('#assign-target').inputValue()) {
        await act(() => page.locator('#assign-target').selectOption(journeyDesk.id));
      }
      await act(() => page.getByRole('dialog').getByRole('button', { name: '배정 저장', exact: true }).click());
      await page.getByText('스태프를 배정했습니다.', { exact: true }).first().waitFor({ timeout: 15000 });
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const assignment = (state.workspaces[createdEventId].assignments || [])
        .find((item) => item && String(item.accountId) === journeyStaffId && String(item.type) === 'DESK');
      assert.ok(assignment, 'DESK assignment for the accepted staff missing from workspace.assignments');
      assert.equal(String(assignment.targetId), String(journeyDesk.id));
      task.state = `workspace.assignments: accountId=${assignment.accountId} type=${assignment.type} targetId=${assignment.targetId}`;
      task.serverNote = 'desk seeded via real desk.save; assignment via the handoff-opened operations dialog staff.assign, target chosen explicitly';
      await shot('final-team-staff-assignment');
    });

    await measure('client-after-event-discard', '고객사 등록 후 행사 초안 취소 → 재진입 시 등록값 재사용', async (act, task) => {
      const clientName = `취소 복귀 고객사 ${suffix.slice(0, 6)}`;
      await go('/console', '#console-event-directory');
      await act(() => page.getByRole('button', { name: '새 행사 만들기', exact: true }).click());
      await act(() => page.getByRole('button', { name: '새 고객사 등록', exact: true }).click());
      await act(() => page.locator('#create-new-client-name').fill(clientName));
      await act(() => page.getByRole('dialog').getByRole('button', { name: '고객사 등록', exact: true }).click());
      await page.locator('#create-client').waitFor();
      const clientId = await page.locator('#create-client').inputValue();
      assert.ok(clientId, 'registered customer selected before explicit discard');
      page.once('dialog', dialog => { task.steps += 1; return dialog.accept(); });
      await act(() => page.keyboard.press('Escape'));
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await act(() => page.getByRole('button', { name: '새 행사 만들기', exact: true }).click());
      assert.equal(await page.locator(`#create-client option[value="${clientId}"]`).textContent(), clientName);
      assert.equal(await page.locator('#create-name').inputValue(), '', 'explicitly discarded event draft is not restored');
      await act(() => page.locator('#create-client').selectOption(clientId));
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      assert.equal((state.clients || []).filter(item => item.name === clientName).length, 1);
      task.state = 'committed customer remains in directory options; event draft discarded explicitly; duplicate customer 0';
      await shotBoth('final-client-after-event-discard');
      page.once('dialog', dialog => { task.steps += 1; return dialog.accept(); });
      await act(() => page.keyboard.press('Escape'));
    });

    if (errors.length) throw new Error(`browser errors: ${errors.join(' | ').slice(0, 500)}`);
    const report = {
      build: buildId(),
      fixture: 'isolated random schema; customer/event/report via real UI (first customer response lost, same-receipt retry); invites via real REST + UI accept + UI login; intake/module/desk via real commands (setup); assignment via team link + operations dialog; all counted steps are real UI ops verified by bootstrap re-read',
      createdEventId, inlineClientId,
      results, errors,
    };
    fs.writeFileSync(path.join(out, 'journey-final-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(results.map((task) => ({
      key: task.key, steps: task.steps, writes: task.writes,
      screens: task.screens, fields: task.fields, state: task.state,
    })), null, 2));
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
