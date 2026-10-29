'use strict';
// Two real tabs share one multi-org session. Every state change is scoped to
// this disposable task-DB schema; only transport loss/503 are simulated.
process.env.EVENTOUCH_SMS_MOCK = '1';
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const captureRoot = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`system-improvement-20261024/ux-${runStamp()}`);
const runId = process.env.EVENTOUCH_AUDIT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(captureRoot, `organizations-${runId}`);

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const f = await startAuditFixture({ loseFirstResponseFor: ['attendee.page.save'] });
  const checks = [], requests = [], errors = [], axe = [], routeFailures = [];
  let browser, finished = false;
  const check = (name, ok, details = null) => { checks.push({ name, ok: Boolean(ok), details }); assert.ok(ok, `${name}: ${JSON.stringify(details)}`); };
  const committedResponse = async (route, stage) => {
    try {
      const actual = await route.fetch();
      if (actual.ok()) return actual;
      const body = await actual.text();
      routeFailures.push({ stage, status: actual.status(), body });
      await route.fulfill({ response: actual, body });
    } catch (error) {
      routeFailures.push({ stage, status: 0, error: error.message });
      await route.abort('failed').catch(() => {});
    }
    return null;
  };
  const api = (cookie, url, options = {}) => f.helpers.requestJson(f.harness.baseUrl, url, { cookie, ...options });
  const me = async (cookie) => (await api(cookie, '/api/auth/me')).json.user;
  const headersFor = (user) => ({ 'x-eventouch-organization-id': user.organizationId, 'x-eventouch-context-version': String(user.contextVersion) });
  const write = async (cookie, url, body) => api(cookie, url, { method: 'POST', headers: headersFor(await me(cookie)), body });
  const cmd = async (cookie, eventId, command, payload) => {
    const response = await write(cookie, `/api/events/${eventId}/commands`, { commandId: crypto.randomUUID(), command, payload });
    assert.ok(response.status < 300, `${command}: ${JSON.stringify(response.json)}`);
    return response.json;
  };
  const ownerId = `audit-owner-${f.suffix}`;
  try {
    // Synthetic A keeps the explicitly assigned legacy fixture organization.
    await f.harness.database.query('UPDATE organizations SET name=$2 WHERE id=$1', [f.helpers.LEGACY_ORG, '검증 운영사 A']);
    const ownerCookie = await f.helpers.sessionCookie(f.harness, ownerId);
    const a = await me(ownerCookie);
    const createdB = await write(ownerCookie, '/api/auth/organizations', { name: '검증 운영사 B', commandId: crypto.randomUUID() });
    assert.ok(createdB.status < 300, JSON.stringify(createdB.json));
    const bOrg = createdB.json.organization.id;
    // Global account is still AGENCY; B membership is STAFF. This intentionally
    // tests that global role cannot leak into the selected-org UI or writes.
    await f.harness.database.query(`UPDATE organization_memberships SET role='STAFF' WHERE org_id=$1 AND account_id=$2`, [bOrg, ownerId]);
    const bOwnerId = `ux-b-owner-${f.suffix}`;
    await f.helpers.insertAccount(f.harness.database, { orgId: bOrg, id: bOwnerId, role: 'AGENCY', name: 'B 운영 담당자', email: `${bOwnerId}@example.test` });
    const bCookie = await f.helpers.sessionCookie(f.harness, bOwnerId);
    const bEvent = `ux-b-event-${f.suffix}`;
    await f.helpers.insertEvent(f.harness.database, { orgId: bOrg, id: bEvent, slug: bEvent, payload: { id: bEvent, slug: bEvent, name: 'B 현장 행사', stage: 'LIVE', features: ['reward'] }, workspace: f.helpers.emptyWorkspace() });
    const bDesk = (await cmd(bCookie, bEvent, 'desk.save', { name: 'B 입장 데스크', action: 'IN', mode: 'desk', open: true })).desk;
    await f.helpers.insertAssignment(f.harness.database, { id: `ux-b-assignment-${f.suffix}`, accountId: ownerId, eventId: bEvent, type: 'DESK', targetId: bDesk.id });
    const startContext = await me(ownerCookie);
    const proof = await api(ownerCookie, '/api/console/directory');
    check('server read proof identifies the actual selected organization and session revision', proof.headers.get('x-eventouch-organization-id') === startContext.organizationId && proof.headers.get('x-eventouch-context-version') === String(startContext.contextVersion));

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const addCookie = (context, cookie) => context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    await addCookie(context, ownerCookie);
    const first = await context.newPage(), second = await context.newPage();
    let affiliationsUnavailable = true;
    await first.route('**/api/auth/organizations', async (route) => {
      if (route.request().method() === 'GET' && affiliationsUnavailable) return route.fulfill({ status: 503, json: { error: '합성 소속 조회 장애' } });
      await route.continue();
    });
    for (const page of [first, second]) {
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'POST' && (/\/commands$/.test(url.pathname) || url.pathname.includes('/organizations'))) {
          requests.push({ page: page === first ? 'A-view' : 'B-view', path: url.pathname, headers: request.headers(), body: request.postDataJSON() });
        }
      });
    }
    const capture = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }); };
    const inspect = async (page, name) => {
      check(`${name} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(require('axe-core').source);
      const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })));
      axe.push({ name, violations });
      check(`${name} no serious/critical axe`, !violations.some((v) => ['serious', 'critical'].includes(v.impact)), violations);
    };
    const openAccount = async (page) => {
      const panel = page.getByRole('dialog', { name: /운영자 메뉴|계정 및 조직 전환/ });
      if (!await panel.isVisible().catch(() => false)) await page.locator('button[aria-haspopup="dialog"]:visible').first().click();
      await panel.waitFor();
      return panel;
    };
    const pick = async (page, organizationId) => {
      const panel = await openAccount(page);
      await panel.getByLabel('전환할 운영사', { exact: true }).selectOption(organizationId);
      await panel.getByRole('button', { name: '이 운영사로 이동', exact: true }).click();
    };
    const original = `${f.baseUrl}/console/events/${f.eventId}/page`;
    await first.goto(original);
    await first.locator('#home-intro').fill('운영사 A에만 남아야 하는 초안');
    const panel = await openAccount(first);
    await panel.getByText('운영사 소속을 불러오지 못했습니다.', { exact: false }).waitFor();
    check('membership lookup 503 is retryable without pretending sign-in is required', await panel.getByRole('button', { name: '소속 다시 확인', exact: true }).isEnabled() && await panel.getByRole('link', { name: '로그인으로', exact: true }).count() === 0);
    await capture(first, 'organization-list-503-1280');
    affiliationsUnavailable = false;
    await panel.getByRole('button', { name: '소속 다시 확인', exact: true }).click();
    await panel.getByLabel('전환할 운영사', { exact: true }).selectOption(bOrg);
    let cancelledWarning;
    first.once('dialog', async (dialog) => { cancelledWarning = dialog.message(); await dialog.dismiss(); });
    await panel.getByRole('button', { name: '이 운영사로 이동', exact: true }).click();
    check('dirty explicit switch cancels before any selection request', Boolean(cancelledWarning?.includes('저장하지 않은')) && !requests.some((r) => r.path.endsWith('/select')));
    check('cancelled switch retains A input', await first.locator('#home-intro').inputValue() === '운영사 A에만 남아야 하는 초안');
    await capture(first, 'account-switch-guard-1280');
    await first.keyboard.press('Escape');

    await second.goto(f.baseUrl + '/console');
    await pick(second, bOrg);
    await second.waitForURL(`**/staff/events/${bEvent}`);
    await second.locator('#staff-desk').waitFor();
    check('same global AGENCY identity uses B effective STAFF role', (await me(ownerCookie)).role === 'STAFF' && (await me(ownerCookie)).organizationId === bOrg);
    await second.setViewportSize({ width: 390, height: 844 });
    await capture(second, 'staff-effective-B-390');
    await inspect(second, 'staff-effective-B-390');
    const staffAccount = await openAccount(second);
    check('B STAFF account menu does not inherit A owner actions', await staffAccount.getByRole('button', { name: '운영사 추가', exact: true }).count() === 0);
    await capture(second, 'staff-account-switcher-B-390');
    await second.keyboard.press('Escape');
    await first.getByRole('region', { name: '운영사 문맥 변경', exact: true }).waitFor();
    check('other-tab selection keeps A draft and locks its writes', await first.locator('#home-intro').inputValue() === '운영사 A에만 남아야 하는 초안' && await first.locator('#theme-save-draft').isDisabled());
    await capture(first, 'other-tab-A-draft-locked-1280');
    await first.setViewportSize({ width: 390, height: 844 });
    await capture(first, 'other-tab-A-draft-locked-390');
    await inspect(first, 'other-tab-A-draft-locked-390');
    const stale = await api(ownerCookie, `/api/events/${f.eventId}/commands`, { method: 'POST', headers: headersFor(startContext), body: { commandId: crypto.randomUUID(), command: 'notice.save', payload: { title: '보내지 않아야 할 과거 탭', body: '합성 반례' } } });
    check('actual server rejects old-tab A headers instead of writing under B', stale.status === 409 && stale.json.code === 'ORGANIZATION_CONTEXT_CHANGED', stale.json);
    await first.getByRole('button', { name: '검증 운영사 A에 다시 연결', exact: true }).click();
    await first.getByRole('region', { name: '운영사 문맥 변경', exact: true }).waitFor({ state: 'hidden' });
    check('explicit A return preserves the original draft', await first.locator('#home-intro').inputValue() === '운영사 A에만 남아야 하는 초안');
    await first.locator('#theme-save-draft').click();
    await f.gateway.waitForResponseLoss('attendee.page.save');
    await first.locator('#theme-save-draft').waitFor();
    await second.getByRole('region', { name: '운영사 문맥 변경', exact: true }).waitFor();
    await second.getByRole('button', { name: '검증 운영사 B에 다시 연결', exact: true }).click();
    await second.getByRole('region', { name: '운영사 문맥 변경', exact: true }).waitFor({ state: 'hidden' });
    await first.getByRole('region', { name: '운영사 문맥 변경', exact: true }).waitFor();
    await capture(first, 'uncertain-A-receipt-under-B-390');
    await first.getByRole('button', { name: '검증 운영사 A에 다시 연결', exact: true }).click();
    await first.getByRole('region', { name: '운영사 문맥 변경', exact: true }).waitFor({ state: 'hidden' });
    await first.locator('#theme-save-draft').click();
    await first.getByText('초안을 저장했습니다', { exact: false }).first().waitFor();
    const saved = requests.filter((r) => r.body?.command === 'attendee.page.save');
    check('uncertain A receipt replays only after explicit A return with same id and body', saved.length === 2 && JSON.stringify(saved[0].body) === JSON.stringify(saved[1].body) && saved.every((r) => r.headers['x-eventouch-organization-id'] === a.organizationId), saved.map((r) => ({ id: r.body.commandId, org: r.headers['x-eventouch-organization-id'], version: r.headers['x-eventouch-context-version'] })));

    // Lost selection response itself: same expected-version body must replay.
    let lostSelection = false;
    const selectionBodies = [];
    await second.route('**/api/auth/organizations/select', async (route) => {
      selectionBodies.push(route.request().postDataJSON());
      if (!lostSelection) { const actual = await committedResponse(route, 'organization.select'); if (!actual) return; lostSelection = true; await route.fulfill({ status: 502, json: { error: '합성 전환 응답 유실' } }); }
      else await route.continue();
    });
    await second.getByRole('button', { name: '검증 운영사 B에 다시 연결', exact: true }).click();
    await second.getByRole('button', { name: '같은 전환 요청 다시 확인', exact: true }).waitFor();
    await capture(second, 'selection-response-unknown-390');
    await second.getByRole('button', { name: '같은 전환 요청 다시 확인', exact: true }).click();
    await second.getByRole('region', { name: '운영사 문맥 변경', exact: true }).waitFor({ state: 'hidden' });
    check('selection lost response retries identical nonce and expected session revision', selectionBodies.length === 2 && JSON.stringify(selectionBodies[0]) === JSON.stringify(selectionBodies[1]), selectionBodies);
    await first.getByRole('button', { name: '검증 운영사 A에 다시 연결', exact: true }).click();
    await first.getByRole('region', { name: '운영사 문맥 변경', exact: true }).waitFor({ state: 'hidden' });

    // Create is explicit and idempotent; it never selects or inherits sending.
    let lostCreate = false;
    const createBodies = [];
    await first.route('**/api/auth/organizations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      createBodies.push(route.request().postDataJSON());
      if (!lostCreate) { const actual = await committedResponse(route, 'organization.create'); if (!actual) return; lostCreate = true; await route.fulfill({ status: 502, json: { error: '합성 등록 응답 유실' } }); }
      else await route.continue();
    });
    const createPanel = await openAccount(first);
    await createPanel.getByRole('button', { name: '운영사 추가', exact: true }).click();
    await createPanel.getByLabel('새 운영사 이름', { exact: true }).fill('검증 신규 운영사 C');
    await createPanel.getByRole('button', { name: '운영사 등록', exact: true }).click();
    await createPanel.getByRole('button', { name: '같은 등록 요청 다시 확인', exact: true }).waitFor();
    check('unknown org creation freezes its original name', await createPanel.getByLabel('새 운영사 이름', { exact: true }).isDisabled());
    await createPanel.getByRole('button', { name: '같은 등록 요청 다시 확인', exact: true }).click();
    await createPanel.getByText('운영사를 추가했습니다.', { exact: false }).waitFor();
    const affiliations = (await api(ownerCookie, '/api/auth/organizations')).json;
    const cOrg = affiliations.organizations.find((o) => o.name === '검증 신규 운영사 C');
    check('org create retains same receipt and creates once without switching', createBodies.length === 2 && JSON.stringify(createBodies[0]) === JSON.stringify(createBodies[1]) && affiliations.activeOrganizationId === a.organizationId && affiliations.organizations.filter((o) => o.name === '검증 신규 운영사 C').length === 1);
    await createPanel.getByLabel('전환할 운영사', { exact: true }).selectOption(cOrg.id);
    await createPanel.getByRole('button', { name: '이 운영사로 이동', exact: true }).click();
    await first.waitForURL('**/console');
    const cEvent = `ux-c-event-${f.suffix}`;
    await f.helpers.insertEvent(f.harness.database, { orgId: cOrg.id, id: cEvent, slug: cEvent, payload: { id: cEvent, slug: cEvent, name: '신규 C 행사', stage: 'LIVE', features: [] }, workspace: f.helpers.emptyWorkspace() });
    // Deliberately contradictory process-global health fixture: the current
    // org display must still use real scoped integrations, never inherit it.
    await first.route('**/api/health', async (route) => {
      const actual = await route.fetch();
      const body = await actual.json();
      await route.fulfill({ response: actual, json: { ...body, messaging: { connected: true, provider: 'fixture-legacy-global-provider' } } });
    });
    await first.goto(`${f.baseUrl}/console/events/${cEvent}/messages`);
    await first.locator('#message-compose-open').click();
    await first.locator('#campaign-title').waitFor();
    const simulation = first.getByLabel('모의 발송으로 기록', { exact: false });
    check('fresh org starts in locked simulation mode without inherited real send', await simulation.isChecked() && await simulation.isDisabled());
    await capture(first, 'new-org-simulation-only-390');
    await inspect(first, 'new-org-simulation-only-390');
    await first.setViewportSize({ width: 1280, height: 900 });
    await capture(first, 'new-org-simulation-only-1280');
    await first.goto(f.baseUrl + '/console/team');
    await first.getByRole('heading', { name: '구성원', exact: true }).waitFor();
    await first.locator('summary').filter({ hasText: /^연동·활동$/ }).click();
    await first.getByText('미연동 · 새 운영사는 모의 기록만 사용합니다', { exact: true }).waitFor();
    check('new-org integration display ignores connected legacy health', await first.getByText('fixture-legacy-global-provider', { exact: false }).count() === 0);
    await capture(first, 'new-org-team-1280');

    // Initial multi-membership session has no selection: no login loop and
    // no automatic fallback even if only one membership later remains.
    const unselected = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await addCookie(unselected, await f.helpers.sessionCookie(f.harness, ownerId));
    const picker = await unselected.newPage();
    picker.on('pageerror', (error) => errors.push(error.message));
    await picker.goto(f.baseUrl + '/login');
    await picker.getByRole('heading', { name: '작업할 운영사를 선택하세요', exact: true }).waitFor();
    await capture(picker, 'authenticated-unselected-picker-390');
    await inspect(picker, 'authenticated-unselected-picker-390');
    await picker.getByRole('region', { name: '운영사 선택', exact: true }).getByLabel('전환할 운영사', { exact: true }).selectOption(a.organizationId);
    await picker.getByRole('button', { name: '이 운영사로 이동', exact: true }).click();
    await picker.getByRole('heading', { name: '행사', exact: true }).waitFor();
    check('unselected identity explicitly reaches chosen effective-role home', new URL(picker.url()).pathname === '/console');
    await unselected.close();

    // Existing global account joins C: never a new password or overwrite.
    const hashBefore = (await f.harness.database.query('SELECT password_hash FROM accounts WHERE id=$1', [f.manager.id])).rows[0].password_hash;
    const invitation = await write(ownerCookie, '/api/auth/invitations', { commandId: crypto.randomUUID(), name: '감사 운영자', email: f.manager.email, role: 'STAFF' });
    assert.ok(invitation.status < 300, JSON.stringify(invitation.json));
    const inviteContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const invitePage = await inviteContext.newPage();
    invitePage.on('pageerror', (error) => errors.push(error.message));
    const invitePath = `/invite/${invitation.json.token}`;
    await invitePage.goto(f.baseUrl + invitePath);
    await invitePage.getByRole('link', { name: '로그인으로', exact: true }).waitFor();
    const brandLink = invitePage.getByRole('link', { name: 'EVENTOUCH', exact: true });
    check('invitation brand remains a named home link, not an accept action', await brandLink.count() === 1 && await brandLink.getAttribute('href') === '/');
    check('existing-account invite offers no signup password form', await invitePage.locator('input[type="password"]').count() === 0);
    await capture(invitePage, 'existing-account-invite-390');
    await invitePage.getByRole('link', { name: '로그인으로', exact: true }).click();
    await invitePage.getByLabel('이메일', { exact: true }).fill(f.manager.email);
    await invitePage.getByLabel('비밀번호', { exact: true }).fill(f.manager.password);
    await invitePage.getByRole('button', { name: '로그인', exact: true }).click();
    await invitePage.waitForURL('**' + invitePath);
    await invitePage.getByRole('button', { name: '초대 수락', exact: true }).click();
    await invitePage.getByRole('heading', { name: '초대를 수락했습니다', exact: true }).waitFor();
    const managerSession = `etko_session=${encodeURIComponent((await inviteContext.cookies()).find((cookie) => cookie.name === 'etko_session').value)}`;
    const hashAfter = (await f.harness.database.query('SELECT password_hash FROM accounts WHERE id=$1', [f.manager.id])).rows[0].password_hash;
    check('joining preserves global password and waits for explicit org selection', hashBefore === hashAfter && new URL(invitePage.url()).pathname === invitePath);
    await capture(invitePage, 'invite-accepted-explicit-org-390');
    await invitePage.getByLabel('전환할 운영사', { exact: true }).selectOption(cOrg.id);
    await invitePage.getByRole('button', { name: '이 운영사로 이동', exact: true }).click();
    await invitePage.waitForURL('**/staff');
    await invitePage.getByText('배정된 업무가 없습니다.', { exact: false }).waitFor();
    check('joined C membership uses STAFF empty assignment without permission promise', new URL(invitePage.url()).pathname === '/staff');
    await capture(invitePage, 'joined-staff-empty-390');
    await inspect(invitePage, 'joined-staff-empty-390');

    // Shared accounts are known up front: do not open a reset form and then
    // surprise the owner with a global-effect refusal. The API also fails
    // closed against a stale client or direct request.
    await first.reload();
    const memberRow = first.getByRole('region', { name: '구성원', exact: true }).locator('li').filter({ hasText: f.manager.email });
    const reset = memberRow.getByRole('button', { name: '비밀번호 재설정', exact: true });
    check('known shared account offers no enabled password reset', await reset.count() === 0 || await reset.isDisabled());
    check('shared account explains the cross-organization restriction before input', /공유|여러 (?:운영사|조직)/.test(await memberRow.innerText()) && await first.locator('#reset-password').count() === 0);
    const refusedReset = await write(ownerCookie, `/api/auth/accounts/${f.manager.id}/password`, { password: 'SyntheticNeverApplied!2026', commandId: crypto.randomUUID() });
    check('shared account API refuses a global password change', refusedReset.status === 403 && refusedReset.json.code === 'SHARED_ACCOUNT_GLOBAL_EFFECT', refusedReset.json);
    check('shared account password hash remains unchanged', (await f.harness.database.query('SELECT password_hash FROM accounts WHERE id=$1', [f.manager.id])).rows[0].password_hash === hashBefore);
    await capture(first, 'shared-password-reset-restricted-upfront-1280');
    await memberRow.getByRole('button', { name: '이 운영사 소속 사용 중지', exact: true }).click();
    await first.getByRole('button', { name: /소속.*중지.*확인|사용 중지한다|이 운영사 소속만 사용 중지/ }).click();
    await first.getByText(/사용 중지했습니다/, { exact: false }).first().waitFor();
    const membership = (await f.harness.database.query('SELECT active FROM organization_memberships WHERE org_id=$1 AND account_id=$2', [cOrg.id, f.manager.id])).rows[0];
    check('deactivation changes only C membership, not the global account or A membership', membership.active === false && (await f.harness.database.query('SELECT active FROM accounts WHERE id=$1', [f.manager.id])).rows[0].active === true && (await f.harness.database.query('SELECT active FROM organization_memberships WHERE org_id=$1 AND account_id=$2', [a.organizationId, f.manager.id])).rows[0].active === true);
    const joinedPanel = await openAccount(invitePage);
    await joinedPanel.getByRole('button', { name: '소속 다시 확인', exact: true }).click();
    await joinedPanel.getByLabel('전환할 운영사', { exact: true }).selectOption(a.organizationId);
    check('remaining single membership is not automatically selected', (await api(managerSession, '/api/auth/organizations')).json.activeOrganizationId === null && new URL(invitePage.url()).pathname === '/staff');
    await capture(invitePage, 'membership-revoked-explicit-selection-390');
    await joinedPanel.getByRole('button', { name: '이 운영사로 이동', exact: true }).click();
    await invitePage.waitForURL('**/console');
    // Synthetic final revocation of the remaining membership proves that an
    // authenticated org-less identity has an honest empty state, not a login loop.
    await f.harness.database.query('UPDATE organization_memberships SET active=false WHERE account_id=$1', [f.manager.id]);
    await invitePage.goto(f.baseUrl + '/login');
    await invitePage.getByRole('heading', { name: '작업할 운영사를 선택하세요', exact: true }).waitFor();
    await invitePage.getByText(/활성 운영사 소속이 없습니다/, { exact: false }).first().waitFor();
    const none = await api(managerSession, '/api/auth/me');
    check('zero-membership identity remains authenticated with truthful no-membership state', none.status === 403 && none.json.code === 'NO_ORGANIZATION_MEMBERSHIP' && new URL(invitePage.url()).pathname === '/console');
    await capture(invitePage, 'zero-membership-not-login-loop-390');
    await inviteContext.close();
    check('organization workflows have no unexpected page errors', errors.length === 0, errors);
    check('response-loss fixtures only replace committed successes', routeFailures.length === 0, routeFailures);
    finished = true;
  } finally {
    fs.writeFileSync(`${OUT}/route-failures.json`, JSON.stringify(routeFailures, null, 2), { mode: 0o600 });
    if (!finished && browser) {
      for (const [contextIndex, context] of browser.contexts().entries()) {
        for (const [pageIndex, page] of context.pages().entries()) {
          await page.screenshot({ path: `${OUT}/failure-context-${contextIndex}-page-${pageIndex}.png`, fullPage: false }).catch((error) => console.error('Failure capture unavailable:', error.message));
        }
      }
    }
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8'), checks, requests, errors, axe, simulation: 'Disposable explicit-org task schema; synthetic role rows/assignment; actual UI/API commands. Committed response losses and no real messaging credentials.' }, null, 2), { mode: 0o600 });
    console.log(`Organization UI evidence: ${OUT}`);
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
