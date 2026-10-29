'use strict';

// Event-card product audit: the approved white directory row (flat white
// zone + 8px published-color identity dot), published-only theme link, and
// in-dialog duplication against a real production build with an isolated
// API/PostgreSQL fixture. Nothing here touches a deployed, review, or shared
// database: all writes land in the harness's dropped schema.
//
// The retired A2 full-header tint is NOT the authority here: the 2026-10-27
// approved white contract (DESIGN.md "화이트 업무용 SaaS", Cards/Tiles/Rows;
// console-home.module.css identity dot) keeps every row zone flat white and
// represents the published participant-home background only in the dot.
// The customer published attendee home itself is untouched by this audit.
// Captures honor EVENTOUCH_CAPTURE_ROOT when set, else
// /tmp/eventouch-private-<uid>/eventouch-captures/event-card-a2/. (per-run leaf; fresh per run).
//
// Run after `npm run build` with an isolated database, e.g.
//   EVENTOUCH_TEST_DATABASE_URL='postgres://...' npm run web:cards:audit
// Chromium: root Playwright + CHROMIUM_EXECUTABLE when set (audit-browser).
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, ensureCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const OUT = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'event-card-a2', 'after')
  : path.join(defaultCaptureDir(`event-card-a2-${runStamp()}`), 'after');

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
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const buildId = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
  assert.ok(buildId, 'event-card-a2 audit requires a production Next build');
  // Historical baseline pointer: the A2 mock below is the RETIRED design
  // reference, not the current authority. The current authority is the
  // approved white row (DESIGN.md "화이트 업무용 SaaS"; Cards/Tiles/Rows;
  // console-home.module.css identity dot). No fake product "before" render
  // is manufactured here; the new renders under OUT are the evidence.
  ensureCaptureDir(path.join(OUT, '..', 'before'));
  fs.writeFileSync(
    path.join(OUT, '..', 'before', 'source.json'),
    JSON.stringify({
      note: 'RETIRED A2 reference (historical only). Current authority is the approved white row: flat white zone + 8px identity dot carrying the published color; see DESIGN.md Cards/Tiles/Rows and console-home.module.css.',
      retiredMock: '/tmp/opencode/eventouch-captures/event-card-abc/visual.html?view=A2',
      retiredCaptures: [
        '/tmp/opencode/eventouch-captures/event-card-a-visual/a2-1139.png',
        '/tmp/opencode/eventouch-captures/event-card-a-visual/a2-390.png',
        '/tmp/opencode/eventouch-captures/event-card-a-visual/compare1440.png',
      ],
    }, null, 2), { mode: 0o600, flag: 'wx' },
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
    // A real near-term event is needed to test the highlighted date voice;
    // the other published/draft fixtures remain useful even on a future date.
    const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const today = localDate(new Date());
    const seed = [
      // [idSuffix, name, date, stage, pageFlow]
      ['navy', '남색 게시 행사', '2027-02-10', 'READY', { save: '#17252B', publish: true }],
      ['white', '흰색 게시 행사', '2027-02-11', 'LIVE', { save: '#FFFFFF', publish: true }],
      ['brand', '주황 게시 행사', '2027-02-12', 'DRAFT', { save: '#E76D26', publish: true }],
      ['draftonly', '초안만 있는 행사', '2027-02-13', 'DRAFT', { save: '#E76D26', publish: false }],
      ['undated', longName, '', 'DRAFT', null],
      ['today', '오늘 진행 검증 행사', today, 'READY', { save: '#17252B', publish: true }],
    ];
    for (const [suffix, name, date, stage, flow] of seed) {
      const id = `cards-${suffix}-${f.suffix}`;
      await f.helpers.insertEvent(f.harness.database, {
        orgId: f.helpers.LEGACY_ORG,
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
    // White-row paint: the zone itself is always flat white; the published
    // participant-home background tints only the 8px identity dot rendered
    // on the card name (::before). The date is muted by default, and today or
    // tomorrow uses brand text independently of the published customer color.
    const readCard = async (card) => {
      const zone = zoneOf(card);
      const bg = parseRgb(await zone.evaluate((el) => getComputedStyle(el).backgroundColor));
      const dot = parseRgb(await card.locator('h3').first().evaluate((el) => getComputedStyle(el, '::before').backgroundColor));
      const date = zone.locator('p').first();
      const ink = parseRgb(await date.evaluate((el) => getComputedStyle(el).color));
      const soon = await date.getAttribute('data-soon') === 'true';
      return { bg, dot, ink, soon, ratio: contrast(ink, bg) };
    };
    const cardByName = (name) => page.locator('article', { has: page.getByRole('heading', { name, exact: true }) }).first();

    // Approved white-row paint tokens (computed rgb triplets).
    const FLAT_WHITE = '255,255,255'; // var(--paper): every row zone
    const NAVY_DOT = '220,222,223'; // 15% tint of published #17252B over white
    const BRAND_DOT = '251,233,222'; // 15% tint of published #E76D26 over white
    const REPUBLISHED_DOT = '221,235,228'; // 15% tint of published #1A7A4C over white
    const SOFT_DOT = '255,243,235'; // var(--soft): unpublished fallback dot
    const MUTED_INK = '98,107,120'; // quiet date ink (var(--muted))
    const BRAND_INK = '170,58,16'; // today/tomorrow (var(--brand-text))
    const expectedDateInk = (card) => card.soon ? BRAND_INK : MUTED_INK;

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
      await page.locator('#console-event-directory').waitFor();
      check(`console directory ready at ${width}px`, true);
      await page.screenshot({ path: path.join(OUT, `console-initial-${width}.png`), fullPage: true });

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

      // -- White-row structure: one entry link, zone + body ------------------
      const sample = cardByName('남색 게시 행사');
      const entry = sample.locator('a:has([class*="eventCardZone"])');
      check('whole card is one named entry link', (await entry.count()) === 1);
      check('entry name carries the event identity into the home', ((await entry.first().getAttribute('aria-label')) || (await entry.first().innerText()) || '').includes('남색 게시 행사'));
      check('zone holds title and grouped date·time', ((await zoneOf(sample).innerText()) || '').includes('2027.02.10 · 09:00–17:00'));
      const bodyText = (await sample.innerText()) || '';
      check('body holds client/venue fallback', bodyText.includes('고객사·장소 미지정'));
      check('no nested controls inside the entry link', (await entry.locator('a,button').count()) === 0);

      // -- White row: flat white zone, identity dot, published-only color ----
      // Every zone stays flat white. A published participant-home background
      // paints only the identity dot; unpublished rows keep the soft dot.
      // Date contrast is measured against the actual white zone behind the
      // text, including the independent near-term emphasis.
      const navy = await readCard(cardByName('남색 게시 행사'));
      check('row zone stays flat white on a published card', navy.bg.join(',') === FLAT_WHITE, navy.bg.join(','));
      check('published navy paints the identity dot', navy.dot.join(',') === NAVY_DOT, navy.dot.join(','));
      check('navy date text follows the date urgency, not customer color', navy.ink.join(',') === expectedDateInk(navy), navy.ink.join(','));
      check('navy date text meets 4.5:1 on the white row', navy.ratio >= 4.5, navy.ratio.toFixed(2));
      const white = await readCard(cardByName('흰색 게시 행사'));
      check('published white keeps the white row', white.bg.join(',') === FLAT_WHITE, white.bg.join(','));
      check('published white dot stays white (bordered, never soft)', white.dot.join(',') === FLAT_WHITE, white.dot.join(','));
      check('white date text follows the date urgency, not customer color', white.ink.join(',') === expectedDateInk(white), white.ink.join(','));
      check('white date text meets 4.5:1 on the white row', white.ratio >= 4.5, white.ratio.toFixed(2));
      const brand = await readCard(cardByName('주황 게시 행사'));
      check('row zone stays flat white on a brand card', brand.bg.join(',') === FLAT_WHITE, brand.bg.join(','));
      check('published brand orange tints the identity dot pale', brand.dot.join(',') === BRAND_DOT, brand.dot.join(','));
      check('brand date text follows the date urgency, not customer color', brand.ink.join(',') === expectedDateInk(brand), brand.ink.join(','));
      check('brand date text meets 4.5:1 on the white row', brand.ratio >= 4.5, brand.ratio.toFixed(2));
      const draftOnly = await readCard(cardByName('초안만 있는 행사'));
      check('draft-only row zone stays flat white', draftOnly.bg.join(',') === FLAT_WHITE, draftOnly.bg.join(','));
      check('draft-only dot falls back to the soft token', draftOnly.dot.join(',') === SOFT_DOT, draftOnly.dot.join(','));
      check('draft-only date follows the same urgency rule', draftOnly.ink.join(',') === expectedDateInk(draftOnly), draftOnly.ink.join(','));
      check('draft-only date meets 4.5:1 on the white row', draftOnly.ratio >= 4.5, draftOnly.ratio.toFixed(2));
      const todayCard = await readCard(cardByName('오늘 진행 검증 행사'));
      check('today date is explicitly marked near-term', todayCard.soon);
      check('today date uses the brand-text emphasis', todayCard.ink.join(',') === BRAND_INK, todayCard.ink.join(','));
      check('today date meets 4.5:1 on the white row', todayCard.ratio >= 4.5, todayCard.ratio.toFixed(2));
      const undatedInk = await readCard(cardByName(longName));
      check('an unknown date remains quiet', !undatedInk.soon && undatedInk.ink.join(',') === MUTED_INK, undatedInk.ink.join(','));
      check('unknown date meets 4.5:1 on the white row', undatedInk.ratio >= 4.5, undatedInk.ratio.toFixed(2));

      // -- Status badges keep semantic colors on the flat white row -----------
      // LIVE keeps the success-soft surface (tokens.css --success-soft).
      const liveBadge = cardByName('흰색 게시 행사').locator('.stage-badge').first();
      check('LIVE badge keeps the success surface on a published card',
        (await liveBadge.evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(228, 239, 231)');

      // -- Long names wrap; unknown dates stay explicit ------------------------
      const undated = page.locator('article', { has: page.getByRole('heading', { name: longName.slice(0, 20) }) }).first();
      check('long undated event renders', (await undated.count()) === 1);
      check('unknown date reads 일정 미정, never blank', ((await zoneOf(undated).innerText()) || '').includes('일정 미정'));
      const undatedCard = await readCard(undated);
      check('never-published row keeps the flat white zone', undatedCard.bg.join(',') === FLAT_WHITE, undatedCard.bg.join(','));
      check('never-published dot falls back to soft', undatedCard.dot.join(',') === SOFT_DOT, undatedCard.dot.join(','));
      check(`no horizontal overflow at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

      await page.screenshot({ path: path.join(OUT, `console-${width}.png`), fullPage: true });
    }

    // -- Calendar reuses the same white row ----------------------------------
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${f.baseUrl}/console?view=calendar&month=2027-02`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    await page.getByRole('button', { name: /2월 10일/ }).first().click();
    const calCard = cardByName('남색 게시 행사');
    check('calendar reuses the white row card', (await calCard.count()) === 1);
    const calCardRead = await readCard(calCard);
    check('calendar card zone stays flat white', calCardRead.bg.join(',') === FLAT_WHITE, calCardRead.bg.join(','));
    check('calendar card carries the published dot', calCardRead.dot.join(',') === NAVY_DOT, calCardRead.dot.join(','));
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

    // -- Remount after publish: the dot follows the published color -----------
    // A draft save must not move the published dot; only a publish does —
    // the same published-only/no-draft-leak contract on the white row.
    const navyId = `cards-navy-${f.suffix}`;
    await savePage(navyId, '#1A7A4C');
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    const beforePublish = await readCard(cardByName('남색 게시 행사'));
    check('unsaved draft never moves the published dot', beforePublish.dot.join(',') === NAVY_DOT, beforePublish.dot.join(','));
    check('unsaved draft keeps the flat white zone', beforePublish.bg.join(',') === FLAT_WHITE, beforePublish.bg.join(','));
    await publishPage(navyId);
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    const afterPublish = await readCard(cardByName('남색 게시 행사'));
    check('dot follows the published color after remount', afterPublish.dot.join(',') === REPUBLISHED_DOT, afterPublish.dot.join(','));
    check('zone stays flat white after republish', afterPublish.bg.join(',') === FLAT_WHITE, afterPublish.bg.join(','));
    check('republished date still follows date urgency', afterPublish.ink.join(',') === expectedDateInk(afterPublish), afterPublish.ink.join(','));
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

    // -- Sticky chrome: exit + form stay discoverable at 4 viewports --------
    // Opt-in sticky header (닫기) + footer keep the exit visible on the long
    // event/duplicate form without covering fields, errors or keyboard focus.
    // Short heights never show the whole form; they must keep header+footer
    // visible with the rest reachable by scroll. No submit here creates an
    // event: the error path is the local copy-without-source guard, and the
    // customer subview is opened and returned without saving.
    async function stickyHitOk(locator) {
      const box = await locator.boundingBox();
      if (!box) return { ok: false, reason: 'no-box', box: null };
      const vp = page.viewportSize();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) {
        return { ok: false, reason: 'outside-viewport', box };
      }
      const hit = await locator.evaluate((el, pt) => {
        const found = document.elementFromPoint(pt.x, pt.y);
        return found === el || (found instanceof Node && el.contains(found));
      }, { x: cx, y: cy });
      return { ok: hit === true, reason: hit === true ? null : 'covered-by-chrome', box };
    }
    async function expectStickyVisible(name, locator, minHeight = 44) {
      check(`${name} is visible`, await locator.isVisible());
      const box = await locator.boundingBox();
      check(`${name} keeps a 44px target`, Boolean(box) && box.height >= minHeight, JSON.stringify(box));
      const hit = await stickyHitOk(locator);
      check(`${name} is hit-testable at its center (not covered)`, hit.ok, JSON.stringify({ reason: hit.reason, box: hit.box }));
    }
    // A Korean word must keep its syllables on one visual line: exactly one
    // Range rect means no mid-word break (하이/픈, 바/로). Zero or 2+ rects
    // fail so a missing word can never pass as intact.
    async function wordRects(containerLocator, word) {
      return await containerLocator.evaluate((el, w) => {
        const text = el.innerText ?? el.textContent ?? '';
        const idx = text.indexOf(w);
        if (idx < 0) return { found: false, rects: -1 };
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let offset = 0;
        let startNode = null;
        let startOff = 0;
        let endNode = null;
        let endOff = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const len = node.textContent.length;
          if (startNode === null && offset + len > idx) { startNode = node; startOff = idx - offset; }
          if (startNode !== null && offset + len >= idx + w.length) { endNode = node; endOff = idx + w.length - offset; break; }
          offset += len;
        }
        if (!startNode || !endNode) return { found: false, rects: -1 };
        const range = document.createRange();
        try {
          range.setStart(startNode, startOff);
          range.setEnd(endNode, endOff);
        } catch {
          return { found: false, rects: -1 };
        }
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
        return { found: true, rects: rects.length };
      }, word);
    }
    const stickyViewports = [
      { width: 1280, height: 900 },
      { width: 1280, height: 600 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ];
    for (const vp of stickyViewports) {
      const tag = `${vp.width}x${vp.height}`;
      await page.setViewportSize(vp);
      await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
      await page.locator('#console-event-directory').waitFor();
      check(`no horizontal overflow at ${tag} before dialog`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await page.getByRole('button', { name: '새 행사 만들기' }).click();
      const stickyDialog = page.getByRole('dialog');
      await stickyDialog.waitFor({ state: 'visible' });
      const headerClose = stickyDialog.getByRole('button', { name: '닫기', exact: true });
      const footerCancel = stickyDialog.getByRole('button', { name: '취소', exact: true });
      const footerSubmit = stickyDialog.getByRole('button', { name: '행사 만들기', exact: true });
      // First view: exit + actions visible without scrolling.
      await expectStickyVisible(`header close at ${tag}`, headerClose);
      await expectStickyVisible(`footer cancel at ${tag}`, footerCancel);
      await expectStickyVisible(`footer submit at ${tag}`, footerSubmit);
      check(`no horizontal overflow with dialog at ${tag}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await page.screenshot({ path: path.join(OUT, `dialog-sticky-new-${tag}.png`) });
      if (tag === '320x568') {
        const addrHint = stickyDialog.getByText(/참가자 주소에 쓰입니다/);
        check('address hint keeps keep-all wrapping at 320',
          (await addrHint.evaluate((el) => getComputedStyle(el).wordBreak)) === 'keep-all'
          && (await addrHint.evaluate((el) => getComputedStyle(el).overflowWrap)) === 'break-word');
        const hyphen = await wordRects(addrHint, '하이픈');
        check('하이픈 stays on one line at 320', hyphen.found === true && hyphen.rects === 1, JSON.stringify(hyphen));
      }
      // Last field stays reachable by scroll and is not covered by the footer.
      const lastField = stickyDialog.locator('#create-format');
      await lastField.scrollIntoViewIfNeeded();
      await expectStickyVisible(`last field reachable at ${tag}`, lastField);
      await expectStickyVisible(`footer still hit-testable after scroll at ${tag}`, footerSubmit);
      await page.screenshot({ path: path.join(OUT, `dialog-sticky-new-scrolled-${tag}.png`) });
      if (vp.width <= 480) {
        const eventFooterBox = await stickyDialog.locator('.dialog-actions').boundingBox();
        check(`narrow event footer does not over-occupy at ${tag}`,
          Boolean(eventFooterBox) && eventFooterBox.height <= 120, JSON.stringify(eventFooterBox));
        const cancelBox = await footerCancel.boundingBox();
        const submitBox = await footerSubmit.boundingBox();
        check(`narrow event actions share one row at ${tag}`,
          Boolean(cancelBox) && Boolean(submitBox)
          && Math.abs((cancelBox.y + cancelBox.height / 2) - (submitBox.y + submitBox.height / 2)) < Math.min(cancelBox.height, submitBox.height),
          JSON.stringify({ cancelBox, submitBox }));
        const eventShare = eventFooterBox && cancelBox && submitBox
          ? (cancelBox.width + submitBox.width) / eventFooterBox.width
          : 0;
        check(`narrow event actions use the footer width at ${tag}`, eventShare >= 0.7, JSON.stringify({ eventShare, eventFooterBox, cancelBox, submitBox }));
        check(`narrow event buttons keep usable widths at ${tag}`,
          Boolean(cancelBox) && Boolean(submitBox) && cancelBox.width >= 90 && submitBox.width >= 90,
          JSON.stringify({ cancelBox, submitBox }));
        check(`narrow event button text renders without clipping at ${tag}`,
          await footerCancel.evaluate((el) => el.scrollWidth <= el.clientWidth + 2 && el.scrollHeight <= el.clientHeight + 2)
          && await footerSubmit.evaluate((el) => el.scrollWidth <= el.clientWidth + 2 && el.scrollHeight <= el.clientHeight + 2));
        check(`narrow event buttons stay height-balanced at ${tag}`,
          Boolean(cancelBox) && Boolean(submitBox) && Math.abs(cancelBox.height - submitBox.height) <= 16,
          JSON.stringify({ cancelBox, submitBox }));
      }
      // Local error (copy without source) stays visible, uncovered, focused.
      // Browser native required validation blocks submit while name/date are
      // empty, so fill valid required values through the real UI first; the
      // copy guard is a definitive local error that must win after that.
      await stickyDialog.getByText('기존 행사 복제', { exact: false }).click();
      await stickyDialog.locator('#create-source').waitFor({ state: 'visible' });
      check('copy mode names itself before a source is chosen',
        ((await stickyDialog.getByRole('heading', { name: '행사 복제' }).count()) === 1)
        && ((await stickyDialog.getByRole('button', { name: '행사 복제', exact: true }).count()) === 1));
      await stickyDialog.locator('#create-name').fill(`복제 검증 ${tag}`);
      await stickyDialog.locator('#create-date').fill('2027-02-10');
      await stickyDialog.getByRole('button', { name: '행사 복제', exact: true }).click();
      const sourceError = stickyDialog.getByText('복제할 원본 행사를 선택하세요');
      await sourceError.waitFor({ state: 'visible' });
      await sourceError.scrollIntoViewIfNeeded();
      await expectStickyVisible(`copy-without-source error at ${tag}`, sourceError, 16);
      check(`copy-without-source focuses the source at ${tag}`, await stickyDialog.locator('#create-source').evaluate((el) => document.activeElement === el));
      await page.screenshot({ path: path.join(OUT, `dialog-sticky-copy-error-${tag}.png`) });
      // The filled name/date above make this dialog dirty, so Escape must ask
      // explicitly; accept to leave a clean state for the next reopen.
      {
        const acceptCopyErrorClose = page.waitForEvent('dialog').then(async (d) => {
          check(`dirty copy-error Escape asks at ${tag}`, (d.message() || '').includes('저장하지 않고 닫을까요'), d.message());
          await d.accept();
        });
        await page.keyboard.press('Escape');
        await acceptCopyErrorClose.catch(() => {});
      }
      await stickyDialog.waitFor({ state: 'detached' });
      // Reopen pristine for the customer subview.
      await page.getByRole('button', { name: '새 행사 만들기' }).click();
      const freshDialog = page.getByRole('dialog');
      await freshDialog.waitFor({ state: 'visible' });
      await freshDialog.locator('#create-client').waitFor({ state: 'visible' });
      await freshDialog.getByRole('button', { name: '새 고객사 등록' }).click();
      await freshDialog.locator('#create-new-client-name').waitFor({ state: 'visible' });
      const clientBack = freshDialog.getByRole('button', { name: '행사 입력으로 돌아가기' });
      const clientSubmit = freshDialog.getByRole('button', { name: '고객사 등록' });
      const freshHeaderClose = freshDialog.getByRole('button', { name: '닫기', exact: true });
      await expectStickyVisible(`client subview header close at ${tag}`, freshHeaderClose);
      await expectStickyVisible(`client subview back at ${tag}`, clientBack);
      await expectStickyVisible(`client subview submit at ${tag}`, clientSubmit);
      check(`client subview focuses its first field at ${tag}`, await freshDialog.locator('#create-new-client-name').evaluate((el) => document.activeElement === el));
      check(`client subview titles the actual task at ${tag}`,
        (await freshDialog.getByRole('heading', { name: '새 고객사 등록' }).count()) === 1);
      const clientDescription = freshDialog.locator('#create-event-title-description');
      await clientDescription.scrollIntoViewIfNeeded();
      await expectStickyVisible(`client subview description stays readable at ${tag}`, clientDescription, 16);
      await expectStickyVisible(`client subview first field stays reachable at ${tag}`, freshDialog.locator('#create-new-client-name'));
      if (tag === '320x568') {
        const clientDescriptionText = freshDialog.locator('#create-event-title-description span');
        check('customer description keeps keep-all wrapping at 320',
          (await clientDescriptionText.evaluate((el) => getComputedStyle(el).wordBreak)) === 'keep-all'
          && (await clientDescriptionText.evaluate((el) => getComputedStyle(el).overflowWrap)) === 'break-word');
        for (const word of ['바로', '그대로']) {
          const hit = await wordRects(clientDescription, word);
          check(`${word} stays on one line at 320`, hit.found === true && hit.rects === 1, JSON.stringify(hit));
        }
      }
      if (vp.width <= 480) {
        const narrowFooter = freshDialog.locator('.dialog-actions');
        const narrowFooterBox = await narrowFooter.boundingBox();
        check(`narrow client footer does not over-occupy at ${tag}`,
          Boolean(narrowFooterBox) && narrowFooterBox.height <= 120, JSON.stringify(narrowFooterBox));
        const backBox = await clientBack.boundingBox();
        const submitBox = await clientSubmit.boundingBox();
        check(`narrow client actions share one row at ${tag}`,
          Boolean(backBox) && Boolean(submitBox)
          && Math.abs((backBox.y + backBox.height / 2) - (submitBox.y + submitBox.height / 2)) < Math.min(backBox.height, submitBox.height),
          JSON.stringify({ backBox, submitBox }));
        const clientShare = narrowFooterBox && backBox && submitBox
          ? (backBox.width + submitBox.width) / narrowFooterBox.width
          : 0;
        check(`narrow client actions use the footer width at ${tag}`, clientShare >= 0.7, JSON.stringify({ clientShare, narrowFooterBox, backBox, submitBox }));
        check(`narrow client button text renders without clipping at ${tag}`,
          await clientBack.evaluate((el) => el.scrollWidth <= el.clientWidth + 2 && el.scrollHeight <= el.clientHeight + 2)
          && await clientSubmit.evaluate((el) => el.scrollWidth <= el.clientWidth + 2 && el.scrollHeight <= el.clientHeight + 2));
      }
      await page.screenshot({ path: path.join(OUT, `dialog-sticky-client-${tag}.png`) });
      // Tab wraps inside the single trap; Shift+Tab wraps back.
      await clientSubmit.focus();
      await page.keyboard.press('Tab');
      check(`Tab from client submit wraps to header close at ${tag}`,
        await freshHeaderClose.evaluate((el) => document.activeElement === el));
      await freshHeaderClose.focus();
      await page.keyboard.press('Shift+Tab');
      check(`Shift+Tab from header close wraps to client submit at ${tag}`,
        await clientSubmit.evaluate((el) => document.activeElement === el));
      // Pristine subview Escape closes and returns focus to the create entry.
      // (Dirty/in-flight confirms stay covered by the existing mode/receipt guards.)
      await clientBack.click();
      await freshDialog.locator('#create-name').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await freshDialog.waitFor({ state: 'detached' });
      check(`pristine dialog Escape returns focus at ${tag}`,
        (await page.evaluate(() => document.activeElement && document.activeElement.textContent)) === '새 행사 만들기');
    }
    // One dirty header-close guard (representative 1280x900, not every size):
    // a typed draft must ask before the header close discards it.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
    await page.locator('#console-event-directory').waitFor();
    await page.getByRole('button', { name: '새 행사 만들기' }).click();
    const dirtyDialog = page.getByRole('dialog');
    await dirtyDialog.waitFor({ state: 'visible' });
    await dirtyDialog.locator('#create-name').fill('헤더 닫기 확인용 초안');
    let dirtyConfirm = null;
    page.once('dialog', async (d) => { dirtyConfirm = d.message(); await d.dismiss(); });
    await dirtyDialog.getByRole('button', { name: '닫기', exact: true }).click();
    check('dirty header close asks first', dirtyConfirm && dirtyConfirm.includes('저장하지 않고 닫을까요'), dirtyConfirm);
    check('dismissed header close keeps the dialog mounted', (await dirtyDialog.count()) === 1);
    check('dismissed header close keeps the typed draft', (await dirtyDialog.locator('#create-name').inputValue()) === '헤더 닫기 확인용 초안');
    // Escape on the same dirty draft asks again; accept to leave a clean state.
    const acceptDirty = page.waitForEvent('dialog').then(async (d) => { await d.accept(); });
    await page.keyboard.press('Escape');
    await acceptDirty.catch(() => {});
    await dirtyDialog.waitFor({ state: 'detached' }).catch(() => {});

    check('no page errors through the audit', pageerrors.length === 0, pageerrors.slice(0, 3).join(' | '));
    const result = { ok: true, buildId, verdicts, captures: fs.readdirSync(OUT).filter((name) => name !== 'tmp') };
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
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
