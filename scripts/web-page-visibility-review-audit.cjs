'use strict';
// Synthetic event: compare the operator's publication review with public UI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { openStudioPanel } = require('./ui-journey-helpers.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'page-visibility-review');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const command = async (name, payload) => {
      const result = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.ok(result.status >= 200 && result.status < 300, `${name}: ${JSON.stringify(result.json)}`);
      return result.json;
    };
    const notice = (await command('notice.save', { title: '합성 공지', body: '합성 안내', published: true })).notice;
    await command('display.set', { type: 'notice', noticeId: notice.id });
    await command('program.save', { title: '합성 프로그램 일정', date: '2027-01-16', start: '10:00', end: '11:00', place: '합성 세션룸', published: true });
    await command('program.save', { title: '합성 둘째 날 프로그램', date: '2027-01-17', start: '10:00', end: '11:00', place: '합성 세션룸 B', published: true });
    await command('venue.save', { name: '합성 행사장', address: '서울 합성로 1' });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const ticket = (await workspace()).participants[0].ticket;
    assert.ok(ticket);
    browser = await launchBrowser();
    const operator = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await operator.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await operator.newPage();
    const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    const attendee = await publicContext.newPage();
    const registration = await publicContext.newPage();
    const ticketPage = await publicContext.newPage();
    const screen = await publicContext.newPage();
    const errors = [];
    for (const target of [page, attendee, registration, ticketPage, screen]) target.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    const eventUrl = `${fixture.baseUrl}/event/${fixture.slug}`;
    const venueLink = target => target.getByRole('link', { name: '오시는 길', exact: true });
    await registration.goto(`${eventUrl}/register`, { waitUntil: 'networkidle' });
    await registration.locator('time[datetime="2027-01-16"]').waitFor();
    assert.equal(await venueLink(registration).getAttribute('href'), `/event/${fixture.slug}#public-venue`);
    await attendee.goto(eventUrl, { waitUntil: 'networkidle' });
    await attendee.locator('dt').filter({ hasText: /^일시$/ }).waitFor();
    await attendee.getByRole('heading', { name: '합성 프로그램 일정', exact: true }).waitFor();
    await attendee.getByRole('heading', { name: '오시는 길', exact: true }).waitFor();
    const publicProgramDates = async () => attendee.getByRole('region', { name: '프로그램', exact: true }).locator('h3 time[datetime]').evaluateAll(elements => elements.map(element => element.getAttribute('datetime')));
    assert.deepEqual(await publicProgramDates(), ['2027-01-16', '2027-01-17'], 'each program day exposes its actual date in datetime');
    await screen.goto(`${fixture.baseUrl}/screen/${fixture.slug}`, { waitUntil: 'networkidle' });
    await screen.getByText('합성 공지', { exact: true }).waitFor();
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/page`, { waitUntil: 'networkidle' });
    assert.ok(await page.getByText(/미리보기.*메뉴는 작동하지 않습니다/).count(), 'read-only preview controls are explained');
    assert.equal(await page.getByRole('region', { name: '390×700 홈 디자인 미리보기' }).getByRole('button', { name: '모바일 티켓' }).isDisabled(), true);
    const guideQrButton = page.getByRole('button', { name: '행사 안내 QR', exact: true });
    assert.equal(await guideQrButton.count(), 1, 'public events offer an attendee guide QR from the page editor');
    await guideQrButton.click();
    const guideDialog = page.getByRole('dialog', { name: '행사 안내 QR', exact: true });
    await guideDialog.waitFor();
    const guideUrl = await guideDialog.locator('#attendee-guide-public-url').inputValue();
    const qrAddress = new URL(guideUrl);
    assert.equal(qrAddress.origin, new URL(fixture.baseUrl).origin);
    assert.equal(qrAddress.pathname, `/event/${fixture.slug}`);
    assert.equal(qrAddress.search, '', 'attendee QR excludes login, ticket and private query tokens');
    assert.equal(qrAddress.hash, '', 'attendee QR excludes console deep links and fragments');
    const screenQr = await guideDialog.locator('svg path').last().getAttribute('d');
    assert.ok(screenQr, 'the preview renders a QR');
    assert.equal(await page.locator('body > article svg path').last().getAttribute('d'), screenQr, 'the same QR is printed on A4');
    assert.equal(await guideDialog.getByRole('link', { name: '행사 안내 페이지 열기' }).getAttribute('href'), eventUrl);
    await guideDialog.getByRole('button', { name: '닫기', exact: true }).click();
    await guideDialog.waitFor({ state: 'hidden' });
    await openStudioPanel(page, 'exposure');
    const dateToggle = page.getByRole('switch', { name: /^(일정 보기|행사 일시 보기)$/ });
    const programToggle = page.getByRole('switch', { name: /^(프로그램 보기|프로그램 일정 보기)$/ });
    const noticeToggle = page.getByRole('switch', { name: '공지 보기', exact: true });
    const venueToggle = page.getByRole('switch', { name: '장소 보기', exact: true });
    const save = async () => {
      await page.getByRole('button', { name: '초안 저장', exact: true }).click();
      await page.getByText('초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.', { exact: true }).waitFor();
    };
    const review = async () => {
      await page.getByRole('button', { name: '게시 검토', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '참가자 페이지 게시 검토', exact: true });
      await dialog.waitFor();
      return dialog;
    };
    const publish = async (dialog) => {
      await dialog.getByRole('button', { name: '게시하기', exact: true }).click();
      await page.getByText('게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.', { exact: true }).waitFor();
    };
    const destination = (dialog, label) => dialog.locator('section').first().locator('li').filter({ hasText: label });
    const audit = async (target, label) => {
      await target.evaluate(axeSource);
      const result = await target.evaluate(async () => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
        violations: (await window.axe.run(document)).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id) }));
      assert.equal(result.overflow, false, `${label}: no horizontal overflow`);
      assert.deepEqual(result.violations, [], `${label}: no serious or critical accessibility findings`);
    };

    // Hiding the event fact does not hide session dates or ticket dates.
    await dateToggle.uncheck();
    await save();
    let dialog = await review();
    await dialog.screenshot({ path: path.join(out, 'schedule-review-1280.png') });
    const eventDetail = await destination(dialog, '행사 안내').innerText();
    assert.match(eventDetail, /숨길 안내:.*행사 일시/, 'review must identify the event date hidden by this setting');
    assert.match(await dialog.innerText(), /프로그램 일정.*별도|별도.*프로그램 일정/, 'review must explain the separate program schedule');
    assert.match(await dialog.innerText(), /화면 열기는 현재 참가자 화면/, 'live destination links are distinguished from the pending draft');
    const splitDateWord = await destination(dialog, '행사 안내').locator('p').evaluate(element => {
      const node = element.firstChild;
      const index = node?.textContent?.indexOf('행사 일시') ?? -1;
      if (!node || index < 0) return null;
      const range = document.createRange();
      range.setStart(node, index + 3); range.setEnd(node, index + 4);
      const first = range.getBoundingClientRect();
      range.setStart(node, index + 4); range.setEnd(node, index + 5);
      return Math.abs(first.top - range.getBoundingClientRect().top) > 1;
    });
    assert.equal(splitDateWord, false, 'the Korean word 일시 should not split across lines in the review');
    const eventLink = destination(dialog, '행사 안내').getByRole('link', { name: /화면 열기/ });
    assert.equal(await eventLink.getAttribute('href'), `/event/${fixture.slug}`);
    const [opened] = await Promise.all([operator.waitForEvent('page'), eventLink.click()]);
    await opened.waitForLoadState('networkidle');
    await opened.locator('dt').filter({ hasText: /^일시$/ }).waitFor();
    await opened.close();
    await attendee.reload({ waitUntil: 'networkidle' });
    await attendee.locator('dt').filter({ hasText: /^일시$/ }).waitFor();
    const draftBeforeCancel = await workspace();
    await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
    assert.equal((await workspace()).pageExperience.publishedAt, draftBeforeCancel.pageExperience.publishedAt, 'leaving review does not publish');
    dialog = await review();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await audit(page, `review ${width}`);
      if (width === 320) {
        const overflow = await destination(dialog, '행사 안내').locator('p').evaluate(element => {
          const probe = element.cloneNode(false);
          probe.textContent = '합성긴단어'.repeat(100);
          element.after(probe);
          const result = probe.scrollWidth > probe.clientWidth + 1;
          probe.remove();
          return result;
        });
        assert.equal(overflow, false, 'long uninterrupted text wraps without horizontal overflow');
      }
      await dialog.screenshot({ path: path.join(out, `schedule-review-${width}-verified.png`) });
    }
    await publish(dialog);
    await attendee.reload({ waitUntil: 'networkidle' });
    assert.equal(await attendee.locator('dt').filter({ hasText: /^일시$/ }).count(), 0, 'event fact is hidden');
    await attendee.getByRole('heading', { name: '합성 프로그램 일정', exact: true }).waitFor();
    assert.deepEqual(await publicProgramDates(), ['2027-01-16', '2027-01-17'], 'program days remain visible with their actual dates independently of the event fact');
    const dateFilter = attendee.getByRole('group', { name: '프로그램 날짜 선택', exact: true });
    assert.equal(await dateFilter.getByRole('button').count(), 3, 'a multi-day program offers all days and each actual date');
    await dateFilter.getByRole('button').nth(2).click();
    assert.deepEqual(await publicProgramDates(), ['2027-01-17'], 'a selected program date filters out the other day');
    assert.equal(await attendee.getByRole('heading', { name: '합성 둘째 날 프로그램', exact: true }).count(), 1);
    await dateFilter.getByRole('button').first().click();
    assert.deepEqual(await publicProgramDates(), ['2027-01-16', '2027-01-17'], 'all dates restores the complete published schedule');
    await ticketPage.goto(`${eventUrl}/ticket?ticket=${encodeURIComponent(ticket)}`, { waitUntil: 'networkidle' });
    await ticketPage.getByRole('heading', { name: '내 티켓' }).waitFor();
    await ticketPage.getByText('2027-01-16', { exact: true }).first().waitFor();
    await venueLink(ticketPage).waitFor();
    await registration.reload({ waitUntil: 'networkidle' });
    assert.equal(await registration.locator('time').count(), 0, 'the published setting hides the registration date');
    await venueLink(registration).waitFor();
    await screen.reload({ waitUntil: 'networkidle' });
    await screen.getByText('2027-01-16', { exact: true }).first().waitFor();
    await attendee.screenshot({ path: path.join(out, 'attendee-schedule-hidden.png'), fullPage: true });

    // Venue visibility controls venue guidance, not program places or booth maps.
    await page.setViewportSize({ width: 1280, height: 900 });
    await venueToggle.uncheck();
    await save(); dialog = await review();
    assert.match(await destination(dialog, '행사 안내').innerText(), /장소/);
    assert.match(await dialog.innerText(), /프로그램.*장소.*부스 지도.*전광판.*별도/s);
    await publish(dialog);
    await attendee.reload({ waitUntil: 'networkidle' });
    assert.equal(await attendee.getByRole('heading', { name: '오시는 길', exact: true }).count(), 0);
    assert.match(await attendee.locator('#public-program').locator('..').innerText(), /합성 세션룸/, 'program place is independent of venue visibility');
    await screen.reload({ waitUntil: 'networkidle' });
    await screen.getByText('합성 행사장', { exact: true }).first().waitFor();

    // All four setting changes must be named, including the home notice link.
    await page.setViewportSize({ width: 1280, height: 900 });
    await noticeToggle.uncheck();
    await programToggle.uncheck();
    await venueToggle.uncheck();
    await save();
    dialog = await review();
    const hiddenDetail = await destination(dialog, '행사 안내').innerText();
    for (const label of ['행사 일시', '공지', '프로그램 일정', '장소']) assert.ok(hiddenDetail.includes(label), `review names hidden ${label}`);
    assert.match(await destination(dialog, '참가자 홈').innerText(), /공지/, 'home notice hiding is named');
    assert.match(await dialog.innerText(), /전광판.*별도/, 'screen notices are distinguished from participant page visibility');
    await dialog.screenshot({ path: path.join(out, 'all-hidden-review.png') });
    await publish(dialog);
    await attendee.reload({ waitUntil: 'networkidle' });
    assert.equal(await attendee.locator('dt').filter({ hasText: /^일시$/ }).count(), 0);
    assert.equal(await attendee.getByRole('heading', { name: '합성 공지', exact: true }).count(), 0);
    assert.equal(await attendee.getByRole('heading', { name: '합성 프로그램 일정', exact: true }).count(), 0);
    assert.equal(await attendee.getByRole('heading', { name: '오시는 길', exact: true }).count(), 0);
    await attendee.goto(`${eventUrl}/home`, { waitUntil: 'networkidle' });
    await attendee.getByRole('button', { name: /^모바일 티켓/u }).waitFor();
    assert.equal(await attendee.getByRole('button', { name: /^공지사항/u }).count(), 0);
    await ticketPage.reload({ waitUntil: 'networkidle' });
    await ticketPage.getByText('2027-01-16', { exact: true }).first().waitFor();
    await registration.reload({ waitUntil: 'networkidle' });
    for (const target of [registration, ticketPage]) {
      assert.equal(await venueLink(target).count(), 0);
      assert.equal(await target.getByText('합성 행사장', { exact: true }).count(), 0);
    }
    await screen.reload({ waitUntil: 'networkidle' });
    await screen.getByText('합성 공지', { exact: true }).waitFor();

    // A switched-on setting is not a promise that disabled features are shown.
    await dateToggle.check(); await noticeToggle.check(); await programToggle.check(); await venueToggle.check();
    await save(); dialog = await review();
    assert.doesNotMatch(await destination(dialog, '행사 안내').innerText(), /숨길 안내:/);
    await publish(dialog);
    const eventRecord = (await fixture.harness.database.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    await command('event.features', { features: eventRecord.features.filter(value => value !== 'venue'), expectedFeatures: eventRecord.features });
    await page.reload({ waitUntil: 'networkidle' });
    await openStudioPanel(page, 'exposure');
    await page.getByRole('group', { name: '미리보기 기준' }).getByRole('button', { name: '게시본', exact: true }).click();
    await page.getByText(/표시 설정.*모두 켜짐/).waitFor();
    assert.equal(await page.getByText('전체 항목 노출', { exact: false }).count(), 0);
    await attendee.goto(eventUrl, { waitUntil: 'networkidle' });
    assert.equal(await attendee.getByRole('heading', { name: '오시는 길', exact: true }).count(), 0, 'disabled venue feature stays hidden despite enabled setting');

    // A published page setting does not make a DRAFT event public.
    const draftId = `draft-page-${crypto.randomUUID()}`;
    await fixture.helpers.insertEvent(fixture.harness.database, {
      id: draftId, slug: draftId, orgId: fixture.helpers.LEGACY_ORG,
      payload: { id: draftId, slug: draftId, name: '합성 기획 행사', stage: 'DRAFT', date: '2027-02-01', start: '09:00', end: '17:00', capacity: 100, features: ['venue'] },
      workspace: fixture.helpers.emptyWorkspace(),
    });
    await fixture.helpers.insertMembership(fixture.harness.database, fixture.manager.id, draftId, ['all']);
    const draftEventUrl = `${fixture.baseUrl}/event/${draftId}`;
    const unavailable = await attendee.goto(draftEventUrl, { waitUntil: 'networkidle' });
    assert.equal(unavailable.status(), 404, 'a planning-stage event has no public event page');
    await page.goto(`${fixture.baseUrl}/console/events/${draftId}/page`, { waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: '행사 안내 QR', exact: true }).count(), 0, 'private planning events do not offer a public guide QR');
    assert.ok(await page.getByText(/미리보기.*메뉴는 작동하지 않습니다/).count(), 'planning-stage preview controls are explained');
    await openStudioPanel(page, 'exposure');
    await page.locator('#home-intro').fill('합성 기획 행사 안내');
    await save();
    dialog = await review();
    await dialog.screenshot({ path: path.join(out, 'draft-review-1280.png') });
    assert.match(await dialog.innerText(), /기획 단계.*참가자.*공개되지/s, 'review explains that publishing page settings does not publish the event');
    assert.equal(await dialog.getByRole('link', { name: /화면 열기/ }).count(), 0, 'unavailable public links are not offered as working previews');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await audit(page, `planning review ${width}`);
      if (width === 320) {
        for (const [target, word] of [
          [dialog.locator('[id$="-description"]'), '않습니다'],
          [dialog.locator('dd').filter({ hasText: '합성 기획 행사 안내' }), '안내'],
        ]) {
          const split = await target.evaluate((element, targetWord) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const index = node.textContent?.indexOf(targetWord) ?? -1;
              if (index < 0) continue;
              const range = document.createRange();
              range.setStart(node, index); range.setEnd(node, index + targetWord.length);
              return range.getClientRects().length > 1;
            }
            return null;
          }, word);
          assert.equal(split, false, `${word} stays together in the mobile publication review`);
        }
        const valueOverflow = await dialog.locator('dd').filter({ hasText: '합성 기획 행사 안내' }).evaluate(element => {
          const probe = element.cloneNode(false);
          probe.textContent = '합성긴변경값'.repeat(100);
          element.after(probe);
          const result = probe.scrollWidth > probe.clientWidth + 1;
          probe.remove();
          return result;
        });
        assert.equal(valueOverflow, false, 'long comparison values still wrap in the mobile review');
        const descriptionOverflow = await dialog.locator('[id$="-description"]').evaluate(element => {
          const probe = element.cloneNode(false);
          const text = element.querySelector('span')?.cloneNode(false);
          if (!text) return null;
          text.textContent = '합성긴행사명'.repeat(100);
          probe.append(text);
          element.after(probe);
          const result = probe.scrollWidth > probe.clientWidth + 1;
          probe.remove();
          return result;
        });
        assert.equal(descriptionOverflow, false, 'long descriptions still wrap in the mobile review');
      }
      await dialog.screenshot({ path: path.join(out, `draft-review-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByRole('button', { name: '게시하기', exact: true }).click();
    await page.getByText(/기획 단계.*참가자.*공개되지/).first().waitFor();
    await page.getByText('페이지 게시됨 · 행사 비공개', { exact: true }).first().waitFor();
    await page.getByRole('group', { name: '미리보기 기준' }).getByRole('button', { name: '게시본', exact: true }).click();
    assert.equal(await page.getByRole('group', { name: '미리보기 기준' }).getByRole('button', { name: '게시본', exact: true }).getAttribute('aria-pressed'), 'true', 'the published preview is selected');
    await page.getByText(/기획 단계.*참가자.*공개되지/).first().waitFor();
    await page.screenshot({ path: path.join(out, 'draft-published-1280.png'), fullPage: true });
    assert.equal((await attendee.goto(draftEventUrl, { waitUntil: 'networkidle' })).status(), 404, 'saving page settings does not expose the event');
    const transition = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${draftId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie, body: { commandId: crypto.randomUUID(), command: 'event.stage', payload: { stage: 'READY' } },
    });
    assert.equal(transition.status, 200);
    assert.equal((await attendee.goto(draftEventUrl, { waitUntil: 'networkidle' })).status(), 200, 'operational readiness exposes the event');
    await attendee.getByText('합성 기획 행사 안내', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('page visibility: review matches event fact, program, notice, venue, home and ticket scopes');
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(String(error.stack || error).replace(/https?:\/\/[^\s]+/g, '[url]')); process.exitCode = 1; });
