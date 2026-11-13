'use strict';
const { openProgram } = require('./ui-journey-helpers.cjs');
// Real isolated API/Next fixture; never print credentials, bearer or personal data.
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { startStalledResponseProxy } = require('./stalled-response-fixture.cjs');

function safeErrorSummary(error) {
  const line = String(error && error.message || 'Unknown failure').split('\n')[0];
  // Playwright can embed the attempted URL in navigation failures. Remove
  // the entire query, including encoded parameters and arbitrary bearer text.
  return line.replace(/\?[^\s"'<>]*/g, '?[redacted]')
    .replace(/\bticket\s*=\s*[^\s&"'<>]*/gi, 'ticket=[redacted]');
}

async function checkTicketRecovery(browser, fixture, pending, out) {
  const { baseUrl, slug } = fixture;
  const apiPath = `/api/public/events/${slug}/ticket`;
  const proxy = await startStalledResponseProxy(baseUrl, apiPath);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(11000);
  const ticketUrl = `${proxy.origin}/event/${slug}/ticket`;
  const headers = () => page.waitForResponse(response => response.url() === proxy.origin + apiPath && response.status() === 200);
  const retry = page.getByRole('button', { name: '다시 시도', exact: true });
  const recheck = page.getByRole('button', { name: '상태 다시 확인', exact: true });
  const receipt = page.getByText('승인 대기', { exact: true });
  const qr = page.locator('[aria-label*="입장 및 퇴장용 QR"]');
  const statusChange = async status => {
    const result = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      cookie: fixture.manager.cookie, method: 'POST',
      body: { commandId: crypto.randomUUID(), command: 'participant.status', payload: { ids: [pending.id], status } },
    });
    assert.equal(result.status, 200);
  };
  try {
    await context.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug, ticket: pending.ticket });
    proxy.setStalled(true);
    await Promise.all([headers(), page.goto(ticketUrl, { waitUntil: 'domcontentloaded' })]);
    await retry.waitFor();
    await proxy.waitForClosed(0);
    proxy.setStalled(false);
    await retry.click();
    await receipt.waitFor();

    proxy.setStalled(true);
    await Promise.all([headers(), recheck.click()]);
    assert.ok(await receipt.isVisible(), 'pending receipt stays visible while checking');
    await page.getByRole('alert').filter({ hasText: '최신 상태를 확인하지 못했습니다' }).waitFor();
    await proxy.waitForClosed(1);
    assert.ok(await receipt.isVisible());
    assert.equal(await qr.count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(out, 'ticket-pending-timeout-390.png') });

    await statusChange('APPROVED');
    proxy.setStalled(false);
    await recheck.click();
    await qr.waitFor();
    proxy.setStalled(true);
    await Promise.all([headers(), recheck.click()]);
    await page.getByRole('alert').filter({ hasText: /입장 가능 여부는 확정되지 않았습니다/ }).waitFor();
    await proxy.waitForClosed(2);
    assert.ok(await qr.isVisible(), 'a transport failure is not ticket revocation');
    assert.ok(await recheck.isEnabled());

    await statusChange('CANCELLED');
    proxy.setStalled(false);
    await recheck.click();
    await page.getByRole('heading', { name: '티켓을 사용할 수 없습니다', exact: true }).waitFor();
    assert.equal(await qr.count(), 0);
    assert.equal(await page.evaluate(slug => sessionStorage.getItem(`eventouch.ticket.${slug}`), slug), null);
    console.log('[attendee-journey] initial and manual ticket reads recover from stalled HTTP bodies; server revocation clears the QR');
  } finally {
    await context.close();
    await proxy.close();
  }
}

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendee');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  try {
    const db = f.harness.database;
    const row = (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0];
    const w = row.payload;
    assert.ok(w.participants.length >= 3);
    const [approved, pending, waitlist] = w.participants;
    for (const [person, status] of [[approved, 'APPROVED'], [pending, 'PENDING'], [waitlist, 'WAITLIST']]) {
      person.status = status; person.paymentStatus = 'FREE';
      person.answers = { published: '합성 공개 답변', hidden: '비공개 답변 표식' };
    }
    const raceParticipant = w.participants[3];
    raceParticipant.status = 'APPROVED'; raceParticipant.paymentStatus = 'FREE';
    w.publishedFields = [{ id: 'published', label: '식사 선택', type: 'text' }];
    w.notices[0].published = true;
    w.program = [{ id: 'schedule-1', title: '게시된 일정 표식', date: '2027-01-16', start: '09:00', end: '10:00', published: true }];
    w.venue = { name: '게시된 장소 표식', description: '게시된 행사장 안내 표식\n두 번째 안내 줄' };
    w.modules = [
      { id: 'published-poll', type: 'poll', title: '공개 투표', status: 'OPEN', published: true, options: ['예', '아니요'] },
      { id: 'draft-poll', type: 'poll', title: '초안 표식', status: 'DRAFT', published: false },
      { id: 'disabled-quiz', type: 'quiz', title: '꺼진 기능 표식', status: 'OPEN', published: true },
    ];
    for (const delivery of ['aborted', 'uncancellable']) for (const kind of ['failure', 'success']) for (const step of ['one', 'two', 'three']) {
      w.modules.push({ id: `race-${delivery}-${kind}-${step}`, type: 'poll', title: `지연 ${delivery} ${kind} ${step}`, status: 'OPEN', published: true, options: ['예', '아니요'] });
    }
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(w)]);
    browser = await launchBrowser();
    // Existing ticket-link entry with denied storage and no session: a real
    // submit must survive the in-place post-commit reload without a second
    // command, and the bearer must be consumed from the address bar.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 664 } });
      await context.addInitScript(() => {
        Storage.prototype.setItem = function () { throw new DOMException('denied', 'SecurityError'); };
        Storage.prototype.getItem = function () { throw new DOMException('denied', 'SecurityError'); };
      });
      const page = await context.newPage();
      let submits = 0;
      page.on('request', request => {
        if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
        try { if (request.postDataJSON().command === 'response.submit') submits += 1; } catch { /* unrelated request */ }
      });
      await page.goto(`${f.baseUrl}/event/${f.slug}/engage?ticket=${encodeURIComponent(approved.ticket)}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '공개 투표' }).waitFor();
      assert.equal(new URL(page.url()).searchParams.has('ticket'), false);
      const poll = await openProgram(page, '공개 투표');
      await poll.getByRole('radio', { name: /^예/ }).check();
      await poll.getByRole('button', { name: '투표하기' }).click();
      await poll.getByText('이미 제출했습니다.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).count(), 0);
      assert.equal(submits, 1);
      const current = (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
      assert.equal(current.responses.filter(item => item.moduleId === 'published-poll' && item.participantId === approved.id).length, 1);
      await context.close();
    }
    // Refresh A may correctly abort when refresh B supersedes it. Observe
    // that settlement before triggering B, then separately force a genuinely
    // uncancellable old response to exercise the stale success/failure guards.
    for (const delivery of ['aborted', 'uncancellable']) for (const kind of ['failure', 'success']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const title = step => `지연 ${delivery} ${kind} ${step}`;
      const moduleId = step => `race-${delivery}-${kind}-${step}`;
      let releaseOld;
      const oldGate = new Promise(resolve => { releaseOld = resolve; });
      try {
        await page.goto(`${f.baseUrl}/event/${f.slug}/engage?ticket=${encodeURIComponent(approved.ticket)}`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: title('one'), exact: true }).waitFor();
        if (delivery === 'uncancellable') {
          // Model an adapter that ignores cancellation for exactly the next
          // ticket read. Its real HTTP response must reach the old effect.
          await page.evaluate(() => {
            const nativeFetch = window.fetch;
            let nextTicket = true;
            window.fetch = (input, init) => {
              if (nextTicket && typeof input === 'string' && new URL(input, location.href).pathname.endsWith('/ticket')) {
                nextTicket = false;
                const { signal, ...uncancellable } = init || {};
                return nativeFetch.call(window, input, uncancellable);
              }
              return nativeFetch.call(window, input, init);
            };
          });
        }
        let oldStarted, finishRoute;
        const started = new Promise(resolve => { oldStarted = resolve; });
        const routeFinished = new Promise(resolve => { finishRoute = resolve; });
        let intercepted = 0, oldRequest, oldSettlement;
        await page.route('**/api/public/events/*/ticket', async route => {
          intercepted += 1;
          if (intercepted !== 1) return route.continue();
          oldRequest = route.request();
          const response = await route.fetch();
          // A cancelled fetch emits requestfailed, not response. Both waits
          // are request-specific and armed before the superseding submit.
          oldSettlement = delivery === 'aborted'
            ? page.waitForEvent('requestfailed', { predicate: request => request === oldRequest }).then(request => ({ error: request.failure()?.errorText }))
            : page.waitForResponse(response => response.request() === oldRequest).then(async response => ({ status: response.status(), finished: await response.finished() }));
          oldSettlement.catch(() => {});
          oldStarted();
          try {
            await oldGate;
            if (kind === 'failure') await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
            else await route.fulfill({ response });
          } finally { finishRoute(); }
        });
        const form = step => page.locator(':is(section,[role=region])[aria-labelledby^="engage-"]').filter({ has: page.getByRole('heading', { name: title(step), exact: true }) });
        await openProgram(page, title('one'));
        await form('one').getByRole('radio', { name: /^예/ }).check();
        await form('one').getByRole('button', { name: '투표하기' }).click();
        await started;
        await openProgram(page, title('two'));
        await form('two').getByRole('radio', { name: /^예/ }).check();
        await page.evaluate(ticket => { const url = new URL(location.href); url.searchParams.set('ticket', ticket); history.replaceState(null, '', url); }, raceParticipant.ticket);
        const newResponse = page.waitForResponse(response => response.request() !== oldRequest && response.url().endsWith('/ticket') && response.status() === 200);
        await form('two').getByRole('button', { name: '투표하기' }).click();
        await newResponse;
        assert.equal(new URL(page.url()).searchParams.has('ticket'), false);
        releaseOld();
        const oldResult = await oldSettlement;
        await routeFinished;
        if (delivery === 'aborted') assert.match(oldResult.error, /ERR_ABORTED/, 'the superseded read actually aborted');
        else {
          assert.equal(oldResult.status, kind === 'failure' ? 404 : 200, 'the uncancellable stale response actually arrived');
          assert.equal(oldResult.finished, null, 'the stale body finished, not merely its headers');
        }
        await page.waitForLoadState('networkidle');
        assert.equal(await page.evaluate(({ slug, ticket }) => sessionStorage.getItem(`eventouch.ticket.${slug}`) === ticket, { slug: f.slug, ticket: raceParticipant.ticket }), true);
        await openProgram(page, title('three'));
        await form('three').getByRole('radio', { name: /^예/ }).check();
        await form('three').getByRole('button', { name: '투표하기' }).click();
        await form('three').getByText('이미 제출했습니다.', { exact: false }).waitFor();
        const current = (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
        for (const step of ['one', 'two', 'three']) {
          const saved = current.responses.filter(item => item.moduleId === moduleId(step));
          assert.equal(saved.length, 1, 'each real submit commits exactly once');
          assert.equal(saved[0].participantId, step === 'three' ? raceParticipant.id : approved.id);
        }
        console.log(`[attendee-journey] ${delivery} stale ${kind} preserves the new bearer and exactly-once submissions`);
      } finally {
        releaseOld();
        await context.close();
      }
    }
    // A new event in the same browser tab must not inherit the previous
    // event's memory bearer when both storage and session are unavailable.
    // The cloned synthetic fixture deliberately accepts the same token server
    // side, so an accidental cross-event carry would make this assertion fail.
    {
      const eventRow = (await db.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
      const nextId = `${f.eventId}-next`;
      await f.helpers.insertEvent(db, { id: nextId, slug: nextId, orgId: f.helpers.LEGACY_ORG, payload: { ...eventRow, id: nextId, slug: nextId }, workspace: w });
      const context = await browser.newContext();
      await context.addInitScript(() => {
        Storage.prototype.setItem = function () { throw new DOMException('denied', 'SecurityError'); };
        Storage.prototype.getItem = function () { throw new DOMException('denied', 'SecurityError'); };
      });
      const page = await context.newPage();
      await page.goto(`${f.baseUrl}/event/${f.slug}/engage?ticket=${encodeURIComponent(approved.ticket)}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '공개 투표' }).waitFor();
      await page.goto(`${f.baseUrl}/event/${nextId}/engage`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.has('ticket'), false);
      await context.close();
    }
    // Separate valid A/B credentials: delay A's real read across navigation
    // and assert B's ticket request and displayed identity belong only to B.
    // page.goto may remount: the React-key test separately checks that the
    // actual page functions enforce a remount even if routing reuses a page.
    {
      const eventRow = (await db.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
      const nextId = `${f.eventId}-other`;
      const bTicket = crypto.randomBytes(32).toString('base64url');
      const otherWorkspace = JSON.parse(JSON.stringify(w));
      otherWorkspace.participants[0].ticket = bTicket;
      otherWorkspace.participants[0].name = '두번째 합성 참가자';
      otherWorkspace.participants[0].answers = { published: '두번째 행사 답변' };
      await f.helpers.insertEvent(db, { id: nextId, slug: nextId, orgId: f.helpers.LEGACY_ORG, payload: { ...eventRow, id: nextId, slug: nextId, name: '두번째 합성 행사' }, workspace: otherWorkspace });
      for (const [suffix, heading] of [['home?view=application', '내 신청 정보'], ['ticket', '내 티켓'], ['engage', '공개 투표']]) {
        const context = await browser.newContext();
        await context.addInitScript(({ slugA, ticketA, slugB, ticketB }) => {
          sessionStorage.setItem(`eventouch.ticket.${slugA}`, ticketA);
          sessionStorage.setItem(`eventouch.ticket.${slugB}`, ticketB);
        }, { slugA: f.slug, ticketA: approved.ticket, slugB: nextId, ticketB: bTicket });
        const page = await context.newPage();
        let releaseA;
        const gate = new Promise(resolve => { releaseA = resolve; });
        let startA;
        const pendingA = new Promise(resolve => { startA = resolve; });
        let correctB = false;
        let wrongB = false;
        await page.route('**/api/public/events/*/ticket', async route => {
          const request = route.request();
          if (request.url().includes(`/events/${nextId}/ticket`)) {
            const auth = request.headers().authorization || '';
            correctB ||= auth === `Bearer ${bTicket}`;
            wrongB ||= auth === `Bearer ${approved.ticket}`;
            return route.continue();
          }
          const response = await route.fetch();
          startA();
          await gate;
          try { await route.fulfill({ response }); } catch { /* navigation can abort A */ }
        });
        await page.goto(`${f.baseUrl}/event/${f.slug}/${suffix}`, { waitUntil: 'domcontentloaded' });
        await pendingA;
        await page.goto(`${f.baseUrl}/event/${nextId}/${suffix}`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: heading }).waitFor();
        releaseA();
        await page.waitForLoadState('networkidle');
        assert.equal(correctB, true);
        assert.equal(wrongB, false);
        assert.equal(await page.getByText(approved.name, { exact: true }).count(), 0);
        if (suffix !== 'engage') await page.getByText('두번째 합성 참가자', { exact: true }).waitFor();
        assert.equal(await page.evaluate(({ slugA, ticketA, slugB, ticketB }) => sessionStorage.getItem(`eventouch.ticket.${slugA}`) === ticketA && sessionStorage.getItem(`eventouch.ticket.${slugB}`) === ticketB, { slugA: f.slug, ticketA: approved.ticket, slugB: nextId, ticketB: bTicket }), true);
        await context.close();
      }
    }
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 664 } });
      const home = `${f.baseUrl}/event/${f.slug}/home`;
      await page.goto(home, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '모바일 티켓' }).waitFor();
      assert.equal(await page.locator('[aria-label*="입장 및 퇴장용 QR"]').count(), 0);
      const box = await page.getByRole('button', { name: '모바일 티켓' }).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height && box.height >= 44);
      await page.screenshot({ path: path.join(out, `home-${width}.png`), fullPage: false });
      await page.getByRole('button', { name: '내 신청 정보' }).click();
      await page.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
      await page.getByRole('button', { name: '참가 메뉴' }).click();
      await page.getByRole('button', { name: '모바일 티켓' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
      await page.goBack();
      await page.getByRole('link', { name: /행사 안내/ }).click();
      await page.locator('main.public-event-page h1').waitFor();
      await page.goBack();
      await page.getByRole('link', { name: /참여 콘텐츠 보기/ }).click();
      await page.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
      await page.getByRole('link', { name: '참가 메뉴로' }).first().click();
      await page.getByRole('button', { name: '모바일 티켓' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.close();
    }
    for (const [person, state] of [[approved, '참가 확정'], [pending, '승인 대기'], [waitlist, '대기 명단']]) {
      assert.ok(person.ticket);
      const context = await browser.newContext({ viewport: { width: 390, height: 664 } });
      await context.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: person.ticket });
      const page = await context.newPage();
      await page.goto(`${f.baseUrl}/event/${f.slug}/home?view=application`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '내 신청 정보' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '참가 메뉴' }).evaluate(el => el === document.activeElement), true);
      await page.getByText(state, { exact: true }).waitFor();
      await page.getByText('합성 공개 답변', { exact: true }).waitFor();
      assert.equal(await page.getByText('비공개 답변 표식').count(), 0);
      assert.equal(await page.getByText(w.participants.find(item => item.id !== person.id).name, { exact: true }).count(), 0);
      assert.equal(await page.locator('[aria-label*="입장 및 퇴장용 QR"]').count(), 0);
      assert.equal(await page.evaluate((token) => document.body.innerText.includes(token) || location.href.includes(token), person.ticket), false);
      if (state === '참가 확정') {
        await page.screenshot({ path: path.join(out, 'application-390.png'), fullPage: true, mask: [page.locator('dd')] });
        await page.setViewportSize({ width: 320, height: 568 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(out, 'application-320.png'), mask: [page.locator('dd')] });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      await page.getByRole('button', { name: '참가 메뉴' }).click();
      await page.getByRole('button', { name: '모바일 티켓' }).click();
      if (state === '참가 확정') await page.locator('[aria-label*="입장 및 퇴장용 QR"]').waitFor();
      else assert.equal(await page.locator('[aria-label*="입장 및 퇴장용 QR"]').count(), 0);
      if (state === '참가 확정') {
        await page.getByRole('button', { name: '참가 메뉴' }).click();
        await page.getByRole('link', { name: /참여 콘텐츠 보기/ }).click();
        await page.getByRole('heading', { name: '공개 투표' }).waitFor();
        assert.equal(await page.getByText('초안 표식').count(), 0);
        assert.equal(await page.getByText('꺼진 기능 표식').count(), 0);
        await page.screenshot({ path: path.join(out, 'engage-320.png'), fullPage: true });
        await page.getByRole('link', { name: '참가 메뉴로' }).first().click();
        await page.getByRole('button', { name: '모바일 티켓' }).waitFor();
      }
      await context.close();
    }
    // Storage refusal: the consumed legacy link remains in component memory
    // while switching home details; it is not copied into another URL/store.
    {
      const context = await browser.newContext();
      await context.addInitScript(() => {
        Storage.prototype.setItem = function () { throw new DOMException('denied', 'SecurityError'); };
        Storage.prototype.getItem = function () { throw new DOMException('denied', 'SecurityError'); };
      });
      const page = await context.newPage();
      await page.goto(`${f.baseUrl}/event/${f.slug}/home?ticket=${encodeURIComponent(approved.ticket)}`, { waitUntil: 'networkidle' });
      assert.equal(new URL(page.url()).searchParams.has('ticket'), false);
      await page.getByRole('button', { name: '내 신청 정보' }).click();
      await page.getByRole('heading', { name: '내 신청 정보' }).waitFor();
      await page.getByRole('button', { name: '참가 메뉴' }).click();
      await page.getByRole('button', { name: '모바일 티켓' }).click();
      await page.locator('[aria-label*="입장 및 퇴장용 QR"]').waitFor();
      await context.close();
    }
    // Synthetic pre-verified session: when tab storage is unavailable the
    // attendee explicitly selects the browser session before it is used on
    // other screens. This is not a test of SMS delivery.
    {
      const session = crypto.randomBytes(32).toString('base64url');
      const digest = crypto.createHash('sha256').update(session).digest('hex');
      const grants = [{ eventId: f.eventId, participantId: approved.id, phone: approved.phone, grantedAt: new Date().toISOString() }];
      await db.query('INSERT INTO attendee_sessions (token_hash, grants, expires_at) VALUES ($1,$2::jsonb,$3)', [digest, JSON.stringify(grants), new Date(Date.now() + 86400000).toISOString()]);
      const context = await browser.newContext();
      await context.addCookies([{ name: 'etko_attendee', value: session, url: f.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
      await context.addInitScript(() => {
        Storage.prototype.setItem = function () { throw new DOMException('denied', 'SecurityError'); };
        Storage.prototype.getItem = function () { throw new DOMException('denied', 'SecurityError'); };
      });
      const page = await context.newPage();
      await page.goto(`${f.baseUrl}/event/${f.slug}/ticket`, { waitUntil: 'networkidle' });
      await page.getByRole('link', { name: '이 브라우저에서 인증된 티켓 확인' }).click();
      await page.locator('[aria-label*="입장 및 퇴장용 QR"]').waitFor();
      await page.getByRole('link', { name: '← 참가 메뉴로' }).click();
      await page.getByRole('button', { name: '내 신청 정보' }).click();
      await page.getByText('합성 공개 답변', { exact: true }).waitFor();
      await page.getByRole('button', { name: '참가 메뉴' }).click();
      await page.getByRole('link', { name: /참여 콘텐츠 보기/ }).click();
      await page.getByRole('heading', { name: '공개 투표' }).waitFor();
      // Full reload cannot safely bind the shared cookie to the chosen
      // participant when storage is unavailable; ask again instead.
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
      await context.close();
    }
    // Draft visibility must not override the published settings. The
    // schedule/program section toggles govern public event information; they
    // do not publish or unpublish the separately controlled engage modules.
    {
      w.pageExperience = w.pageExperience || {};
      w.pageExperience.published = { ...(w.pageExperience.published || {}), showAnnouncements: false, showSchedule: false, showVenue: false, showPrograms: false };
      w.pageExperience.draft = { ...(w.pageExperience.draft || {}), showAnnouncements: true, showSchedule: true, showVenue: true, showPrograms: true };
      w.pageExperience.published.homeStyle = { heroTitle: '게시된 제목' };
      w.pageExperience.draft.homeStyle = { heroTitle: '초안 제목' };
      await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(w)]);
      const page = await browser.newPage();
      await page.goto(`${f.baseUrl}/event/${f.slug}/home?view=notice`, { waitUntil: 'networkidle' });
      await page.getByText('현재 이 행사에서 제공하지 않습니다.', { exact: false }).waitFor();
      await page.getByRole('button', { name: '참가 메뉴' }).click();
      await page.getByRole('heading', { name: '게시된 제목' }).waitFor();
      assert.equal(await page.getByText('초안 제목').count(), 0);
      await page.getByRole('link', { name: /참여 콘텐츠 보기/ }).waitFor();
      await page.getByRole('link', { name: '행사 안내 보기' }).click();
      assert.equal(await page.getByText('감사 안내', { exact: true }).count(), 0);
      assert.equal(await page.getByText('게시된 일정 표식', { exact: true }).count(), 0);
      assert.equal(await page.getByText('게시된 장소 표식', { exact: true }).count(), 0);
      assert.equal(await page.getByText('게시된 행사장 안내 표식', { exact: false }).count(), 0);
      await page.close();
      w.pageExperience.published.showAnnouncements = true;
      w.pageExperience.published.showSchedule = true;
      w.pageExperience.published.showVenue = true;
      w.pageExperience.published.showPrograms = true;
      w.pageExperience.draft.showAnnouncements = false;
      await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(w)]);
      const publishedPage = await browser.newPage();
      await publishedPage.goto(`${f.baseUrl}/event/${f.slug}/home?view=notice`, { waitUntil: 'networkidle' });
      await publishedPage.getByText('감사 안내', { exact: true }).waitFor();
      await publishedPage.getByRole('button', { name: '참가 메뉴' }).click();
      await publishedPage.getByRole('link', { name: '행사 안내 보기' }).click();
      await publishedPage.getByText('게시된 일정 표식', { exact: true }).waitFor();
      await publishedPage.getByText('게시된 장소 표식', { exact: true }).first().waitFor();
      const venueDescription = publishedPage.getByText('게시된 행사장 안내 표식', { exact: false });
      await venueDescription.waitFor();
      assert.equal(await venueDescription.evaluate((el) => getComputedStyle(el).whiteSpace), 'pre-wrap');
      assert.match(await venueDescription.textContent(), /표식\n두 번째 안내 줄/);
      await publishedPage.close();
    }
    {
      const context = await browser.newContext();
      await context.addInitScript(({ slug }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, 'invalid-ticket'), { slug: f.slug });
      const page = await context.newPage();
      await page.goto(`${f.baseUrl}/event/${f.slug}/home?view=application`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '티켓을 확인할 수 없습니다' }).waitFor();
      assert.equal(await page.locator('[aria-label*="입장 및 퇴장용 QR"]').count(), 0);
      assert.equal(await page.getByText('합성 공개 답변').count(), 0);
      await context.close();
    }
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('**/api/public/events/*/ticket', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      await page.goto(`${f.baseUrl}/event/${f.slug}/home`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '행사를 불러올 수 없습니다' }).waitFor();
      await page.getByRole('button', { name: '다시 시도' }).waitFor();
      await page.unrouteAll();
      await page.getByRole('button', { name: '다시 시도' }).click();
      await page.getByRole('button', { name: '모바일 티켓' }).waitFor();
      await context.close();
    }
    const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
    await page.goto(`${f.baseUrl}/event/${f.slug}/home?view=stamp`, { waitUntil: 'networkidle' });
    await page.getByText('현재 이 행사에서 제공하지 않습니다.', { exact: false }).waitFor();
    await page.getByRole('button', { name: '참가 메뉴' }).click();
    await page.getByRole('link', { name: /참여 콘텐츠 보기/ }).click();
    await page.getByRole('heading', { name: '티켓이 확인되지 않습니다', exact: true }).waitFor();
    await page.close();
    await checkTicketRecovery(browser, f, pending, out);
    console.log('[attendee-journey] synthetic journey checks passed');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}
if (require.main === module) {
  main().catch((error) => {
    const location = String(error?.stack || '').split('\n').find(line => /web-attendee-journey-audit\.cjs:\d+:\d+/.test(line));
    console.error('[attendee-journey] failed:', safeErrorSummary(error), location?.trim() || ''); process.exitCode = 1;
  });
}
module.exports = { safeErrorSummary };
