'use strict';
// Production-build real isolated DB/browser audit: organization owner role policy.
// Standalone audit main (main registers a separate roles root command/CI).
// Also exports runOrganizationRoleAudit.
// Runtime URL is fixture.baseUrl, browser comes from ./audit-browser.cjs
// (headless only), no build/run here.
//
// FINAL SOURCE EXPECTED (TeamWorkspace.tsx + OrganizationSwitcher.tsx):
//   - Owner invite offers role AGENCY; choosing it hides the event scope and
//     stages an in-place org-wide confirm; only the staged send POSTs.
//   - Role editor freezes on unknown (502) outcomes; retry replays the same
//     body/commandId; identical bytes twice in the request log.
//   - Inactive memberships expose a real reactivation control; role-only
//     change never activates, reactivation never changes the role.
//   - Self change blocks while unrelated work is pending/uncertain (zero POST).
//   - Self change re-reads fresh me: a 503 on that GET surfaces an explicit
//     observed GET-retry action with no native exit and no write replay; the
//     retry reads fresh and the native exit lands on the OBSERVED role home.
//   - Last active AGENCY can be neither demoted nor deactivated (409).
//   - Directory account list exposes sharedAccount as a boolean for every
//     membership; long contacts render on desktop + mobile without overflow.
//
// Database: explicit isolated audit URL only (same precedence as
// audit-fixture), shared loopback-only validation, no default fallback,
// never a protected/live database. The harness isolates all writes in a
// random UUID schema dropped on close.
// Direct API calls are fixture setup, server-guard proofs, and cleanup
// only — never a substitute for a UI requirement.
process.env.EVENTOUCH_SMS_MOCK = '1';
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const { testDatabaseUrl } = require('../tests/helpers/postgres-test.cjs');

function enforceTaskDatabase() {
  // Same precedence as audit-fixture, explicit URL only: no default fallback,
  // never a protected/live database. Loopback-only validation is shared with
  // every other audit; the harness below additionally isolates all writes in
  // a random UUID schema that is dropped on close. Current runtime value is
  // the synthetic task database eventouch_ux; future verify:system / CI
  // databases flow through the same explicit env vars.
  const resolved = String(
    process.env.EVENTOUCH_A11Y_DATABASE_URL
    || process.env.EVENTOUCH_MOBILE_DATABASE_URL
    || process.env.EVENTOUCH_TEST_DATABASE_URL
    || ''
  ).trim();
  if (!resolved) {
    throw new Error(
      'organization-roles audit refuses: set an explicit isolated audit database URL '
      + '(EVENTOUCH_A11Y_DATABASE_URL); no default fallback, never a protected/live database',
    );
  }
  testDatabaseUrl(resolved);
  process.env.EVENTOUCH_A11Y_DATABASE_URL = resolved;
}

const captureRoot = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`system-improvement-20261024/ux-${runStamp()}`);
const runId = process.env.EVENTOUCH_AUDIT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(captureRoot, `organization-roles-${runId}`);

async function runOrganizationRoleAudit() {
  enforceTaskDatabase();
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const f = await startAuditFixture();
  const checks = [], requests = [], errors = [], axe = [], dialogs = [], routeFailures = [];
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
  const memberWrite = (cookie, orgId, accountId, body) => write(cookie, `/api/auth/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`, body);
  const membershipRow = async (orgId, accountId) =>
    (await f.harness.database.query('SELECT role, active, revision FROM organization_memberships WHERE org_id=$1 AND account_id=$2', [orgId, accountId])).rows[0] || null;
  const globalRow = async (accountId) =>
    (await f.harness.database.query('SELECT active, password_hash FROM accounts WHERE id=$1', [accountId])).rows[0] || null;
  const memberPosts = () => requests.filter((r) => /\/members\/[^/]+$/.test(r.path));
  const invitePosts = () => requests.filter((r) => r.path === '/api/auth/invitations');
  const createPosts = () => requests.filter((r) => r.path === '/api/auth/organizations');

  const ownerId = `audit-owner-${f.suffix}`;
  try {
    await f.harness.database.query('UPDATE organizations SET name=$2 WHERE id=$1', [f.helpers.LEGACY_ORG, '검증 운영사 R']);
    const ownerCookie = await f.helpers.sessionCookie(f.harness, ownerId);
    const orgId = f.helpers.LEGACY_ORG;
    // Second owner + worker accounts, all synthetic rows inside the disposable task schema.
    const owner2Id = `ux-r-owner2-${f.suffix}`.toLowerCase();
    const workerId = `ux-r-worker-${f.suffix}`.toLowerCase();
    const dormantId = `ux-r-dormant-${f.suffix}`.toLowerCase();
    const invitedEmail = `ux-r-invited-owner-${f.suffix}@example.test`;
    await f.helpers.insertAccount(f.harness.database, { orgId, id: owner2Id, role: 'AGENCY', name: '검증 부소유자', email: `${owner2Id}@example.test` });
    await f.helpers.insertAccount(f.harness.database, { orgId, id: workerId, role: 'MANAGER', name: '검증 운영 구성원', email: `${workerId}@example.test` });
    await f.helpers.insertAccount(f.harness.database, { orgId, id: dormantId, role: 'STAFF', name: '검증 휴면 스태프', email: `${dormantId}@example.test` });
    // Second org makes one account shared, proving per-org scope of every write.
    const createdB = await write(ownerCookie, '/api/auth/organizations', { name: '검증 운영사 R-B', commandId: crypto.randomUUID() });
    assert.ok(createdB.status < 300, JSON.stringify(createdB.json));
    const orgB = createdB.json.organization.id;
    await f.harness.database.query(
      'INSERT INTO organization_memberships (org_id, account_id, role, active, permissions) VALUES ($1, $2, \'MANAGER\', true, \'[]\'::jsonb)',
      [orgB, workerId],
    );
    const workerHashBefore = (await globalRow(workerId)).password_hash;

    // Fixture writes (org create + membership inserts) move the session
    // context. Re-read /me, then explicitly select the original org with its
    // receipt BEFORE any page load: the browser must never start on a stale
    // selection and mistake the correct context-block screen for a defect.
    const reselectCurrent = await me(ownerCookie);
    const reselect = await api(ownerCookie, '/api/auth/organizations/select', {
      method: 'POST',
      headers: headersFor(reselectCurrent),
      body: { organizationId: orgId, commandId: crypto.randomUUID(), expectedContextVersion: reselectCurrent.contextVersion },
    });
    assert.ok(reselect.status < 300, JSON.stringify(reselect.json));
    check('fixture explicitly reselects the original org with a receipt', reselect.json.user.organizationId === orgId && typeof reselect.json.user.contextVersion === 'number', reselect.json.user);

    const startContext = await me(ownerCookie);
    const proof = await api(ownerCookie, '/api/console/directory');
    check('server read proof identifies the actual selected organization and session revision', proof.headers.get('x-eventouch-organization-id') === startContext.organizationId && proof.headers.get('x-eventouch-context-version') === String(startContext.contextVersion));
    const directoryAccounts = proof.json.directory.accounts;
    check('owner account list exposes sharedAccount boolean for every membership',
      Array.isArray(directoryAccounts) && directoryAccounts.length >= 4 && directoryAccounts.every((a) => typeof a.sharedAccount === 'boolean'),
      directoryAccounts.map((a) => ({ id: a.id, shared: a.sharedAccount })));
    check('multi-org membership reads shared without leaking the other org',
      directoryAccounts.find((a) => a.id === workerId).sharedAccount === true
      && directoryAccounts.find((a) => a.id === dormantId).sharedAccount === false
      && JSON.stringify(directoryAccounts).includes(orgB) === false);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(ownerCookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    // Role/invite writes use ConsoleConfirm. Native leave/role-home prompts
    // are recorded before modeled acceptance, not counted as custom UI.
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message(), url: page.url() });
      await dialog.accept().catch(() => {});
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && (/\/members\/[^/]+$/.test(url.pathname) || url.pathname === '/api/auth/invitations' || url.pathname === '/api/auth/organizations' || url.pathname.includes('/organizations/'))) {
        try {
          requests.push({ path: url.pathname, headers: { org: request.headers()['x-eventouch-organization-id'], version: request.headers()['x-eventouch-context-version'] }, body: request.postDataJSON() });
        } catch { /* ignore unparseable */ }
      }
    });
    const capture = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }); };
    const inspect = async (name) => {
      check(`${name} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(require('axe-core').source);
      const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes })));
      axe.push({ name, violations });
      check(`${name} no serious/critical axe`, !violations.some((v) => ['serious', 'critical'].includes(v.impact)), violations);
    };
    const headingReady = async () => { await page.getByRole('heading', { name: '구성원', exact: true }).first().waitFor(); };
    // Initial team load only: if the correct context-block screen appears
    // instead of the team screen, reselect the original org explicitly
    // through the real API (receipt included), reload, and require the team
    // screen. A persistent block fails loudly — never counted as a pass.
    const ensureTeamReady = async (stage) => {
      await page.goto(`${f.baseUrl}/console/team`);
      const teamHeading = page.getByRole('heading', { name: '구성원', exact: true }).first();
      await teamHeading.waitFor();
      // The heading alone is NOT success: fixture org writes move the
      // session, so the correct context lock may co-show. A co-visible
      // lock region must recover through the product's own restore
      // control (verified as a product feature here); a persistent block
      // fails loudly, never counted as a pass.
      const lockNotice = page.getByRole('region', { name: '운영사 문맥 변경', exact: true });
      if (await lockNotice.count() > 0) {
        await capture(`context-block-before-recovery-${stage}-1280`);
        check(`context lock is honestly shown instead of a silent wrong-org view (${stage})`, true);
        await lockNotice.getByRole('button', { name: /에 다시 연결/, exact: false }).click();
        await lockNotice.waitFor({ state: 'hidden', timeout: 15000 });
        check(`explicit restore control clears the lock (${stage})`, await lockNotice.count() === 0);
      }
      const inviteAction = page.getByRole('button', { name: '구성원 초대', exact: true });
      check(`invite action is enabled once the lock is gone (${stage})`, await inviteAction.isEnabled());
    };
    const openEditor = async (accountId) => {
      if (await page.locator(`#org-role-panel-${accountId}`).isVisible().catch(() => false)) return;
      await page.locator(`#org-role-toggle-${accountId}`).click();
      await page.locator(`#org-role-panel-${accountId}`).waitFor();
    };
    const accountMenuButton = page.locator('button[aria-haspopup="dialog"]:visible').first();
    const openAccountMenu = async () => {
      await accountMenuButton.click();
      const menu = page.getByRole('dialog', { name: '운영자 메뉴' });
      await menu.waitFor();
      return menu;
    };
    // Recovery-control probe inside the context notice: ordered candidate
    // labels, first visible wins, missing control fails loudly with the
    // visible labels (no skips; exact recovery copy is still landing).
    const noticeButton = async (notice, patterns, what) => {
      const labels = await notice.getByRole('button').allInnerTexts().catch(() => []);
      for (const pattern of patterns) {
        const candidate = notice.getByRole('button', { name: pattern }).first();
        if (await candidate.count() > 0 && await candidate.isVisible().catch(() => false)) return candidate;
      }
      check(`${what} control exists in the context notice`, false, { labels });
      throw new Error(`unreachable: ${what}`);
    };

    await ensureTeamReady('initial');
    await capture('team-long-contact-1280');
    await inspect('team-long-contact-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('team-long-contact-390');
    await inspect('team-long-contact-390');
    await page.setViewportSize({ width: 1280, height: 900 });

    // Owner invite: AGENCY stages an in-place org-wide confirm; only the staged send POSTs.
    await page.getByRole('button', { name: '구성원 초대', exact: true }).click();
    await page.locator('#invite-form').waitFor();
    const inviteRole = page.locator('#invite-role');
    const agencyOffered = await inviteRole.locator('option[value="AGENCY"]').count();
    check('owner invite offers the AGENCY role option', agencyOffered > 0, { agencyOffered });
    await page.locator('#invite-name').fill('검증 소유자 초대');
    await page.locator('#invite-email').fill(invitedEmail);
    await inviteRole.selectOption('AGENCY');
    check('AGENCY invite carries no event scope', await page.locator('#invite-event').count() === 0);
    await page.getByRole('button', { name: '초대 링크 발급', exact: true }).click();
    await page.waitForTimeout(800);
    check('AGENCY invite stages confirmation before any send', invitePosts().length === 0, invitePosts());
    const ownerReview = page.getByRole('dialog', { name: '구성원 초대', exact: true }).getByRole('group', { name: '실행 확인', exact: true });
    await ownerReview.waitFor();
    const dialogText = await ownerReview.innerText();
    check('AGENCY invite confirmation names the target and org-wide scope', dialogText.includes(invitedEmail) && /모든 행사|조직 전체/.test(dialogText), dialogText.slice(0, 400));
    await capture('owner-invite-agency-confirm-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('owner-invite-agency-confirm-390');
    await inspect('owner-invite-agency-confirm-390');
    await page.setViewportSize({ width: 1280, height: 900 });
    await ownerReview.getByRole('button', { name: '초대한다', exact: true }).click();
    await page.getByText(/발급된 초대 링크|초대 링크는 지금 한 번만/, { exact: false }).first().waitFor();
    check('staged AGENCY invite POSTs once with the org-wide role',
      invitePosts().length === 1 && invitePosts()[0].body.role === 'AGENCY' && typeof invitePosts()[0].body.commandId === 'string',
      invitePosts().map((p) => p.body));
    await capture('owner-invite-agency-issued-1280');
    const inviteRow = (await f.harness.database.query('SELECT id, role FROM invitations WHERE org_id=$1 AND email=$2 ORDER BY created_at DESC LIMIT 1', [orgId, invitedEmail])).rows[0];
    check('server stores the AGENCY invitation', inviteRow && inviteRow.role === 'AGENCY', inviteRow);
    // The synthetic invitation leaves through the real UI revoke, not a direct-API substitute.
    await page.reload();
    await headingReady();
    const issuedRow = page.locator('li').filter({ hasText: invitedEmail }).first();
    let revokeLost = false;
    const revokeBodies = [];
    await page.route('**/api/auth/invitations/*/revoke', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      revokeBodies.push(route.request().postDataJSON());
      if (!revokeLost) {
        const actual = await committedResponse(route, 'invitation.revoke');
        if (!actual) return;
        revokeLost = true;
        await route.fulfill({ status: 502, json: { error: '합성 초대 철회 응답 유실' } });
      } else await route.continue();
    });
    await issuedRow.getByRole('button', { name: '초대 철회', exact: true }).click();
    const revokeRetry = issuedRow.getByRole('button', { name: /같은 요청/ });
    await revokeRetry.waitFor();
    await capture('owner-invite-revoke-unknown-1280');
    await revokeRetry.click();
    await issuedRow.waitFor({ state: 'hidden' });
    check('unknown invitation revocation replays its original receipt', revokeBodies.length === 2
      && JSON.stringify(revokeBodies[0]) === JSON.stringify(revokeBodies[1]), revokeBodies);
    await page.unroute('**/api/auth/invitations/*/revoke');
    check('real UI revokes the synthetic invitation', await page.locator('li').filter({ hasText: invitedEmail }).count() === 0);

    // Non-self role change through the real editor: confirm copy, success, DB scope.
    await openEditor(workerId);
    await capture('team-role-editor-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(`#org-role-panel-${workerId}`).scrollIntoViewIfNeeded();
    await capture('team-role-editor-390');
    await inspect('team-role-editor-390');
    await page.setViewportSize({ width: 1280, height: 900 });
    const workerGroup = page.getByRole('group', { name: '검증 운영 구성원 조직 역할 선택' });
    await workerGroup.getByRole('radio', { name: /조직 구성원/ }).focus();
    await page.keyboard.press('ArrowRight');
    check('native radio keyboard selection chooses STAFF', await workerGroup.getByRole('radio', { name: /현장 스태프/ }).isChecked());
    const rolePostsBefore = memberPosts().length;
    await page.getByRole('button', { name: '변경 확인', exact: true }).focus();
    await page.keyboard.down('Enter');
    await page.getByRole('button', { name: '역할을 바꾼다', exact: true }).waitFor();
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    check('held activation does not confirm the newly focused role operation', memberPosts().length === rolePostsBefore);
    check('role change confirms the target and the org-only scope before sending',
      await page.getByText(/조직 역할을/, { exact: false }).first().count() > 0);
    await page.getByRole('button', { name: '역할을 바꾼다', exact: true }).press('Enter');
    await page.getByText(/조직 역할을.*바꿨습니다/, { exact: false }).first().waitFor();
    check('role write sends one scoped request with a command id',
      memberPosts().length === rolePostsBefore + 1 && typeof memberPosts()[memberPosts().length - 1].body.commandId === 'string'
      && memberPosts()[memberPosts().length - 1].headers.org === orgId,
      memberPosts().map((r) => ({ path: r.path, org: r.headers.org, body: r.body })));
    check('role-only body carries no active flag', !Object.hasOwn(memberPosts()[memberPosts().length - 1].body, 'active'), memberPosts()[memberPosts().length - 1].body);
    let row = await membershipRow(orgId, workerId);
    check('MANAGER to STAFF commits with other org membership untouched', row.role === 'STAFF' && row.active === true
      && (await membershipRow(orgB, workerId)).role === 'MANAGER' && (await globalRow(workerId)).password_hash === workerHashBefore);

    // Committed 502 on a role write: freeze, identical replay, receipt re-confirm.
    const memberRoute = /\/api\/auth\/organizations\/[^/]+\/members\/[^/]+$/;
    let lostRole = false;
    const roleBodies = [];
    await page.route(memberRoute, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      roleBodies.push(route.request().postDataJSON());
      if (!lostRole) {
        const actual = await committedResponse(route, 'membership.role');
        if (!actual) return;
        lostRole = true;
        await route.fulfill({ status: 502, json: { error: '합성 역할 응답 유실' } });
      } else await route.continue();
    });
    await openEditor(workerId); // currently STAFF after the previous change
    await page.getByRole('group', { name: '검증 운영 구성원 조직 역할 선택' }).getByRole('radio', { name: /조직 구성원/ }).check();
    await page.getByRole('button', { name: '변경 확인', exact: true }).click();
    await page.getByRole('button', { name: '역할을 바꾼다', exact: true }).click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).waitFor();
    check('unknown role outcome surfaces the frozen retry in editor and confirm without minting', await page.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).count() === 2);
    check('unknown role outcome freezes other changes until the same retry', await page.locator(`#org-role-panel-${workerId} input[type="radio"]`).first().isDisabled());
    await capture('team-role-502-frozen-1280');

    // P1: another owner changes the actor role while the actor holds the
    // uncertain command above. Recovery is same-org only: the original Team
    // workspace stays locked, the contextual notice (outside the fieldset)
    // replays the frozen request, nothing auto-exits, and the explicit home
    // move follows a fresh read of the actual role.
    const owner2Cookie = await f.helpers.sessionCookie(f.harness, owner2Id);
    const demoteActor = await memberWrite(owner2Cookie, orgId, ownerId, { role: 'MANAGER', commandId: crypto.randomUUID() });
    check('independent owner changes the uncertain actor role to MANAGER', demoteActor.status < 300, { status: demoteActor.status, body: demoteActor.json });
    // The actor learns it through the real account-menu refresh, not a direct read.
    const refreshMenu = await openAccountMenu();
    await refreshMenu.getByRole('button', { name: '소속 다시 확인', exact: true }).click();
    const contextNotice = page.getByRole('region', { name: '운영사 문맥 변경', exact: true });
    await contextNotice.waitFor();
    await page.keyboard.press('Escape');
    await refreshMenu.waitFor({ state: 'hidden' });
    await capture('context-recovery-notice-1280');
    await inspect('context-recovery-notice-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('context-recovery-notice-390');
    await inspect('context-recovery-notice-390');
    await page.setViewportSize({ width: 1280, height: 900 });
    check('recovery stays on the original Team workspace locked',
      new URL(page.url()).pathname === '/console/team'
      && await page.locator(`#org-role-panel-${workerId}`).isVisible()
      && await page.locator(`#org-role-panel-${workerId} input[type="radio"]`).first().isDisabled(),
      { url: page.url() });
    // New intents stay blocked while locked: org creation is gated and no
    // member or org write POSTs while the uncertainty stands.
    const lockedMemberPosts = memberPosts().length;
    const lockedCreatePosts = createPosts().length;
    const gateMenu = await openAccountMenu();
    const createIntent = gateMenu.getByRole('button', { name: '운영사 추가', exact: true });
    check('new org intent is gated while uncertain', await createIntent.count() === 0 || await createIntent.isDisabled());
    await page.keyboard.press('Escape');
    await gateMenu.waitFor({ state: 'hidden' });
    check('no new intent POSTs while locked', memberPosts().length === lockedMemberPosts && createPosts().length === lockedCreatePosts,
      { memberPosts: memberPosts().length, createPosts: createPosts().length });
    // Explicit same-org restore: no exit, panel stays frozen and uncertain.
    await noticeButton(contextNotice, [/미확인 요청.*연결|미확인 요청.*복구/, /변경된 역할의 홈으로 이동/, /에 다시 연결/, /복구/], 'same-org restore').then((button) => button.click());
    await page.waitForTimeout(2000);
    check('same-org restore keeps the locked workspace without exiting',
      new URL(page.url()).pathname === '/console/team'
      && await page.locator(`#org-role-panel-${workerId} input[type="radio"]`).first().isDisabled(),
      { url: page.url() });
    // Central replay of the frozen request: byte-identical body and command
    // id; only the context-version header may renew; org header stays this
    // org (never the second org).
    const replayResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().endsWith(`/members/${workerId}`)
      && response.request().postDataJSON()?.commandId === roleBodies[0].commandId);
    await noticeButton(contextNotice, [/같은 요청/, /재시도/, /복구/, /다시 시도/], 'same-request replay').then((button) => button.click());
    const receivedReplay = await replayResponse;
    const receivedReplayBody = await receivedReplay.json();
    check('explicit recovery receives the original membership receipt', receivedReplay.ok()
      && receivedReplayBody.membership?.accountId === workerId
      && receivedReplayBody.membership?.role === 'MANAGER', { status: receivedReplay.status(), body: receivedReplayBody });
    check('committed 502 replays the identical body and command id', roleBodies.length === 2
      && JSON.stringify(roleBodies[0]) === JSON.stringify(roleBodies[1])
      && roleBodies[0].commandId === roleBodies[1].commandId, roleBodies);
    check('replay keeps the same org header and frozen expected version',
      memberPosts()[memberPosts().length - 1].headers.org === orgId
      && memberPosts()[memberPosts().length - 1].body.expectedContextVersion === roleBodies[0].expectedContextVersion,
      memberPosts().map((r) => ({ org: r.headers.org, version: r.headers.version, body: r.body })));
    row = await membershipRow(orgId, workerId);
    check('502 retry commits the single intended role', row.role === 'MANAGER' && row.active === true);
    await page.waitForTimeout(2000);
    check('resolved replay triggers no auto-exit', new URL(page.url()).pathname === '/console/team', { url: page.url() });
    await capture('context-recovery-resolved-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('context-recovery-resolved-390');
    await page.setViewportSize({ width: 1280, height: 900 });
    // Explicit home move follows the fresh read of the actual role
    // (MANAGER from the independent mutation, not the requested edit).
    await noticeButton(contextNotice, [/현재 역할 다시 확인/, /변경된 역할의 홈으로 이동/, /홈으로 이동/, /홈으로/], 'changed-role home').then((button) => button.click());
    await page.waitForURL((url) => new URL(url).pathname === '/console', { timeout: 15000 });
    const afterRecovery = await me(ownerCookie);
    check('explicit home lands on the fresh-read MANAGER home', afterRecovery.role === 'MANAGER' && new URL(page.url()).pathname === '/console',
      { observedRole: afterRecovery.role, path: new URL(page.url()).pathname });
    await page.unroute(memberRoute);
    // Fixture note: the actor returns to AGENCY through the independent owner
    // (real API) before the remaining tests, which assume an owner session.
    const restoreActor = await memberWrite(owner2Cookie, orgId, ownerId, { role: 'AGENCY', commandId: crypto.randomUUID() });
    check('actor restored to AGENCY for the remaining fixture', restoreActor.status < 300, { status: restoreActor.status, body: restoreActor.json });
    // Own-membership writes rebind the session: the next team load honestly
    // locks until the explicit restore rebinds it. Recover through the
    // product control, then prove a clean reload does NOT bring it back.
    await page.goto(`${f.baseUrl}/console/team`);
    const rebindNotice = page.getByRole('region', { name: '운영사 문맥 변경', exact: true });
    // The lock renders asynchronously after the guarded reads settle, so a
    // bare count right after goto misses it: wait for either the team
    // screen or the lock, then recover through the product control.
    let locked = false;
    try {
      await rebindNotice.waitFor({ timeout: 10000 });
      locked = true;
    } catch { /* no lock: the team screen owns the rest */ }
    if (locked) {
      await capture('post-restore-rebind-1280');
      check('stale session binding locks honestly instead of a silent wrong-org view', true);
      await rebindNotice.getByRole('button', { name: /에 다시 연결/, exact: false }).click();
      await rebindNotice.waitFor({ state: 'hidden', timeout: 15000 });
      check('explicit restore rebinds the changed membership', await rebindNotice.count() === 0);
    }
    // The pre-restore load failed honestly under the lock and keeps its
    // failed state with a working retry (inputs preserved by design); a
    // clean reload on the rebound session must come back clean with the
    // team screen, no lock, and no recurrence.
    await page.reload();
    await headingReady();
    check('clean reload after rebinding shows no lock', await page.getByRole('region', { name: '운영사 문맥 변경', exact: true }).count() === 0);

    // Owner-only enforcement (confirmed policy: no enabled non-owner path, direct API answers 403).
    const dormantCookie = await f.helpers.sessionCookie(f.harness, dormantId);
    const forbidden = await memberWrite(dormantCookie, orgId, workerId, { role: 'STAFF', commandId: crypto.randomUUID() });
    check('non-owner direct role write is a definitive 403', forbidden.status === 403, { status: forbidden.status, body: forbidden.json });
    row = await membershipRow(orgId, workerId);
    check('forbidden write changes nothing', row.role === 'MANAGER' && row.active === true, row);

    // Inactive role-only change preserves inactive (real UI); reactivation is a
    // real Team button (API deactivation below is fixture setup only).
    const deactivate = await memberWrite(ownerCookie, orgId, dormantId, { active: false, commandId: crypto.randomUUID() });
    assert.ok(deactivate.status < 300, JSON.stringify(deactivate.json));
    await page.reload();
    await headingReady();
    await openEditor(dormantId);
    check('inactive editor states no auto-activation', await page.locator(`#org-role-panel-${dormantId}`).getByText(/그대로 유지됩니다|자동으로 활성화되지 않습니다/, { exact: false }).count() > 0);
    await page.getByRole('group', { name: '검증 휴면 스태프 조직 역할 선택' }).getByRole('radio', { name: /조직 구성원/ }).check();
    await page.getByRole('button', { name: '변경 확인', exact: true }).click();
    await page.getByRole('button', { name: '역할을 바꾼다', exact: true }).click();
    await page.getByText(/조직 역할을.*바꿨습니다/, { exact: false }).first().waitFor();
    row = await membershipRow(orgId, dormantId);
    check('role-only change on an inactive membership preserves inactive', row.role === 'MANAGER' && row.active === false, row);
    await page.reload();
    await headingReady();
    const dormantRow = page.locator('li').filter({ hasText: `${dormantId}@example.test` }).first();
    const reactivate = dormantRow.getByRole('button', { name: /사용 재개|다시 사용|소속 다시 사용|활성화|중지 해제/ });
    check('inactive membership offers a real reactivation control', await reactivate.count() > 0, { row: (await dormantRow.innerText().catch(() => '')).slice(0, 300) });
    await reactivate.first().click();
    await page.waitForTimeout(600);
    row = await membershipRow(orgId, dormantId);
    if (!row.active) {
      const reactivateConfirm = dormantRow.getByRole('button', { name: /재개한다|다시 사용한다|다시 활성화한다|사용한다|확인/ });
      check('reactivation stages a confirm before applying', await reactivateConfirm.count() > 0);
      await reactivateConfirm.first().click();
      await page.waitForTimeout(1000);
      row = await membershipRow(orgId, dormantId);
    }
    check('team reactivation preserves the stored role', row.active === true && row.role === 'MANAGER', row);
    const reactivatedRoleLine = await dormantRow.locator('p').filter({ hasText: /조직 역할/ }).first().innerText().catch(() => '');
    check('reactivated row no longer reads as suspended', reactivatedRoleLine.length > 0 && !/사용 중지/.test(reactivatedRoleLine), { roleLine: reactivatedRoleLine.slice(0, 200) });

    // Last-owner guard: sole AGENCY can be neither demoted nor deactivated (API + real UI).
    const demoteOwner2 = await memberWrite(ownerCookie, orgId, owner2Id, { role: 'MANAGER', commandId: crypto.randomUUID() });
    check('non-last owner demotion succeeds', demoteOwner2.status < 300, { status: demoteOwner2.status, body: demoteOwner2.json });
    const demoteLast = await memberWrite(ownerCookie, orgId, ownerId, { role: 'MANAGER', commandId: crypto.randomUUID() });
    check('last active owner demotion is an honest 409', demoteLast.status === 409 && /마지막 조직 소유자/.test(String(demoteLast.json.error || '')), { status: demoteLast.status, body: demoteLast.json });
    const deactivateLast = await memberWrite(ownerCookie, orgId, ownerId, { active: false, commandId: crypto.randomUUID() });
    check('last active owner deactivation is an honest 409', deactivateLast.status === 409 && /마지막 조직 소유자/.test(String(deactivateLast.json.error || '')), { status: deactivateLast.status, body: deactivateLast.json });
    row = await membershipRow(orgId, ownerId);
    check('rejected last-owner writes change nothing', row.role === 'AGENCY' && row.active === true, row);
    await page.reload();
    await headingReady();
    await openEditor(ownerId);
    await page.locator(`#org-role-panel-${ownerId}`).getByRole('radio', { name: /조직 구성원/ }).check();
    await page.getByRole('button', { name: '변경 확인', exact: true }).click();
    await page.getByRole('button', { name: '역할을 바꾼다', exact: true }).click();
    await page.getByText(/마지막 조직 소유자/, { exact: false }).first().waitFor();
    check('real UI surfaces the last-owner refusal without navigating away', new URL(page.url()).pathname === '/console/team'
      && (await membershipRow(orgId, ownerId)).role === 'AGENCY');
    await capture('team-last-owner-refused-1280');
    await page.reload();
    await headingReady();
    const restoreOwner2 = await memberWrite(ownerCookie, orgId, owner2Id, { role: 'AGENCY', commandId: crypto.randomUUID() });
    assert.ok(restoreOwner2.status < 300, JSON.stringify(restoreOwner2.json));

    // Unrelated pending work blocks a self demotion with zero role POSTs.
    // Central uncertainty comes from a committed-but-unseen ORG CREATE in the
    // always-mounted OrganizationSwitcher (ConsoleShell account menu), never
    // from an ambiguous invite loss or a memory-losing reload.
    await accountMenuButton.click();
    const menu = page.getByRole('dialog', { name: '운영자 메뉴' });
    await menu.waitFor();
    await menu.getByRole('button', { name: '운영사 추가', exact: true }).click();
    const pendingOrgName = `검증 보류 운영사 R-${f.suffix}`.slice(0, 60);
    const orgNameInput = menu.getByLabel('새 운영사 이름', { exact: true });
    await orgNameInput.fill(pendingOrgName);
    let createLost = false;
    const createBodies = [];
    await page.route('**/api/auth/organizations', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'POST' || url.pathname !== '/api/auth/organizations') return route.continue();
      createBodies.push(route.request().postDataJSON());
      if (!createLost) {
        const actual = await committedResponse(route, 'organization.create');
        if (!actual) return;
        createLost = true;
        await route.fulfill({ status: 502, json: { error: '합성 등록 응답 유실' } });
      } else await route.continue();
    });
    await menu.getByRole('button', { name: '운영사 등록', exact: true }).click();
    await menu.getByRole('button', { name: '같은 등록 요청 다시 확인', exact: true }).waitFor();
    check('unknown org creation freezes its original name', await orgNameInput.isDisabled());
    check('create-unknown explains reconnect-then-retry', await menu.getByText(/등록 결과를 확인하지 못했습니다/, { exact: false }).count() > 0);
    await capture('switcher-create-uncertain-1280');
    // Escape keeps the org form and the central uncertainty; the Team self editor stays accessible.
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await openEditor(ownerId);
    const selfPostsBefore = memberPosts().length;
    await page.locator(`#org-role-panel-${ownerId}`).getByRole('radio', { name: /조직 구성원/ }).check();
    check('self editor warns about the permission change once a different role is staged', await page.locator(`#org-role-panel-${ownerId}`).getByText(/본인 계정입니다/, { exact: false }).count() > 0);
    await page.getByRole('button', { name: '변경 확인', exact: true }).click();
    await page.getByRole('button', { name: '역할을 바꾼다', exact: true }).click();
    await page.locator(`#org-role-panel-${ownerId}`).getByText(/진행 중이거나 결과 미확인/, { exact: false }).first().waitFor();
    check('unrelated pending work blocks a self demotion with zero role POSTs', memberPosts().length === selfPostsBefore, memberPosts().slice(selfPostsBefore));
    await capture('self-blocked-pending-1280');
    // Reopen the popup: the frozen form retries the SAME create request and resolves the uncertainty.
    await accountMenuButton.click();
    await menu.waitFor();
    check('reopened menu retains the frozen create form',
      await menu.getByRole('button', { name: '같은 등록 요청 다시 확인', exact: true }).count() > 0
      && await menu.getByLabel('새 운영사 이름', { exact: true }).inputValue() === pendingOrgName);
    await menu.getByRole('button', { name: '같은 등록 요청 다시 확인', exact: true }).click();
    await menu.getByText(/운영사를 추가했습니다/, { exact: false }).first().waitFor();
    check('create retry replays the identical name and command id', createBodies.length === 2
      && JSON.stringify(createBodies[0]) === JSON.stringify(createBodies[1])
      && createBodies[0].commandId === createBodies[1].commandId, createBodies);
    await page.unroute('**/api/auth/organizations');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await page.reload();
    await headingReady();

    // Successful self change: fresh-me 503 surfaces an explicit observed
    // GET-retry action — no initial native exit, no write replay.
    let failFreshMe = true;
    let meGets = 0, meBlocked = 0;
    await page.route('**/api/auth/me', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      if (failFreshMe) { meBlocked += 1; await route.fulfill({ status: 503, json: { error: '합성 세션 조회 장애' } }); }
      else { meGets += 1; await route.continue(); }
    });
    const selfWriteBefore = memberPosts().length;
    await openEditor(ownerId);
    await page.locator(`#org-role-panel-${ownerId}`).getByRole('radio', { name: /조직 구성원/ }).check();
    await page.getByRole('button', { name: '변경 확인', exact: true }).click();
    await page.getByRole('button', { name: '역할을 바꾼다', exact: true }).click();
    const getRetry = page.getByRole('button', { name: '현재 역할 다시 확인', exact: true });
    await getRetry.waitFor();
    await getRetry.click();
    await page.waitForTimeout(2500);
    check('fresh-me 503 triggers no initial native exit', new URL(page.url()).pathname === '/console/team', { url: page.url() });
    check('role write posted exactly once despite the read failure', memberPosts().length === selfWriteBefore + 1, { before: selfWriteBefore, after: memberPosts().length });
    check('fresh-me 503 was actually served', meBlocked >= 1, { meBlocked, meGets });
    const committedAfterSelf = await me(ownerCookie);
    check('server committed the requested MANAGER role', committedAfterSelf.role === 'MANAGER', { role: committedAfterSelf.role });
    const retryCount = await getRetry.count();
    check('explicit observed GET-retry action is offered', retryCount > 0, { labels: retryCount ? await getRetry.allInnerTexts() : [] });
    await capture('fresh-me-503-retry-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('fresh-me-503-retry-390');
    await inspect('fresh-me-503-retry-390');
    await page.setViewportSize({ width: 1280, height: 900 });
    // Requested-vs-observed proof: the independent owner session (created for
    // the P1 recovery above and still valid) changes the actor to STAFF
    // BEFORE the GET-only retry, so the destination can only come from
    // a fresh read — never the requested MANAGER fallback.
    const mutate = await memberWrite(owner2Cookie, orgId, ownerId, { role: 'STAFF', commandId: crypto.randomUUID() });
    check('fixture mutation changes the actor to STAFF before the retry', mutate.status < 300, { status: mutate.status, body: mutate.json });
    failFreshMe = false;
    await getRetry.first().click();
    await page.waitForURL((url) => new URL(url).pathname === '/staff', { timeout: 15000 });
    await page.getByText('배정된 업무가 없습니다.', { exact: false }).waitFor();
    const observedFinal = await me(ownerCookie);
    check('native exit lands on the OBSERVED STAFF home, not requested MANAGER',
      observedFinal.role === 'STAFF' && new URL(page.url()).pathname === '/staff' && meGets >= 1,
      { observedRole: observedFinal.role, path: new URL(page.url()).pathname, meGets, meBlocked });
    check('GET-only recovery replays no role write', memberPosts().length === selfWriteBefore + 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('self-role-observed-staff-empty-390');
    await inspect('self-role-observed-staff-empty-390');
    await page.unroute('**/api/auth/me');

    check('role workflows have no unexpected page errors', errors.length === 0, errors);
    check('response-loss fixtures only replace committed successes', routeFailures.length === 0, routeFailures);
    finished = true;
  } finally {
    fs.writeFileSync(`${OUT}/native-dialogs.json`, JSON.stringify(dialogs, null, 2), { mode: 0o600 });
    fs.writeFileSync(`${OUT}/route-failures.json`, JSON.stringify(routeFailures, null, 2), { mode: 0o600 });
    if (!finished && browser) {
      for (const [contextIndex, context] of browser.contexts().entries()) {
        for (const [pageIndex, page] of context.pages().entries()) {
          await page.screenshot({ path: `${OUT}/failure-context-${contextIndex}-page-${pageIndex}.png`, fullPage: false }).catch((error) => console.error('Failure capture unavailable:', error.message));
        }
      }
    }
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8'), checks, requests, errors, axe, simulation: 'Disposable explicit-org task schema; synthetic second owner/worker/dormant/invited accounts and second org; actual UI role writes; committed 502 via route.fetch-then-fulfill (role write + org create); 503 only for the fresh-me read. P1 cross-owner recovery: second owner moves the uncertain actor to MANAGER, actor refreshes via the account menu, same-org restore stays locked, notice replays the frozen bytes, no auto-exit, explicit home follows the fresh read; actor restored to AGENCY via the second owner + explicit team navigation before the remaining tests. Explicit fixture mutation: second owner moves the self-demoted actor MANAGER->STAFF before the GET-only retry, proving the native exit follows the observed role. No API response fabrication.' }, null, 2), { mode: 0o600 });
    console.log(`Organization role evidence: ${OUT}`);
    if (browser) await browser.close();
    await f.close();
  }
  return { out: OUT, checks };
}

async function main() {
  await runOrganizationRoleAudit();
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { runOrganizationRoleAudit };
