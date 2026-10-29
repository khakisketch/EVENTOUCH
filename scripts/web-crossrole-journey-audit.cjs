'use strict';

// Cross-role product journey: participant signup → ticket → assigned staff
// check-in → operator report, plus receipt-wording branches (waitlist,
// immediate-approved, unpaid, cancelled) and a storage-denied re-check.
// Drives the real rendered UI against the real isolated API/PostgreSQL;
// committed-response loss and one delayed roster refresh are injected
// (disclosed), and a QR read is
// simulated by typing the participant-held ticket code into the staff form
// (no physical scanner).
// Seeded preconditions (disclosed): approvalRequired=true so public signups
// land PENDING and the operator approval handoff is exercised; one
// assignment-less staff account for the unassigned state; capacity/price/
// feature tweaks for the waitlist/unpaid wording branches (set back right
// after the branch signup where the journey depends on it).
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID', 'SOLAPI_API_HOST']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const axe = require('axe-core').source;
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

// Each default run gets its own evidence directory. Do not overwrite earlier
// captures; callers such as CI may still select an explicit capture root.
const captureRoot = process.env.EVENTOUCH_CAPTURE_ROOT
  || defaultCaptureDir(`crossrole-${crypto.randomUUID()}`);
const OUT = path.join(captureRoot, 'crossrole-journey');

// Masks the typed ticket code for screenshots only (dots instead of the raw
// bearer); the field value itself is asserted separately and restored after.
async function maskTicketInput(page) {
  await page.locator('#staff-ticket').evaluate((el) => {
    if (el instanceof HTMLInputElement) el.dataset.fixtureType = el.type;
    if (el instanceof HTMLInputElement) el.setAttribute('type', 'password');
  });
}
async function unmaskTicketInput(page) {
  await page.locator('#staff-ticket').evaluate((el) => {
    if (el instanceof HTMLInputElement) el.setAttribute('type', el.dataset.fixtureType || 'text');
  });
}

// Measure actual glyph positions on the participant's receipt and recovery
// guidance, not just element overflow or the presence of a CSS declaration.
async function splitKoreanWords(locator) {
  return locator.evaluate((node) => {
    const range = document.createRange(), chars = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      for (let i = 0; i < text.data.length; i++) {
        range.setStart(text, i); range.setEnd(text, i + 1);
        const rect = range.getClientRects()[0];
        chars.push({ char: text.data[i], top: rect ? Math.round(rect.top) : null });
      }
    }
    return chars.flatMap((char, index) => {
      const previous = chars[index - 1];
      return previous && char.top !== null && previous.top !== null && char.top !== previous.top && /[가-힣]/.test(previous.char) && /[가-힣]/.test(char.char)
        ? [`${previous.char}/${char.char}`] : [];
    });
  });
}

async function bounded(promise, label, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A status success notice can precede the roster refresh finishing. The
// dialog deliberately ignores Escape while busy, so wait for its real close
// button to become actionable and verify that the backdrop is actually gone.
async function closeParticipantDetails(roster, name) {
  const dialog = roster.getByRole('dialog', { name, exact: true });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click({ timeout: 15000 });
  await dialog.waitFor({ state: 'hidden', timeout: 15000 });
}

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const buildPath = path.join(__dirname, '..', 'apps', 'web', '.next', 'BUILD_ID');
  const buildId = fs.readFileSync(buildPath, 'utf8').trim();
  if (!buildId) throw new Error('cross-role audit requires a production Next build');
  const fixture = await startAuditFixture();
  const checks = [];
  const errors = [];
  const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); assert.ok(ok, name); };
  let browser;
  let completed = false;
  const snapshot = async () => (await fixture.harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId],
  )).rows[0].payload;
  // Real manager command path shared by the wording branches and the
  // seeded-setting adjustments below (disclosed preconditions, never a
  // substitute for the UI-driven transitions).
  const managerCall = async (command, payload) => {
    const res = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie,
      body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(res.status >= 200 && res.status < 300, `${command}: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json;
  };
  try {
    // Seeded precondition (not a substitute for the journey): public signup
    // needs operator approval so the pending/approved handoff is exercised.
    await fixture.harness.database.query(
      "UPDATE event_workspaces SET payload=jsonb_set(payload,'{approvalRequired}','true'::jsonb) WHERE event_id=$1",
      [fixture.eventId],
    );
    // The existing public presenter places built-in name/phone/company first.
    // Published custom fields must follow in the organizer's chosen order.
    // Exercise a real reorder in the disposable fixture; both are optional.
    const firstCustom = (await managerCall('field.save', { label: '검수용 추가 질문 하나', type: 'text', required: false })).field;
    const secondCustom = (await managerCall('field.save', { label: '검수용 추가 질문 둘', type: 'text', required: false })).field;
    await managerCall('field.move', { id: secondCustom.id, delta: -1 });
    await managerCall('form.publish', {});
    const customFieldOrder = (await snapshot()).publishedFields.map(field => field.id).filter(id => !['name', 'phone', 'company'].includes(id));
    assert.deepEqual(customFieldOrder, [secondCustom.id, firstCustom.id], 'fixture published the reordered custom fields');
    const displayedFieldOrder = ['name', 'phone', 'company', ...customFieldOrder];
    // Seeded precondition: an assignment-less staff account for the
    // unassigned state. Real login cookie, never used for the check-in path.
    const loneId = `audit-lone-${fixture.suffix}`.toLowerCase();
    await fixture.helpers.insertAccount(fixture.harness.database, {
      orgId: fixture.helpers.LEGACY_ORG, id: loneId, role: 'STAFF', name: '감사 미배정', email: `${loneId}@example.test`,
    });
    const loneCookie = await fixture.helpers.sessionCookie(fixture.harness, loneId);

    browser = await launchBrowser();
    const axePage = async (page, label) => {
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => (await window.axe.run()).violations
        .filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => item.id));
      check(`${label}: axe serious/critical 0`, violations.length === 0);
    };
    // Measures the real rendered control with the Playwright locator API
    // (engine selectors like :has-text work here, unlike querySelector).
    const geometry = async (page, label, cta, scrollFirst = false) => {
      const viewport = page.viewportSize() || { width: 0, height: 0 };
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      check(`${label}: no document overflow`, documentWidth <= viewport.width + 1);
      if (cta) {
        const target = page.locator(cta).first();
        if (scrollFirst) await target.scrollIntoViewIfNeeded().catch(() => {});
        const box = await target.boundingBox().catch(() => null);
        check(`${label}: primary action visible${scrollFirst ? ' (after scroll for long forms)' : ' in the first viewport'}`,
          box !== null && box.y >= 0 && box.y + box.height <= viewport.height + 1);
        check(`${label}: primary action >= 44px`, box !== null && box.width >= 44 && box.height >= 44);
      }
    };

    // ---- Participant A @390: entry → register → pending ticket ----
    const pa = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const entry = await pa.newPage();
    entry.on('pageerror', (error) => errors.push(`entry: ${error.message}`));
    await entry.goto(`${fixture.baseUrl}/event/${fixture.slug}`);
    await entry.getByRole('link', { name: '참가 신청하기' }).waitFor();
    await entry.screenshot({ path: path.join(OUT, 'a-entry-390-first.png') });
    await entry.getByRole('link', { name: '참가 신청하기' }).click();
    const reg = entry;
    await reg.locator('form.registration-form').waitFor();
    const renderedFieldOrder = await reg.locator('form.registration-form input[id^="field-"], form.registration-form select[id^="field-"]').evaluateAll(nodes => nodes.map(node => node.id.slice('field-'.length)));
    check('registration retains the built-in and published custom-field order', JSON.stringify(renderedFieldOrder) === JSON.stringify(displayedFieldOrder));
    await reg.screenshot({ path: path.join(OUT, 'a-register-390-first.png') });
    await geometry(reg, 'register 390', 'form.registration-form button[type="submit"]', true);
    await axePage(reg, 'register 390');
    check('gated register lead promises approval, not instant issuance',
      (await reg.getByText('아래 정보를 입력하면 신청이 접수되고, 운영자 승인 뒤 입장 QR이 표시됩니다.').count()) === 1
      && (await reg.getByText(/바로 발급됩니다/).count()) === 0);
    await reg.locator('#field-name').fill('여정 참가자 갑');
    await reg.locator('#field-phone').fill('01055500101');
    if (await reg.locator('#consent').count()) await reg.locator('#consent').check();
    await reg.getByRole('button', { name: '신청하기', exact: true }).click();
    await reg.getByText('승인 대기').first().waitFor({ timeout: 15000 });
    check('signup A lands on a pending receipt', true);
    check('pending receipt keeps Korean words intact at 390', (await splitKoreanWords(reg.getByText('신청이 접수되었습니다. 아래에서 진행 상태를 확인하세요.', { exact: true }))).length === 0);
    check('pending explanation keeps Korean words intact at 390', (await splitKoreanWords(reg.getByText('신청이 접수되었습니다. 운영자가 승인하면 이 화면에 입장 QR이 표시됩니다.', { exact: true }))).length === 0);
    await reg.screenshot({ path: path.join(OUT, 'a-ticket-pending-390-first.png') });
    await reg.screenshot({ path: path.join(OUT, 'a-ticket-pending-390-full.png'), fullPage: true });
    await geometry(reg, 'pending ticket 390', null);
    await axePage(reg, 'pending ticket 390');
    const pendingQr = await reg.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count();
    check('pending ticket shows no entry QR', pendingQr === 0);
    const recheckA = reg.getByRole('button', { name: '상태 다시 확인', exact: true });
    check('pending ticket offers a status re-check', (await recheckA.count()) === 1);
    await geometry(reg, 'pending recheck 390', 'button:has-text("상태 다시 확인")');
    check('pending fresh banner promises a receipt, not entry',
      (await reg.getByText('신청이 접수되었습니다. 아래에서 진행 상태를 확인하세요.').count()) === 1
      && (await reg.getByText('신청이 완료되었습니다. 이 화면이 입장권입니다.').count()) === 0);
    const peopleA = (await snapshot()).participants.filter((p) => p.phone === '01055500101');
    check('signup A persists exactly one participant', peopleA.length === 1);
    check('signup A is PENDING before approval', peopleA[0] && peopleA[0].status === 'PENDING');
    const ticketA = peopleA[0].ticket;

    // ---- Participant B @320: register → pending ticket ----
    const pb = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' });
    const regB = await pb.newPage();
    regB.on('pageerror', (error) => errors.push(`registerB: ${error.message}`));
    await regB.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
    await regB.locator('form.registration-form').waitFor();
    await regB.screenshot({ path: path.join(OUT, 'b-register-320-first.png') });
    await geometry(regB, 'register 320', 'form.registration-form button[type="submit"]', true);
    await regB.locator('#field-name').fill('여정 참가자 을');
    await regB.locator('#field-phone').fill('01055500102');
    if (await regB.locator('#consent').count()) await regB.locator('#consent').check();
    await regB.getByRole('button', { name: '신청하기', exact: true }).click();
    await regB.getByText('승인 대기').first().waitFor({ timeout: 15000 });
    check('pending receipt keeps Korean words intact at 320', (await splitKoreanWords(regB.getByText('신청이 접수되었습니다. 아래에서 진행 상태를 확인하세요.', { exact: true }))).length === 0);
    check('pending explanation keeps Korean words intact at 320', (await splitKoreanWords(regB.getByText('신청이 접수되었습니다. 운영자가 승인하면 이 화면에 입장 QR이 표시됩니다.', { exact: true }))).length === 0);
    await regB.screenshot({ path: path.join(OUT, 'b-ticket-pending-320-first.png') });
    await regB.screenshot({ path: path.join(OUT, 'b-ticket-pending-320-full.png'), fullPage: true });
    await geometry(regB, 'pending ticket 320', null);
    await geometry(regB, 'pending recheck 320', 'button:has-text("상태 다시 확인")');
    check('320 pending fresh banner promises a receipt, not entry',
      (await regB.getByText('신청이 접수되었습니다. 아래에서 진행 상태를 확인하세요.').count()) === 1);
    const peopleB = (await snapshot()).participants.filter((p) => p.phone === '01055500102');
    check('signup B persists exactly one participant', peopleB.length === 1);
    const ticketB = peopleB[0].ticket;

    // ---- Operator @1280: find PENDING → approve via rendered UI ----
    const op = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await op.addCookies([{ name: 'etko_session', value: decodeURIComponent(fixture.manager.cookie.slice('etko_session='.length)), url: fixture.baseUrl }]);
    const roster = await op.newPage();
    roster.on('pageerror', (error) => errors.push(`roster: ${error.message}`));
    await roster.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`);
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').waitFor();
    await roster.screenshot({ path: path.join(OUT, 'op-roster-1280-first.png') });
    await geometry(roster, 'roster 1280', null);
    await axePage(roster, 'roster 1280');
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill('여정 참가자 갑');
    await roster.getByRole('button', { name: '승인', exact: true }).first().click();
    await roster.getByText('여정 참가자 갑 상태를 참가 확정(으)로 바꿨습니다.', { exact: true }).waitFor({ timeout: 15000 });
    check('operator approval notice names the action', true);
    await roster.screenshot({ path: path.join(OUT, 'op-roster-approved-1280.png'), fullPage: true });
    const afterApproveA = (await snapshot()).participants.find((p) => p.phone === '01055500101');
    check('approval persists APPROVED for A', afterApproveA && afterApproveA.status === 'APPROVED');
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill('여정 참가자 을');
    await roster.getByRole('button', { name: '승인', exact: true }).first().click();
    await roster.getByText('여정 참가자 을 상태를 참가 확정(으)로 바꿨습니다.', { exact: true }).waitFor({ timeout: 15000 });
    const afterApproveB = (await snapshot()).participants.find((p) => p.phone === '01055500102');
    check('approval persists APPROVED for B', afterApproveB && afterApproveB.status === 'APPROVED');

    // ---- Participant B @320 re-checks by keyboard after approval ----
    let recheckFocused = false;
    for (let i = 0; i < 40; i++) {
      await regB.keyboard.press('Tab');
      const label = await regB.evaluate(
        () => ((document.activeElement && document.activeElement.textContent) || '').trim(),
      );
      if (label === '상태 다시 확인') { recheckFocused = true; break; }
    }
    check('re-check is reachable by keyboard (Tab)', recheckFocused);
    await regB.keyboard.press('Enter');
    await regB.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 15000 });
    check('keyboard re-check reaches the approved QR', true);
    check('ticket recovery guidance keeps Korean words intact at 320', (await splitKoreanWords(regB.getByText('이 티켓은 현재 탭에만 보관됩니다.', { exact: false }))).length === 0);
    await regB.screenshot({ path: path.join(OUT, 'b-ticket-approved-320.png'), fullPage: true });

    // ---- Participant A reloads: approved ticket with QR ----
    // Uses the rendered re-check affordance (not a blind browser reload):
    // the operator approved while this receipt was open.
    await reg.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await reg.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 15000 });
    check('approved ticket presents the entry QR', true);
    await reg.getByText('참가 확정').first().waitFor();
    check('ticket recovery guidance keeps Korean words intact at 390', (await splitKoreanWords(reg.getByText('이 티켓은 현재 탭에만 보관됩니다.', { exact: false }))).length === 0);
    await reg.screenshot({ path: path.join(OUT, 'a-ticket-approved-390.png'), fullPage: true });
    await geometry(reg, 'approved ticket 390', null);

    // ---- Staff @390: hub → assigned work → intercepted-loss retry → check-in ----
    const st = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await st.addCookies([{ name: 'etko_session', value: decodeURIComponent(fixture.staff.cookie.slice('etko_session='.length)), url: fixture.baseUrl }]);
    const hub = await st.newPage();
    hub.on('pageerror', (error) => errors.push(`staff: ${error.message}`));
    await hub.goto(`${fixture.baseUrl}/staff`);
    // A single assignment auto-enters its work screen (real product
    // shortcut): the hub list itself is only rendered with zero or multiple
    // assignments (covered by the lone account below).
    await hub.locator('#staff-desk').waitFor({ timeout: 15000 });
    await hub.screenshot({ path: path.join(OUT, 'staff-hub-autoenter-390-first.png') });
    const work = hub;
    await work.locator('#staff-desk').waitFor({ timeout: 15000 });
    await work.screenshot({ path: path.join(OUT, 'staff-work-390-first.png') });
    await geometry(work, 'staff scan action 390', 'button:has-text("카메라로 스캔")');
    await axePage(work, 'staff work 390');
    // The assigned staff account can also open the restricted event overview.
    // It must show its permission explanation and assigned-desk records as a
    // single readable stack rather than positioning records in an implicit
    // desktop grid column. This uses the real staff session and API projection.
    const restrictedOverview = await st.newPage();
    restrictedOverview.on('pageerror', (error) => errors.push(`staff-overview: ${error.message}`));
    for (const width of [1280, 390, 320]) {
      await restrictedOverview.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 900 });
      await restrictedOverview.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}`);
      await restrictedOverview.getByText('행사 지표는 행사 운영자에게 표시됩니다.', { exact: true }).waitFor();
      await restrictedOverview.locator('#event-recent-heading').waitFor();
      const layout = await restrictedOverview.evaluate(() => {
        const note = [...document.querySelectorAll('main p')].find(element => element.textContent?.trim() === '행사 지표는 행사 운영자에게 표시됩니다.');
        const recent = document.querySelector('#event-recent-heading')?.closest('[class*="regionRecent"]');
        const parent = note?.parentElement;
        if (!note || !recent || !parent) return null;
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, top: r.top, bottom: r.bottom, width: r.width }; };
        return { note: rect(note), recent: rect(recent), parent: rect(parent), documentWidth: document.documentElement.scrollWidth };
      });
      if (!layout || Math.abs(layout.note.x - layout.recent.x) > 1 || layout.recent.top < layout.note.bottom || layout.recent.width < layout.parent.width - 1 || layout.documentWidth > width + 1) {
        console.error(`[crossrole-journey] restricted overview@${width}`, layout);
      }
      check(`staff restricted overview@${width} keeps one readable stack`, Boolean(layout && Math.abs(layout.note.x - layout.recent.x) <= 1 && layout.recent.top >= layout.note.bottom && layout.recent.width >= layout.parent.width - 1 && layout.documentWidth <= width + 1));
      check(`staff restricted overview@${width} does not expose manager metrics`, await restrictedOverview.locator('#event-metrics-heading').count() === 0);
      await restrictedOverview.screenshot({ path: path.join(OUT, `staff-restricted-overview-${width}.png`), fullPage: true });
    }
    await restrictedOverview.close();
    if ((await work.locator('#staff-desk').inputValue()) !== fixture.deskId) {
      await work.locator('#staff-desk').selectOption(fixture.deskId);
    }
    // Intercepted committed-response loss (disclosed simulation): the first
    // scan commits on the real API, the browser sees 502 and must retry the
    // identical request instead of minting a second check. Both attempts are
    // captured and compared (body and idempotent command id).
    const scanAttempts = [];
    let committedReady, committedFailed, releaseCommitted, committedFinished;
    let committedStarted = false;
    const committedResponse = new Promise((resolve, reject) => { committedReady = resolve; committedFailed = reject; });
    void committedResponse.catch(() => {});
    const committedGate = new Promise(resolve => { releaseCommitted = resolve; });
    const committedDone = new Promise(resolve => { committedFinished = resolve; });
    await work.route('**/api/events/*/commands', async (route) => {
      const body = route.request().postDataJSON() || {};
      if (body.command === 'check.scan') {
        if (scanAttempts.length === 0) {
          committedStarted = true;
          scanAttempts.push(body);
          try {
            const actual = await route.fetch();
            committedReady(actual.status());
            await committedGate;
            return await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture response lost"}' });
          } catch (error) {
            committedFailed(error);
            await route.abort().catch(() => {});
          } finally {
            committedFinished();
          }
          return;
        }
        scanAttempts.push(body);
      }
      return route.continue();
    });
    await work.locator('#staff-ticket').fill(ticketA);
    await geometry(work, 'staff submit 390', 'button:has-text("입장 처리")', true);
    try {
      await work.getByRole('button', { name: '입장 처리', exact: true }).click();
      check('first scan commits on the real API', await bounded(committedResponse, 'committed scan response') === 200);
      const field = work.locator('#staff-ticket');
      await field.focus();
      await work.keyboard.press('Control+A');
      await work.keyboard.type('ET-NEXT-WHILE-WAITING');
      check('committed scan awaiting a lost response protects its original ticket', await field.inputValue() === ticketA && await field.getAttribute('readonly') !== null);
      check('committed scan awaiting a lost response protects its desk and camera', await work.locator('#staff-desk').isDisabled() && await work.getByRole('button', { name: '카메라로 스캔', exact: true }).isDisabled());
      check('pending scan explains why editing is temporarily unavailable', await work.getByRole('status').filter({ hasText: '확인이 끝나면 티켓과 업무를 다시 바꿀 수 있습니다.' }).isVisible());
      await maskTicketInput(work);
      await work.screenshot({ path: path.join(OUT, 'staff-scan-waiting-390.png') });
      await unmaskTicketInput(work);
      // Restore the normal submit focus situation for the error-focus check.
      await field.blur();
    } finally {
      releaseCommitted();
      if (committedStarted) await bounded(committedDone, 'committed scan cleanup');
    }
    await work.getByText(/확인하지 못했습니다|다시 시도/).first().waitFor({ timeout: 15000 });
    const uncertainAlert = work.getByRole('alert').filter({ hasText: '처리 응답을 확인하지 못했습니다.' });
    await uncertainAlert.waitFor({ timeout: 15000 });
    await work.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await maskTicketInput(work);
    await work.screenshot({ path: path.join(OUT, 'staff-scan-uncertain-390.png') });
    await unmaskTicketInput(work);
    const uncertainView = await uncertainAlert.evaluate(alert => {
      const section = alert.closest('section')?.parentElement;
      const heading = section?.querySelector('h2');
      const retry = [...(section?.querySelectorAll('button') || [])].find(button => button.textContent?.trim() === '다시 시도');
      const probe = element => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { top: rect.top, bottom: rect.bottom, inViewport: rect.top >= 0 && rect.bottom <= innerHeight,
          unobscured: hit === element || element.contains(hit) };
      };
      return { heading: heading?.textContent?.trim(), alert: probe(alert), retry: probe(retry), retryFocused: retry === document.activeElement };
    });
    if (uncertainView.heading !== '처리 결과를 확인하지 못했습니다' || !uncertainView.alert?.inViewport || !uncertainView.retry?.inViewport || !uncertainView.retry?.unobscured || !uncertainView.retryFocused) {
      console.error('[crossrole-journey] uncertain scan presentation', uncertainView);
    }
    check('lost scan response stays uncertain, not failed', uncertainView.heading === '처리 결과를 확인하지 못했습니다');
    check('uncertain scan explanation and retry are visible, reachable and focused', Boolean(uncertainView.alert?.inViewport && uncertainView.alert?.unobscured && uncertainView.retry?.inViewport && uncertainView.retry?.unobscured && uncertainView.retryFocused));
    // Request-bound place (390 uncertain): the verdict names the desk the
    // request committed to — source pin alone is not enough.
    const uncertainPlace = await work.locator('section[aria-label="스캔 결과 미확인"]').getByText(/처리 위치:/).first().innerText().catch(() => '');
    check('uncertain 390 binds the request desk, not the live selection', /처리 위치:\s*감사 입장 데스크\s*·\s*입장/.test(uncertainPlace));
    // Word wrap (390 uncertain): the warning must wrap by word (eojeol),
    // never split mid-syllable like 티/켓. Computed style plus a Range
    // boundary probe on 티켓으로 proves the rendered lines.
    const uncertainWrap = await uncertainAlert.evaluate((alert) => {
      const style = getComputedStyle(alert);
      const text = alert.textContent || '';
      const probe = '티켓으로';
      const node = Array.from(alert.childNodes).find((n) => n.nodeType === 3 && (n.textContent || '').includes(probe));
      let split = null;
      if (node) {
        const offset = (node.textContent || '').indexOf(probe);
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + probe.length);
        const tops = Array.from(range.getClientRects()).map((r) => Math.round(r.top));
        split = new Set(tops).size > 1;
      } else if (text.indexOf(probe) < 0) {
        split = null;
      }
      return { wordBreak: style.wordBreak, overflowWrap: style.overflowWrap, split };
    });
    if (uncertainWrap.wordBreak !== 'keep-all' || uncertainWrap.overflowWrap !== 'break-word' || uncertainWrap.split !== false) console.error('[crossrole-journey] uncertain 390 wrap', uncertainWrap);
    check('uncertain 390 warning wraps by word without mid-syllable split', uncertainWrap.wordBreak === 'keep-all' && uncertainWrap.overflowWrap === 'break-word' && uncertainWrap.split === false);
    await work.getByRole('button', { name: /다시 시도/ }).first().click().catch(() => {});
    // The retry control may be the same submit; fall back to resubmitting.
    if (await work.getByRole('button', { name: '다음 참가자', exact: true }).count() === 0) {
      await work.getByRole('button', { name: '입장 처리', exact: true }).click();
    }
    await work.getByRole('button', { name: '다음 참가자', exact: true }).waitFor({ timeout: 15000 });
    check('retry of the identical scan completes check-in', true);
    check('successful retry places keyboard focus on the next participant', await work.getByRole('button', { name: '다음 참가자', exact: true }).evaluate(element => element === document.activeElement));
    check('retry replays the identical request (body and command id)',
      scanAttempts.length === 2
      && JSON.stringify(scanAttempts[0]) === JSON.stringify(scanAttempts[1])
      && scanAttempts[0].commandId === scanAttempts[1].commandId
      && typeof scanAttempts[0].commandId === 'string'
      && scanAttempts[0].commandId.length > 0);
    await work.screenshot({ path: path.join(OUT, 'staff-checkin-ok-390.png'), fullPage: true });
    const afterScan = await snapshot();
    check('checked-in A is inside', afterScan.participants.find((p) => p.phone === '01055500101')?.inside === true);
    check('exactly one IN check for A (no duplicate from retry)', afterScan.checks.filter((c) => c.participantId === peopleA[0].id && c.action === 'IN').length === 1);

    // ---- Staff failure state: unknown ticket keeps the typed input ----
    await work.getByRole('button', { name: '다음 참가자', exact: true }).click();
    await work.locator('#staff-ticket').fill('ET-INVALID-CODE-0000');
    await work.getByRole('button', { name: '입장 처리', exact: true }).click();
    const failureSection = work.locator('section[aria-label="스캔 실패"]');
    await failureSection.waitFor({ timeout: 15000 });
    const failureText = ((await failureSection.getByRole('alert').first().innerText()) || '').trim();
    check('failed scan states the error explicitly (alert, not a silent wait)',
      failureText.length > 0 && /티켓|스캔|다시|확인/.test(failureText));
    // Request-bound place (390 failure): same desk the request committed to.
    const failurePlace = await failureSection.getByText(/처리 위치:/).first().innerText().catch(() => '');
    check('failed 390 binds the request desk, not the live selection', /처리 위치:\s*감사 입장 데스크\s*·\s*입장/.test(failurePlace));
    await maskTicketInput(work);
    await work.screenshot({ path: path.join(OUT, 'staff-scan-failed-390.png') });
    await unmaskTicketInput(work);
    check('failed scan keeps the typed code for correction', (await work.locator('#staff-ticket').inputValue()) === 'ET-INVALID-CODE-0000');

    // ---- Staff @320: check-in B on the narrow viewport ----
    const st320 = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' });
    await st320.addCookies([{ name: 'etko_session', value: decodeURIComponent(fixture.staff.cookie.slice('etko_session='.length)), url: fixture.baseUrl }]);
    const work320 = await st320.newPage();
    work320.on('pageerror', (error) => errors.push(`staff320: ${error.message}`));
    await work320.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await work320.locator('#staff-desk').waitFor({ timeout: 15000 });
    await work320.screenshot({ path: path.join(OUT, 'staff-work-320-first.png') });
    await geometry(work320, 'staff scan action 320', 'button:has-text("카메라로 스캔")');
    // A floating scan dock previously passed the camera-button check while
    // covering the selected desk. Both controls must be genuinely hit-testable
    // in the initial 320×568 viewport, not merely present somewhere in DOM.
    for (const [label, target] of [
      ['assigned desk', work320.locator('#staff-desk')],
      ['camera action', work320.getByRole('button', { name: '카메라로 스캔', exact: true })],
    ]) {
      const actual = await target.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
          inViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
          unobscured: hit === element || element.contains(hit) };
      });
      if (!(actual.inViewport && actual.unobscured)) console.error(`[crossrole-journey] ${label} geometry`, actual);
      check(`staff 320: ${label} is visible and unobscured`, actual.inViewport && actual.unobscured);
    }
    if ((await work320.locator('#staff-desk').inputValue()) !== fixture.deskId) {
      await work320.locator('#staff-desk').selectOption(fixture.deskId);
    }
    let successReady, successFailed, releaseSuccess, successFinished;
    let successStarted = false;
    const successResponse = new Promise((resolve, reject) => { successReady = resolve; successFailed = reject; });
    void successResponse.catch(() => {});
    const successGate = new Promise(resolve => { releaseSuccess = resolve; });
    const successDone = new Promise(resolve => { successFinished = resolve; });
    const delayedSuccess = async route => {
      const body = route.request().postDataJSON() || {};
      if (body.command !== 'check.scan' || body.payload?.ticket !== ticketB) return route.continue();
      successStarted = true;
      try {
        const actual = await route.fetch();
        successReady(actual.status());
        await successGate;
        await route.fulfill({ response: actual });
      } catch (error) {
        successFailed(error);
        await route.abort().catch(() => {});
      } finally {
        successFinished();
      }
    };
    await work320.route('**/api/events/*/commands', delayedSuccess);
    await work320.locator('#staff-ticket').fill(ticketB);
    const work320Back = work320.locator('a[href="/staff"]').first();
    try {
      await work320.getByRole('button', { name: '입장 처리', exact: true }).click();
      check('delayed 320 scan commits on the real API', await bounded(successResponse, 'delayed successful scan') === 200);
      const field = work320.locator('#staff-ticket');
      await field.focus();
      await work320.keyboard.press('Control+A');
      await work320.keyboard.type('ET-NEXT-WHILE-SUCCESS-WAITS');
      check('delayed successful scan protects the submitted ticket', await field.inputValue() === ticketB && await field.getAttribute('readonly') !== null);
      check('delayed successful scan protects the desk, camera and kiosk', await work320.locator('#staff-desk').isDisabled() && await work320.getByRole('button', { name: '카메라로 스캔', exact: true }).isDisabled() && await work320.getByRole('button', { name: '키오스크 모드', exact: true }).isDisabled());
      await work320Back.focus();
    } finally {
      releaseSuccess();
      if (successStarted) await bounded(successDone, 'delayed successful scan cleanup');
      await work320.unroute('**/api/events/*/commands', delayedSuccess);
    }
    await work320.getByRole('button', { name: '다음 참가자', exact: true }).waitFor({ timeout: 15000 });
    check('delayed scan success does not steal focus from another control', await work320Back.evaluate(element => element === document.activeElement));
    await work320.screenshot({ path: path.join(OUT, 'staff-checkin-ok-320.png'), fullPage: true });
    // A definitive bad ticket must expose its explanation and retry on the
    // short screen as well, while retaining the entered code for correction.
    await work320.getByRole('button', { name: '다음 참가자', exact: true }).click();
    await work320.locator('#staff-ticket').fill('ET-INVALID-CODE-320');
    await work320.getByRole('button', { name: '입장 처리', exact: true }).click();
    const failure320 = work320.locator('section[aria-label="스캔 실패"]');
    await failure320.waitFor({ timeout: 15000 });
    await work320.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const failedView = await failure320.evaluate(section => {
      const alert = section.querySelector('[role="alert"]');
      const retry = [...section.querySelectorAll('button')].find(button => button.textContent?.trim() === '다시 시도');
      const probe = element => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { inViewport: rect.top >= 0 && rect.bottom <= innerHeight, unobscured: hit === element || element.contains(hit) };
      };
      return { alert: probe(alert), retry: probe(retry), retryFocused: retry === document.activeElement };
    });
    if (!failedView.alert?.inViewport || !failedView.retry?.inViewport || !failedView.retry?.unobscured || !failedView.retryFocused) console.error('[crossrole-journey] staff 320 failure', failedView);
    check('staff 320 failure explanation and retry are visible and focused', Boolean(failedView.alert?.inViewport && failedView.alert?.unobscured && failedView.retry?.inViewport && failedView.retry?.unobscured && failedView.retryFocused));
    // Request-bound place (320 failure): short screen keeps the same desk.
    const failed320Place = await failure320.getByText(/처리 위치:/).first().innerText().catch(() => '');
    check('failed 320 binds the request desk on the narrow viewport', /처리 위치:\s*감사 입장 데스크\s*·\s*입장/.test(failed320Place));
    // Word wrap (320 failure): the short screen keeps 어절 intact even for
    // the definitive verdict (티켓을, 찾을). Same computed + Range proof.
    const failed320Wrap = await failure320.getByRole('alert').first().evaluate((alert) => {
      const style = getComputedStyle(alert);
      const probe = '티켓을';
      const node = Array.from(alert.childNodes).find((n) => n.nodeType === 3 && (n.textContent || '').includes(probe));
      let split = null;
      if (node) {
        const offset = (node.textContent || '').indexOf(probe);
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + probe.length);
        const tops = Array.from(range.getClientRects()).map((r) => Math.round(r.top));
        split = new Set(tops).size > 1;
      }
      return { wordBreak: style.wordBreak, overflowWrap: style.overflowWrap, split };
    });
    if (failed320Wrap.wordBreak !== 'keep-all' || failed320Wrap.overflowWrap !== 'break-word' || failed320Wrap.split !== false) console.error('[crossrole-journey] staff 320 failure wrap', failed320Wrap);
    check('failed 320 warning wraps by word without mid-syllable split', failed320Wrap.wordBreak === 'keep-all' && failed320Wrap.overflowWrap === 'break-word' && failed320Wrap.split === false);
    await maskTicketInput(work320);
    await work320.screenshot({ path: path.join(OUT, 'staff-scan-failed-320.png') });
    await unmaskTicketInput(work320);
    await failure320.getByRole('button', { name: '다시 시도', exact: true }).click();
    await work320.waitForFunction(() => document.activeElement?.id === 'staff-ticket', null, { timeout: 15000 });
    check('staff 320 retry retains and focuses the entered ticket', await work320.locator('#staff-ticket').inputValue() === 'ET-INVALID-CODE-320' && await work320.locator('#staff-ticket').evaluate(element => element === document.activeElement));
    // A scan response must belong to the same visible ticket and desk. During
    // the request, the input remains focusable but read-only; an unrelated
    // control may still receive focus without the eventual error stealing it.
    let responseReady;
    let responseFailed;
    let releaseResponse;
    let responseFinished;
    let matchedDelayedScan = false;
    const delayedResponse = new Promise((resolve, reject) => { responseReady = resolve; responseFailed = reject; });
    // A route failure may arrive before the click finishes; keep its rejection
    // observed until the bounded wait below can report it.
    void delayedResponse.catch(() => {});
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    const responseDone = new Promise(resolve => { responseFinished = resolve; });
    const delayedScan = async route => {
      try {
        const body = route.request().postDataJSON() || {};
        if (body.command !== 'check.scan' || body.payload?.ticket !== 'ET-INVALID-CODE-320') return await route.continue();
        matchedDelayedScan = true;
        const response = await route.fetch();
        responseReady();
        await responseGate;
        await route.fulfill({ response });
      } catch (error) {
        responseFailed(error);
        await route.abort().catch(() => {});
      } finally {
        if (matchedDelayedScan) responseFinished();
      }
    };
    await work320.route('**/api/events/*/commands', delayedScan);
    let responseTimeout;
    try {
      await work320.getByRole('button', { name: '입장 처리', exact: true }).click();
      await Promise.race([
        delayedResponse,
        new Promise((_, reject) => { responseTimeout = setTimeout(() => reject(new Error('delayed scan response timed out')), 15000); }),
      ]);
      const ticketDuringRequest = work320.locator('#staff-ticket');
      await ticketDuringRequest.focus();
      await work320.keyboard.press('Control+A');
      await work320.keyboard.type('ET-EDITING-WHILE-WAITING');
      check('a pending scan protects the submitted ticket from editing', await ticketDuringRequest.inputValue() === 'ET-INVALID-CODE-320' && await ticketDuringRequest.getAttribute('readonly') !== null);
      check('a pending scan prevents desk and camera changes', await work320.locator('#staff-desk').isDisabled() && await work320.getByRole('button', { name: '카메라로 스캔', exact: true }).isDisabled());
      const backLink = work320.locator('a[href="/staff"]').first();
      await backLink.focus();
      releaseResponse();
      await failure320.waitFor({ timeout: 15000 });
      await work320.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check('a late scan error leaves unrelated focus and the submitted ticket intact', await backLink.evaluate(element => element === document.activeElement) && await ticketDuringRequest.inputValue() === 'ET-INVALID-CODE-320');
      await failure320.getByRole('button', { name: '다시 시도', exact: true }).click();
      await ticketDuringRequest.fill('ET-EDITING-AFTER-RESPONSE');
      check('the ticket becomes editable again after a definitive response', await ticketDuringRequest.inputValue() === 'ET-EDITING-AFTER-RESPONSE');
    } finally {
      clearTimeout(responseTimeout);
      releaseResponse();
      if (matchedDelayedScan) {
        let cleanupTimeout;
        try {
          await Promise.race([
            responseDone,
            new Promise((_, reject) => { cleanupTimeout = setTimeout(() => reject(new Error('delayed scan route cleanup timed out')), 15000); }),
          ]);
        } finally {
          clearTimeout(cleanupTimeout);
        }
      }
      await work320.unroute('**/api/events/*/commands', delayedScan);
    }

    // ---- Unassigned staff @320: stable explanation, not a loop ----
    const lone = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' });
    await lone.addCookies([{ name: 'etko_session', value: decodeURIComponent(loneCookie.slice('etko_session='.length)), url: fixture.baseUrl }]);
    const lonePage = await lone.newPage();
    lonePage.on('pageerror', (error) => errors.push(`lone: ${error.message}`));
    await lonePage.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await lonePage.getByText(/업무 배정이 없습니다/).waitFor({ timeout: 15000 });
    await lonePage.screenshot({ path: path.join(OUT, 'staff-unassigned-320.png') });
    check('unassigned staff sees a stable explanation with a way back', (await lonePage.getByRole('link', { name: '내 업무로' }).count()) > 0);
    // Skip links must stay off-screen until focused: full-page captures can
    // paint fixed elements, so probe the live rect in a normal viewport.
    {
      const top = await work.evaluate(() => {
        const el = document.querySelector('.skip-link');
        return el ? el.getBoundingClientRect().top : null;
      });
      check('staff work: skip link stays off-screen until focused', top !== null && top < 0);
    }
    // The lone account's hub shows the empty assignment state (the single-
    // assignment shortcut auto-enters work, so /staff itself is only seen
    // with zero or multiple assignments).
    await lonePage.goto(`${fixture.baseUrl}/staff`);
    await lonePage.waitForTimeout(1500);
    await lonePage.screenshot({ path: path.join(OUT, 'staff-hub-empty-320.png') });
    // Hub empty @320: wording keeps its source/contact/retry and wraps by
    // word (eojeol), never split mid-syllable like 문/의 or 스태/프.
    check('hub empty names the assignment source and a contact', (await lonePage.getByText(/운영 콘솔.*현장 운영.*스태프 배정/).count()) > 0 && (await lonePage.getByText(/초대 메일·행사 안내의 문의처/).count()) > 0);
    check('hub empty retry stays findable', await lonePage.getByRole('button', { name: '다시 불러오기', exact: true }).isVisible());
    const hubKeepAll = await lonePage.locator('section.state-panel p').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).wordBreak));
    check('hub empty wraps by word at 320 (keep-all)', hubKeepAll.length > 0 && hubKeepAll.every((mode) => mode === 'keep-all'));

    // ---- Operator @1280: report reflects the persisted journey ----
    const rep = await op.newPage();
    rep.on('pageerror', (error) => errors.push(`report: ${error.message}`));
    await rep.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/reports`);
    await rep.locator('#reports-list').waitFor({ timeout: 15000 });
    await rep.screenshot({ path: path.join(OUT, 'op-reports-1280-first.png') });
    await geometry(rep, 'reports 1280', null);
    await geometry(rep, 'report create action 1280', 'button:has-text("보고서 만들기")');
    await axePage(rep, 'reports 1280');
    await rep.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
    await rep.locator('#report-title').waitFor({ timeout: 15000 });
    await rep.screenshot({ path: path.join(OUT, 'op-report-create-1280.png') });
    await rep.locator('#report-title').fill('신청부터 입장까지 여정 검수');
    await rep.locator('#report-summary').fill('참가 신청 2건이 승인·입장까지 이어졌는지 확인한 보고서입니다.');
    await rep.getByRole('button', { name: '보고서 만들기', exact: true }).last().click();
    await rep.getByText(/보고서 초안을 만들었습니다/).first().waitFor({ timeout: 15000 });
    await rep.getByRole('button', { name: '내용 보기', exact: true }).first().click();
    await rep.locator('#report-detail').waitFor({ timeout: 15000 });
    await rep.screenshot({ path: path.join(OUT, 'op-report-detail-1280.png'), fullPage: true });
    {
      const top = await rep.evaluate(() => {
        const el = document.querySelector('.skip-link');
        return el ? el.getBoundingClientRect().top : null;
      });
      check('reports: skip link stays off-screen until focused', top !== null && top < 0);
    }
    check('report snapshot counts the real check-ins',
      (await rep.getByText(/누적 입장 2명/).count()) > 0 && (await rep.getByText(/현재 입장 2명/).count()) > 0);

    // The temporary lock must end even if the network never delivers the
    // response. Commit a third synthetic participant after the two-person
    // report snapshot, then replay the exact request after the real timeout.
    const timeoutParticipant = (await snapshot()).participants.find(person => person.status === 'APPROVED' && person.ticket && !person.inside && person.name !== '감사 참가자 1');
    check('an unscanned synthetic participant is available for timeout recovery', Boolean(timeoutParticipant));
    let timeoutReady, timeoutFailed, releaseTimeout, timeoutFinished;
    let timeoutStarted = false;
    const timeoutResponse = new Promise((resolve, reject) => { timeoutReady = resolve; timeoutFailed = reject; });
    void timeoutResponse.catch(() => {});
    const timeoutGate = new Promise(resolve => { releaseTimeout = resolve; });
    const timeoutDone = new Promise(resolve => { timeoutFinished = resolve; });
    const timeoutAttempts = [];
    const delayedTimeout = async route => {
      const body = route.request().postDataJSON() || {};
      if (body.command !== 'check.scan' || body.payload?.ticket !== timeoutParticipant.ticket) return route.continue();
      timeoutAttempts.push(body);
      if (timeoutAttempts.length > 1) return route.continue();
      timeoutStarted = true;
      try {
        const actual = await route.fetch();
        timeoutReady(actual.status());
        await timeoutGate;
        await route.fulfill({ response: actual });
      } catch (error) {
        timeoutFailed(error);
        await route.abort().catch(() => {});
      } finally {
        timeoutFinished();
      }
    };
    await work320.route('**/api/events/*/commands', delayedTimeout);
    try {
      await work320.locator('#staff-ticket').fill(timeoutParticipant.ticket);
      await work320.getByRole('button', { name: '입장 처리', exact: true }).click();
      check('withheld scan response was committed in the isolated API', await bounded(timeoutResponse, 'withheld committed scan') === 200);
      const timeoutFailure = work320.locator('section[aria-label="스캔 결과 미확인"]');
      await timeoutFailure.waitFor({ timeout: 22000 });
      check('timed-out scan retains the original ticket and unlocks editing', await work320.locator('#staff-ticket').inputValue() === timeoutParticipant.ticket && await work320.locator('#staff-ticket').getAttribute('readonly') === null && !await work320.locator('#staff-desk').isDisabled());
      releaseTimeout();
      await bounded(timeoutDone, 'withheld scan cleanup');
      await timeoutFailure.getByRole('button', { name: '다시 시도', exact: true }).click();
      await work320.getByRole('button', { name: '입장 처리', exact: true }).click();
      await work320.getByRole('button', { name: '다음 참가자', exact: true }).waitFor({ timeout: 15000 });
      check('timed-out scan retry reuses the exact request and command id', timeoutAttempts.length === 2 && JSON.stringify(timeoutAttempts[0]) === JSON.stringify(timeoutAttempts[1]));
      check('timed-out scan retry produces one check only', (await snapshot()).checks.filter(check => check.participantId === timeoutParticipant.id && check.action === 'IN').length === 1);
    } finally {
      releaseTimeout();
      if (timeoutStarted) await bounded(timeoutDone, 'withheld scan cleanup');
      await work320.unroute('**/api/events/*/commands', delayedTimeout);
    }

    // ---- Storage-denied re-check (restricted mode + no session grant) ----
    // Denies the ticket's sessionStorage keys (simulated restricted mode),
    // clears the same-device session cookie after signup so no substitute
    // credential can restore the ticket, fails one ticket read, then
    // approves through the rendered operator UI. Every ticket read must
    // carry the in-tab bearer; the bearer must never appear in the address.
    {
      const denied = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      await denied.addInitScript(() => {
        for (const method of ['getItem', 'setItem', 'removeItem']) {
          const original = Storage.prototype[method];
          Storage.prototype[method] = function (key, ...rest) {
            if (typeof key === 'string' && key.indexOf('eventouch.ticket.') === 0) {
              throw new Error('fixture storage denied');
            }
            return original.call(this, key, ...rest);
          };
        }
      });
      const regD = await denied.newPage();
      regD.on('pageerror', (error) => errors.push(`denied: ${error.message}`));
      const deniedAuth = [];
      await regD.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await regD.locator('#field-name').fill('저장 거부 참가자');
      await regD.locator('#field-phone').fill('01055500401');
      if (await regD.locator('#consent').count()) await regD.locator('#consent').check();
      await regD.getByRole('button', { name: '신청하기', exact: true }).click();
      await regD.getByText('승인 대기').first().waitFor({ timeout: 15000 });
      check('denied-storage signup reaches the pending receipt', true);
      await denied.clearCookies();
      // Fail only re-checks: the initial load must complete normally so the
      // receipt (and its in-tab bearer) exists before the fault injects.
      await regD.route('**/api/public/events/*/ticket', async (route) => {
        deniedAuth.push(route.request().headers().authorization || '');
        if (deniedAuth.length === 1) {
          return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"fixture ticket read lost"}' });
        }
        return route.continue();
      });
      await regD.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
      await regD.getByText('티켓을 사용할 수 없습니다').waitFor({ timeout: 15000 });
      check('lost re-check with denied storage stays retryable (not missing)', true);
      await regD.getByRole('button', { name: '다시 시도', exact: true }).click();
      await regD.getByText('승인 대기').first().waitFor({ timeout: 15000 });
      check('failed re-check retries from the in-tab bearer', deniedAuth.length >= 2 && deniedAuth.every((h) => typeof h === 'string' && h.startsWith('Bearer ') && h.length > 7));
      await roster.getByRole('button', { name: /새로고침( 중…)?/, exact: true }).click();
      await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill('저장 거부 참가자');
      await roster.getByRole('button', { name: '승인', exact: true }).first().click();
      await roster.getByText('저장 거부 참가자 상태를 참가 확정(으)로 바꿨습니다.', { exact: true }).waitFor({ timeout: 15000 });
      await regD.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
      await regD.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 15000 });
      check('denied-storage re-check reaches the approved QR', true);
      check('re-check bearer never leaks into the address', !new URL(regD.url()).searchParams.has('ticket'));
      await regD.screenshot({ path: path.join(OUT, 'd-ticket-denied-approved-390.png'), fullPage: true });
      // Definitive invalidation while pending: a second denied participant is
      // cancelled through the rendered dialog while its receipt is open.
      // Its SAME in-tab bearer must then fail 404 (not silently recover),
      // and the rejection must clear it: retry and reload both land missing.
      // (Usable tickets carry no re-check control — no change is expected
      // while admitted — so invalidation-through-recheck is exercised here
      // on the pending receipt, which does.)
      const deniedE = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      await deniedE.addInitScript(() => {
        for (const method of ['getItem', 'setItem', 'removeItem']) {
          const original = Storage.prototype[method];
          Storage.prototype[method] = function (key, ...rest) {
            if (typeof key === 'string' && key.indexOf('eventouch.ticket.') === 0) {
              throw new Error('fixture storage denied');
            }
            return original.call(this, key, ...rest);
          };
        }
      });
      const regE = await deniedE.newPage();
      regE.on('pageerror', (error) => errors.push(`deniedE: ${error.message}`));
      await regE.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await regE.locator('#field-name').fill('무효 검증 참가자');
      await regE.locator('#field-phone').fill('01055500403');
      if (await regE.locator('#consent').count()) await regE.locator('#consent').check();
      await regE.getByRole('button', { name: '신청하기', exact: true }).click();
      await regE.getByText('승인 대기').first().waitFor({ timeout: 15000 });
      await deniedE.clearCookies();
      await roster.getByRole('button', { name: /새로고침( 중…)?/, exact: true }).click();
      await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill('무효 검증 참가자');
      await roster.getByRole('button', { name: '무효 검증 참가자 참가자 상세', exact: true }).click();
      await roster.getByLabel('무효 검증 참가자 상태 변경').selectOption('CANCELLED');
      await roster.getByRole('button', { name: '신청 취소', exact: true }).click();
      await roster.getByText('무효 검증 참가자 상태를 신청 취소(으)로 바꿨습니다.', { exact: true }).waitFor({ timeout: 15000 });
      await closeParticipantDetails(roster, '무효 검증 참가자');
      await regE.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
      await regE.getByText('티켓을 사용할 수 없습니다').waitFor({ timeout: 15000 });
      check('cancelled bearer fails definitively after re-check', true);
      await regE.screenshot({ path: path.join(OUT, 'e-ticket-denied-invalidated-390.png') });
      // A definitive 404 clears the bearer (no credential left to retry
      // with — the failed state offers recovery guidance, not a replay),
      // so a reload lands on the missing state instead of the old ticket.
      await regE.reload();
      await regE.getByText('티켓이 확인되지 않습니다').waitFor({ timeout: 15000 });
      check('stale bearer cannot regain authority after rejection', true);
      await deniedE.close();
      await denied.close();
    }

    // ---- Superseded-load race: a late 404 must not wipe the live ticket ----
    // First re-check hangs; a full reload mounts a new instance that
    // completes with the stored bearer; the hung load then resolves 404.
    // The superseded (cancelled) load must not clear shared storage.
    // Reachability note: a full reload aborts the hung fetch, so this
    // ordering pins the property as defense-in-depth — no real UI flow
    // holds two live loads on one mounted instance (same-slug overlaps
    // cannot start while loading, and no client-side links exist between
    // ticket URLs). The source test pins the guard shape itself.
    {
      const race = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      const regR = await race.newPage();
      regR.on('pageerror', (error) => errors.push(`race: ${error.message}`));
      await regR.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await regR.locator('#field-name').fill('경합 참가자');
      await regR.locator('#field-phone').fill('01055500402');
      if (await regR.locator('#consent').count()) await regR.locator('#consent').check();
      await regR.getByRole('button', { name: '신청하기', exact: true }).click();
      await regR.getByText('승인 대기').first().waitFor({ timeout: 15000 });
      let releaseHung = null;
      const hungGate = new Promise((resolve) => { releaseHung = resolve; });
      let raceCalls = 0;
      await regR.route('**/api/public/events/*/ticket', async (route) => {
        raceCalls += 1;
        if (raceCalls === 1) {
          await hungGate;
          return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"fixture late rejection"}' });
        }
        return route.continue();
      });
      await regR.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
      await regR.waitForTimeout(500);
      await regR.reload();
      await regR.getByText('승인 대기').first().waitFor({ timeout: 15000 });
      check('remount completes from stored bearer while old load hangs', true);
      releaseHung();
      await regR.waitForTimeout(1000);
      const storedAfter = await regR.evaluate(
        (slug) => { try { return window.sessionStorage.getItem(`eventouch.ticket.${slug}`) || ''; } catch { return 'denied'; } },
        fixture.slug,
      );
      check('superseded 404 does not wipe shared storage', typeof storedAfter === 'string' && storedAfter.length > 0);
      await regR.reload();
      await regR.getByText('승인 대기').first().waitFor({ timeout: 15000 });
      check('ticket survives a second reload after the late rejection', true);
      await race.close();
    }

    // ---- Receipt-wording branches: waitlist / immediate / unpaid / cancelled ----
    // Each branch signs up through the rendered form (fresh=1 arrival) and
    // asserts the exact fresh banner for that server state. Event settings
    // change through the real manager commands and are disclosed; the frozen
    // report above is unaffected (created earlier).
    const eventPayload = (await fixture.harness.database.query(
      'SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    const baseEvent = {
      name: eventPayload.name, slug: eventPayload.slug, date: eventPayload.date,
      start: eventPayload.start, end: eventPayload.end,
    };
    const signupFresh = async (tag, name, phone, inspectLead) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      page.on('pageerror', (error) => errors.push(`${tag}: ${error.message}`));
      await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await page.locator('form.registration-form').waitFor();
      if (inspectLead) await inspectLead(page);
      await page.locator('#field-name').fill(name);
      await page.locator('#field-phone').fill(phone);
      if (await page.locator('#consent').count()) await page.locator('#consent').check();
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      return { ctx, page };
    };

    // WAITLIST: capacity pinned to the live headcount, approval still on.
    const liveActive = (await snapshot()).participants.filter((p) => p.status !== 'CANCELLED').length;
    await managerCall('event.update', { ...baseEvent, capacity: liveActive, approvalRequired: true });
    {
      const { ctx, page } = await signupFresh('waitlist', '여정 참가자 병', '01055500103');
      await page.getByText('대기 명단').first().waitFor({ timeout: 15000 });
      check('waitlist fresh banner promises a receipt, not entry',
        (await page.getByText('신청이 접수되었습니다. 아래에서 진행 상태를 확인하세요.').count()) === 1);
      check('waitlist shows no entry QR', (await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 0);
      check('waitlist offers a status re-check', (await page.getByRole('button', { name: '상태 다시 확인', exact: true }).count()) === 1);
      await page.screenshot({ path: path.join(OUT, 'w-ticket-waitlist-390.png'), fullPage: true });
      const stored = (await snapshot()).participants.find((p) => p.phone === '01055500103');
      check('waitlist signup persists WAITLIST', stored && stored.status === 'WAITLIST');
      // No auto-promotion: freeing a seat through the rendered operator UI
      // (cancel one import) leaves the waitlisted receipt on WAITLIST after
      // a re-check; only an explicit APPROVED transition admits. Capacity is
      // pinned, so cancel first, re-check, then approve via the dialog.
      await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill('감사 참가자 1');
      await roster.getByRole('button', { name: /참가자 상세/, exact: false }).first().click();
      await roster.getByLabel('감사 참가자 1 상태 변경').selectOption('CANCELLED');
      await roster.getByRole('button', { name: '신청 취소', exact: true }).click();
      await roster.getByText('감사 참가자 1 상태를 신청 취소(으)로 바꿨습니다.', { exact: true }).waitFor({ timeout: 15000 });
      await closeParticipantDetails(roster, '감사 참가자 1');
      const refreshed = page.waitForResponse((response) =>
        response.url().includes(`/api/public/events/${fixture.slug}/ticket`) && response.status() === 200);
      await page.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
      await refreshed;
      await page.getByText('대기 명단').first().waitFor({ timeout: 15000 });
      const afterFree = (await snapshot()).participants.find((p) => p.phone === '01055500103');
      check('freed seat does not auto-promote (still WAITLIST)', afterFree && afterFree.status === 'WAITLIST');
      await page.screenshot({ path: path.join(OUT, 'w-ticket-waitlist-after-free-seat-390.png') });
      await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill('여정 참가자 병');
      await roster.getByRole('button', { name: '여정 참가자 병 참가자 상세', exact: true }).click();
      const waitlistDetails = roster.getByRole('dialog', { name: '여정 참가자 병', exact: true });
      let bootstrapStarted = false;
      let resolveBootstrap, rejectBootstrap, releaseBootstrap, finishBootstrap;
      const bootstrapReady = new Promise((resolve, reject) => { resolveBootstrap = resolve; rejectBootstrap = reject; });
      void bootstrapReady.catch(() => {});
      const bootstrapGate = new Promise((resolve) => { releaseBootstrap = resolve; });
      const bootstrapDone = new Promise((resolve) => { finishBootstrap = resolve; });
      const delayedBootstrap = async (route) => {
        bootstrapStarted = true;
        try {
          const response = await route.fetch();
          resolveBootstrap(response.status());
          await bootstrapGate;
          await route.fulfill({ response });
        } catch (error) {
          rejectBootstrap(error);
          await route.abort().catch(() => {});
        } finally {
          finishBootstrap();
        }
      };
      await roster.route('**/api/events/*/bootstrap', delayedBootstrap);
      let closingWaitlistDetails;
      try {
        await roster.getByLabel('여정 참가자 병 상태 변경').selectOption('APPROVED');
        check('waitlist approval reload reaches the real API', await bounded(bootstrapReady, 'held roster refresh') === 200);
        await roster.getByText('여정 참가자 병 상태를 참가 확정(으)로 바꿨습니다.', { exact: true }).waitFor({ timeout: 15000 });
        check('waitlist details remain busy while the real refresh response is delayed',
          await waitlistDetails.getByRole('button', { name: '닫기', exact: true }).isDisabled());
        await roster.keyboard.press('Escape');
        check('busy waitlist details reject dismissal', await waitlistDetails.isVisible());
        closingWaitlistDetails = closeParticipantDetails(roster, '여정 참가자 병');
        void closingWaitlistDetails.catch(() => {});
      } finally {
        releaseBootstrap();
        if (bootstrapStarted) await bounded(bootstrapDone, 'held roster refresh cleanup');
        await roster.unroute('**/api/events/*/bootstrap', delayedBootstrap);
      }
      await closingWaitlistDetails;
      await page.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
      await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 15000 });
      check('explicit approval admits the waitlisted ticket', true);
      await ctx.close();
    }

    // IMMEDIATE: approval off, room restored — the entry claim is honest here.
    await managerCall('event.update', { ...baseEvent, capacity: 200, approvalRequired: false });
    let ctxI = null;
    let regI = null;
    {
      const { ctx, page } = await signupFresh('immediate', '여정 참가자 정', '01055500104', async (form) => {
        check('open register lead promises instant issuance',
          (await form.getByText('아래 정보를 입력하면 입장 티켓이 바로 발급됩니다.').count()) === 1);
      });
      ctxI = ctx; regI = page;
      await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 15000 });
      check('immediate fresh banner claims the entry ticket',
        (await page.getByText('신청이 완료되었습니다. 이 화면이 입장권입니다.').count()) === 1
        && (await page.getByText('신청이 접수되었습니다. 아래에서 진행 상태를 확인하세요.').count()) === 0);
      await page.screenshot({ path: path.join(OUT, 'i-ticket-immediate-390.png'), fullPage: true });
      const stored = (await snapshot()).participants.find((p) => p.phone === '01055500104');
      check('immediate signup persists APPROVED/FREE', stored && stored.status === 'APPROVED' && stored.paymentStatus === 'FREE');
    }

    // UNPAID: payment feature + price — approved but not admittable.
    const currentFeatures = Array.isArray(eventPayload.features) ? eventPayload.features : [];
    await managerCall('event.features', { features: [...new Set([...currentFeatures, 'payment'])] });
    await managerCall('event.update', { ...baseEvent, capacity: 200, approvalRequired: false, price: 10000 });
    let ctxU = null;
    let regU = null;
    {
      const { ctx, page } = await signupFresh('unpaid', '여정 참가자 무', '01055500105', async (form) => {
        check('paid register lead promises confirmation after payment, not instant entry',
          (await form.getByText('아래 정보를 입력하면 신청이 접수되고, 결제 확인이 끝나면 입장 QR이 표시됩니다.').count()) === 1
          && (await form.getByText(/바로 발급됩니다/).count()) === 0);
        await form.screenshot({ path: path.join(OUT, 'u-register-paid-390.png') });
      });
      ctxU = ctx; regU = page;
      await page.getByText('결제 확인 필요').first().waitFor({ timeout: 15000 });
      check('unpaid fresh banner promises a receipt, not entry',
        (await page.getByText('신청이 접수되었습니다. 아래에서 진행 상태를 확인하세요.').count()) === 1);
      check('unpaid shows no entry QR', (await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 0);
      check('unpaid offers a status re-check', (await page.getByRole('button', { name: '상태 다시 확인', exact: true }).count()) === 1);
      await page.screenshot({ path: path.join(OUT, 'u-ticket-unpaid-390.png'), fullPage: true });
      const stored = (await snapshot()).participants.find((p) => p.phone === '01055500105');
      check('unpaid signup persists APPROVED/PENDING-payment', stored && stored.status === 'APPROVED' && stored.paymentStatus === 'PENDING');
    }

    // COMBINED: approval gate + paid flow on one event. The server marks
    // payment PENDING even while status is PENDING, so the receipt and the
    // register lead must name both gates — an approval-only promise would be
    // false (proven below: approval alone yields no QR). No payment behavior
    // changes; copy only.
    await managerCall('event.update', { ...baseEvent, capacity: 200, approvalRequired: true, price: 10000 });
    let ctxK = null;
    let regK = null;
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      ctxK = ctx;
      const page = await ctx.newPage();
      regK = page;
      page.on('pageerror', (error) => errors.push(`combined: ${error.message}`));
      await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
      await page.locator('form.registration-form').waitFor();
      check('combined register lead names both gates',
        (await page.getByText('아래 정보를 입력하면 신청이 접수되고, 운영자 승인과 결제 확인이 모두 끝나면 입장 QR이 표시됩니다.').count()) === 1
        && (await page.getByText(/바로 발급됩니다/).count()) === 0);
      await page.screenshot({ path: path.join(OUT, 'k-register-combined-390.png') });
      await page.locator('#field-name').fill('복합 조건 참가자');
      await page.locator('#field-phone').fill('01055500602');
      if (await page.locator('#consent').count()) await page.locator('#consent').check();
      await page.getByRole('button', { name: '신청하기', exact: true }).click();
      await page.getByText('승인 대기').first().waitFor({ timeout: 15000 });
      check('combined receipt names both gates',
        (await page.getByText('운영자 승인과 결제 확인이 끝나면 이 화면에 입장 QR이 표시됩니다.').count()) === 1);
      check('combined pending shows no entry QR', (await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 0);
      await page.screenshot({ path: path.join(OUT, 'k-ticket-combined-pending-390.png'), fullPage: true });
      const stored = (await snapshot()).participants.find((p) => p.phone === '01055500602');
      check('combined signup persists PENDING + payment PENDING', stored && stored.status === 'PENDING' && stored.paymentStatus === 'PENDING');
    }
    await roster.getByRole('button', { name: /새로고침( 중…)?/, exact: true }).click();
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill('복합 조건 참가자');
    await roster.getByRole('button', { name: '승인', exact: true }).first().click();
    await roster.getByText('복합 조건 참가자 상태를 참가 확정(으)로 바꿨습니다.', { exact: true }).waitFor({ timeout: 15000 });
    await regK.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await regK.getByText('결제 확인 필요').first().waitFor({ timeout: 15000 });
    check('approval alone does not yield the QR on a combined event',
      (await regK.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 0);
    await regK.screenshot({ path: path.join(OUT, 'k-ticket-combined-unpaid-390.png'), fullPage: true });
    await ctxK.close();
    await managerCall('event.update', { ...baseEvent, capacity: 200, approvalRequired: false, price: 10000 });

    // CANCELLED: the operator cancels through the rendered dialog; the open
    // ticket re-check then hits a definitive 404 and must explain, not spin.
    // The roster loaded before the wording-branch signups, so refresh first.
    await roster.getByRole('button', { name: /새로고침( 중…)?/, exact: true }).click();
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill('여정 참가자 무');
    await roster.getByRole('button', { name: '여정 참가자 무 참가자 상세', exact: true }).click();
    await roster.getByLabel('여정 참가자 무 상태 변경').selectOption('CANCELLED');
    await roster.getByRole('button', { name: '신청 취소', exact: true }).click();
    await roster.getByText('여정 참가자 무 상태를 신청 취소(으)로 바꿨습니다.', { exact: true }).waitFor({ timeout: 15000 });
    await closeParticipantDetails(roster, '여정 참가자 무');
    check('operator cancel persists CANCELLED', ((await snapshot()).participants.find((p) => p.phone === '01055500105') || {}).status === 'CANCELLED');
    await regU.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await regU.getByText('티켓을 사용할 수 없습니다').waitFor({ timeout: 15000 });
    check('cancelled re-check explains invalidation (no recovery link without SMS)',
      (await regU.getByText('신청한 기기에서만 열 수 있습니다').count()) >= 1);
    await regU.screenshot({ path: path.join(OUT, 'u-ticket-cancelled-390.png'), fullPage: true });
    if (ctxI) await ctxI.close();
    if (ctxU) await ctxU.close();

    // Multiple real assignments: while a scan is in flight the visible desk,
    // task and kiosk controls must not relabel its result. The camera is
    // explicitly simulated and denied; no physical device is accessed.
    const secondDesk = (await managerCall('desk.save', { name: '감사 퇴장 데스크', action: 'OUT', mode: 'desk', open: true })).desk;
    await managerCall('event.features', { features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp'] });
    const extraBooth = (await managerCall('booth.save', { name: '감사 인증 부스', zone: '감사 구역', status: 'OPEN', capacity: 0, limit: 1 })).booth;
    await managerCall('booth.mode', { mode: 'STAFF', acknowledge: true });
    await fixture.helpers.insertAssignment(fixture.harness.database, { id: `scan-extra-desk-${fixture.suffix}`, accountId: fixture.staff.id, eventId: fixture.eventId, type: 'DESK', targetId: secondDesk.id });
    await fixture.helpers.insertAssignment(fixture.harness.database, { id: `scan-extra-booth-${fixture.suffix}`, accountId: fixture.staff.id, eventId: fixture.eventId, type: 'BOOTH', targetId: extraBooth.id });
    const multi = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await multi.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new DOMException('Simulated denial', 'NotAllowedError'); } } });
    });
    await multi.addCookies([{ name: 'etko_session', value: decodeURIComponent(fixture.staff.cookie.slice('etko_session='.length)), url: fixture.baseUrl }]);
    const multiWork = await multi.newPage();
    multiWork.on('pageerror', error => errors.push(`staff-multi: ${error.message}`));
    await multiWork.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
    await multiWork.locator('#staff-desk').selectOption(fixture.deskId);
    const cameraButton = multiWork.getByRole('button', { name: '카메라로 스캔', exact: true });
    await cameraButton.focus();
    await multiWork.keyboard.press('Enter');
    await multiWork.locator('section[aria-label="카메라 스캔"]').waitFor({ timeout: 15000 });
    check('keyboard opens the simulated camera fallback', true);
    let multiReady, multiFailed, releaseMulti, multiFinished;
    let multiStarted = false;
    const multiResponse = new Promise((resolve, reject) => { multiReady = resolve; multiFailed = reject; });
    void multiResponse.catch(() => {});
    const multiGate = new Promise(resolve => { releaseMulti = resolve; });
    const multiDone = new Promise(resolve => { multiFinished = resolve; });
    const multiHandler = async route => {
      const body = route.request().postDataJSON() || {};
      if (body.command !== 'check.scan' || body.payload?.ticket !== 'ET-MULTI-INVALID') return route.continue();
      multiStarted = true;
      try {
        const actual = await route.fetch();
        multiReady(actual.status());
        await multiGate;
        await route.fulfill({ response: actual });
      } catch (error) {
        multiFailed(error);
        await route.abort().catch(() => {});
      } finally {
        multiFinished();
      }
    };
    await multiWork.route('**/api/events/*/commands', multiHandler);
    try {
      await multiWork.locator('#staff-ticket').fill('ET-MULTI-INVALID');
      await multiWork.locator('#staff-ticket').press('Enter');
      check('multiple-assignment scan receives a real rejection', await bounded(multiResponse, 'multiple-assignment scan') === 404);
      check('pending scan closes the already-open simulated camera', await multiWork.locator('section[aria-label="카메라 스캔"]').count() === 0);
      check('pending scan locks both task switches and the assigned desk', await multiWork.getByRole('button', { name: '데스크 체크인', exact: true }).isDisabled() && await multiWork.getByRole('button', { name: '부스 인증', exact: true }).isDisabled() && await multiWork.locator('#staff-desk').isDisabled() && await multiWork.locator('#staff-desk').inputValue() === fixture.deskId);
    } finally {
      releaseMulti();
      if (multiStarted) await bounded(multiDone, 'multiple-assignment cleanup');
      await multiWork.unroute('**/api/events/*/commands', multiHandler);
    }
    const multiFailure = multiWork.locator('section[aria-label="스캔 실패"]');
    await multiFailure.waitFor({ timeout: 15000 });
    // Request-bound place (multi-desk failure): read while the verdict is
    // actually open — reading after retry would see the cleared result.
    const multiPlace = await multiFailure.getByText(/처리 위치:/).first().innerText().catch(() => '');
    check('multi-desk failure binds its request desk', /처리 위치:\s*감사 입장 데스크\s*·\s*입장/.test(multiPlace));
    // The old result and the editable input are different contexts. When a
    // ticket is edited after a rejection, the action still needs its current
    // desk in view and in the input's accessible description; the previous
    // failure must continue to name the request-bound desk, not the input.
    const multiTicket = multiWork.locator('#staff-ticket');
    const currentScanHint = multiWork.locator('#staff-scan-hint');
    const describedBy = (await multiTicket.getAttribute('aria-describedby') || '').split(/\s+/);
    check('failed scan input shows and describes its current desk',
      await currentScanHint.isVisible()
      && /현재\s*감사 입장 데스크\s*·\s*입장/.test(await currentScanHint.innerText())
      && describedBy.includes('staff-scan-hint'));
    await multiTicket.fill('ET-MULTI-EDITED');
    check('editing a failed ticket preserves both input context and prior result location',
      await currentScanHint.isVisible()
      && /현재\s*감사 입장 데스크\s*·\s*입장/.test(await currentScanHint.innerText())
      && /처리 위치:\s*감사 입장 데스크\s*·\s*입장/.test(await multiFailure.getByText(/처리 위치:/).first().innerText()));
    await multiWork.screenshot({ path: path.join(OUT, 'staff-failed-edited-context-390.png') });
    // Stale-place guard: an actual work switch while the verdict is open
    // clears it instead of re-labeling it under the new booth/desk.
    await multiWork.getByRole('button', { name: '부스 인증', exact: true }).focus();
    await multiWork.keyboard.press('Enter');
    await multiWork.locator('#staff-booth').waitFor({ timeout: 15000 });
    check('task switching works again after the definitive response', await multiWork.locator('#staff-booth').isVisible());
    check('task switch clears the bound place with the result', await multiWork.locator('section[aria-label="스캔 실패"]').count() === 0 && await multiWork.getByText(/처리 위치:/).count() === 0);
    // Separate keyboard-retry reproduction with a real 404 failure: re-enter
    // desk work, submit the same invalid ticket, then retry via keyboard.
    // The retry value/focus guards stay pinned on this second verdict.
    await multiWork.getByRole('button', { name: '데스크 체크인', exact: true }).focus();
    await multiWork.keyboard.press('Enter');
    await multiWork.locator('#staff-desk').waitFor({ timeout: 15000 });
    await multiWork.locator('#staff-ticket').fill('ET-MULTI-INVALID');
    await multiWork.locator('#staff-ticket').press('Enter');
    const multiFailureRetry = multiWork.locator('section[aria-label="스캔 실패"]');
    await multiFailureRetry.waitFor({ timeout: 15000 });
    await multiFailureRetry.getByRole('button', { name: '다시 시도', exact: true }).focus();
    await multiWork.keyboard.press('Enter');
    await multiWork.waitForFunction(() => document.activeElement?.id === 'staff-ticket', null, { timeout: 15000 });
    check('keyboard retry preserves the submitted ticket and returns focus', await multiWork.locator('#staff-ticket').inputValue() === 'ET-MULTI-INVALID');
    await multi.close();

    check('no unexpected browser runtime errors', errors.length === 0);
    completed = true;
  } finally {
    let finalBuildId = '';
    try {
      finalBuildId = fs.readFileSync(buildPath, 'utf8').trim();
    } catch {
      // A removed artifact cannot substantiate a successful audit.
    }
    if (finalBuildId !== buildId) {
      completed = false;
      errors.push('Next build changed or disappeared during the audit');
      process.exitCode = 1;
    }
    try {
      fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({
        completed, checks, errors,
        build: buildId,
        buildSource: 'apps/web/.next/BUILD_ID',
        disclosures: [
          'isolated synthetic event and disposable PostgreSQL; no real DB, volume, deployment, or messages contacted',
          'approvalRequired=true seeded so public signup exercises the PENDING handoff; assignment-less staff account seeded for the unassigned state',
          'capacity pinned to the live headcount for the WAITLIST branch, then restored; payment feature + price for the UNPAID branch — all through real manager commands',
          'first staff scan response replaced with intercepted 502 after a real 200 commit; another committed response withheld until the real 15-second timeout; identical retry bodies, command ids and single persisted checks asserted',
          'multi-desk and booth assignments seeded for the temporary scan lock; a denied camera is simulated and no physical camera is opened',
          'staff ticket entry is manual typing of the participant-held bearer (simulated QR read, no physical scanner); input masked as password dots for failure screenshots only, value asserted separately and restored',
          'QR images necessarily encode synthetic bearers of the dropped disposable schema; no other raw bearer appears in captures',
          'storage-denied re-check covered in-repo: ticket keys throw, session cookie cleared, one intercepted 500 then retry, rendered approval, same in-tab bearer to QR, and a cancelled bearer proven unable to regain authority',
          'superseded-load race covered in-repo: hung first re-check, full reload completing from storage, late 404 released, storage asserted intact and ticket surviving a second reload (reload aborts the hung fetch, so this pins the property as defense-in-depth; the guard shape itself is pinned by the source test)',
          'waitlist wording fixed after proving a freed seat does not auto-promote (explicit APPROVED transition only); free-seat, approval and QR all driven through rendered UI',
          'waitlist approval delays one real roster-refresh response: Escape is rejected while busy, then the close button is used and the dialog is confirmed gone after the response is released',
          'combined approval+payment branch covered in-repo: combined lead and receipt name both gates, rendered approval provably yields no QR until payment confirms; no payment behavior changed',
          'no real SMS/email; verification path not exercised here (covered by prior signup-retry audit)',
          'keyboard paths include pending re-check (Tab + Enter), staff camera, ticket submit, retry and task switch (focus setup + Enter); not a complete keyboard-only walkthrough',
          'Chromium only; no real device, Safari, screen-reader listening, or customer acceptance',
        ],
      }, null, 2), { mode: 0o600 });
      if (completed) console.log(`[crossrole-journey] ${checks.length} checks passed; evidence: ${OUT}`);
    } finally {
      try {
        if (browser) await browser.close();
      } finally {
        await fixture.close();
      }
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
