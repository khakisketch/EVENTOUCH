'use strict';

// Same-origin tabs, actual Next/API and an isolated database. No real SMS,
// participant data, or persistent credentials are used. Each tab starts
// with no participant cookie and signs up through the visible form.
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const fixture = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const axe = require('axe-core').source;
const { createAttendeeAccess, attendeeCookieName } = require('../server/attendees');

async function main() {
  fixture.ensureAuditDatabaseEnv();
  const out = process.env.EVENTOUCH_CAPTURE_ROOT
    ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendee-tab-identities')
    : defaultCaptureDir(`attendee-tab-identities-${runStamp()}`);
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const { startApiHarness, insertEvent, LEGACY_ORG, startWebApiGateway } = fixture.loadHelpers();
  const harness = await startApiHarness();
  let web, gateway, browser;
  try {
    const fields = [{ id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true }];
    for (const slug of ['tab-identity-a', 'tab-identity-b']) {
      await insertEvent(harness.database, { id: slug, slug, orgId: LEGACY_ORG,
        payload: { id: slug, slug, name: `합성 ${slug}`, date: '2099-01-01', stage: 'READY', capacity: 20 },
        workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
          formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '합성 정보 수집 동의',
          consentVersion: 1, price: 0, verificationRequired: false } });
    }
    web = await fixture.startOwnedNext({ apiBase: harness.baseUrl });
    gateway = await startWebApiGateway({ apiBase: harness.baseUrl, webBase: web.baseUrl });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const people = [
      { slug: 'tab-identity-a', name: '합성 참가자 갑', phone: '01088001111' },
      { slug: 'tab-identity-a', name: '합성 참가자 을', phone: '01088002222' },
      { slug: 'tab-identity-b', name: '다른 행사 참가자', phone: '01088003333' },
    ];
    const pages = await Promise.all(people.map(() => context.newPage()));
    await Promise.all(pages.map((page, i) => page.goto(`${gateway.baseUrl}/event/${people[i].slug}/register`)));
    for (const [i, page] of pages.entries()) {
      await page.locator('#field-name').fill(people[i].name);
      await page.locator('#field-phone').fill(people[i].phone);
      await page.locator('#consent').check();
    }
    await Promise.all(pages.map(page => page.getByRole('button', { name: '신청하기', exact: true }).click()));
    for (const [i, page] of pages.entries()) {
      await page.getByRole('heading', { name: people[i].name, exact: true }).waitFor({ timeout: 20000 });
      assert.equal(new URL(page.url()).searchParams.has('ticket'), false, 'ticket is consumed from the address');
    }
    for (const [i, page] of pages.entries()) {
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: people[i].name, exact: true }).waitFor({ timeout: 15000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.evaluate(axe);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations
        .filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `ticket-${i + 1}-390.png`), fullPage: true });
    }
    // A new tab has no per-tab ticket. The same-event cookie is shared and
    // resolves to one of the completed registrations, never a mixture.
    const fresh = await context.newPage();
    await fresh.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket`);
    await fresh.getByRole('heading', { name: /합성 참가자 (갑|을)/ }).waitFor({ timeout: 15000 });
    const sessionName = await fresh.locator('h2').filter({ hasText: /합성 참가자 (갑|을)/ }).first().innerText();
    assert.ok(['합성 참가자 갑', '합성 참가자 을'].includes(sessionName.trim()));
    // An explicit invalid link is a different intent from restoring the
    // shared browser cookie. Reload must not silently turn its failure into
    // the other person's ticket after the rejected bearer was cleared.
    const invalid = await context.newPage();
    await invalid.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket?ticket=invalid-ticket`);
    await invalid.getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor();
    assert.equal(new URL(invalid.url()).searchParams.has('ticket'), false, 'rejected bearer is removed from the address');
    await invalid.screenshot({ path: path.join(out, 'rejected-before-refresh-390.png'), fullPage: true });
    await invalid.reload({ waitUntil: 'networkidle' });
    await invalid.screenshot({ path: path.join(out, 'rejected-after-refresh-390.png'), fullPage: true });
    await invalid.getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await invalid.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ }).count(), 0);
    assert.equal(await invalid.getByRole('heading', { name: /합성 참가자 (갑|을)/ }).count(), 0);
    const workspace = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', ['tab-identity-a'])).rows[0].payload;
    assert.equal(workspace.participants.length, 2);
    for (const [route, heading] of [['home', '티켓을 확인할 수 없습니다'], ['engage', '참여 콘텐츠를 열 수 없습니다']]) {
      await invalid.goto(`${gateway.baseUrl}/event/tab-identity-a/${route}`);
      await invalid.getByRole('heading', { name: heading, exact: true }).waitFor();
      await invalid.reload({ waitUntil: 'networkidle' });
      await invalid.getByRole('heading', { name: heading, exact: true }).waitFor();
      assert.equal(await invalid.getByText(sessionName.trim(), { exact: true }).count(), 0, `${route} must not pick another identity`);
    }
    // A deliberately opened, valid new ticket replaces the rejection marker.
    const b = workspace.participants.find(p => p.name === people[1].name);
    await invalid.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket?ticket=${encodeURIComponent(b.ticket)}`);
    await invalid.getByRole('heading', { name: people[1].name, exact: true }).waitFor();
    await invalid.reload({ waitUntil: 'networkidle' });
    await invalid.getByRole('heading', { name: people[1].name, exact: true }).waitFor();

    // A previously valid ticket can be revoked while the same tab is open.
    const a = workspace.participants.find(p => p.name === people[0].name);
    a.revoked = true;
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', ['tab-identity-a', JSON.stringify(workspace)]);
    await pages[0].getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await pages[0].getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor();
    await pages[0].reload({ waitUntil: 'networkidle' });
    await pages[0].getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor();
    assert.equal(await pages[0].getByText(people[1].name, { exact: true }).count(), 0);
    await pages[1].reload({ waitUntil: 'networkidle' });
    await pages[1].getByRole('heading', { name: people[1].name, exact: true }).waitFor();

    // Restricted tab storage cannot carry the rejection marker across
    // routes. In that case implicit shared-cookie restoration is disabled;
    // the attendee can still explicitly request the browser's last session.
    const blocked = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const bSession = await createAttendeeAccess(harness.database).grantAccess({
      event: { id: 'tab-identity-a', payload: { date: '2099-01-01' } }, participantId: b.id, phone: b.phone,
    });
    await blocked.addCookies([{ name: attendeeCookieName('tab-identity-a'), value: bSession.token,
      url: gateway.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    await blocked.addInitScript(() => Object.defineProperty(window, 'sessionStorage', {
      configurable: true, get() { throw new DOMException('Blocked', 'SecurityError'); },
    }));
    const restricted = await blocked.newPage();
    await restricted.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket?ticket=invalid-ticket`);
    await restricted.getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor();
    await restricted.reload({ waitUntil: 'networkidle' });
    await restricted.getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor();
    const [publicHomeTicket] = await Promise.all([
      restricted.waitForResponse(response => response.url().includes('/api/public/events/tab-identity-a/ticket')),
      restricted.goto(`${gateway.baseUrl}/event/tab-identity-a/home`),
    ]);
    assert.equal(publicHomeTicket.status(), 404, 'restricted storage must not silently restore the shared cookie on home');
    for (const person of people.slice(0, 2)) assert.equal(await restricted.getByText(person.name, { exact: true }).count(), 0);
    await restricted.goto(`${gateway.baseUrl}/event/tab-identity-a/engage`);
    await restricted.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
    for (const person of people.slice(0, 2)) assert.equal(await restricted.getByText(person.name, { exact: true }).count(), 0);
    await restricted.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket`);
    await restricted.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
    await restricted.getByText(/마지막으로 인증한 참가자의 티켓이 열립니다/).waitFor();
    await restricted.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await restricted.setViewportSize({ width, height: 844 });
      assert.equal(await restricted.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const action = await restricted.getByRole('link', { name: '이 브라우저에서 인증된 티켓 확인', exact: true }).boundingBox();
      assert.ok(action && action.width >= 44 && action.height >= 44, 'session confirmation remains a usable touch target');
      assert.deepEqual(await restricted.evaluate(async () => (await window.axe.run()).violations
        .filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
    }
    await restricted.setViewportSize({ width: 390, height: 844 });
    await restricted.screenshot({ path: path.join(out, 'restricted-storage-390.png'), fullPage: true });
    const sessionChoice = restricted.getByRole('link', { name: '이 브라우저에서 인증된 티켓 확인', exact: true });
    await sessionChoice.focus();
    assert.equal(await sessionChoice.evaluate(element => element === document.activeElement), true);
    await restricted.keyboard.press('Enter');
    await restricted.waitForLoadState('networkidle');
    await restricted.getByRole('heading', { name: people[1].name, exact: true }).waitFor();
    const aSession = await createAttendeeAccess(harness.database).grantAccess({
      event: { id: 'tab-identity-a', payload: { date: '2099-01-01' } }, participantId: a.id, phone: a.phone,
    });
    await blocked.addCookies([{ name: attendeeCookieName('tab-identity-a'), value: aSession.token,
      url: gateway.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    await restricted.getByRole('link', { name: '← 참가 메뉴로' }).click();
    await restricted.getByRole('button', { name: '내 신청 정보' }).click();
    await restricted.getByText(people[1].name, { exact: true }).waitFor();
    await restricted.reload({ waitUntil: 'networkidle' });
    await restricted.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
    for (const person of people.slice(0, 2)) assert.equal(await restricted.getByText(person.name, { exact: true }).count(), 0);
    await blocked.addCookies([{ name: attendeeCookieName('tab-identity-a'), value: bSession.token,
      url: gateway.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    await restricted.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket?ticket=invalid-ticket`);
    await restricted.getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor();
    await restricted.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket`);
    await restricted.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
    assert.equal(await restricted.getByText(people[1].name, { exact: true }).count(), 0, 'a later invalid link revokes the tab session choice');
    await blocked.close();

    // Storage can reject this event's marker (for example at its quota)
    // while accepting other keys. A smaller generic probe is insufficient.
    const quota = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await quota.addCookies([{ name: attendeeCookieName('tab-identity-a'), value: bSession.token,
      url: gateway.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    await quota.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith('eventouch.ticket-rejected.')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    });
    const limited = await quota.newPage();
    await limited.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket?ticket=invalid-ticket`);
    await limited.getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor();
    await limited.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket`);
    await limited.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
    assert.equal(await limited.getByText(people[1].name, { exact: true }).count(), 0);
    await quota.close();

    // A browser may still expose an old stored ticket even though replacing
    // it now fails. Explicitly choosing B's session must not read that old
    // A ticket when moving into the participant menu or its content.
    const partial = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await partial.addCookies([{ name: attendeeCookieName('tab-identity-a'), value: bSession.token,
      url: gateway.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    await partial.addInitScript(({ oldTicket }) => {
      const set = Storage.prototype.setItem;
      set.call(sessionStorage, 'eventouch.ticket.tab-identity-a', oldTicket);
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith('eventouch.ticket.')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        if (String(key).startsWith('eventouch.ticket-rejected.')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    }, { oldTicket: a.ticket });
    const staleStored = await partial.newPage();
    await staleStored.goto(`${gateway.baseUrl}/event/tab-identity-a/ticket?session=1`);
    await staleStored.getByRole('heading', { name: people[1].name, exact: true }).waitFor();
    await staleStored.getByRole('link', { name: '← 참가 메뉴로' }).click();
    await staleStored.getByRole('button', { name: '내 신청 정보' }).click();
    await staleStored.getByText(people[1].name, { exact: true }).waitFor();
    assert.equal(await staleStored.getByText(people[0].name, { exact: true }).count(), 0);
    await staleStored.reload({ waitUntil: 'networkidle' });
    await staleStored.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
    for (const person of people.slice(0, 2)) assert.equal(await staleStored.getByText(person.name, { exact: true }).count(), 0);
    await partial.close();
    console.log('PASS: concurrent signup, rejected identity across routes and reload, explicit recovery, restricted storage');
  } finally {
    if (browser) await browser.close();
    if (gateway) await gateway.close();
    if (web) await web.close();
    await harness.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
