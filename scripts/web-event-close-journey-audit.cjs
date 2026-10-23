'use strict';

// Event-close paired journey: one operator closes out a LIVE event end to
// end against the real isolated stack (random PostgreSQL schema, real API
// harness, owned Next bound to that harness, same-origin gateway). No mocked
// API, no shared/production database, no protected review event.
//
// Modes:
//   --before  the current UI: an operator who already knows the sequence
//             follows existing menu links (approval link, programs screen,
//             settings intake/stage gates, report create dialog + detail
//             freeze, messages composer, archive gate).
//   (default) the linear path: enter the reports map once, then use each
//             workspace's direct next control. Optional closeReturn links
//             are not used in the measured journey.
//
// Step rule: every click/fill/select/check is 1 step. page.goto is used only
// for login/initial overview setup, never measured task navigation. Scrolls are counted with
// a document listener (one gesture = one scroll after settle) and reported,
// not capped. Backs are counted through the goBack wrapper (this journey
// never goes back; the count proves it). Path changes compare pathnames
// only, so hash-only moves never count. Revisit = arrival at an
// already-visited pathname. Each phase stays within 12 operator steps; the
// whole journey adds no new cap.
//
// Messaging posture: provider keys are deleted, EVENTOUCH_SMS_MOCK=1 is set,
// and the result campaign is recorded with simulate=true, so nothing can
// actually send. Fixture setup names the commands it uses.
//
// Order matters: ARCHIVED locks every command write (server/commands/
// domain.js), so the result notice (SIMULATED) runs BEFORE the archive
// step, and the frozen report (PUBLISHED) precedes both.
//
// Scenario (owner, UI-driven, each step verified against the bootstrap):
//   1. approve-pending   overview approval link -> roster -> 선택 승인
//   2. program-close     programs screen -> OPEN module -> 종료
//   3. intake-close      settings -> 접수 닫기 (form.close)
//   4. stage-end         settings stage gate -> LIVE -> ENDED (+ checkpoint)
//   5. report-create     reports -> 보고서 만들기 dialog (DRAFT snapshot)
//   6. report-freeze     report detail -> 공유 완료·잠금 (PUBLISHED)
//   7. result-notify     messages composer, simulate=true -> SIMULATED
//   8. archive           settings stage gate -> ENDED -> ARCHIVED
// Final proof reads the raw DB rows (events.payload.stage, workspace
// reports/messages), not just the projected bootstrap.

for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) {
  delete process.env[key];
}
process.env.EVENTOUCH_SMS_MOCK = '1';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture, FIXTURE_PASSWORD } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const before = process.argv.includes('--before');
const out = `/tmp/opencode/eventouch-captures/round-close/linear${before ? '/reference-direct' : ''}`;
fs.mkdirSync(out, { recursive: true });

const STEP_CAP = 12;
const MODULE_TITLE = '마감 만족도 투표';
const PENDING_NAME = '마감 대기 신청자';
const PENDING_PHONE = '01099998888';
const REPORT_TITLE = '마감 결과 보고서';
const MSG_TITLE = '마감 결과 안내';
const MSG_BODY = '행사 마감 결과를 모의로 안내합니다. 실제 전달 없음.';

// Existing page sections, not new routes or menu destinations.
const HUB = {
  section: '#event-close',
  nextAction: '[data-close-next]',
  backLink: '[data-close-back]',
};

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
  const recoveryEvidence = [];
  try {
    fixture = await startAuditFixture();
    const { harness, helpers } = fixture;
    const baseUrl = fixture.baseUrl;
    const { suffix, eventId } = fixture;
    const eventPath = (rest) => `/console/events/${encodeURIComponent(eventId)}${rest}`;

    const ownerId = `audit-owner-${suffix}`.toLowerCase();
    const ownerEmail = `${ownerId}@example.test`;
    // The fixture seeds a password only for manager/staff; the owner logs in
    // through the real login form, so it needs the same test-only password.
    // This row lives in the dropped isolated schema, never a real account.
    await harness.database.query('UPDATE accounts SET password_hash=$1 WHERE id=$2', [
      helpers.hashPassword(FIXTURE_PASSWORD), ownerId,
    ]);
    const ownerCookie = await helpers.sessionCookie(harness, ownerId);

    // ---- Fixture setup through the real owner commands (never counted) ----
    const setupNotMetrics = [];
    const created = await apiCommand(helpers, harness.baseUrl, ownerCookie, eventId,
      'participant.create', { name: PENDING_NAME, phone: PENDING_PHONE, company: '마감 검증사' });
    setupNotMetrics.push(`participant.create ${created.participant.id} (operator path lands APPROVED)`);
    await apiCommand(helpers, harness.baseUrl, ownerCookie, eventId,
      'participant.status', { id: created.participant.id, status: 'PENDING' });
    setupNotMetrics.push(`participant.status ${created.participant.id} -> PENDING`);
    const savedModule = await apiCommand(helpers, harness.baseUrl, ownerCookie, eventId,
      'module.save', { type: 'poll', title: MODULE_TITLE, options: ['좋았어요', '아쉬워요'] });
    setupNotMetrics.push(`module.save ${savedModule.module.id} (DRAFT)`);
    await apiCommand(helpers, harness.baseUrl, ownerCookie, eventId,
      'module.status', { id: savedModule.module.id, status: 'OPEN' });
    setupNotMetrics.push(`module.status ${savedModule.module.id} -> OPEN`);
    const pendingParticipantId = created.participant.id;
    const openModuleId = savedModule.module.id;

    {
      const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
      const seed = (state.events || []).find((item) => item.id === eventId);
      assert.ok(seed, 'fixture event missing from bootstrap');
      assert.equal(String(seed.stage).toUpperCase(), 'LIVE', 'journey starts at LIVE');
      const people = (state.workspaces[eventId].participants || [])
        .filter((person) => person.status === 'PENDING');
      assert.ok(people.length >= 1, `need PENDING 1+, found ${people.length}`);
      const openModules = (state.workspaces[eventId].modules || [])
        .filter((module) => module.status === 'OPEN');
      assert.equal(openModules.length, 1, `need exactly 1 OPEN module, found ${openModules.length}`);
      assert.equal(state.workspaces[eventId].registrationOpen, true, 'registration must start open (seed form.publish)');
      assert.equal((state.workspaces[eventId].reports || []).length, 0, 'reports must start at 0');
      setupNotMetrics.push(
        `seed verified: stage=LIVE pending=${people.length} openModules=1 registrationOpen=true reports=0`
      );
    }

    browser = await launchBrowser();
    const context = await browser.newContext();

    // Navigation ledger: pathname-only arrivals across the whole run.
    // Hash-only moves never fire framenavigated, and the comparison below
    // uses pathname only, so closeReturn/hash traffic cannot inflate paths.
    const nav = { prev: null, visited: new Set(), revisitedPaths: new Set(), trace: [], pathChanges: 0, revisits: 0, backs: 0 };
    const noteArrival = (pathname) => {
      if (pathname === nav.prev) return;
      const revisit = nav.visited.has(pathname);
      nav.trace.push({ from: nav.prev, to: pathname, revisit });
      if (nav.prev !== null && pathname !== nav.prev) nav.pathChanges += 1;
      if (revisit) { nav.revisits += 1; nav.revisitedPaths.add(pathname); }
      else nav.visited.add(pathname);
      nav.prev = pathname;
    };
    const page = await context.newPage();
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        noteArrival(new URL(frame.url()).pathname);
      } catch {
        // Non-URL arrivals (about:blank) never count as path moves.
      }
    });
    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${String((error && error.message) || error).split('\n')[0]}`);
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      if (!url.startsWith(baseUrl)) return;
      // Anonymous login checks /auth/me before credentials are submitted.
      // This expected 401 is not an authenticated journey failure.
      if (status === 401 && new URL(url).pathname === '/api/auth/me' && new URL(page.url()).pathname === '/login') return;
      if (url.includes('/api/') || response.request().resourceType() === 'document') {
        errors.push(`http ${status}: ${url.split('?')[0].slice(url.indexOf('/', 8))}`);
      }
    });

    // Scroll accounting survives navigation via addInitScript; paused during
    // goto/readiness and captures so setup scrolling is never counted.
    let scrollCounter = null;
    await context.exposeFunction('__closeJourneyScrollTick', (y, now) => {
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
    await page.addInitScript(() => {
      window.addEventListener('scroll', () => {
        try {
          window.__closeJourneyScrollTick(window.scrollY, Date.now());
        } catch {
          // Fire-and-forget accounting.
        }
      }, { passive: true });
    });

    const go = async (target, marker) => {
      if (scrollCounter) scrollCounter.paused = true;
      try {
        await page.goto(baseUrl + target, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator(marker).first().waitFor({ state: 'visible', timeout: 15000 });
      } finally {
        if (scrollCounter) {
          scrollCounter.paused = false;
          scrollCounter.lastY = null;
          scrollCounter.lastTime = 0;
        }
      }
    };
    const goBack = async () => {
      // This journey never goes back; the wrapper exists so the count is
      // honest rather than assumed.
      nav.backs += 1;
      await page.goBack({ waitUntil: 'networkidle', timeout: 30000 });
    };
    const shot = async (name) => {
      await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    };
    const shotBoth = async (name) => {
      if (scrollCounter) scrollCounter.paused = true;
      try {
        await page.waitForLoadState('networkidle');
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await shot(`${name}-1280`);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.scrollTo(0, 0));
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
        steps: 0, clicks: 0, fills: 0, selects: 0, checks: 0, scrolls: 0, writes: 0,
        pathChanges: 0, backs: 0, revisits: 0,
        screens: [], fields: [], state: null, serverNote: '',
        actions: [],
        a11y: { axeBlocking: null, overflow: null, touch: [] },
        passed: false, errors: [],
      };
      const navBefore = { pathChanges: nav.pathChanges, backs: nav.backs, revisits: nav.revisits };
      scrollCounter = { count: 0, lastY: null, lastTime: 0, paused: false };
      const onRequest = (request) => {
        if (request.method() === 'POST' && request.url().includes('/api/')) task.writes += 1;
      };
      page.on('request', onRequest);
      // The instrument wrapper counts every real operator action by kind:
      // click, fill, select and check stay separate in the JSON.
      const act = async (kind, fn2) => {
        assert.ok(['click', 'fill', 'select', 'check'].includes(kind), `unknown act kind ${kind}`);
        task.steps += 1;
        if (kind === 'click') task.clicks += 1;
        else if (kind === 'fill') task.fills += 1;
        else if (kind === 'select') task.selects += 1;
        else task.checks += 1;
        const from = page.url();
        await fn2();
        task.actions.push({ kind, from, to: page.url() });
      };
      // Key action buttons keep the 44px touch target; checked on the real
      // locator about to be clicked, recorded per phase.
      const touchOk = async (locator, label) => {
        await locator.waitFor({ state: 'visible', timeout: 15000 });
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox().catch(() => null);
        const height = box ? Math.round(box.height) : null;
        const pass = height !== null && height >= 44;
        task.a11y.touch.push({ label, height, pass });
        assert.ok(pass, `${key}: touch target ${label} height ${height}px < 44px`);
      };
      try {
        await fn(act, task, { touchOk });
        task.scrolls = scrollCounter ? scrollCounter.count : 0;
        task.pathChanges = nav.pathChanges - navBefore.pathChanges;
        task.backs = nav.backs - navBefore.backs;
        task.revisits = nav.revisits - navBefore.revisits;
        assert.ok(task.steps <= STEP_CAP, `${key}: ${task.steps} steps exceed cap ${STEP_CAP}`);
        task.passed = true;
      } catch (error) {
        task.scrolls = scrollCounter ? scrollCounter.count : 0;
        task.pathChanges = nav.pathChanges - navBefore.pathChanges;
        task.backs = nav.backs - navBefore.backs;
        task.revisits = nav.revisits - navBefore.revisits;
        task.errors.push(String((error && error.message) || error).split('\n')[0]);
        task.urlAtFailure = page.url();
        try {
          await shotBoth(`paired-failure-${key}`);
        } catch {
          // Failure evidence must never be lost to a capture error.
        }
        throw error;
      } finally {
        page.off('request', onRequest);
        scrollCounter = null;
        results.push(task);
      }
      return task;
    };

    async function axeBlocking(page2) {
      await page2.evaluate(axeSource);
      const violations = await page2.evaluate(async () => {
        const result = await window.axe.run(document, {
          resultTypes: ['violations'],
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        });
        return result.violations.map((violation) => ({
          id: violation.id, impact: violation.impact, nodes: violation.nodes.length,
          elements: violation.nodes.map(node => ({ target: node.target, html: node.html, failureSummary: node.failureSummary })),
        }));
      });
      return violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
    }

    async function noOverflow(page2) {
      const box = await page2.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      return { pass: box.scrollWidth <= box.innerWidth, ...box };
    }

    await page.setViewportSize({ width: 1280, height: 900 });

    // ---- Setup (never counted): the owner logs in through the real form ----
    await go('/login', '#login-email');
    await page.locator('#login-email').fill(ownerEmail);
    await page.locator('#login-password').fill(FIXTURE_PASSWORD);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.waitForURL(/\/console/, { timeout: 15000 });
    await page.locator('#console-event-directory').first().waitFor({ state: 'visible', timeout: 15000 });
    {
      const me = await helpers.requestJson(baseUrl, '/api/auth/me', {
        cookie: `etko_session=${sessionValue(ownerCookie)}`,
      });
      void me;
    }
    await go(eventPath(''), '#event-metrics-heading');
    await shotBoth('paired-00-overview-live');
    nav.prev = eventPath('');
    nav.visited = new Set([nav.prev]);
    nav.revisitedPaths.clear();
    nav.trace = [];
    nav.pathChanges = 0;
    nav.revisits = 0;
    nav.backs = 0;

    const moduleCard = () => page.locator('li').filter({
      has: page.getByRole('heading', { name: MODULE_TITLE }),
    });
    const stageSummary = () => page.locator('summary[data-settings-collapse-summary="stage"]');
    const stageOpen = () => page.locator('details[data-settings-collapse="stage"]')
      .evaluate((el) => el.open).catch(() => false);
    const confirmTransition = async (act, task, touch, stageLabel) => {
      const first = page.getByRole('button', { name: `${stageLabel}(으)로 전환`, exact: true });
      await touch(first, `${stageLabel} 전환 열기`);
      await act('click', () => first.click());
      await page.getByRole('group', { name: '단계 전환 확인' }).waitFor({ timeout: 10000 });
      const exact = page.getByRole('button', { name: new RegExp(`^(?:정말 전환합니다 · ${stageLabel} 단계로|정말 ${stageLabel} 단계로 전환합니다)$`) });
      const confirmButton = (await exact.count())
        ? exact
        : page.getByRole('group', { name: '단계 전환 확인' }).getByRole('button', { name: '정말 전환합니다', exact: true });
      await touch(confirmButton.first(), `${stageLabel} 전환 확정`);
      await act('click', () => confirmButton.first().click());
      await page.getByText(new RegExp(`${stageLabel}\\(으\\)로 전환했습니다`), { exact: false }).first().waitFor({ timeout: 15000 });
    };

    // Only initial login/overview use goto. Every measured destination is
    // reached through an existing visible UI link, including section jumps.
    const menuTo = async (rest, marker, act) => {
      const href = eventPath(rest);
      const link = page.locator(`a[href="${href}"]:visible`).first();
      await act('click', () => link.click());
      await page.locator(marker).first().waitFor({ state: 'visible', timeout: 15000 });
    };

    const followNext = async (act, marker, label) => {
      const next = page.locator(HUB.nextAction);
      await next.waitFor({ state: 'visible', timeout: 15000 });
      if (label) assert.match(await next.innerText(), label);
      const href = await next.getAttribute('href');
      if (href) assert.ok(new URL(href, baseUrl).searchParams.get('closeReturn'), 'every departure carries an explicit return path');
      await act('click', () => next.click());
      await page.locator(marker).first().waitFor({ state: 'visible', timeout: 15000 });
    };
    const followLinear = async (act, marker, label) => {
      const next = page.locator('[data-close-linear-next]');
      await next.waitFor({ state: 'visible', timeout: 15000 });
      assert.match(await next.innerText(), label);
      const href = await next.getAttribute('href');
      if (!href.startsWith('#')) assert.ok(new URL(href, baseUrl).searchParams.get('closeReturn'), 'linear handoff retains the optional map return');
      await act('click', () => next.click());
      await page.locator(marker).first().waitFor({ state: 'visible', timeout: 15000 });
    };

    {
      // ---- Phase 1: approve the waiting application from the overview ----
      await measure('approve-pending', '승인 대기 처리 (운영 현황 링크 → 명단 → 선택 승인)', async (act, task, { touchOk }) => {
        task.screens = [eventPath(''), `${eventPath('/participants')}?status=PENDING`];
        task.fields = ['승인 대기 처리 link', '표시 N명 선택', '선택 승인'];
        if (before) {
          const link = page.getByRole('link', { name: '승인 대기 처리' });
          await touchOk(link, '승인 대기 처리');
          await act('click', () => link.click());
        } else {
          await act('click', () => page.getByRole('link', { name: '행사 마감', exact: true }).click());
          await page.locator(HUB.nextAction).waitFor({ state: 'visible', timeout: 15000 });
          await shotBoth('paired-hub-start');
          const disclosure = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '전체 마감 단계와 전제 확인' }) });
          assert.equal(await disclosure.evaluate(el => el.open), false, 'full journey starts folded');
          await followNext(act, 'input[placeholder*="이름·소속·연락처 검색"]', /승인 대기/);
        }
        await page.locator('input[placeholder*="이름·소속·연락처 검색"]').first().waitFor({ state: 'visible', timeout: 15000 });
        const selectVisible = page.getByRole('button', { name: /표시 \d+명 선택/ });
        await touchOk(selectVisible, '표시 선택');
        await act('click', () => selectVisible.click());
        const approve = page.getByRole('button', { name: '선택 승인', exact: true });
        await touchOk(approve, '선택 승인');
        await act('click', () => approve.click());
        await page.getByText(/명을 승인했습니다/, { exact: false }).first().waitFor({ timeout: 15000 });
        const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
        const pending = (state.workspaces[eventId].participants || []).filter((person) => person.status === 'PENDING');
        assert.equal(pending.length, 0, `PENDING must be empty, found ${pending.length}`);
        task.state = `participants: pending=0 approved=${(state.workspaces[eventId].participants || []).filter((p) => p.status === 'APPROVED').length}`;
        task.serverNote = 'setup participant.create (APPROVED) + participant.status (PENDING); UI bulk 승인 처리';
        task.a11y.axeBlocking = await axeBlocking(page);
        assert.equal(task.a11y.axeBlocking.length, 0, `axe blocking: ${JSON.stringify(task.a11y.axeBlocking)}`);
        task.a11y.overflow = await noOverflow(page);
        assert.ok(task.a11y.overflow.pass, `horizontal overflow ${task.a11y.overflow.scrollWidth} > ${task.a11y.overflow.innerWidth}`);
        await shotBoth('paired-01-approved');
      });

      // ---- Phase 2: close the running participation program ----
      await measure('program-close', '진행 프로그램 종료 (참여 프로그램 → 종료 → 종료한다)', async (act, task, { touchOk }) => {
        task.screens = [eventPath('/programs')];
        task.fields = ['module 종료 button', 'ConsoleConfirm 종료한다'];
        if (before) await menuTo('/programs', 'text=프로그램 만들기', act);
        else {
          await page.getByText('승인 대기 없음', { exact: true }).waitFor();
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-close-linear-next'));
          await shotBoth('linear-approved-next');
          await followLinear(act, 'text=프로그램 만들기', /진행 중 프로그램 닫기/);
        }
        const card = moduleCard();
        await card.getByRole('heading', { name: MODULE_TITLE }).waitFor({ timeout: 10000 });
        const closeButton = card.getByRole('button', { name: '종료', exact: true });
        await touchOk(closeButton, '프로그램 종료');
        await act('click', () => closeButton.click());
        const confirm = page.getByRole('button', { name: '종료한다', exact: true });
        await touchOk(confirm, '종료 확정');
        await act('click', () => confirm.click());
        await page.getByText(/프로그램을 종료했습니다/, { exact: false }).first().waitFor({ timeout: 15000 });
        const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
        const module = (state.workspaces[eventId].modules || []).find((item) => item.id === openModuleId);
        assert.ok(module, 'setup module missing from workspace.modules');
        assert.equal(module.status, 'CLOSED');
        if (!before) {
          await page.getByText('진행 중 프로그램 없음', { exact: true }).waitFor();
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-close-linear-next'));
        }
        task.state = `modules: id=${module.id} status=${module.status}`;
        task.serverNote = 'setup module.save (poll) + module.status OPEN; UI 종료 확정';
      });

      // ---- Phase 3: close registration (form.close) ----
      await measure('intake-close', '참가 접수 닫기 (행사 설정 → 접수 닫기)', async (act, task, { touchOk }) => {
        task.screens = [eventPath('/settings')];
        task.fields = ['접수 닫기 button'];
        if (before) await menuTo('/settings', '#set-name', act);
        else { await followLinear(act, '#set-name', /참가 접수 닫기/); }
        await page.locator('#settings-intake').waitFor({ state: 'visible', timeout: 15000 });
        const close = page.getByRole('button', { name: '접수 닫기', exact: true });
        await touchOk(close, '접수 닫기');
        await act('click', () => close.click());
        await page.getByText(/접수를 닫았습니다/, { exact: false }).first().waitFor({ timeout: 15000 });
        const workspace = (await readBootstrap(helpers, harness.baseUrl, ownerCookie)).workspaces[eventId];
        assert.equal(workspace.registrationOpen, false);
        if (!before) {
          await page.getByText('참가 접수 닫힘 · 진행 단계도 같은 화면에서 처리할 수 있습니다.', { exact: true }).waitFor();
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-close-linear-next'));
        }
        task.state = `workspace: registrationOpen=${workspace.registrationOpen}`;
        task.serverNote = 'server/commands/preparation.js form.close sets registrationOpen false';
      });

      // ---- Phase 4: LIVE -> ENDED through the stage gate ----
      let endedStage = null;
      await measure('stage-end', '종료 단계로 전환 (진행 단계 → 종료(으)로 전환 → 확정)', async (act, task, { touchOk }) => {
        task.screens = [eventPath('/settings')];
        task.fields = ['summary[data-settings-collapse-summary=stage]', '종료(으)로 전환', '단계 전환 확인 / 정말 전환합니다'];
        if (before) await act('click', () => page.locator('a[href="#settings-stage"]:visible').first().click());
        else {
          const pathBefore = new URL(page.url()).pathname;
          await followLinear(act, 'summary[data-settings-collapse-summary="stage"]', /ENDED/);
          assert.equal(new URL(page.url()).pathname, pathBefore, 'intake and ENDED stay in one settings visit');
        }
        if (!before) await page.waitForFunction(() => document.querySelector('details[data-settings-collapse="stage"]')?.open === true);
        if (!(await stageOpen())) {
          await touchOk(stageSummary(), '진행 단계 펼치기');
          await act('click', () => stageSummary().click());
          task.serverNote = 'details were collapsed after reload; expansion counted as 1 step. ';
        } else {
          task.serverNote = 'details stayed expanded after reload; no expansion step needed. ';
        }
        await confirmTransition(act, task, touchOk, '종료');
        const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
        endedStage = String((state.events || []).find((item) => item.id === eventId).stage).toUpperCase();
        assert.equal(endedStage, 'ENDED');
        if (!before) {
          await page.getByText('행사 종료 확인 · 다음은 보고서입니다.', { exact: true }).waitFor();
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-close-linear-next'));
        }
        task.state = `events: id=${eventId} stage=${endedStage}`;
        task.serverNote += 'archive gate needs registration closed + no OPEN modules; both held.';
        task.a11y.axeBlocking = await axeBlocking(page);
        assert.equal(task.a11y.axeBlocking.length, 0, `axe blocking: ${JSON.stringify(task.a11y.axeBlocking)}`);
        await shotBoth('paired-04-ended');
      });

      // ---- Phase 5: freeze the closing numbers in a draft report ----
      let reportId = null;
      await measure('report-create', '마감 보고서 만들기 (결과 보고서 → 보고서 만들기 dialog)', async (act, task, { touchOk }) => {
        task.screens = [eventPath('/reports')];
        task.fields = ['보고서 만들기 button', '#report-title', 'dialog submit 보고서 만들기'];
        if (before) {
          await menuTo('/reports', '#reports-list', act);
          const open = page.getByRole('button', { name: '보고서 만들기', exact: true }).first();
          await touchOk(open, '보고서 만들기 열기');
          await act('click', () => open.click());
        } else {
          await followLinear(act, HUB.nextAction, /보고서 만들기\/동결/);
          await followNext(act, '#report-title', /마감 보고서 만들기/);
        }
        await page.locator('#report-title').waitFor({ state: 'visible', timeout: 10000 });
        await act('fill', () => page.locator('#report-title').fill(REPORT_TITLE));
        const submit = page.getByRole('dialog').getByRole('button', { name: '보고서 만들기', exact: true });
        await touchOk(submit, '보고서 만들기 제출');
        await act('click', () => submit.click());
        await page.getByText(/보고서 초안을 만들었습니다/, { exact: false }).first().waitFor({ timeout: 15000 });
        const workspace = (await readBootstrap(helpers, harness.baseUrl, ownerCookie)).workspaces[eventId];
        assert.equal((workspace.reports || []).length, 1, 'exactly 1 report expected');
        assert.equal(workspace.reports[0].status, 'DRAFT');
        reportId = workspace.reports[0].id;
        task.state = `reports: id=${reportId} status=DRAFT title=${workspace.reports[0].title}`;
        task.serverNote = 'report.create snapshots current metrics; later ops changes never rewrite it';
      });

      // ---- Phase 6: review the frozen content and lock it (PUBLISHED) ----
      await measure('report-freeze', '보고서 검토·동결 (내용 보기 → 공유 완료로 표시 → 공유 완료·잠금)', async (act, task, { touchOk }) => {
        task.screens = [eventPath('/reports'), `${eventPath('/reports')}#report-* (detail)`];
        task.fields = ['내용 보기', '공유 완료로 표시', '공유 완료·잠금'];
        if (before) {
          const row = page.locator('li').filter({ hasText: REPORT_TITLE });
          const detail = row.getByRole('button', { name: '내용 보기', exact: true });
          await touchOk(detail, '내용 보기');
          await act('click', () => detail.click());
        }
        await page.getByText('보고서 내용', { exact: true }).first().waitFor({ timeout: 15000 });
        const mark = page.getByRole('button', { name: '공유 완료로 표시', exact: true });
        await touchOk(mark, '공유 완료로 표시');
        await act('click', () => mark.click());
        const lock = page.getByRole('button', { name: '공유 완료·잠금', exact: true });
        await touchOk(lock, '공유 완료·잠금');
        const published = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'report.publish');
        await act('click', () => lock.click());
        assert.ok((await published).ok(), 'report.publish must commit successfully');
        await page.getByText('공유 완료를 기록하고 이 버전을 잠갔습니다. 고객사에 자동 전송되지는 않습니다.', { exact: true }).waitFor({ timeout: 15000 });
        const workspace = (await readBootstrap(helpers, harness.baseUrl, ownerCookie)).workspaces[eventId];
        const report = (workspace.reports || []).find((item) => item.id === reportId);
        assert.ok(report, 'created report missing after freeze');
        assert.equal(report.status, 'PUBLISHED');
        if (!before) {
          await page.locator('[data-close-report-progress]').filter({ hasText: '완료' }).waitFor();
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-close-report-next'));
        }
        task.state = `reports: id=${report.id} status=${report.status} version=${report.version}`;
        task.serverNote = 'report.publish locks the version; no auto-send to the client happens';
        task.a11y.axeBlocking = await axeBlocking(page);
        assert.equal(task.a11y.axeBlocking.length, 0, `axe blocking: ${JSON.stringify(task.a11y.axeBlocking)}`);
        task.a11y.overflow = await noOverflow(page);
        assert.ok(task.a11y.overflow.pass, `horizontal overflow ${task.a11y.overflow.scrollWidth} > ${task.a11y.overflow.innerWidth}`);
        await shotBoth('paired-06-report-published');
      });

      // ---- Phase 7: result notice as a SIMULATED campaign (never a send) ----
      await measure('result-notify', '결과 안내 모의 발송 (메시지 작성 → 모의 기록 → 확정)', async (act, task, { touchOk }) => {
        task.screens = [eventPath('/messages')];
        task.fields = ['#campaign-title', '#campaign-body', '모의 발송으로 기록 checkbox', '수신자 목록 열기·닫기', '표시 추가', '모의 발송 기록', '모의 발송을 기록한다'];
        if (before) await menuTo('/messages', '#campaign-title', act);
        else {
          await act('click', () => page.locator('[data-close-report-next]').click());
          await page.locator('#campaign-title').waitFor({ state: 'visible', timeout: 15000 });
          assert.ok(new URL(page.url()).searchParams.get('closeReturn').includes('closeReport='), 'chosen report survives the messages handoff');
        }
        await act('fill', () => page.locator('#campaign-title').fill(MSG_TITLE));
        await act('fill', () => page.locator('#campaign-body').fill(MSG_BODY));
        const simulate = page.getByRole('checkbox', { name: /모의 발송으로 기록/ });
        await act('check', () => simulate.check());
        assert.ok(await simulate.isChecked(), 'simulate must stay checked: real send is forbidden');
        const list = page.locator('summary').filter({ hasText: '수신자 목록 열기·닫기' });
        await act('click', () => list.click());
        const addVisible = page.getByRole('button', { name: '표시 추가', exact: true });
        await act('click', () => addVisible.click());
        const submit = page.getByRole('button', { name: '모의 발송 기록', exact: true });
        await touchOk(submit, '모의 발송 기록');
        await act('click', () => submit.click());
        const confirm = page.getByRole('button', { name: '모의 발송을 기록한다', exact: true });
        await act('click', () => confirm.click());
        await page.getByText(/모의 발송을 기록했습니다/, { exact: false }).first().waitFor({ timeout: 15000 });
        const workspace = (await readBootstrap(helpers, harness.baseUrl, ownerCookie)).workspaces[eventId];
        const campaign = (workspace.messages || [])[0];
        assert.ok(campaign, 'campaign missing from workspace.messages');
        assert.equal(campaign.status, 'SIMULATED');
        assert.equal(campaign.simulate, true, 'campaign must carry simulate=true');
        task.state = `messages: id=${campaign.id} status=${campaign.status} simulate=${campaign.simulate} recipients=${(campaign.recipientIds || []).length}`;
        task.serverNote = 'message.create with simulate=true; EVENTOUCH_SMS_MOCK=1 and provider keys deleted; no dispatch runs';
        await shotBoth('paired-07-result-simulated');
      });

      // ---- Phase 8: archive only after the result notice (writes lock) ----
      await measure('archive', '보관 단계로 전환 (진행 단계 → 보관(으)로 전환 → 확정)', async (act, task, { touchOk }) => {
        task.screens = [eventPath(before ? '/settings' : '/messages')];
        task.fields = before ? ['summary[data-settings-collapse-summary=stage] (collapsed only)', '보관(으)로 전환', '단계 전환 확인 / 정말 전환합니다'] : ['다음: 보관', 'shared 단계 전환 확인 / 정말 전환합니다'];
        if (before) {
          await menuTo('/settings', 'summary[data-settings-collapse-summary="stage"]', act);
          await act('click', () => page.locator('a[href="#settings-stage"]:visible').first().click());
          if (!(await stageOpen())) {
            await touchOk(stageSummary(), '진행 단계 펼치기');
            await act('click', () => stageSummary().click());
          }
          await confirmTransition(act, task, touchOk, '보관');
        } else {
          await page.getByText('모의 안내 기록 확인 · 실제로 전달되지 않았습니다.', { exact: true }).waitFor();
          const from = new URL(page.url()).pathname;
          const archive = page.locator('[data-close-inline-archive]');
          await touchOk(archive, '다음: 보관');
          await act('click', () => archive.click());
          await page.getByRole('group', { name: '단계 전환 확인' }).waitFor();
          await shotBoth('linear-inline-archive-confirm');
          const confirm = page.getByRole('button', { name: '정말 전환합니다 · 보관 단계로', exact: true });
          await touchOk(confirm, '보관 확인');
          task.a11y.axeBlocking = await axeBlocking(page);
          assert.equal(task.a11y.axeBlocking.length, 0, `inline archive axe blocking: ${JSON.stringify(task.a11y.axeBlocking)}`);
          task.a11y.overflow = await noOverflow(page);
          assert.ok(task.a11y.overflow.pass, 'inline archive must not overflow');
          const committed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'event.stage');
          await act('click', () => confirm.click());
          assert.ok((await committed).ok());
          await page.getByText('행사를 보관(으)로 전환했습니다.', { exact: true }).waitFor();
          assert.equal(new URL(page.url()).pathname, from, 'result notice and archive stay on the messages screen');
          task.serverNote = 'Existing event.stage ARCHIVED and shared stage confirmation, executed inline after notice; no second settings visit. ';
        }
        const state = await readBootstrap(helpers, harness.baseUrl, ownerCookie);
        assert.equal(String((state.events || []).find((item) => item.id === eventId).stage).toUpperCase(), 'ARCHIVED');
        task.state = `events: id=${eventId} stage=ARCHIVED`;
        task.serverNote += 'domain.js rejects every command write at ARCHIVED, so result-notify ran first by design.';
        await shotBoth('paired-08-archived');
        if (!before) {
          await page.getByText('보관 완료 · 읽기 전용입니다.', { exact: true }).waitFor({ timeout: 15000 });
          assert.equal(await page.locator('[data-close-linear-next]').count(), 0, 'archived step has no write next action');
          await shotBoth('linear-completed-messages');
        }
      });

      // ENDED checkpoint: the intermediate stage was proven, not skipped.
      assert.equal(endedStage, 'ENDED', 'stage-end must prove the ENDED intermediate before archive');
    }

    // ---- Final proof against the raw DB rows ----
    const eventRow = await harness.database.query('SELECT payload FROM events WHERE id = $1', [eventId]);
    const workspaceRow = await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]);
    const finalEvent = eventRow.rows[0] && eventRow.rows[0].payload;
    const finalWorkspace = workspaceRow.rows[0] && workspaceRow.rows[0].payload;
    assert.ok(finalEvent, 'events row missing for the journey event');
    assert.ok(finalWorkspace, 'event_workspaces row missing for the journey event');
    assert.equal(String(finalEvent.stage).toUpperCase(), 'ARCHIVED', 'DB events.payload.stage must be ARCHIVED');
    const finalReports = Array.isArray(finalWorkspace.reports) ? finalWorkspace.reports : [];
    assert.ok(finalReports.length >= 1, 'DB workspace must keep the closing report');
    const finalReport = finalReports[0];
    assert.equal(finalReport.status, 'PUBLISHED', 'DB report must be PUBLISHED (frozen)');
    const finalMessages = Array.isArray(finalWorkspace.messages) ? finalWorkspace.messages : [];
    const simulated = finalMessages.find((message) => message && message.status === 'SIMULATED');
    assert.ok(simulated, 'DB workspace must keep the SIMULATED result campaign');
    assert.equal(simulated.simulate, true, 'DB campaign must carry simulate=true');

    if (errors.length) throw new Error(`browser errors: ${errors.join(' | ').slice(0, 500)}`);
    const totals = results.reduce((sum, task) => ({
      steps: sum.steps + task.steps,
      clicks: sum.clicks + task.clicks,
      fills: sum.fills + task.fills,
      selects: sum.selects + task.selects,
      checks: sum.checks + task.checks,
      writes: sum.writes + task.writes,
      pathChanges: sum.pathChanges + task.pathChanges,
      backs: sum.backs + task.backs,
      revisits: sum.revisits + task.revisits,
    }), { steps: 0, clicks: 0, fills: 0, selects: 0, checks: 0, writes: 0, pathChanges: 0, backs: 0, revisits: 0 });
    const measuredNavigation = [...nav.trace];
    const revisitedScreens = [...nav.revisitedPaths];
    if (!before) {
      assert.ok(totals.pathChanges <= 6, `linear path ${totals.pathChanges} exceeds original before 6; do not raise this goal`);
      assert.equal(measuredNavigation.filter(move => move.to === eventPath('/settings')).length, 1, 'one settings visit handles intake and ENDED');
      assert.equal(new URL(page.url()).pathname, eventPath('/messages'), 'archive finishes on messages with no forced settings/map return');
    }
    const stateChecks = [];
    if (!before) {
      // Separate, unmeasured recovery fixtures inside this same owned schema.
      // Never mutate the completed journey or the shared review event.
      const seedVariant = async (name) => {
        const id = `close-state-${crypto.randomUUID()}`;
        await helpers.insertEvent(harness.database, {
          id, slug: id,
          payload: { id, slug: id, name, stage: 'LIVE', date: '2027-01-16', features: ['poll'] },
          workspace: helpers.emptyWorkspace(),
        });
        return id;
      };
      const staleId = await seedVariant('이미 종료된 마감 예외');
      const pending = await apiCommand(helpers, harness.baseUrl, ownerCookie, staleId, 'participant.create', { name: '종료 잔여 대기', phone: '01099997777' });
      await apiCommand(helpers, harness.baseUrl, ownerCookie, staleId, 'participant.status', { id: pending.participant.id, status: 'PENDING' });
      const old = await apiCommand(helpers, harness.baseUrl, ownerCookie, staleId, 'report.create', { title: '이전 동결 보고서', sections: ['overview', 'attendance'] });
      await apiCommand(helpers, harness.baseUrl, ownerCookie, staleId, 'report.publish', { id: old.report.id });
      await apiCommand(helpers, harness.baseUrl, ownerCookie, staleId, 'event.stage', { stage: 'ENDED' });
      await go(`/console/events/${staleId}/reports#event-close`, HUB.nextAction);
      await page.getByText(/승인 대기 1명이 남아 있지만 종료 이후에는 참가자를 변경할 수 없습니다/).waitFor();
      assert.equal(await page.locator(HUB.nextAction).innerText(), '마감 보고서 만들기', 'a previous PUBLISHED report is not silently chosen for this close');
      const summary = page.locator('summary').filter({ hasText: '전체 마감 단계와 전제 확인' });
      await summary.focus(); await page.keyboard.press('Enter');
      assert.equal(await summary.locator('..').evaluate(el => el.open), true);
      await page.keyboard.press('Space');
      assert.equal(await summary.locator('..').evaluate(el => el.open), false);
      await shotBoth('states-ended-pending-old-published');
      await page.locator(HUB.nextAction).click();
      const endedDialog = page.getByRole('dialog');
      await endedDialog.getByText(/종료 이후에는 참가자 승인 상태를 변경할 수 없습니다/).waitFor();
      assert.equal(await endedDialog.getByRole('link', { name: '참가자에서 승인 처리하기', exact: true }).count(), 0, 'ENDED create dialog must not offer an impossible approval action');
      await shotBoth('states-ended-pending-create-dialog');
      await page.keyboard.press('Escape');
      stateChecks.push('ENDED pending: immutable warning, no impossible approval next; old PUBLISHED not auto-selected; Enter/Space disclosure');
      await page.getByRole('button', { name: '내용 보기', exact: true }).click();
      await page.waitForFunction(() => { const rect = document.getElementById('report-detail')?.getBoundingClientRect(); return rect && rect.top >= 0 && rect.top < innerHeight; });
      await page.locator('[data-report-close-return]').click();
      await page.locator(HUB.nextAction).waitFor();
      assert.match(await page.locator(HUB.nextAction).innerText(), /결과 안내/);
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator(HUB.nextAction).waitFor();
      assert.match(await page.locator(HUB.nextAction).innerText(), /결과 안내/);
      stateChecks.push('explicit report selection survives reload; capture basis stays visible');
      await go(`/console/events/${staleId}/programs?closeReturn=${encodeURIComponent(`/console/events/${staleId}/reports?closeReport=${old.report.id}#event-close`)}`, '[data-close-linear-next]');
      await page.getByText(/미충족 전제: 승인 대기 1명 미처리/).waitFor();
      assert.match(await page.locator('[data-close-linear-next]').getAttribute('href'), /\/messages\?/);
      assert.equal(await page.locator('[data-close-linear-next]').isEnabled(), true, 'out-of-order progression is warned, not blocked');
      await shotBoth('linear-out-of-order-warning');
      stateChecks.push('out-of-order entry shows unfinished approval facts and leaves the next control available');
      await page.locator('[data-close-linear-next]').click();
      await page.locator('[data-close-inline-archive]').waitFor();
      await page.locator('#campaign-title').fill('미저장 안내 초안');
      let archiveDraftCancelled = false;
      page.once('dialog', async dialog => { archiveDraftCancelled = true; await dialog.dismiss(); });
      await page.locator('[data-close-inline-archive]').click();
      assert.equal(archiveDraftCancelled, true, 'inline archive respects the existing unsaved-message guard');
      assert.equal(await page.getByRole('group', { name: '단계 전환 확인' }).count(), 0);
      await page.locator('#campaign-title').fill('');
      const archiveAttempts = [];
      let loseArchiveReply = true;
      const archiveRoute = async route => {
        const payload = route.request().postDataJSON();
        if (payload.command === 'event.stage' && payload.payload?.stage === 'ARCHIVED') {
          archiveAttempts.push(payload.commandId);
          if (loseArchiveReply) {
            loseArchiveReply = false;
            const actual = await route.fetch();
            assert.ok(actual.ok(), 'fault injection happens only after a real successful API commit');
            await route.abort('connectionreset');
            return;
          }
        }
        await route.continue();
      };
      await page.route(`**/api/events/${staleId}/commands`, archiveRoute);
      await page.locator('[data-close-inline-archive]').focus();
      await page.keyboard.down('Enter');
      await page.getByRole('group', { name: '단계 전환 확인' }).waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '정말 전환합니다 · 보관 단계로');
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      assert.equal(archiveAttempts.length, 0, 'held Enter repeat must not auto-confirm archive');
      await page.getByRole('button', { name: '정말 전환합니다 · 보관 단계로', exact: true }).click();
      await page.getByText('보관 응답을 확인하지 못했습니다. 이미 보관됐을 수 있습니다. 같은 요청으로 다시 확인하세요.', { exact: true }).waitFor();
      const lostStage = (await readBootstrap(helpers, harness.baseUrl, ownerCookie)).events.find(e => e.id === staleId).stage;
      assert.equal(lostStage, 'ARCHIVED', 'archive committed even though its UI response was lost');
      await shotBoth('linear-inline-archive-committed-response-loss');
      await page.getByRole('button', { name: '같은 요청 다시 시도 · 보관 단계로', exact: true }).click();
      await page.getByText('보관 완료 · 읽기 전용입니다.', { exact: true }).waitFor();
      assert.equal(archiveAttempts.length, 2);
      assert.equal(new Set(archiveAttempts).size, 1, 'inline archive retries the exact same receipt');
      await page.unroute(`**/api/events/${staleId}/commands`, archiveRoute);
      recoveryEvidence.push({ case: 'inline archive committed-response loss', eventId: staleId, commandIds: archiveAttempts, stageBeforeRetry: lostStage, unsavedDraftCancellation: archiveDraftCancelled });
      stateChecks.push('inline archive shares stage confirmation; cancels dirty notice; suppresses held Enter repeat; real commit plus lost reply retries the same commandId');

      const refreshArchiveId = await seedVariant('보관 응답 재조회 복구');
      const refreshReport = await apiCommand(helpers, harness.baseUrl, ownerCookie, refreshArchiveId, 'report.create', { title: '재조회 복구 보고서', sections: ['overview'] });
      await apiCommand(helpers, harness.baseUrl, ownerCookie, refreshArchiveId, 'report.publish', { id: refreshReport.report.id });
      await apiCommand(helpers, harness.baseUrl, ownerCookie, refreshArchiveId, 'event.stage', { stage: 'ENDED' });
      await go(`/console/events/${refreshArchiveId}/messages?closeReturn=${encodeURIComponent(`/console/events/${refreshArchiveId}/reports?closeReport=${refreshReport.report.id}#event-close`)}`, '[data-close-inline-archive]');
      let refreshLost = false;
      const refreshLossRoute = async route => {
        const payload = route.request().postDataJSON();
        if (!refreshLost && payload.command === 'event.stage' && payload.payload?.stage === 'ARCHIVED') {
          refreshLost = true;
          const actual = await route.fetch(); assert.ok(actual.ok());
          await route.abort('connectionreset');
        } else await route.continue();
      };
      await page.route(`**/api/events/${refreshArchiveId}/commands`, refreshLossRoute);
      await page.locator('[data-close-inline-archive]').click();
      await page.getByRole('button', { name: '정말 전환합니다 · 보관 단계로', exact: true }).click();
      await page.getByText('보관 응답을 확인하지 못했습니다. 이미 보관됐을 수 있습니다. 같은 요청으로 다시 확인하세요.', { exact: true }).waitFor();
      await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
      await page.getByText('서버 재조회에서 보관된 행사임을 확인했습니다.', { exact: true }).waitFor();
      await page.getByText('보관 완료 · 읽기 전용입니다.', { exact: true }).waitFor();
      let refreshGuardBlocked = false;
      const refreshGuard = async dialog => { refreshGuardBlocked = true; await dialog.dismiss(); };
      page.on('dialog', refreshGuard);
      await page.locator(HUB.backLink).click();
      await page.getByText('보관된 행사입니다. 분석과 동결 보고서는 읽기 전용이며, 메시지 작성·발송과 행사 변경은 잠겨 있습니다.', { exact: true }).waitFor();
      page.off('dialog', refreshGuard);
      assert.equal(refreshGuardBlocked, false, 'verified ARCHIVED refresh resolves the obsolete unconfirmed-write guard');
      await page.unroute(`**/api/events/${refreshArchiveId}/commands`, refreshLossRoute);
      recoveryEvidence.push({ case: 'inline archive lost reply resolved by authoritative refresh', eventId: refreshArchiveId, guardBlockedAfterVerifiedRefresh: refreshGuardBlocked });
      stateChecks.push('authoritative ARCHIVED refresh resolves unknown archive intent and permits optional map navigation without a stale guard');

      const disabledId = await seedVariant('기능 꺼짐 복구');
      const mod = await apiCommand(helpers, harness.baseUrl, ownerCookie, disabledId, 'module.save', { type: 'poll', title: '닫아야 할 투표', options: ['A', 'B'] });
      await apiCommand(helpers, harness.baseUrl, ownerCookie, disabledId, 'module.status', { id: mod.module.id, status: 'OPEN' });
      await apiCommand(helpers, harness.baseUrl, ownerCookie, disabledId, 'event.features', { features: [] });
      await go(`/console/events/${disabledId}/reports#event-close`, HUB.nextAction);
      assert.match(await page.locator(HUB.nextAction).innerText(), /프로그램 기능 설정/);
      await shotBoth('states-disabled-open-module');
      await page.locator(HUB.nextAction).focus(); await page.keyboard.press('Enter');
      await page.getByRole('checkbox', { name: '투표', exact: true }).waitFor();
      await page.getByRole('checkbox', { name: '투표', exact: true }).check();
      let discarded = false;
      page.once('dialog', async dialog => { discarded = true; await dialog.dismiss(); });
      await page.locator('[data-close-linear-next]').click();
      assert.equal(discarded, true, 'linear next uses the existing unsaved-change guard');
      assert.equal(new URL(page.url()).pathname, `/console/events/${disabledId}/settings`);
      await page.getByRole('button', { name: '기능 저장', exact: true }).click();
      await page.getByText('기능 설정을 저장했습니다.', { exact: false }).first().waitFor();
      await page.locator('[data-close-linear-next]').click();
      await page.getByRole('button', { name: '종료', exact: true }).waitFor();
      stateChecks.push('OPEN+feature OFF routes to settings; keyboard entry; unsaved linear-next cancellation; real event.features then direct programs handoff');
      await page.getByRole('button', { name: '종료', exact: true }).click();
      await page.getByRole('button', { name: '종료한다', exact: true }).click();
      await page.getByText(/프로그램을 종료했습니다/).first().waitFor();
      await page.getByText('진행 중 프로그램 없음', { exact: true }).waitFor();
      assert.match(await page.locator('[data-close-linear-next]').getAttribute('href'), /closeStep=end/, 'already-closed intake is skipped');
      stateChecks.push('already-closed intake skips straight from program completion to the existing ENDED control');
      await page.route('**/api/bootstrap', route => route.abort('connectionreset'));
      await page.locator(HUB.backLink).click();
      await page.getByText('연결하지 못했습니다. 다시 시도하세요.', { exact: true }).waitFor();
      assert.equal(await page.locator(HUB.nextAction).count(), 0, 'failed return never displays a stale next action');
      await shotBoth('states-return-network-error');
      await page.unroute('**/api/bootstrap');
      await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
      await page.locator(HUB.nextAction).waitFor();
      assert.match(await page.locator(HUB.nextAction).innerText(), /종료/);
      stateChecks.push('simulated transport loss on return: error+retry, stale checklist hidden; real bootstrap recovery');
      await go(`/console/events/${disabledId}/messages?closeReturn=${encodeURIComponent('https://evil.test')}`, '#campaign-title');
      assert.equal(await page.locator(HUB.backLink).count(), 0);
      stateChecks.push('external closeReturn ignored in actual render');
    }
    assert.equal(errors.length, 0, `browser errors including recovery states: ${errors.join(' | ')}`);
    const report = {
      before, build: buildId(),
      mode: before
        ? 'known-sequence direct menu route + report detail freeze'
        : 'linear event-close path; optional map returns only; one settings intake/end visit',
      comparisonNote: 'Same initial overview and LIVE/pending=1/open=1/intake-open/no-report scenario. All pathname moves including overview→map are counted. Entry-only numbers subtract exactly that recorded first move, not an invisible setup navigation.',
      fixture: 'isolated random schema; owner UI login with the test-only password; PENDING via participant.create+participant.status; OPEN poll via module.save+module.status; every counted step is a real UI op verified by bootstrap re-read',
      setupNotMetrics,
      eventId, pendingParticipantId, openModuleId,
      finalDb: {
        stage: finalEvent.stage,
        reportStatus: finalReport.status,
        reportId: finalReport.id,
        simulatedMessageId: simulated.id,
        simulate: simulated.simulate,
      },
      totals,
      fromMapEntry: before ? null : { pathChanges: totals.pathChanges - 1, clicks: totals.clicks - 1, excluded: 'only the measured overview→reports map launcher click/path change' },
      inputCounting: { buttonAndLinkClicks: totals.clicks, checkboxChoices: totals.checks, pointerActionsIncludingChecks: totals.clicks + totals.checks, fillActions: totals.fills, note: 'The table may show click+check as pointer actions; fills stay separate. Initial login and initial overview goto are setup in both modes.' },
      measuredNavigation,
      revisitedScreens,
      stateChecks,
      recoveryEvidence,
      results, errors,
    };
    fs.writeFileSync(path.join(out, 'journey-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(results.map((task) => ({
      key: task.key, steps: task.steps, clicks: task.clicks, fills: task.fills,
      selects: task.selects, checks: task.checks, scrolls: task.scrolls, writes: task.writes,
      pathChanges: task.pathChanges, backs: task.backs, revisits: task.revisits,
      screens: task.screens, fields: task.fields, state: task.state,
    })), null, 2));
    await context.close();
  } catch (error) {
    fs.writeFileSync(path.join(out, `journey-failure-${Date.now()}.json`), JSON.stringify({ before, build: buildId(), results, errors, failure: String(error) }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
