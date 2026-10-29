'use strict';

// Synthetic end-to-end signup/retry and staff/report journey. The first
// request reaches the real isolated API/PG before a response is lost. All
// response injections are disclosed; no supplier or user data is contacted.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const http = require('node:http');
const path = require('node:path');
const axe = require('axe-core').source;
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const OUT = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'signup-retry')
  : defaultCaptureDir(`signup-retry-${runStamp()}`);

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const fixture = await startAuditFixture();
  const checks = [];
  const errors = [];
  const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); assert.ok(ok, name); };
  let browser;
  let completed = false;
  const workspace = async () => (await fixture.harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId],
  )).rows[0].payload;
  try {
    browser = await launchBrowser();
    const scenarios = [
      { name: 'committed-502', width: 390, phone: '01098761231', first: '502', next: '429' },
      { name: 'committed-network-loss', width: 320, phone: '01098761232', first: 'abort', next: '409' },
      { name: 'committed-missing-ticket', width: 1280, phone: '01098761233', first: 'empty' },
      { name: 'not-sent-network-loss', width: 390, phone: '01098761234', first: 'not-sent' },
      { name: 'initial-rate-limit', width: 390, phone: '01098761237', first: 'throttle' },
    ];
    let journeyPerson;
    for (const scenario of scenarios) {
      const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.width === 1280 ? 900 : 844 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      const attempts = [];
      await page.route('**/api/events/*/signup', async route => {
        attempts.push(route.request().postDataJSON());
        if (attempts.length === 1) {
          if (scenario.first === 'not-sent') return route.abort('failed');
          if (scenario.first === 'throttle') return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"fixture rate limit"}' });
          const actual = await route.fetch();
          check(`${scenario.name}: original committed`, actual.status() === 201);
          if (scenario.first === 'abort') return route.abort('failed');
          if (scenario.first === 'empty') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
          return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture response lost"}' });
        }
        if (attempts.length === 2 && scenario.next) {
          return route.fulfill({ status: Number(scenario.next), contentType: 'application/json', body: '{"error":"fixture retry error"}' });
        }
        return route.continue();
      });
      await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await page.locator('#field-name').fill('재확인 검증 참가자');
      await page.locator('#field-phone').fill(scenario.phone);
      if (await page.locator('#consent').count()) await page.locator('#consent').check();
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      const notice = page.getByRole('alert').filter({ hasText: '신청 결과를 확인하지 못했습니다' });
      await notice.waitFor();
      const retry = page.getByRole('button', { name: '신청 결과 다시 확인', exact: true });
      await retry.waitFor({ state: 'visible' });
      check(`${scenario.name}: ambiguous result keeps input`, await page.locator('#field-phone').inputValue() === scenario.phone);
      check(`${scenario.name}: inputs locked`, await page.locator('#field-name').isDisabled() && await page.locator('#field-phone').isDisabled());
      check(`${scenario.name}: focus reaches explanation`, await notice.evaluate(el => el === document.activeElement));
      check(`${scenario.name}: warning explains possible commit and reload`, (await notice.innerText()).includes('이미 신청되었을 수 있습니다') && (await notice.innerText()).includes('새로고침하거나 닫지 마세요'));
      await page.keyboard.press('Tab');
      check(`${scenario.name}: support link is keyboard reachable`, await page.getByRole('link', { name: /행사 안내·문의처/ }).evaluate(el => el === document.activeElement));
      await page.keyboard.press('Tab');
      check(`${scenario.name}: retry is next in keyboard order`, await retry.evaluate(el => el === document.activeElement));
      check(`${scenario.name}: no personal data or request id persisted`, await page.evaluate(({ phone, id }) =>
        ![localStorage, sessionStorage].some(storage => Object.entries(storage).some(([key, value]) => `${key}${value}`.includes(phone) || `${key}${value}`.includes(id))),
      { phone: scenario.phone, id: attempts[0].commandId }));
      if (scenario.name === 'committed-502') {
        const dialogPromise = page.waitForEvent('dialog', { timeout: 5000 });
        const reload = page.reload({ timeout: 5000 }).catch(() => null);
        const dialog = await dialogPromise;
        check('uncertain signup asks before browser reload', dialog.type() === 'beforeunload');
        await dialog.dismiss();
        await reload;
        check('cancelled reload keeps the original attempt', await notice.isVisible() && await page.locator('#field-phone').inputValue() === scenario.phone);
      }
      const geometry = await page.evaluate(() => {
        const notice = document.querySelector('.registration-retry').getBoundingClientRect();
        const button = document.querySelector('.registration-form button[type=submit]').getBoundingClientRect();
        return { noticeTop: notice.top, noticeBottom: notice.bottom, buttonTop: button.top, buttonBottom: button.bottom, height: innerHeight, width: innerWidth, documentWidth: document.documentElement.scrollWidth, buttonHeight: button.height };
      });
      await page.screenshot({ path: path.join(OUT, `${scenario.name}-uncertain-viewport.png`), fullPage: false });
      await page.screenshot({ path: path.join(OUT, `${scenario.name}-uncertain-full.png`), fullPage: true });
      if (scenario.next) {
        await retry.click();
        await page.waitForFunction(() => !document.querySelector('.registration-form button[type=submit]')?.disabled);
        check(`${scenario.name}: later ${scenario.next} does not discard request`, await notice.isVisible() && await page.locator('#field-phone').isDisabled());
      }
      const responsePromise = page.waitForResponse(response => response.url().includes('/signup') && response.request().method() === 'POST');
      await retry.click();
      const response = await responsePromise;
      check(`${scenario.name}: every retry sends the original body`, attempts.every(body => JSON.stringify(body) === JSON.stringify(attempts[0])));
      check(`${scenario.name}: real receipt or first commit returns`, response.status() === (['not-sent', 'throttle'].includes(scenario.first) ? 201 : 200));
      await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
      await page.waitForURL(url => url.pathname.endsWith('/ticket') && !url.searchParams.has('ticket'));
      check(`${scenario.name}: ticket opens without bearer in address`, !new URL(page.url()).searchParams.has('ticket'));
      const people = (await workspace()).participants.filter(person => person.phone === scenario.phone);
      check(`${scenario.name}: exactly one participant`, people.length === 1);
      if (scenario.name === 'committed-502') journeyPerson = people[0];
      await page.screenshot({ path: path.join(OUT, `${scenario.name}-ticket.png`), fullPage: true });
      await context.close();
    }

    // Two submit events in one turn must not make two outbound requests.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      let requests = 0;
      page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/signup')) requests += 1; });
      await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await page.locator('#field-name').fill('중복 클릭 검증');
      await page.locator('#field-phone').fill('01098761238');
      if (await page.locator('#consent').count()) await page.locator('#consent').check();
      await page.evaluate(() => {
        const form = document.querySelector('form.registration-form');
        form.requestSubmit();
        form.requestSubmit();
      });
      await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
      check('same-turn double submit sends one request', requests === 1);
      check('same-turn double submit creates one person', (await workspace()).participants.filter(person => person.phone === '01098761238').length === 1);
      await context.close();
    }

    // The real verification/grant and signup endpoints are exercised through
    // a loopback-only fake SMS supplier. The product normally blocks mock SMS
    // on this screen; the fixture explicitly exposes simulated Solapi state.
    {
      let code = '';
      const supplier = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const message = JSON.parse(body).messages[0];
            code = String(message.text).match(/인증번호 (\d{6})/)?.[1] || '';
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ groupInfo: { groupId: 'fixture-local' }, failedMessageList: [] }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
      });
      await new Promise(resolve => supplier.listen(0, '127.0.0.1', resolve));
      Object.assign(process.env, {
        SOLAPI_API_KEY: 'fixture-key', SOLAPI_API_SECRET: 'fixture-secret', SOLAPI_SENDER: '0212345678',
        SOLAPI_API_HOST: `http://127.0.0.1:${supplier.address().port}`,
      });
      let verifiedFixture;
      try {
        verifiedFixture = await startAuditFixture();
        await verifiedFixture.harness.database.query(
          "UPDATE event_workspaces SET payload=jsonb_set(payload,'{verificationRequired}','true'::jsonb) WHERE event_id=$1",
          [verifiedFixture.eventId],
        );
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        const attempts = [];
        await page.route('**/api/events/*/signup', async route => {
          attempts.push(route.request().postDataJSON());
          if (attempts.length !== 1) return route.continue();
          const actual = await route.fetch();
          check('verified signup commits before response loss', actual.status() === 201);
          return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture response lost"}' });
        });
        await page.goto(`${verifiedFixture.baseUrl}/event/${verifiedFixture.slug}/register`);
        await page.locator('#field-name').fill('인증 재확인 참가자');
        await page.locator('#field-phone').fill('01098761239');
        if (await page.locator('#consent').count()) await page.locator('#consent').check();
        await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
        await page.locator('#verify-code').waitFor();
        check('local fake supplier received a code', /^\d{6}$/.test(code));
        await page.locator('#verify-code').fill(code);
        await page.getByRole('button', { name: '인증 확인', exact: true }).click();
        await page.getByText(/연락처 인증됨/).waitFor();
        await page.getByRole('button', { name: '신청하기', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '신청 결과를 확인하지 못했습니다' }).waitFor();
        const responsePromise = page.waitForResponse(response => response.url().includes('/signup') && response.request().method() === 'POST');
        await page.getByRole('button', { name: '신청 결과 다시 확인', exact: true }).click();
        check('used verification grant permits receipt replay', (await responsePromise).status() === 200);
        check('verified retry sends the identical grant and body', attempts.length === 2 && JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]));
        await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
        const verified = (await verifiedFixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [verifiedFixture.eventId])).rows[0].payload;
        check('verified retry creates one participant', verified.participants.filter(person => person.phone === '01098761239').length === 1);
        await context.close();
      } finally {
        if (verifiedFixture) await verifiedFixture.close();
        for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_API_HOST']) delete process.env[key];
        await new Promise(resolve => supplier.close(resolve));
      }
    }

    // randomUUID is unavailable in some contexts; a cryptographic fallback is
    // required because the id can replay the newly issued ticket.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(() => Object.defineProperty(window.crypto, 'randomUUID', { value: undefined }));
      const page = await context.newPage();
      let commandId = '';
      page.on('request', request => {
        if (request.method() === 'POST' && request.url().includes('/signup')) commandId = request.postDataJSON().commandId;
      });
      await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await page.locator('#field-name').fill('보안 식별자 검증');
      await page.locator('#field-phone').fill('01098761236');
      if (await page.locator('#consent').count()) await page.locator('#consent').check();
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
      check('fallback request id uses 128 cryptographic bits', /^web-[0-9a-f]{32}$/.test(commandId));
      await context.close();
    }

    // An unambiguous validation rejection is editable and gets a fresh ID;
    // unlike ambiguous failures it must not trap the participant in retry.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const attempts = [];
      page.on('request', request => {
        if (request.method() === 'POST' && request.url().includes('/signup')) attempts.push(request.postDataJSON());
      });
      await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await page.locator('#field-name').fill('입력 수정 참가자');
      await page.locator('#field-phone').fill('123');
      if (await page.locator('#consent').count()) await page.locator('#consent').check();
      const validationResponse = page.waitForResponse(response => response.url().includes('/signup') && response.request().method() === 'POST');
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      const validationStatus = (await validationResponse).status();
      check('invalid phone is rejected by the real API', validationStatus === 400);
      await page.getByRole('alert').first().waitFor();
      await page.locator('#field-phone:enabled').waitFor();
      check('validation rejection leaves phone editable', await page.locator('#field-phone').isEnabled());
      check('validation error is associated with the phone input', await page.locator('#field-phone').getAttribute('aria-invalid') === 'true' &&
        (await page.locator('#field-phone').getAttribute('aria-describedby')).split(' ').includes('field-phone-error') &&
        await page.locator('#field-phone-error').isVisible());
      check('definitive validation error does not leave a reload guard', await page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return !event.defaultPrevented;
      }));
      check('validation rejection is not described as unknown', await page.getByText('신청 결과를 확인하지 못했습니다').count() === 0);
      await page.locator('#field-phone').fill('01098761235');
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
      check('corrected validation error uses a new id', attempts.length === 2 && attempts[0].commandId !== attempts[1].commandId);
      check('corrected validation creates one person', (await workspace()).participants.filter(person => person.phone === '01098761235').length === 1);
      await context.close();
    }

    // The recovered participant's actual ticket is usable by assigned staff,
    // and the resulting real check-in is included in a later report snapshot.
    {
      const staff = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await staff.addCookies([{ name: 'etko_session', value: decodeURIComponent(fixture.staff.cookie.slice('etko_session='.length)), url: fixture.baseUrl }]);
      const page = await staff.newPage();
      await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
      await page.locator('#staff-desk').waitFor();
      if (await page.locator('#staff-desk').inputValue() !== fixture.deskId) await page.locator('#staff-desk').selectOption(fixture.deskId);
      await page.locator('#staff-ticket').fill(journeyPerson.ticket);
      await page.getByRole('button', { name: '입장 처리', exact: true }).click();
      await page.getByRole('button', { name: '다음 참가자', exact: true }).waitFor();
      const after = await workspace();
      check('recovered ticket completes assigned staff check-in', after.participants.find(person => person.id === journeyPerson.id)?.inside === true);
      check('check-in is recorded once', after.checks.filter(item => item.participantId === journeyPerson.id && item.action === 'IN').length === 1);
      await page.screenshot({ path: path.join(OUT, 'staff-checkin.png'), fullPage: true });
      await staff.close();
      const report = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie,
        body: { commandId: crypto.randomUUID(), command: 'report.create', payload: { title: '신청부터 입장까지 검수', sections: ['overview', 'attendance'], color: '#F05A24' } },
      });
      check('manager can create a report after the check-in', report.status >= 200 && report.status < 300);
      check('report snapshot includes the real check-in', report.json.report.snapshot.metrics.checked === 1 && report.json.report.snapshot.metrics.inside === 1);
      const operator = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await operator.addCookies([{ name: 'etko_session', value: decodeURIComponent(fixture.manager.cookie.slice('etko_session='.length)), url: fixture.baseUrl }]);
      const reportPage = await operator.newPage();
      await reportPage.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/reports`);
      await reportPage.locator('#reports-list').waitFor();
      check('created report is visible to the manager', await reportPage.getByText('신청부터 입장까지 검수', { exact: true }).count() > 0);
      await reportPage.getByRole('button', { name: '내용 보기', exact: true }).click();
      check('manager can open the report snapshot', await reportPage.locator('#report-detail').isVisible());
      await reportPage.screenshot({ path: path.join(OUT, 'operator-report.png'), fullPage: true });
      await operator.close();
    }
    check('no unexpected browser runtime errors', errors.length === 0);
    completed = true;
    console.log(`[signup-retry] ${checks.length} checks passed`);
  } finally {
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({
      completed, checks, errors,
      disclosures: ['isolated synthetic events and PostgreSQL', 'Chromium with injected response faults', 'verified flow uses a loopback fake SMS supplier and simulated Solapi state', 'manual ticket input, not a physical scanner', 'report created through real API', 'no external SMS or customer acceptance'],
    }, null, 2), { mode: 0o600 });
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
