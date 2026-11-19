'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk, typeTicket } = require('./audit-staff-direction.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendee-ticket-return'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { database } = fixture.harness;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const attendee = (await read()).participants.find(person => person.status === 'APPROVED' && person.ticket);
    assert.ok(attendee);
    const commandUrl = `${fixture.baseUrl}/api/events/${fixture.eventId}/commands`;
    const ticketRead = `${fixture.baseUrl}/api/public/events/${fixture.slug}/ticket`;
    const ticketUrl = `${fixture.baseUrl}/event/${fixture.slug}/ticket`;
    const eventUrl = `${fixture.baseUrl}/event/${fixture.slug}`;

    browser = await launchBrowser();
    const mobile = { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' };
    const guestContext = await browser.newContext(mobile);
    const guest = await guestContext.newPage();
    const qr = guest.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ });
    const showTicket = async token => {
      await guest.goto(`${ticketUrl}?ticket=${encodeURIComponent(token)}`);
      await qr.waitFor();
      assert.ok(!new URL(guest.url()).searchParams.has('ticket'));
    };
    const visibility = value => guest.evaluate(state => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
    const storageKey = `eventouch.ticket.${fixture.slug}`;
    await showTicket(attendee.ticket);
    const qrShot = name => guest.screenshot({ path: path.join(out, name), mask: [qr], maskColor: '#e4e6ea', fullPage: true });
    let reads = 0;
    let guestWrites = 0;
    const observeTicketReads = context => context.on('request', request => {
      if (request.url() === ticketRead) reads += 1;
    });
    observeTicketReads(guest.context());
    guest.on('request', request => {
      if (request.method() === 'POST') guestWrites += 1;
    });

    // The public event view may offer the current attendee a direct ticket
    // link from this tab's existing per-event storage. Loading public details
    // alone must never fetch private ticket status.
    await guest.goto(eventUrl);
    const sameTabTicket = guest.getByRole('link', { name: '내 티켓 열기' });
    await sameTabTicket.waitFor();
    const eventAddress = new URL(guest.url());
    assert.ok(
      eventAddress.username === '' && eventAddress.password === '' && !eventAddress.search && !eventAddress.hash,
      'the public event address has no credential, query, or fragment'
    );
    const sameTabTarget = new URL(await sameTabTicket.getAttribute('href'), fixture.baseUrl);
    assert.equal(sameTabTarget.origin, new URL(ticketUrl).origin);
    assert.equal(sameTabTarget.pathname, new URL(ticketUrl).pathname);
    assert.ok(
      sameTabTarget.username === '' && sameTabTarget.password === '' && !sameTabTarget.search && !sameTabTarget.hash,
      'the public ticket link carries no credentials or personal data'
    );
    assert.equal(reads, 0, 'viewing the public event does not read private ticket status');
    await sameTabTicket.click();
    await qr.waitFor();
    await guest.waitForFunction(url => window.location.pathname === new URL(url).pathname && !window.location.search.includes('ticket='), ticketUrl);
    await guest.waitForFunction(() => document.querySelector('[aria-label$="행사 입장 및 퇴장용 QR"]') !== null);
    assert.equal(reads, 1, 'opening the ticket link verifies its bearer with the existing status endpoint');

    // Cookies are shared by tabs in one browser context. sessionStorage is
    // isolated to each tab, so another tab must not inherit this ticket.
    const otherTab = await guestContext.newPage();
    await otherTab.goto(eventUrl, { waitUntil: 'networkidle' });
    assert.equal(await otherTab.getByRole('link', { name: '내 티켓 열기' }).count(), 0);
    assert.equal(reads, 1, 'the other tab does not restore or check a ticket');
    await otherTab.close();

    // A stale key for another event never exposes an entry point for this one.
    const wrongEventContext = await browser.newContext(mobile);
    observeTicketReads(wrongEventContext);
    const wrongEventTab = await wrongEventContext.newPage();
    await wrongEventTab.goto(eventUrl);
    await wrongEventTab.evaluate(key => window.sessionStorage.setItem(key, 'fixture-only-ticket'), 'eventouch.ticket.other-fixture-event');
    await wrongEventTab.reload({ waitUntil: 'networkidle' });
    assert.equal(await wrongEventTab.getByRole('link', { name: '내 티켓 열기' }).count(), 0);
    assert.equal(reads, 1, 'a ticket key for a different event is ignored');
    await wrongEventContext.close();

    // Remove the current event key and start a clean document to clear the
    // ticket component's tab-memory fallback as well as persistent storage.
    const clearedContext = await browser.newContext(mobile);
    observeTicketReads(clearedContext);
    const clearedTab = await clearedContext.newPage();
    await clearedTab.goto(eventUrl);
    await clearedTab.evaluate(({ currentKey, ticket }) => window.sessionStorage.setItem(currentKey, ticket), { currentKey: storageKey, ticket: attendee.ticket });
    await clearedTab.reload({ waitUntil: 'networkidle' });
    await clearedTab.getByRole('link', { name: '내 티켓 열기' }).waitFor();
    await clearedTab.evaluate(key => window.sessionStorage.removeItem(key), storageKey);
    await clearedTab.reload({ waitUntil: 'networkidle' });
    assert.equal(await clearedTab.getByRole('link', { name: '내 티켓 열기' }).count(), 0);
    await clearedContext.close();
    reads = 0;

    await visibility('hidden');
    const operatorContext = await browser.newContext(mobile);
    await operatorContext.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    await operatorContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.baseUrl });
    const operator = await operatorContext.newPage();
    async function openReissue(page) {
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`);
      await page.getByRole('button', { name: `${attendee.name} 참가자 상세`, exact: true }).first().click();
      await page.getByRole('button', { name: '티켓 재발급', exact: true }).click();
      return page.getByRole('dialog', { name: '티켓 재발급', exact: true });
    }
    const dialog = await openReissue(operator);
    const secondContext = await browser.newContext(mobile);
    const ownerCookie = await fixture.helpers.sessionCookie(fixture.harness, `audit-owner-${fixture.suffix}`);
    await secondContext.addCookies([{
      name: 'etko_session', value: decodeURIComponent(ownerCookie.slice('etko_session='.length)),
      url: fixture.baseUrl, httpOnly: true, sameSite: 'Lax',
    }]);
    const second = await secondContext.newPage();
    const staleDialog = await openReissue(second);
    const confirmLabel = '기존 티켓 무효화 및 재발급';
    const staleConfirm = staleDialog.getByRole('button', { name: confirmLabel, exact: true });
    await staleConfirm.waitFor();
    let staleWrites = 0;
    second.on('request', request => {
      if (request.url() === commandUrl && request.method() === 'POST') staleWrites += 1;
    });
    const attempts = [];
    await operator.route(commandUrl, async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'ticket.reissue-reviewed') return route.continue();
      attempts.push(body);
      if (attempts.length === 1) {
        assert.equal((await route.fetch()).status(), 200);
        return route.abort('failed');
      }
      if (attempts.length === 2) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '지원하지 않는 참가자 작업입니다' }) });
      return route.continue();
    });
    assert.ok(await dialog.getByText(/기존 링크와 QR은 사용할 수 없게 됩니다/).isVisible());
    assert.equal(attempts.length, 0);
    await operator.screenshot({ path: path.join(out, 'operator-reissue-confirm-390.png') });
    await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await dialog.getByText(/재발급이 확인됐습니다/).waitFor();
    assert.equal(attempts.length, 1);
    await dialog.getByRole('button', { name: '같은 요청으로 링크 받기', exact: true }).click();
    await dialog.getByText(/재발급 결과를 확인하지 못했습니다/).waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(await operator.evaluate(id => [localStorage, sessionStorage].some(store => {
      for (let i = 0; i < store.length; i++) if ((store.getItem(store.key(i)) || '').includes(id)) return true;
      return false;
    }), attempts[0].commandId), true, 'an old-server retry cannot erase the unknown original request');
    const observer = await operatorContext.newPage();
    await observer.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`);
    const recoveryPanel = observer.getByRole('region', { name: '처리 결과 확인' });
    await recoveryPanel.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await recoveryPanel.getByText(/서버에 티켓 재발급 기록이 있습니다/).waitFor();
    await observer.getByRole('button', { name: `${attendee.name} 참가자 상세`, exact: true }).first().click();
    assert.equal(await observer.getByRole('button', { name: '티켓 재발급', exact: true }).isDisabled(), true, 'status-only verification in another tab does not release the unresolved original request');
    await observer.close();
    await dialog.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await dialog.getByText(/재발급이 확인됐습니다/).waitFor();
    await dialog.getByRole('button', { name: '같은 요청으로 링크 받기', exact: true }).click();
    const copy = dialog.getByRole('button', { name: '새 티켓 링크 복사', exact: true });
    await copy.waitFor();
    assert.deepEqual(attempts[2], attempts[0]);
    assert.equal(attempts.length, 3);
    await operator.waitForFunction(id => [localStorage, sessionStorage].some(store => {
      for (let i = 0; i < store.length; i++) if ((store.getItem(store.key(i)) || '').includes(id)) return true;
      return false;
    }), attempts[0].commandId, { timeout: 5000 });
    await operator.screenshot({ path: path.join(out, 'operator-reissue-issued-390.png') });
    await copy.click();
    await dialog.getByRole('status').filter({ hasText: '새 티켓 링크를 복사했습니다.' }).waitFor();
    await dialog.getByText('링크 직접 복사', { exact: true }).click();
    const replacementLink = new URL(await dialog.getByLabel('새 티켓 링크', { exact: true }).inputValue());
    assert.equal(replacementLink.origin, new URL(ticketUrl).origin);
    assert.equal(replacementLink.pathname, new URL(ticketUrl).pathname);
    const replacement = replacementLink.searchParams.get('ticket');
    assert.ok(replacement && replacement !== attendee.ticket);
    assert.ok(await operator.evaluate(async link => (await navigator.clipboard.readText()) === link, replacementLink.href));
    assert.ok(await operator.evaluate(token => !JSON.stringify(sessionStorage).includes(token) && !JSON.stringify(localStorage).includes(token), replacement));

    const [conflict] = await Promise.all([
      second.waitForResponse(response => response.url() === commandUrl && response.request().method() === 'POST'),
      staleConfirm.click(),
    ]);
    assert.equal(conflict.status(), 409);
    assert.equal((await conflict.json()).code, 'TICKET_REVISION_CHANGED');
    assert.equal(conflict.request().postDataJSON().payload.expectedTicketRevision, attempts[0].payload.expectedTicketRevision);
    await staleDialog.getByRole('status').filter({ hasText: '이 재발급 요청을 중단했습니다' }).waitFor();
    assert.equal(await staleConfirm.count(), 0);
    assert.equal(await staleDialog.getByRole('button', { name: '새 티켓 링크 복사' }).count(), 0);
    const latest = staleDialog.getByRole('button', { name: '최신 참가자 정보 보기', exact: true });
    await second.waitForFunction(() => document.activeElement?.textContent?.trim() === '최신 참가자 정보 보기');
    await second.screenshot({ path: path.join(out, 'operator-reissue-conflict-390.png') });
    await second.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await second.setViewportSize({ width, height: 844 });
      assert.ok(await staleDialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      assert.ok((await latest.boundingBox()).height >= 44);
      assert.deepEqual(await second.evaluate(async () => (await window.axe.run()).violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => item.id)), []);
    }
    const bootstrapUrl = `${fixture.baseUrl}/api/events/${fixture.eventId}/bootstrap`;
    await second.route(bootstrapUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    await second.setViewportSize(mobile.viewport);
    await latest.click();
    await staleDialog.getByRole('alert').filter({ hasText: '최신 참가자 정보를 불러오지 못했습니다' }).waitFor();
    await latest.press('Enter');
    await staleDialog.waitFor({ state: 'hidden' });
    const inspector = second.getByRole('dialog', { name: attendee.name, exact: true });
    await inspector.getByRole('button', { name: '티켓 재발급', exact: true }).waitFor();
    assert.equal(staleWrites, 1, 'refreshing the participant after a conflict is read-only');

    for (const width of [320, 390, 1280]) {
      await operator.setViewportSize({ width, height: 844 });
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      assert.ok((await copy.boundingBox()).height >= 44);
    }
    await dialog.getByRole('button', { name: '링크 확인 완료', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await operator.waitForFunction(id => [localStorage, sessionStorage].every(store => {
      for (let i = 0; i < store.length; i++) if ((store.getItem(store.key(i)) || '').includes(id)) return false;
      return true;
    }), attempts[0].commandId, { timeout: 5000 });
    assert.equal(reads, 0, 'the hidden ticket does not request status');

    let release;
    const held = new Promise(resolve => { release = resolve; });
    await guest.route(ticketRead, async route => {
      await held;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    }, { times: 1 });
    const checking = guest.getByRole('status').filter({ hasText: '최신 상태를 확인하고 있습니다' });
    try {
      await visibility('visible');
      const started = await checking.waitFor({ timeout: 2000 }).then(() => true, () => false);
      if (!started) await qrShot('stale-on-return.png');
      assert.ok(started, 'returning to a visible ticket must check the server without a click');
      assert.ok(await qr.isVisible(), 'keep the previous QR visible during verification');
      await guest.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      assert.equal(reads, 1, 'a return signal during an in-flight read must not duplicate it');
    } finally {
      release();
    }
    const unconfirmed = guest.getByRole('alert').filter({ hasText: '이 QR의 입장 가능 여부는 확정되지 않았습니다' });
    await unconfirmed.waitFor();
    assert.ok(await guest.getByText('상태 확인 필요', { exact: true }).isVisible());
    assert.ok((await unconfirmed.boundingBox()).y < (await qr.boundingBox()).y);
    await qrShot('return-connection-failed.png');
    assert.ok(await guest.evaluate(key => sessionStorage.getItem(key) !== null, storageKey));

    const invalid = guest.getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true });
    await guest.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await invalid.waitFor();
    assert.equal(reads, 2);
    assert.equal(await qr.count(), 0);
    assert.equal(await guest.evaluate(key => sessionStorage.getItem(key) === null, storageKey), true);
    await guest.getByText(/새 티켓 안내 링크를 확인하세요/).waitFor();
    await qrShot('reissued-ticket-rejected.png');
    await guest.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await guest.setViewportSize({ width, height: 844 });
      assert.ok(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await guest.evaluate(async () => (await window.axe.run()).violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => item.id)), []);
    }

    const staffContext = await browser.newContext(mobile);
    await staffContext.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    const staff = await staffContext.newPage();
    await staff.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await confirmInitialStaffDesk(staff);
    const scan = staff.getByRole('button', { name: '입장 처리', exact: true });
    const scanTicket = async token => {
      await typeTicket(staff, token);
      return (await Promise.all([
        staff.waitForResponse(response => response.url() === commandUrl && response.request().method() === 'POST'),
        scan.click(),
      ]))[0];
    };
    assert.equal((await scanTicket(attendee.ticket)).status(), 404);
    assert.equal((await read()).checks.length, 0);
    await guest.setViewportSize({ width: 390, height: 844 });
    await showTicket(replacement);
    await qrShot('replacement-ticket-390.png');
    assert.equal((await scanTicket(replacement)).status(), 200);
    await staff.getByRole('region', { name: '스캔 결과', exact: true }).getByText(`${attendee.name} · 입장`, { exact: true }).waitFor();
    await visibility('hidden');
    await visibility('visible');
    await guest.getByText('입장 중', { exact: true }).waitFor();
    const saved = (await read()).checks;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].participantId, attendee.id);
    assert.equal(guestWrites, 0, 'status checks and opening a replacement link are read-only');
    console.log('Console recovered the first reissue after response loss, rejected a stale confirmation, and recorded one staff check-in with the first replacement.');
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

main().catch(error => {
  console.error(String(error?.message || error).split('\n')[0].replace(/https?:\/\/[^\s]+/g, '[url redacted]'));
  process.exitCode = 1;
});
