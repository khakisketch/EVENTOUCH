'use strict';

// Fresh synthetic API/DB + production Next: attendee recovery and the
// assigned-desk manual path. Never sends SMS or touches the preview schema.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk, typeTicket } = require('./audit-staff-direction.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
let stage = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'uiux-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, page;
  try {
    const db = f.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const write = async value => db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(value)]);
    const workspace = await read();
    const people = workspace.participants.slice(0, 8);
    people[1].name = people[2].name = '동명이인';
    people[1].company = people[2].company = '동일 소속';
    people[3].name = '소속없음'; people[3].company = '';
    workspace.venue.contact = '';
    await write(workspace);
    browser = await launchBrowser();
    const guest = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    page = await guest.newPage();
    page.on('dialog', dialog => dialog.dismiss());
    stage = 'same tab and fresh tab';
    await page.goto(`${f.baseUrl}/event/${f.slug}`);
    await page.evaluate(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: people[0].ticket });
    await page.goto(`${f.baseUrl}/event/${f.slug}/ticket`);
    await page.getByRole('heading', { name: '내 티켓' }).waitFor();
    const newTab = await guest.newPage();
    await newTab.goto(`${f.baseUrl}/event/${f.slug}/ticket`);
    // Reopened 2026-11-24 (전수 점검): 티켓 보관 안내를 실제 쿠키 동작에 맞춰 '탭'이 아니라 '신청한 기기의 같은 브라우저'로 설명한다.
    await newTab.getByRole('heading', { name: '티켓이 확인되지 않습니다' }).waitFor();
    await newTab.getByText('신청을 완료한 기기의 같은 브라우저에서 열어 주세요.', { exact: false }).waitFor();
    await newTab.getByText('이 행사는 문자로 티켓을 다시 연결할 수 없습니다.', { exact: false }).waitFor();
    assert.equal(await newTab.getByRole('link', { name: '행사 안내 확인' }).count(), 1);
    assert.equal(await newTab.getByRole('link', { name: '처음 신청하기' }).count(), 1);
    assert.equal(await newTab.getByText('신청한 기기에서만', { exact: false }).count(), 0);
    await newTab.screenshot({ path: path.join(out, 'ticket-new-tab-390.png') });
    stage = 'missing contact and protected form exit';
    await newTab.getByRole('link', { name: '행사 안내 확인' }).click();
    await newTab.locator('summary').filter({ hasText: '이미 신청하셨나요?' }).click();
    // Reopened 2026-11-24: 문의처가 없으면 '행사 초대 안내' 대신 같은 브라우저 안내와 주최 측 문의 문장을 보인다.
    await newTab.getByRole('note').filter({ hasText: '이 행사는 문자로 티켓을 다시 연결할 수 없습니다. 행사 주최 측에 문의하세요.' }).waitFor();
    await newTab.getByRole('link', { name: '참가 신청하기' }).click();
    await newTab.locator('#field-name').fill('합성 신청자');
    newTab.on('dialog', dialog => dialog.dismiss());
    await newTab.getByRole('link', { name: '← 행사 안내로' }).click();
    assert.equal(await newTab.locator('#field-name').inputValue(), '합성 신청자');
    assert.match(newTab.url(), /\/register$/);
    await newTab.close();
    const contactTab = await guest.newPage();
    stage = 'visible contact and hidden contact';
    const contactWorkspace = await read();
    contactWorkspace.venue.contact = '합성 문의 010-0000-0000';
    contactWorkspace.consentText = '합성 정보 수집 안내';
    await write(contactWorkspace);
    await contactTab.goto(`${f.baseUrl}/event/${f.slug}/ticket/recover`);
    await contactTab.getByText('문의: 합성 문의 010-0000-0000', { exact: false }).waitFor();
    await contactTab.goto(`${f.baseUrl}/event/${f.slug}/register`);
    // Reopened 2026-11-24 (티켓 안내를 한 곳에서): 열린 신청서의 상시 '문자 복구 불가 · 문의' 줄은 없어졌고,
    // 신청서에서 주최 측 문의처는 정보 수집 동의의 파기 기준 문장에 보인다.
    await contactTab.getByText('행사 주최 측(합성 문의 010-0000-0000)에 확인하세요.', { exact: false }).waitFor();
    const hidden = await read();
    hidden.pageExperience ||= {};
    hidden.pageExperience.published ||= {};
    hidden.pageExperience.published.showVenue = false;
    await write(hidden);
    for (const route of ['', '/ticket/recover', '/register']) {
      await contactTab.goto(`${f.baseUrl}/event/${f.slug}${route}`);
      await contactTab.locator('main').waitFor();
      assert.equal(await contactTab.getByText('합성 문의 010-0000-0000', { exact: false }).count(), 0, 'hidden contact is not surfaced by recovery');
    }
    await guest.close();
    stage = 'ticket storage blocked';
    const restricted = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await restricted.addInitScript(() => {
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith('eventouch.ticket.')) throw new DOMException('storage blocked', 'SecurityError');
        return originalSetItem.call(this, key, value);
      };
    });
    const restrictedPage = await restricted.newPage();
    await restrictedPage.goto(`${f.baseUrl}/event/${f.slug}/ticket?ticket=${encodeURIComponent(people[0].ticket)}`);
    await restrictedPage.getByRole('heading', { name: '내 티켓' }).waitFor();
    // Reopened 2026-11-24: 안내는 '티켓 보관 차단'으로 말하고, 다시 열 수 없을 때를 대비한 화면 캡처를 함께 알린다.
    await restrictedPage.getByText(/이 브라우저에서 티켓 보관이 차단되어 있습니다\..*다시 확인해야 할 수 있습니다\. 입장 QR 화면을 캡처해 두세요\./).waitFor();
    assert.equal(new URL(restrictedPage.url()).searchParams.has('ticket'), false, 'one-time ticket is removed from the address');
    await restrictedPage.screenshot({ path: path.join(out, 'ticket-storage-blocked-390.png') });
    await restrictedPage.reload();
    await restrictedPage.getByRole('heading', { name: '티켓이 확인되지 않습니다' }).waitFor();
    await restricted.close();
    const staff = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await staff.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
    await staff.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } } }));
    page = await staff.newPage();
    page.on('dialog', dialog => dialog.accept());
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    let mode = 'lost';
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'check.scan') return route.continue();
      requests.push({ commandId: body.commandId, assignmentId: body.assignmentId, payload: body.payload });
      if (mode === 'lost') { mode = 'pass'; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
      if (['mismatch', 'qr-direction', 'qr-check-id'].includes(mode)) {
        const fault = mode;
        mode = 'pass';
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        const original = await response.json();
        const replacement = fault === 'mismatch' ? { id: 'wrong-person', name: '다른 사람' }
          : fault === 'qr-direction' ? { action: 'OUT' } : { checkId: 'different-check-id' };
        return route.fulfill({ response, json: { ...original, ...replacement } });
      }
      return route.continue();
    });
    stage = 'camera denied and manual selection';
    await page.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    await page.locator('#staff-desk').waitFor();
    await confirmInitialStaffDesk(page);
    await page.getByRole('button', { name: '카메라 켜기' }).click();
    await page.getByText('참가자 명단에서 확인하거나', { exact: false }).waitFor();
    await page.getByRole('button', { name: '명단에서 참가자 찾기', exact: true }).click();
    await page.locator('#staff-manual-search').fill('감사 참가자 1');
    await page.getByRole('button', { name: '감사 참가자 1 감사 업체 1 선택' }).click();
    const submit = page.getByRole('button', { name: '확인한 참가자 입장 처리' });
    assert.equal(await submit.isDisabled(), true);
    await page.getByLabel('이름·소속을 직접 확인했습니다').check();
    await page.screenshot({ path: path.join(out, 'manual-confirm-390.png') });
    await page.setViewportSize({ width: 320, height: 760 });
    await submit.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'manual confirmation fits a 320px viewport');
    assert.equal(await submit.isEnabled(), true);
    const identityTarget = await page.getByLabel('이름·소속을 직접 확인했습니다').locator('..').boundingBox();
    assert.ok(identityTarget && identityTarget.height >= 44 && identityTarget.width >= 44, 'identity checkbox has a full-size touch label');
    await page.screenshot({ path: path.join(out, 'manual-confirm-320.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await submit.click();
    const unknown = page.getByRole('region', { name: '스캔 결과 미확인', exact: true });
    await unknown.waitFor();
    assert.match(await unknown.innerText(), /감사 참가자 1/);
    assert.equal(await page.locator('#staff-desk').isDisabled(), true);
    assert.equal((await read()).checks.filter(item => item.participantId === people[0].id).length, 1);
    await unknown.getByRole('button', { name: '같은 요청 재확인' }).click();
    await page.getByRole('region', { name: '스캔 결과 상세', exact: true }).getByText('감사 참가자 1', { exact: false }).waitFor();
    assert.deepEqual(requests[1], requests[0], 'same manual target, desk, assignment and command id after response loss');
    assert.equal(requests[0].payload.participantId, people[0].id);
    assert.equal(Object.hasOwn(requests[0].payload, 'ticket'), false);
    assert.equal((await read()).checks.filter(item => item.participantId === people[0].id).length, 1);
    stage = 'ambiguous or missing identity';
    await page.getByRole('button', { name: '다음 참가자', exact: true }).click();
    await page.getByRole('button', { name: '명단 찾기', exact: true }).click();
    await page.locator('#staff-manual-search').fill('동명이인');
    assert.equal(await page.getByText('같은 이름·소속이 있습니다.', { exact: false }).count(), 2);
    for (const button of await page.getByRole('button', { name: '동명이인 동일 소속 선택' }).all()) assert.equal(await button.isDisabled(), true);
    await page.locator('#staff-manual-search').fill('소속없음');
    assert.equal(await page.getByRole('button', { name: '소속없음 소속 미입력 선택' }).isDisabled(), true);
    stage = 'mismatched success and status-only reconciliation';
    await page.locator('#staff-manual-search').fill('감사 참가자 5');
    await page.getByRole('button', { name: '감사 참가자 5 감사 업체 1 선택' }).click();
    await page.getByLabel('이름·소속을 직접 확인했습니다').check();
    mode = 'mismatch';
    await page.getByRole('button', { name: '확인한 참가자 입장 처리' }).click();
    await page.getByRole('region', { name: '스캔 결과 미확인', exact: true }).waitFor();
    const countBefore = requests.length;
    // The current request's own status check sits in its unconfirmed result.
    await page.getByRole('region', { name: '스캔 결과 미확인', exact: true }).getByRole('group', { name: '현재 요청 서버 확인' }).getByRole('button', { name: '서버 처리 확인' }).click();
    await page.getByText('서버 처리를 확인했습니다. 최신 현장 기록을 확인하세요.').waitFor();
    assert.equal(requests.length, countBefore, 'status lookup does not resend');
    assert.equal((await read()).checks.filter(item => item.participantId === people[4].id).length, 1);
    stage = 'QR response identity and direction';
    const qr = people[6];
    const ticketInput = page.locator('#staff-ticket');
    const qrStart = requests.length;
    await typeTicket(page, qr.ticket);
    mode = 'qr-direction';
    await page.getByRole('button', { name: '입장 처리', exact: true }).click();
    const confirmAgain = unknown.getByRole('button', { name: '같은 요청 재확인' });
    await confirmAgain.waitFor();
    const scanResult = page.getByRole('region', { name: '스캔 결과 상세', exact: true });
    assert.equal(await scanResult.count(), 0, 'a different direction cannot confirm the QR scan');
    mode = 'qr-check-id';
    await confirmAgain.click();
    await confirmAgain.waitFor();
    assert.equal(await scanResult.count(), 0, 'a different check id cannot confirm the QR scan');
    await confirmAgain.click();
    await page.getByRole('region', { name: '스캔 결과', exact: true }).getByText(`${qr.name} · 입장`, { exact: true }).waitFor();
    assert.deepEqual(requests.slice(qrStart), Array.from({ length: 3 }, () => requests[qrStart]));
    assert.equal((await read()).checks.filter(item => item.participantId === qr.id).length, 1);
    await page.screenshot({ path: path.join(out, 'qr-receipt-confirmed-390.png'), mask: [ticketInput] });
    await page.addScriptTag({ content: axe });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
    assert.deepEqual(errors, []);
    stage = 'unauthorized desk';
    const manager = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command: 'desk.save', payload: { name: '다른 데스크', action: 'IN', mode: 'desk', open: true } } });
    assert.ok(manager.status >= 200 && manager.status < 300, 'manager can create a second synthetic desk');
    const denied = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { cookie: f.staff.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command: 'check.scan', assignmentId: requests[0].assignmentId, payload: { deskId: manager.json.desk.id, participantId: people[5].id } } });
    assert.equal(denied.status, 403, 'an assigned staff member cannot use the manual path at another desk');
    assert.equal((await read()).checks.filter(item => item.participantId === people[5].id).length, 0);
    await staff.close();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', synthetic: true, freshTab: true, restrictedStorageAndReload: true, contactVisibility: true, formExitGuard: true, manualIdentity: true, duplicateAndNoCompanyBlocked: true, committedResponseLoss: true, sameCommandRetry: true, mismatchedSuccess: true, statusOnlyNoResend: true, qrReceiptIdentity: true, unauthorizedDesk: true, axeSeriousCritical: 0 }, null, 2), { mode: 0o600 });
    console.log('UI/UX recovery: tab, contact visibility, manual desk identity and uncertain-result protection passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
