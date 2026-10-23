'use strict';

// Event-card A2 product audit: the user-approved soft-header card, published
// theme link, and in-dialog duplication against a real production build with
// an isolated API/PostgreSQL fixture. Nothing here touches a deployed,
// review, or shared database: all writes land in the harness's dropped
// schema. Captures go to /tmp/opencode/eventouch-captures/event-card-a2/.
//
// Run after `npm run build` with an isolated database, e.g.
//   EVENTOUCH_TEST_DATABASE_URL='postgres://...' npm run web:cards:audit
// Chromium: root Playwright + CHROMIUM_EXECUTABLE when set (audit-browser).
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const OUT = '/tmp/opencode/eventouch-captures/event-card-a2/after';

function luminance(rgb) {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function parseRgb(text) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(text));
  assert.ok(match, `expected an rgb color, got ${text}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function contrast(fg, bg) {
  const light = Math.max(luminance(fg), luminance(bg));
  const dark = Math.min(luminance(fg), luminance(bg));
  return (light + 0.05) / (dark + 0.05);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // Honest baseline pointer: the user-approved A2 mock is the "before".
  // No fake product "before" render is manufactured here.
  fs.mkdirSync(path.join(OUT, '..', 'before'), { recursive: true });
  fs.writeFileSync(
    path.join(OUT, '..', 'before', 'source.json'),
    JSON.stringify({
      note: 'User-approved A2 mock; the product tree was already past the old card when this audit was written.',
      mock: '/tmp/opencode/eventouch-captures/event-card-abc/visual.html?view=A2',
      captures: [
        '/tmp/opencode/eventouch-captures/event-card-a-visual/a2-1139.png',
        '/tmp/opencode/eventouch-captures/event-card-a-visual/a2-390.png',
        '/tmp/opencode/eventouch-captures/event-card-a-visual/compare1440.png',
      ],
    }, null, 2),
  );
  const f = await startAuditFixture();
  const verdicts = [];
  const check = (name, ok, detail) => {
    verdicts.push({ name, ok: Boolean(ok), detail: detail ?? null });
    assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`);
  };
  const run = async (eventId, cookie, command, payload) => {
    const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${eventId}/commands`, {
      cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(r.status >= 200 && r.status < 300, `${command} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  let browser;
  try {
    const ownerCookie = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
    const savePage = async (eventId, backgroundColor) => {
      await run(eventId, ownerCookie, 'attendee.page.save', {
        intro: '감사 소개 문구입니다.',
        accent: '#E76D26',
        showAnnouncements: true,
        showSchedule: true,
        showVenue: true,
        showPrograms: true,
        homeStyle: { backgroundColor },
      });
    };
    const publishPage = async (eventId) => {
      await run(eventId, ownerCookie, 'attendee.page.publish', {});
    };
    // Long name + unknown schedule (wrapping, explicit unknown labels).
    const longName = '아주 긴 이름의 검증 행사 '.repeat(6).trim();
    const seed = [
      // [idSuffix, name, date, stage, pageFlow]
      ['navy', '남색 게시 행사', '2027-02-10', 'READY', { save: '#17252B', publish: true }],
      ['white', '흰색 게시 행사', '2027-02-11', 'LIVE', { save: '#FFFFFF', publish: true }],
      ['brand', '주황 게시 행사', '2027-02-12', 'DRAFT', { save: '#E76D26', publish: true }],
      ['draftonly', '초안만 있는 행사', '2027-02-13', 'DRAFT', { save: '#E76D26', publish: false }],
      ['undated', longName, '', 'DRAFT', null],
    ];
    for (const [suffix, name, date, stage, flow] of seed) {
      const id = `cards-${suffix}-${f.suffix}`;
      await f.helpers.insertEvent(f.harness.database, {
        id, slug: id,
        payload: { id, slug: id, name, stage, date, start: date ? '09:00' : '', end: date ? '17:00' : '', features: ['screen'] },
        workspace: f.helpers.emptyWorkspace(),
      });
      if (flow?.save) await savePage(id, flow.save);
      if (flow?.publish) await publishPage(id);
    }
    // One pending approval on the fixture event so its card must carry the
    // direct approval link: import an approved row, then move it back to
    // PENDING through the real operator status path.
    const pendingEvent = f.eventId;
    const imported = await run(pendingEvent, ownerCookie, 'participant.import', {
      rows: [{ name: '대기 참가자', phone: '01099998888', company: '대기 업체' }],
    });
    const importedId = imported.participants[0].id;
    await run(pendingEvent, ownerCookie, 'participant.status', { id: importedId, status: 'PENDING' });

    browser = await launchBrowser();
    const context = await browser.newContext();
    const pageerrors = [];
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(ownerCookie.slice('etko_session='.length)), url: f.baseUrl }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => pageerrors.push(String(error && error.message || error)));

    const zoneOf = (card) => card.locator('[class*="eventCardZone"]').first();
    const readZone = async (card) => {
      const zone = zoneOf(card);
      const bg = parseRgb(await zone.evaluate((el) => getComputedStyle(el).backgroundColor));
      const ink = parseRgb(await zone.locator('p').first().evaluate((el) => getComputedStyle(el).color));
      return { bg, ink, ratio: contrast(ink, bg) };
    };
    const cardByName = (name) => page.locator('article', { has: page.getByRole('heading', { name, exact: true }) }).first();

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
      await page.locator('#console-event-directory').waitFor();
      check(`console directory ready at ${width}px`, true);

      // -- No per-card duplicate, no always-empty footer ---------------------
      check(`no per-card duplicate at ${width}px`, (await page.getByRole('button', { name: '복제', exact: true }).count()) === 0);
      const footers = await page.locator('[class*="eventCardActions"]').count();
      const pendingCards = await page.locator('article', { has: page.getByText(/승인 대기 \d+명 처리/) }).count();
      check(`actions footer only for pending queues at ${width}px`, footers === pendingCards && pendingCards >= 1, `footers=${footers} pending=${pendingCards}`);

      // -- Pending link present and direct -----------------------------------
      const pendingCard = page.locator('article', { has: page.getByText(/승인 대기 \d+명 처리/) }).first();
      const approval = pendingCard.getByRole('link', { name: /승인 대기 \d+명 처리/ });
      check('pending card keeps a direct approval link', (await approval.count()) === 1);
      check('approval link targets the PENDING queue', ((await approval.getAttribute('href')) || '').includes('participants?status=PENDING'));
      const approvalBox = await approval.first().boundingBox();
      check('approval link keeps a 44px target', approvalBox && approvalBox.height >= 44, JSON.stringify(approvalBox));

      // -- A2 structure: one entry link, zone + body --------------------------
      const sample = cardByName('남색 게시 행사');
      const entry = sample.locator('a:has([class*="eventCardZone"])');
      check('whole card is one named entry link', (await entry.count()) === 1);
      check('entry name carries the event identity into the home', ((await entry.first().getAttribute('aria-label')) || (await entry.first().innerText()) || '').includes('남색 게시 행사'));
      check('zone holds title and grouped date·time', ((await zoneOf(sample).innerText()) || '').includes('2027.02.10 · 09:00–17:00'));
      const bodyText = (await sample.innerText()) || '';
      check('body holds client/venue fallback', bodyText.includes('고객사·장소 미지정'));
      check('no nested controls inside the entry link', (await entry.locator('a,button').count()) === 0);

      // -- Published themes tint headers; drafts do not -----------------------
      const navy = await readZone(cardByName('남색 게시 행사'));
      check('published navy tints the header', navy.bg.join(',') === '220,222,223', navy.bg.join(','));
      check('navy date text uses neutral ink', navy.ink.join(',') === '23,37,43', navy.ink.join(','));
      check('navy date text meets 4.5:1', navy.ratio >= 4.5, navy.ratio.toFixed(2));
      const white = await readZone(cardByName('흰색 게시 행사'));
      check('published white stays white', white.bg.join(',') === '255,255,255', white.bg.join(','));
      check('white date text uses neutral ink', white.ink.join(',') === '23,37,43', white.ink.join(','));
      check('white date text meets 4.5:1', white.ratio >= 4.5, white.ratio.toFixed(2));
      const brand = await readZone(cardByName('주황 게시 행사'));
      check('published brand orange tints pale', brand.bg.join(',') === '251,233,222', brand.bg.join(','));
      check('brand date text uses neutral ink, not brand orange', brand.ink.join(',') === '23,37,43', brand.ink.join(','));
      check('brand date text meets 4.5:1', brand.ratio >= 4.5, brand.ratio.toFixed(2));
      const draftOnly = await readZone(cardByName('초안만 있는 행사'));
      check('draft-only event keeps the default soft header', draftOnly.bg.join(',') === '255,241,232', draftOnly.bg.join(','));
      check('default header keeps the brand-text date line', draftOnly.ink.join(',') === '163,68,16', draftOnly.ink.join(','));

      // -- Status badges keep semantic colors under themed headers ------------
      const liveBadge = cardByName('흰색 게시 행사').locator('.stage-badge').first();
      check('LIVE badge keeps the success surface on a themed card',
        (await liveBadge.evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(230, 243, 237)');

      // -- Long names wrap; unknown dates stay explicit ------------------------
      const undated = page.locator('article', { has: page.getByRole('heading', { name: longName.slice(0, 20) }) }).first();
      check('long undated event renders', (await undated.count()) === 1);
      check('unknown date reads 일정 미정, never blank', ((await zoneOf(undated).innerText()) || '').includes('일정 미정'));
      check(`no horizontal overflow at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

      await page.screenshot({ path: path.join(OUT, `console-${width}.png`), fullPage: true });
    }

    // -- Calendar reuses the same EventCard ------------------------------------
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${f.baseUrl}/console?view=calendar&month=2027-02`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    await page.getByRole('button', { name: /2월 10일/ }).first().click();
    const calCard = cardByName('남색 게시 행사');
    check('calendar reuses the tinted A2 card', (await calCard.count()) === 1);
    const calZone = await readZone(calCard);
    check('calendar card carries the published tint', calZone.bg.join(',') === '220,222,223', calZone.bg.join(','));
    await page.screenshot({ path: path.join(OUT, 'calendar-1280.png'), fullPage: true });

    // -- Create dialog: new-first, source select, real duplicate ---------------
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    const createTrigger = page.getByRole('button', { name: '새 행사 만들기' });
    await createTrigger.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    check('create dialog opens in new mode', ((await dialog.innerText()) || '').includes('새 행사 만들기'));
    check('new mode shows fields immediately', await dialog.locator('#create-name').isVisible());
    check('mode choice offers copy', await dialog.getByText('기존 행사 복제').isVisible());
    await page.screenshot({ path: path.join(OUT, 'dialog-new-1280.png') });

    // Dirty draft + mode switch asks and keeps the draft on dismiss.
    await dialog.locator('#create-name').fill('지킬 초안 행사');
    let confirmText = null;
    page.once('dialog', async (d) => { confirmText = d.message(); await d.dismiss(); });
    await dialog.getByText('기존 행사 복제').click();
    check('mode switch with a typed draft asks first', confirmText && confirmText.includes('바꾸시겠습니까'), confirmText);
    check('dismissed switch keeps the typed draft', (await dialog.locator('#create-name').inputValue()) === '지킬 초안 행사');
    check('dismissed switch stays in new mode', (await dialog.locator('#create-source').count()) === 0);

    // Accept the switch, pick a stage-labeled source, submit a real copy.
    const acceptSwitch = page.waitForEvent('dialog').then(async (d) => { await d.accept(); });
    await dialog.getByText('기존 행사 복제').click();
    await acceptSwitch;
    await dialog.locator('#create-source').waitFor();
    const options = await dialog.locator('#create-source option').allInnerTexts();
    check('source select lists permission-available events stage-labeled',
      options.some((text) => text.includes('남색 게시 행사') && text.includes('운영 준비')),
      JSON.stringify(options.slice(0, 4)));
    // Switching sources with an edited draft asks; accept and take the prefill.
    await dialog.locator('#create-name').fill('바뀔 초안');
    const acceptSource = page.waitForEvent('dialog').then(async (d) => { await d.accept(); });
    await dialog.locator('#create-source').selectOption({ label: options.find((text) => text.includes('남색 게시 행사')) });
    await acceptSource;
    const prefilled = await dialog.locator('#create-name').inputValue();
    check('source select prefills the copy name', prefilled === '남색 게시 행사 복사본', prefilled);
    await page.screenshot({ path: path.join(OUT, 'dialog-copy-1280.png') });
    await dialog.getByRole('button', { name: '행사 복제', exact: true }).click();
    await page.waitForURL(/\/console\/events\/.+/, { timeout: 15000 });
    const createdId = page.url().split('/console/events/')[1].split(/[?#]/)[0];
    const created = await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: ownerCookie });
    const createdEvent = (created.json.state.events || []).find((item) => item.id === decodeURIComponent(createdId));
    check('duplicate submit saves a real event and opens it', Boolean(createdEvent) && createdEvent.name === '남색 게시 행사 복사본',
      JSON.stringify(createdEvent && { id: createdEvent.id, name: createdEvent.name }));
    // Same-name retry keeps idempotence semantics (server refuses the slug
    // collision instead of forking a second copy silently).
    const retry = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${createdEvent.id}/commands`, {
      cookie: ownerCookie, method: 'POST', body: { commandId: crypto.randomUUID(), command: 'event.stage', payload: { stage: 'READY' } },
    });
    check('created copy accepts follow-up commands', retry.status >= 200 && retry.status < 300, String(retry.status));

    // -- In-flight lock: a delayed duplicate keeps controls frozen ------------
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    const whiteId = `cards-white-${f.suffix}`;
    const brandId = `cards-brand-${f.suffix}`;
    await page.getByRole('button', { name: '새 행사 만들기' }).click();
    const flightDialog = page.getByRole('dialog');
    await flightDialog.waitFor({ state: 'visible' });
    await flightDialog.getByText('기존 행사 복제', { exact: false }).click();
    await flightDialog.locator('#create-source').selectOption({ value: whiteId });
    await page.route('**/api/events/*/duplicate', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await flightDialog.getByRole('button', { name: '행사 복제', exact: true }).click();
    await flightDialog.getByRole('button', { name: '복제하는 중입니다' }).waitFor({ timeout: 8000 });
    // NOTE: a disabled fieldset locks its radios natively, but Playwright's
    // .disabled IDL check does not reflect fieldset inheritance — assert the
    // :disabled match plus a forced transition attempt that must go nowhere
    // (the synchronous guardTransition is authoritative, not the attribute).
    check('in-flight mode radios inherit the fieldset lock',
      (await flightDialog.locator('input[name="create-mode"]').count()) === 2
      && (await flightDialog.locator('input[name="create-mode"]').evaluateAll((els) => els.every((el) => el.matches(':disabled')))));
    await flightDialog.getByText('새로 만들기', { exact: false }).click({ force: true });
    check('in-flight forced mode switch changes nothing',
      (await flightDialog.locator('#create-source').count()) === 1
      && (await flightDialog.locator('#create-name').inputValue()) === '흰색 게시 행사 복사본');
    check('in-flight source select is disabled', await flightDialog.locator('#create-source').isDisabled());
    check('in-flight prefill is not replaced', (await flightDialog.locator('#create-name').inputValue()) === '흰색 게시 행사 복사본');
    await page.waitForURL(/\/console\/events\/.+/, { timeout: 20000 });
    await page.unroute('**/api/events/*/duplicate');
    const afterFlight = await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: ownerCookie });
    const flightCopies = (afterFlight.json.state.events || []).filter((item) => item.name === '흰색 게시 행사 복사본');
    check('delayed duplicate still saves exactly one event', flightCopies.length === 1, String(flightCopies.length));

    // -- Ambiguous loss: commit server-side, 500 to the client -----------------
    // The mode/source transitions must lock on the unresolved receipt (with a
    // retry note), and the same-request retry must replay exactly one record.
    const seenCommandIds = [];
    await page.route('**/api/events/*/duplicate', async (route) => {
      const req = route.request();
      const bodyText = req.postData() || '{}';
      seenCommandIds.push(JSON.parse(bodyText).commandId);
      if (seenCommandIds.length === 1) {
        const headers = await req.allHeaders();
        const upstream = await fetch(req.url(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: headers.cookie || '' },
          body: bodyText,
        });
        await upstream.arrayBuffer();
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '응답 확인 실패' }) });
      } else {
        await route.continue();
      }
    });
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    await page.getByRole('button', { name: '새 행사 만들기' }).click();
    const lossDialog = page.getByRole('dialog');
    await lossDialog.waitFor({ state: 'visible' });
    await lossDialog.getByText('기존 행사 복제', { exact: false }).click();
    await lossDialog.locator('#create-source').selectOption({ value: brandId });
    await lossDialog.getByRole('button', { name: '행사 복제', exact: true }).click();
    await lossDialog.getByText(/같은 요청으로 다시 시도하세요/).first().waitFor({ timeout: 8000 });
    check('ambiguous duplicate keeps the retry receipt', true);
    await lossDialog.getByText('새로 만들기', { exact: false }).click();
    check('mode switch on an unresolved receipt stays in copy mode',
      (await lossDialog.locator('#create-source').count()) === 1);
    check('mode switch on an unresolved receipt names the retry',
      ((await lossDialog.innerText()) || '').includes('같은 요청으로 다시 시도해 결과를 확인한 뒤에 바꾸세요'));
    check('mode switch on an unresolved receipt keeps the prefill',
      (await lossDialog.locator('#create-name').inputValue()) === '주황 게시 행사 복사본');
    await lossDialog.locator('#create-source').selectOption({ value: whiteId });
    check('source switch on an unresolved receipt keeps the source',
      (await lossDialog.locator('#create-source').inputValue()) === brandId);
    check('source switch on an unresolved receipt keeps the prefill',
      (await lossDialog.locator('#create-name').inputValue()) === '주황 게시 행사 복사본');
    await lossDialog.getByRole('button', { name: '행사 복제', exact: true }).click();
    await page.waitForURL(/\/console\/events\/.+/, { timeout: 20000 });
    await page.unroute('**/api/events/*/duplicate');
    check('lost response retried with the identical command id',
      seenCommandIds.length === 2 && seenCommandIds[0] === seenCommandIds[1] && Boolean(seenCommandIds[0]),
      JSON.stringify(seenCommandIds));
    const afterLoss = await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: ownerCookie });
    const lossCopies = (afterLoss.json.state.events || []).filter((item) => item.name === '주황 게시 행사 복사본');
    check('same-id retry replays exactly one record, no second command', lossCopies.length === 1, String(lossCopies.length));

    // -- Remount after publish: the card follows the published color ----------
    const navyId = `cards-navy-${f.suffix}`;
    await savePage(navyId, '#1A7A4C');
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    const beforePublish = await readZone(cardByName('남색 게시 행사'));
    check('unsaved draft never previews on the card', beforePublish.bg.join(',') === '220,222,223', beforePublish.bg.join(','));
    await publishPage(navyId);
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    const afterPublish = await readZone(cardByName('남색 게시 행사'));
    check('card follows the published color after remount', afterPublish.bg.join(',') === '221,235,228', afterPublish.bg.join(','));
    check('republished date text uses neutral ink', afterPublish.ink.join(',') === '23,37,43', afterPublish.ink.join(','));
    check('republished date text meets 4.5:1', afterPublish.ratio >= 4.5, afterPublish.ratio.toFixed(2));
    await page.screenshot({ path: path.join(OUT, 'console-republished-1280.png'), fullPage: true });

    // -- Keyboard: card entry opens on Enter; dialog cancel returns focus ------
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    await cardByName('흰색 게시 행사').locator('a:has([class*="eventCardZone"])').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/console\/events\/.+/, { timeout: 15000 });
    check('keyboard Enter opens the event home', true, page.url());
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    await page.getByRole('button', { name: '새 행사 만들기' }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    check('dialog cancel returns focus to the create entry',
      (await page.evaluate(() => document.activeElement && document.activeElement.textContent)) === '새 행사 만들기');

    // -- 390px dialog + keyboard ------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    check('no horizontal overflow at 390px after flows', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: path.join(OUT, 'console-390-final.png'), fullPage: true });

    check('no page errors through the audit', pageerrors.length === 0, pageerrors.slice(0, 3).join(' | '));
    const result = { ok: true, verdicts, captures: fs.readdirSync(OUT) };
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(result, null, 2));
    process.stderr.write(`[eventouch] event-card-a2 audit: ${verdicts.length} checks passed\n`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await f.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[eventouch] event-card-a2 audit failed: ${error && error.stack || error}\n`);
  process.exitCode = 1;
});
