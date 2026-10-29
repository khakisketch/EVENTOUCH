'use strict';

// Task-first final review: actual production Next, task-owned PostgreSQL schema
// and real API. No deployment, retained data or live messaging is touched.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const before = process.argv.includes('--before');
const captureRoot = process.env.EVENTOUCH_TASK_FINAL_CAPTURE_ROOT || defaultCaptureDir(`task-first-final-${runStamp()}`);
const out = path.join(captureRoot, before ? 'before' : 'after');

async function main() {
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  const errors = [], checks = [];
  const api = async (command, payload) => {
    const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r));
    return r.json;
  };
  try {
    const owner = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
    await api('event.features', { features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp', 'survey', 'qa'] });
    const booth = (await api('booth.save', { name: '체험 부스', zone: '동문', status: 'OPEN', capacity: 100, limit: 1 })).booth;
    await api('booth.mode', { mode: 'STAFF', acknowledge: true });
    const draw = (await api('module.save', { title: '기념 추첨 무대', type: 'draw' })).module;
    await api('draw.program.save', { name: '기념 추첨', moduleId: draw.id, quota: 1, eligibility: 'PERSON', status: 'DRAFT' });
    await api('report.create', { title: '동결 결과 보고서', subtitle: '행사 운영 결과', summary: '승인 및 집계를 확인합니다.', sections: ['overview', 'attendance'] });
    browser = await launchBrowser();
    const context = await browser.newContext();
    const setAuth = async cookie => {
      await context.clearCookies();
      if (cookie) await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), url: f.baseUrl }]);
    };
    await setAuth(owner);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const shot = async (name, width) => {
      await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true });
      const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
      assert.ok(size.scrollWidth <= size.width, `${name}/${width} overflow`);
      checks.push({ name, width, ...size });
    };
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await setAuth(owner);
      for (const [name, route, ready] of [
        ['team', '/console/team', '#team-members'],
        ['photos', `/console/events/${f.eventId}/photos`, '#evidence-photo-archive'],
        ['import', `/console/events/${f.eventId}/participants/import`, 'input[type=file]'],
        ['operations', `/console/events/${f.eventId}/operations`, '#ops-desks'],
        ['reports', `/console/events/${f.eventId}/reports`, '#reports-list'],
      ]) {
        await page.goto(f.baseUrl + route, { waitUntil: 'networkidle' });
        await page.locator(ready).first().waitFor();
        await shot(name, width);
        if (name === 'team') {
          checks.push({ name: 'team-identity', width, contacts: await page.locator('[class*=memberContact]').evaluateAll(els => els.map(el => ({ text: el.textContent, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, font: getComputedStyle(el).fontSize }))) });
        }
      }
      await page.goto(f.baseUrl + '/console', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '새 행사 만들기', exact: true }).click();
      await page.locator('#create-name').fill('고객사 등록 중 행사 초안');
      await shot('event-draft', width);
      // End the draft in this controlled fixture; retain the real discard gate.
      page.once('dialog', d => d.accept());
      await page.keyboard.press('Escape');
      await setAuth(f.staff.cookie);
      await page.goto(f.baseUrl + `/staff/events/${f.eventId}`, { waitUntil: 'networkidle' });
      await page.locator('#staff-desk').waitFor();
      await shot('staff-work', width);
      await page.goto(f.baseUrl + '/staff', { waitUntil: 'networkidle' });
      await page.locator('#staff-desk').waitFor();
      await shot('staff-hub', width);
      await setAuth(null);
      for (const [name, route, ready] of [
        ['attendee-home', `/event/${f.slug}/home`, 'nav[aria-label="참가 메뉴"]'],
        ['attendee-register', `/event/${f.slug}/register`, '#field-name'],
        ['attendee-ticket-empty', `/event/${f.slug}/ticket`, 'main'],
        ['attendee-engage', `/event/${f.slug}/engage`, 'main'],
        ['attendee-recover', `/event/${f.slug}/ticket/recover`, 'main'],
      ]) {
        await page.goto(f.baseUrl + route, { waitUntil: 'networkidle' });
        await page.locator(ready).first().waitFor();
        await shot(name, width);
      }
    }
    if (!before) {
      // Participant task: network problem keeps the completed form, then the
      // real signup response opens a QR ticket with its bearer removed from
      // the address. Input failure is injected, successful API data is not.
      await setAuth(null);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(f.baseUrl + `/event/${f.slug}/register`, { waitUntil: 'networkidle' });
      await page.locator('#field-name').fill('최종 과제 참가자');
      await page.locator('#field-phone').fill('01099887766');
      await page.locator('form.registration-form input[type=checkbox]').last().check();
      const signupRoute = '**/api/events/*/signup';
      await page.route(signupRoute, route => route.abort('failed'));
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '신청 결과를 확인하지 못했습니다' }).waitFor();
      assert.equal(await page.locator('#field-name').inputValue(), '최종 과제 참가자');
      assert.equal(await page.locator('#field-name').isDisabled(), true);
      await shot('attendee-register-problem', 390);
      await page.unroute(signupRoute);
      await page.getByRole('button', { name: '신청 결과 다시 확인', exact: true }).click();
      await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
      await page.waitForURL(url => url.pathname.endsWith('/ticket') && !url.searchParams.has('ticket'));
      await shot('attendee-ticket-normal', 390);
      checks.push({ name: 'participant-retry-ticket', formRetained: true, bearerRemovedFromAddress: true });

      const state = (await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: owner })).json.state;
      const person = state.workspaces[f.eventId].participants.find(p => p.status === 'APPROVED' && p.ticket && !p.inside);
      assert.ok(person);
      await setAuth(f.staff.cookie);
      await page.goto(f.baseUrl + `/staff/events/${f.eventId}`, { waitUntil: 'networkidle' });
      await page.locator('#staff-desk').waitFor();
      assert.equal(await page.locator('#staff-desk').inputValue(), f.deskId);
      await page.locator('#staff-ticket').fill('invalid-test-ticket');
      await page.getByRole('button', { name: '입장 처리', exact: true }).click();
      await page.locator('.scan-failure').waitFor();
      await shot('staff-scan-problem', 390);
      await page.locator('#staff-ticket').fill(person.ticket);
      await page.getByRole('button', { name: '입장 처리', exact: true }).click();
      await page.getByRole('button', { name: '다음 참가자', exact: true }).waitFor();
      await shot('staff-scan-normal', 390);
      const recentTextBounds = await page.locator('[class*=recentRow] span').first().boundingBox();
      checks.push({ name: 'staff-recent-text', width: 390, height: recentTextBounds?.height });
      await page.setViewportSize({ width: 1280, height: 900 });
      await shot('staff-scan-normal', 1280);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.getByRole('button', { name: '다음 참가자', exact: true }).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#staff-ticket').inputValue(), '');
      checks.push({ name: 'staff-single-desk', beforeSteps: 3, afterSteps: 2, explicitScan: true, nextParticipantKeyboard: true });
      const persisted = (await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: owner })).json.state;
      assert.equal(persisted.workspaces[f.eventId].participants.find(p => p.id === person.id).inside, true);

      // Multiple desks stay a real choice; nothing is auto-selected.
      const second = (await api('desk.save', { name: '두 번째 입장 데스크', action: 'IN', mode: 'desk', open: true })).desk;
      await f.helpers.insertAssignment(f.harness.database, { id: `second-${f.suffix}`, accountId: f.staff.id, eventId: f.eventId, type: 'DESK', targetId: second.id });
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('#staff-desk').inputValue(), '');
      await shot('staff-multiple-desks', 390);

      // Empty assignment and failed bootstrap are separate product states.
      const emptyId = `empty-staff-${f.suffix}`;
      await f.helpers.insertAccount(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id: emptyId, role: 'STAFF', name: '미배정 스태프', email: `${emptyId}@example.test` });
      const emptyCookie = await f.helpers.sessionCookie(f.harness, emptyId);
      await setAuth(emptyCookie);
      await page.goto(f.baseUrl + '/staff', { waitUntil: 'networkidle' });
      await page.getByText('배정된 업무가 없습니다. 운영자에게 문의하세요.', { exact: true }).waitFor();
      await shot('staff-empty', 390);
      await setAuth(f.staff.cookie);
      // The staff workspace now reads the lightweight addresses; the same
      // transport fault is injected on every read address so the retry UI is
      // exercised whichever address the build uses. Recovery below still
      // requires the real fetch — nothing is mocked to succeed.
      for (const pattern of ['**/api/bootstrap', '**/api/console/directory', '**/api/events/*/bootstrap']) {
        await page.route(pattern, route => route.abort('failed'));
      }
      await page.goto(f.baseUrl + `/staff/events/${f.eventId}`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor();
      await shot('staff-load-problem', 390);
      await page.unroute('**/api/bootstrap');
      await page.unroute('**/api/console/directory');
      await page.unroute('**/api/events/*/bootstrap');
      await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
      await page.locator('#staff-desk').waitFor();
      checks.push({ name: 'staff-empty-problem-recovery', emptyAssignment: true, failedFetch: 'injected transport abort', realRetry: true, multipleDesksRequireChoice: true });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), buildId: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), roles: ['AGENCY', 'STAFF', 'anonymous'], simulation: 'Chromium and task-local PostgreSQL/API, no real sending/devices', checks, errors, seededBooth: Boolean(booth) }, null, 2), { mode: 0o600 });
    console.log(`[task-first-final] ${checks.length} rendered checks passed (${before ? 'before' : 'after'})`);
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
