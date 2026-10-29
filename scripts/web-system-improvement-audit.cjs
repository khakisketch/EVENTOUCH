'use strict';

// Task-owned synthetic runtime. Never connects to the deployed UI or its DB.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { loadPlaywright } = require('./audit-browser.cjs');
const captureRoot = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`system-improvement-20261024/ux-${runStamp()}`);
const runId = process.env.EVENTOUCH_AUDIT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(captureRoot, `system-ui-${runId}`);

async function settleVisualState(page) {
  // Readiness markers can appear during the finite page-entry fade. Wait for
  // its real completion before capturing/measuring settled text contrast;
  // do not turn off motion or remove any contrast rule.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations()
      .filter(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime))
      .map(a => a.finished.catch(() => {})));
  });
}

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const f = await startAuditFixture({ loseFirstResponseFor: ['check.correct'] });
  const checks = [], errors = [], requests = [], accessibility = [];
  let browser;
  const check = (name, ok, details = null) => {
    checks.push({ name, ok: Boolean(ok), details });
    assert.ok(ok, `${name}: ${JSON.stringify(details)}`);
  };
  const checkAccessibility = async (page, name) => {
    await settleVisualState(page);
    await page.evaluate(require('axe-core').source);
    const raw = await page.evaluate(async () => {
      const animations = document.getAnimations().map(a => ({ state: a.playState, time: a.currentTime }));
      const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      return { animations, violations: result.violations };
    });
    if (raw.violations.length) fs.writeFileSync(path.join(OUT, `axe-${name}.json`), JSON.stringify(raw, null, 2), { mode: 0o600 });
    const violations = raw.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length }));
    accessibility.push({ name, violations });
    check(`${name} axe has no serious or critical violations`, !violations.some((row) => ['serious', 'critical'].includes(row.impact)), violations);
  };
  const api = (url, options = {}) => f.helpers.requestJson(f.harness.baseUrl, url, { cookie: f.manager.cookie, ...options });
  const command = async (name, payload) => {
    const response = await api(`/api/events/${f.eventId}/commands`, { method: 'POST', body: { commandId: crypto.randomUUID(), command: name, payload } });
    assert.ok(response.status < 300, `${name}: ${JSON.stringify(response.json)}`);
    return response.json;
  };
  const bootstrap = async () => (await api(`/api/events/${f.eventId}/bootstrap`)).json.state;
  try {
    await command('event.features', { features: ['qa', 'photo', 'board', 'draw', 'poll', 'reward', 'screen', 'venue'] });
    for (const [id, type, title] of [['ux-qa', 'qa', '운영 질의응답'], ['ux-photo', 'photo', '참가자 사진 검토'], ['ux-board', 'board', '참가 후기 검토']]) {
      await command('module.save', { id, type, title });
      await command('module.status', { id, status: 'OPEN' });
    }
    let state = await bootstrap();
    const person = state.workspaces[f.eventId].participants[0];
    // Explicit synthetic backlog, including a reservation whose clock elapsed.
    const questions = Array.from({ length: 13 }, (_, index) => ({
      id: `ux-question-${index + 1}`, moduleId: 'ux-qa', participantId: person.id,
      name: `참가자 ${index + 1}`, text: `행사 진행 질문 ${index + 1}`, answer: '', approved: false, likes: [], at: new Date().toISOString(),
    }));
    const posts = Array.from({ length: 13 }, (_, index) => ({ id: `ux-post-${index + 1}`, participantId: person.id, name: `참가자 ${index + 1}`, body: `현장 후기 ${index + 1}`, status: 'PENDING', at: new Date().toISOString() }));
    const messages = [{ id: 'ux-overdue', title: '수동 예약 행사 안내', channel: 'SMS', body: '합성 검증 안내', scheduled: '2026-01-01T00:00:00Z', status: 'SCHEDULED', simulate: true, recipientIds: [person.id], at: new Date().toISOString(), count: 1, logs: [] }];
    await f.harness.database.query(`UPDATE event_workspaces SET payload = payload || $2::jsonb WHERE event_id=$1`, [f.eventId, JSON.stringify({ questions, posts, messages })]);
    browser = await loadPlaywright().chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const addSession = async (context, cookie) => context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    await addSession(context, f.manager.cookie);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (request.url().includes('/api/')) requests.push({ url: new URL(request.url()).pathname, method: request.method() }); });
    const base = `${f.baseUrl}/console/events/${f.eventId}`;
    const capture = async (name) => {
      await settleVisualState(page);
      await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
      await page.screenshot({ path: `${OUT}/${name}-viewport.png`, fullPage: false });
    };
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, route, marker] of [
        ['overview', '', '#event-metrics-heading'], ['roster', '/participants', '#roster-search'],
        ['moderation', '/programs', '#moderation-status'], ['manual-reservation', '/messages?attention=1', '#history-heading'],
      ]) {
        await page.goto(base + route);
        await page.locator(marker).waitFor();
        await capture(`${name}-${width}`);
        check(`${name} no horizontal overflow ${width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await checkAccessibility(page, `${name}-${width}`);
        if (name === 'roster' && width === 390) {
          check('mobile pager stays in flow rather than covering roster cards', await page.getByRole('navigation', { name: '참가자 목록 페이지' }).evaluate((element) => getComputedStyle(element).position === 'static'));
        }
      }
    }
    check('event screens never request organization-wide workspace bootstrap', !requests.some((request) => request.url === '/api/bootstrap'));
    // At the last (phone) viewport badges live inside the closed navigation.
    // Open the real menu rather than counting inaccessible hidden elements.
    await page.locator('.console-global-trigger').click();
    await page.getByRole('img', { name: '실행할 예약 1건', exact: true }).first().waitFor();
    check('manual reservation badge is separate from delivery failures', await page.getByRole('img', { name: '실행할 예약 1건', exact: true }).count() > 0 && await page.getByRole('img', { name: '발송 확인 1건', exact: true }).count() === 0);
    await page.keyboard.press('Escape');
    check('overdue reservation is discoverable through attention deep link', await page.getByText('실행 시점 지남·수동 실행 필요', { exact: true }).isVisible());
    const reservation = page.locator('#campaign-ux-overdue');
    await reservation.getByRole('button', { name: '발송 실행', exact: true }).click();
    check('opening manual execution review does not send', (await bootstrap()).workspaces[f.eventId].messages[0].status === 'SCHEDULED');
    await page.locator('#campaign-detail-ux-overdue').getByRole('button', { name: '취소', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + '/programs');
    await page.locator('#moderation-status').waitFor();
    await page.getByRole('button', { name: '미답변 13건 검토', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'moderation-question-ux-question-1');
    check('review shortcut opens unanswered queue and lands on first item', await page.getByLabel('질문 상태별 보기').inputValue() === 'unanswered');
    const qa = page.locator('li').filter({ has: page.getByRole('heading', { name: '운영 질의응답', exact: true }) }).first();
    await page.locator('#answer-ux-question-1').waitFor();
    check('only first ten questions render', await page.locator('[id^="moderation-question-"]').count() === 10);
    await page.locator('#answer-ux-question-1').fill('안내 데스크에서 확인해 주세요.');
    await page.getByLabel('질문 상태별 보기').selectOption('unanswered');
    check('filter retains typed answer', await page.locator('#answer-ux-question-1').inputValue() === '안내 데스크에서 확인해 주세요.');
    await page.locator('#moderation-question-ux-question-1').getByRole('button', { name: '승인·공개', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'moderation-question-ux-question-2');
    state = await bootstrap();
    check('question approval saved through actual command', state.workspaces[f.eventId].questions[0].approved === true);
    await page.getByLabel('질문 상태별 보기').selectOption('all');
    await qa.getByRole('button', { name: /더 보기 \(/ }).click();
    check('question load more exposes remaining rows', await page.locator('[id^="moderation-question-"]').count() === 13);
    await capture('moderation-processed-keyboard-1280');

    await page.goto(base + '/participants');
    const selected = page.getByRole('checkbox', { name: `${person.name} 선택`, exact: true });
    await selected.check();
    await command('participant.status', { ids: [person.id], status: 'PENDING' });
    await page.evaluate(() => { const original = Date.now; Date.now = () => original() + 16000; window.dispatchEvent(new Event('focus')); });
    await page.getByRole('row').filter({ has: selected }).getByRole('button', { name: '승인', exact: true }).waitFor();
    check('focus refresh preserves roster selection', await selected.isChecked());
    await capture('roster-focus-refreshed-selection-1280');

    // Scope fixture: read-only first, then participant-only cross-scope checks.
    await f.harness.database.query(`UPDATE memberships SET write_permissions=$3::jsonb WHERE account_id=$1 AND event_id=$2`, [f.manager.id, f.eventId, '[]']);
    await page.goto(base + '/participants');
    await page.locator('#roster-search').waitFor();
    const addReadOnly = page.getByRole('button', { name: '참가자 추가', exact: true });
    check('read-only roster has no enabled add action', await addReadOnly.count() === 0 || await addReadOnly.isDisabled());
    await page.getByText('명단 도구', { exact: true }).click();
    const csvRead = page.getByRole('button', { name: /CSV 내보내기/ });
    check('read-only roster retains CSV read', await csvRead.isVisible() && await csvRead.isEnabled());
    check('read-only roster offers no dead-end page selection', await page.getByRole('button', { name: /이 페이지 .*명 선택/ }).count() === 0);
    await capture('roster-read-only-1280');
    await f.harness.database.query(`UPDATE memberships SET write_permissions=$3::jsonb WHERE account_id=$1 AND event_id=$2`, [f.manager.id, f.eventId, '["participants"]']);
    await page.goto(base + '/participants');
    await page.locator('#roster-search').waitFor();
    check('participant scope restores roster add action', await page.getByRole('button', { name: '참가자 추가', exact: true }).isEnabled());
    await page.goto(base + '/messages');
    await page.locator('#message-compose-open').click();
    await page.locator('#campaign-title').waitFor();
    check('participant scope cannot send messages', await page.locator('#campaign-submit').isDisabled());
    await capture('messages-no-write-390');

    const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ownerCookie = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
    await addSession(owner, ownerCookie);
    const ownerPage = await owner.newPage();
    ownerPage.on('pageerror', (error) => errors.push(error.message));
    const memberAttempts = [];
    await ownerPage.route('**/api/events/*/members', async (route) => {
      memberAttempts.push(route.request().postDataJSON());
      if (memberAttempts.length === 1) {
        const actual = await route.fetch();
        assert.ok(actual.ok(), `membership commit: ${actual.status()}`);
        await route.fulfill({ status: 502, json: { error: '합성 커밋 후 응답 유실' } });
      } else await route.continue();
    });
    await ownerPage.goto(f.baseUrl + '/console/team');
    const permissions = ownerPage.getByRole('region', { name: '행사별 쓰기 권한', exact: true });
    await permissions.getByRole('button', { name: '권한 편집', exact: true }).click();
    for (const width of [1280, 390]) {
      await ownerPage.setViewportSize({ width, height: 900 });
      await ownerPage.screenshot({ path: `${OUT}/team-permission-editor-${width}.png`, fullPage: true });
      await permissions.screenshot({ path: `${OUT}/team-permission-section-${width}.png` });
      await ownerPage.screenshot({ path: `${OUT}/team-permission-viewport-${width}.png`, fullPage: false });
      check(`permission editor no overflow ${width}`, await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await checkAccessibility(ownerPage, `team-permissions-${width}`);
    }
    await permissions.getByRole('checkbox', { name: /참가자·명단/ }).uncheck();
    await permissions.getByRole('button', { name: '권한 저장', exact: true }).click();
    await permissions.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).waitFor();
    check('unknown permission write freezes event and scopes', await permissions.getByRole('combobox').isDisabled() && await permissions.getByRole('checkbox', { name: /전체/ }).isDisabled());
    await ownerPage.screenshot({ path: `${OUT}/team-permission-unknown-390.png`, fullPage: true });
    await ownerPage.screenshot({ path: `${OUT}/team-permission-unknown-viewport-390.png`, fullPage: false });
    await permissions.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).click();
    await permissions.getByRole('button', { name: '권한 편집', exact: true }).waitFor();
    check('membership retry uses identical receipt and payload', memberAttempts.length === 2 && JSON.stringify(memberAttempts[0]) === JSON.stringify(memberAttempts[1]), memberAttempts);
    const persistedMembership = (await f.harness.database.query(`SELECT write_permissions FROM memberships WHERE account_id=$1 AND event_id=$2`, [f.manager.id, f.eventId])).rows[0];
    check('owner editor persists explicit read-only grant', JSON.stringify(persistedMembership.write_permissions) === '[]');
    await owner.close();

    await f.harness.database.query(`UPDATE memberships SET write_permissions='["all"]'::jsonb WHERE account_id=$1 AND event_id=$2`, [f.manager.id, f.eventId]);
    await command('participant.status', { ids: [person.id], status: 'APPROVED' });
    const staff = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
    await addSession(staff, f.staff.cookie);
    await staff.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await original(constraints);
        window.__syntheticCameraTracks = stream.getTracks();
        return stream;
      };
    });
    const staffPage = await staff.newPage();
    staffPage.on('pageerror', (error) => errors.push(error.message));
    await staffPage.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    await staffPage.locator('#staff-desk').waitFor();
    await staffPage.getByRole('button', { name: /카메라/ }).click();
    await staffPage.waitForFunction(() => window.__syntheticCameraTracks?.some((track) => track.readyState === 'live'));
    await staffPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await staffPage.waitForFunction(() => window.__syntheticCameraTracks?.every((track) => track.readyState === 'ended'));
    check('synthetic camera stops all tracks when hidden', true);
    await staffPage.screenshot({ path: `${OUT}/staff-camera-paused-390.png`, fullPage: true });
    await checkAccessibility(staffPage, 'staff-camera-paused-390');
    await staffPage.evaluate(() => { delete document.hidden; });
    await staffPage.getByRole('button', { name: '닫기', exact: true }).click();
    const raw = (await f.harness.database.query(`SELECT payload FROM event_workspaces WHERE event_id=$1`, [f.eventId])).rows[0].payload;
    await staffPage.locator('#staff-ticket').fill(raw.participants.find((row) => row.id === person.id).ticket);
    await staffPage.getByRole('button', { name: '입장 처리', exact: true }).click();
    await staffPage.locator('#correct-reason').waitFor();
    await staffPage.locator('#correct-reason').fill('합성 UI 검증 오스캔 정정');
    await staffPage.getByRole('button', { name: '최신 기록 정정', exact: true }).click();
    await f.gateway.waitForResponseLoss('check.correct');
    await staffPage.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).waitFor();
    check('unknown correction locks target and reason', await staffPage.locator('#staff-desk').isDisabled() && await staffPage.locator('#correct-reason').isDisabled());
    await staffPage.screenshot({ path: `${OUT}/staff-correction-unknown-390.png`, fullPage: true });
    check('unknown correction has no current-success treatment', await staffPage.locator('.scan-success').count() === 0);
    await checkAccessibility(staffPage, 'staff-correction-unknown-390');
    await staffPage.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).click();
    await staffPage.getByText('기록을 정정했습니다. 현재 입장 상태에 반영되었습니다.', { exact: true }).waitFor();
    const corrections = f.gateway.commands.filter((row) => row.command === 'check.correct');
    check('lost correction retries identical commandId once', corrections.length === 2 && corrections[0].commandId === corrections[1].commandId, corrections);
    await staff.close();

    // Hung session read: transport fault only, setup and login use the real API.
    const login = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const loginPage = await login.newPage();
    loginPage.on('pageerror', (error) => errors.push(error.message));
    await loginPage.route('**/api/auth/me', () => {});
    await loginPage.goto(f.baseUrl + '/login');
    await loginPage.getByLabel('이메일', { exact: true }).fill(f.manager.email);
    await loginPage.getByLabel('비밀번호', { exact: true }).fill(f.manager.password);
    check('login form usable while session read hangs', await loginPage.getByRole('button', { name: '로그인', exact: true }).isEnabled());
    await loginPage.screenshot({ path: `${OUT}/login-pending-session-390.png`, fullPage: true });
    await checkAccessibility(loginPage, 'login-pending-session-390');
    await loginPage.getByRole('button', { name: '로그인', exact: true }).click();
    await loginPage.waitForURL('**/console');
    check('real login proceeds despite hung session read', loginPage.url().endsWith('/console'));
    await login.close();
    const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const publicPage = await anonymous.newPage();
    publicPage.on('pageerror', (error) => errors.push(error.message));
    let failPublicRead = true;
    await publicPage.route(`**/api/public/events/${f.slug}`, async (route) => {
      if (failPublicRead) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '합성 일시 통신 오류' }) });
      } else await route.continue();
    });
    await publicPage.goto(`${f.baseUrl}/event/${f.slug}/home?view=notice`);
    await publicPage.getByRole('button', { name: '다시 시도', exact: true }).waitFor();
    await publicPage.screenshot({ path: `${OUT}/attendee-transient-390.png`, fullPage: true });
    await checkAccessibility(publicPage, 'attendee-transient-390');
    failPublicRead = false;
    await publicPage.getByRole('button', { name: '다시 시도', exact: true }).click();
    await publicPage.getByRole('region', { name: '공지사항', exact: true }).waitFor();
    await publicPage.getByRole('link', { name: '행사 안내 보기', exact: true }).waitFor();
    check('attendee retry keeps the same detail context', new URL(publicPage.url()).searchParams.get('view') === 'notice');
    await publicPage.screenshot({ path: `${OUT}/attendee-retry-notice-context-390.png`, fullPage: true });
    await publicPage.goto(`${f.baseUrl}/event/not-an-event-ux/home`);
    await publicPage.getByRole('heading', { name: '행사를 찾을 수 없습니다', exact: true }).waitFor();
    check('actual missing event differs from retryable communication error', await publicPage.getByRole('button', { name: '다시 시도', exact: true }).count() === 0);
    await publicPage.screenshot({ path: `${OUT}/attendee-missing-event-390.png`, fullPage: true });
    await checkAccessibility(publicPage, 'attendee-missing-390');
    await anonymous.close();
    check('no page errors', errors.length === 0, errors);
  } finally {
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8'), checks, errors, requests, accessibility, simulation: 'Synthetic questions/posts and elapsed reservation; hung auth read, Date.now+16s focus, Chrome fake camera, and committed correction response loss simulated. All writes actual task-only API/PG.' }, null, 2), { mode: 0o600 });
    console.log(`System UI evidence: ${OUT}`);
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
