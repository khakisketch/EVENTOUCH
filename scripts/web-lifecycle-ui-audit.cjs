'use strict';

// Full lifecycle through the rendered UI: ONE event created in the browser,
// then public setup/publish, participant signup, operator approval, staff
// assignment, check-in, report reflection, ENDED with the intake still open,
// and close+archive — all driven through the real rendered UI against the
// SAME real isolated API/PostgreSQL and the SAME current production Next
// build.
//
// Seeded prerequisites (disclosed, never the subject): an operator
// (AGENCY) + staff (STAFF) account with the isolated-test-only password.
// The subject event, its settings, desk, assignment, approvals, check-ins,
// report, and stage transitions are all created through rendered UI.
// QR reads are software-simulated: the participant-rendered SVG QR is
// rasterized in-browser and decoded with jsQR (project dependency, same
// method as web-hanwool-audit), and the decoded synthetic value is typed
// into the staff form. No physical scanner, no camera. Decoded values are
// compared by sha256 in memory; no raw bearer is ever logged.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID', 'SOLAPI_API_HOST']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
process.env.EVENTOUCH_MAIL_MOCK = '1';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const axe = require('axe-core').source;
const jsQR = require('../apps/web/node_modules/jsqr');
const fixtureLib = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const captureRoot = process.env.EVENTOUCH_CAPTURE_ROOT
  || defaultCaptureDir(`lifecycle-${crypto.randomUUID()}`);
const OUT = path.join(captureRoot, 'journey');

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

async function decodeRenderedTicket(page) {
  const pixels = await page.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ }).locator('svg').evaluate(async (svg) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 360;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 360, 360);
    context.drawImage(image, 24, 24, 312, 312);
    return Array.from(context.getImageData(0, 0, 360, 360).data);
  });
  const decoded = jsQR(Uint8ClampedArray.from(pixels), 360, 360);
  assert.ok(decoded, 'the rendered admission QR must be software-decodable');
  return decoded.data;
}

function maskTicketInput(page) {
  return page.locator('#staff-ticket').evaluate((el) => {
    if (el instanceof HTMLInputElement) el.dataset.fixtureType = el.type;
    if (el instanceof HTMLInputElement) el.setAttribute('type', 'password');
  }).catch(() => {});
}
function unmaskTicketInput(page) {
  return page.locator('#staff-ticket').evaluate((el) => {
    if (el instanceof HTMLInputElement) el.setAttribute('type', el.dataset.fixtureType || 'text');
  }).catch(() => {});
}

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const buildPath = path.join(__dirname, '..', 'apps', 'web', '.next', 'BUILD_ID');
  const buildId = fs.readFileSync(buildPath, 'utf8').trim();
  if (!buildId) throw new Error('lifecycle audit requires a production Next build');

  const dbUrl = fixtureLib.resolveAuditDatabaseUrl();
  if (!dbUrl) throw new Error('set EVENTOUCH_A11Y_DATABASE_URL (or EVENTOUCH_TEST_DATABASE_URL) to the isolated PostgreSQL');
  process.env.EVENTOUCH_TEST_DATABASE_URL = dbUrl;
  const helpers = fixtureLib.loadHelpers();
  const { startWebApiGateway } = require('../tests/helpers/web-api-gateway.cjs');
  const { hashPassword } = helpers;
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const harness = await helpers.startApiHarness();
  let owned = null;
  let gateway = null;
  const checks = [];
  const errors = [];
  const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); assert.ok(ok, name); };
  let browser;
  let completed = false;
  const ownerId = `lc-owner-${suffix}`.toLowerCase();
  const staffId = `lc-staff-${suffix}`.toLowerCase();
  const ownerEmail = `${ownerId}@example.test`;
  const staffEmail = `${staffId}@example.test`;
  const eventName = `여정 완주 행사 ${suffix.slice(0, 6)}`;
  const eventSlug = `lifecycle-${suffix.slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const eventDate = '2027-03-20';
  const participantName = '완주 참가자 갑';
  const participantPhone = '01090000101';
  const participantBName = '완주 참가자 을';
  const participantBPhone = '01090000102';
  let eventId = null;

  const snapshot = async () => (await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId],
  )).rows[0].payload;
  const eventRow = async () => (await harness.database.query(
    'SELECT id, slug, org_id, payload FROM events WHERE id=$1', [eventId],
  )).rows[0];

  try {
    await helpers.insertAccount(harness.database, {
      orgId: helpers.LEGACY_ORG, id: ownerId, role: 'AGENCY', name: '완주 운영자', email: ownerEmail,
    });
    await helpers.insertAccount(harness.database, {
      orgId: helpers.LEGACY_ORG, id: staffId, role: 'STAFF', name: '완주 스태프', email: staffEmail,
    });
    const passwordHash = hashPassword(fixtureLib.FIXTURE_PASSWORD);
    await harness.database.query('UPDATE accounts SET password_hash=$1 WHERE id=ANY($2)', [passwordHash, [ownerId, staffId]]);

    owned = await fixtureLib.startOwnedNext({ apiBase: harness.baseUrl });
    {
      const res = await fetch(`${owned.baseUrl}/login`, { headers: { connection: 'close' } });
      await res.text().catch(() => '');
      if (res.status !== 200) {
        throw new Error(`lifecycle audit SSR check failed: GET /login -> ${res.status}`);
      }
    }
    gateway = await startWebApiGateway({ apiBase: harness.baseUrl, webBase: owned.baseUrl });
    const baseUrl = gateway.baseUrl;

    browser = await launchBrowser();
    const axePage = async (page, label) => {
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => (await window.axe.run()).violations
        .filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => item.id));
      check(`${label}: axe serious/critical 0`, violations.length === 0);
    };
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

    // ---- 1. Operator @1280 logs in through the rendered form ----
    const op = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const login = await op.newPage();
    login.on('pageerror', (error) => errors.push(`login: ${error.message}`));
    await login.goto(`${baseUrl}/login`);
    await login.locator('#login-email').waitFor();
    await login.screenshot({ path: path.join(OUT, '01-login-1280-first.png') });
    await geometry(login, 'login 1280', 'button:has-text("로그인")');
    await login.locator('#login-email').fill(ownerEmail);
    await login.locator('#login-password').fill(fixtureLib.FIXTURE_PASSWORD);
    await login.getByRole('button', { name: '로그인', exact: true }).click();
    await login.waitForURL(/\/console/, { timeout: 20000 });
    check('operator login lands on the console', true);
    await login.locator('text=새 행사 만들기').first().waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '02-console-home-1280-first.png') });
    await geometry(login, 'console home 1280', 'button:has-text("새 행사 만들기")');
    await axePage(login, 'console home 1280');

    // ---- 2. ONE subject event created through the rendered dialog ----
    await login.getByRole('button', { name: '새 행사 만들기', exact: true }).click();
    await login.locator('#create-name').waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '03-create-dialog-1280.png') });
    await login.locator('#create-name').fill(eventName);
    await login.waitForTimeout(400);
    await login.locator('#create-slug').click();
    await login.locator('#create-slug').press('Control+a');
    await login.locator('#create-slug').type(eventSlug);
    if ((await login.locator('#create-slug').inputValue()) !== eventSlug) {
      await login.locator('#create-slug').press('Control+a');
      await login.locator('#create-slug').fill(eventSlug);
    }
    check('create dialog holds the deterministic slug before submit',
      (await login.locator('#create-slug').inputValue()) === eventSlug);
    await login.locator('#create-date').fill(eventDate);
    await login.locator('#create-start').fill('09:00');
    await login.locator('#create-end').fill('18:00');
    await login.locator('#create-capacity').fill('200');
    await login.getByRole('button', { name: '행사 만들기', exact: true }).click();
    await login.waitForURL(/\/console\/events\//, { timeout: 20000 });
    eventId = decodeURIComponent(new URL(login.url()).pathname.split('/').pop());
    check('subject event created through UI (id in URL)', typeof eventId === 'string' && eventId.length > 0);
    const row = await eventRow();
    check('subject event persists with the UI-driven slug', row && row.slug === eventSlug && row.payload.name === eventName);
    check('single subject identity: one event row, one workspace', (await harness.database.query(
      'SELECT count(*)::int AS n FROM events WHERE slug=$1', [eventSlug])).rows[0].n === 1);
    await login.screenshot({ path: path.join(OUT, '04-event-overview-1280-first.png'), fullPage: true });
    await geometry(login, 'event overview 1280', null);
    await axePage(login, 'event overview 1280');

    // ---- 3. Fresh closed DRAFT: state-specific gate note, link, retention ----
    await login.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/settings`);
    await login.getByRole('tab', { name: '기본 정보' }).waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '05-settings-basics-1280-first.png') });
    const approvalBox = login.getByLabel('신청 후 운영자 승인 필요');
    if (!(await approvalBox.isChecked())) await approvalBox.check();
    await login.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await login.getByText('기본 정보를 저장했습니다').first().waitFor({ timeout: 15000 });
    check('approval gate saved through settings UI', true);
    await login.getByRole('tab', { name: '참가 접수' }).click();
    await login.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '05b-settings-intake-closed-draft-1280.png') });
    // Closed DRAFT names BOTH remaining steps (publish + stage), not just one.
    await login.locator('#panel-settings-intake p[role="note"]', { hasText: '접수를 열려면 양식을 게시하고' }).first().waitFor({ timeout: 15000 });
    check('closed DRAFT intake names publish plus stage', true);
    check('closed DRAFT note labels the public acceptance',
      (await login.locator('#panel-settings-intake p[role="note"]', { hasText: '공개 접수: 닫힘' }).count()) >= 1);
    check('closed DRAFT stored line names itself a setting',
      (await login.getByText(/현재 접수 닫힘 \(설정\)/).count()) === 1);
    // Unsaved draft + keyboard-driven stage link: the in-note link sits
    // immediately before the consent field in tab order, so Shift+Tab from
    // the field reaches it through real keyboard navigation (not a
    // programmatic focus); Enter must land on the stage tab.
    await login.locator('#set-consent').fill('완주 여정 동의 안내 초안');
    await login.locator('#set-consent').click();
    let linkReached = false;
    for (let i = 0; i < 8; i++) {
      await login.keyboard.press('Shift+Tab');
      const href = await login.evaluate(
        () => ((document.activeElement instanceof HTMLAnchorElement) ? document.activeElement.getAttribute('href') : null),
      );
      if (href === '#settings-stage') { linkReached = true; break; }
    }
    check('stage link is reachable by keyboard (Shift+Tab)', linkReached);
    await login.keyboard.press('Enter');
    await login.locator('#panel-settings-stage').waitFor({ state: 'visible', timeout: 15000 });
    check('stage link lands on the stage tab via keyboard', true);
    await login.screenshot({ path: path.join(OUT, '05c-stage-tab-via-link-1280.png') });
    await login.getByRole('tab', { name: '참가 접수' }).click();
    check('unsaved consent draft retained after tab return',
      (await login.locator('#set-consent').inputValue()) === '완주 여정 동의 안내 초안');
    check('closed DRAFT note still shown after return',
      (await login.locator('#panel-settings-intake p[role="note"]', { hasText: '접수를 열려면 양식을 게시하고' }).count()) === 1);
    // Narrow-mobile proof of the closed-DRAFT note on the same state.
    const op390 = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const login390 = await op390.newPage();
    login390.on('pageerror', (error) => errors.push(`login390: ${error.message}`));
    await login390.goto(`${baseUrl}/login`);
    await login390.locator('#login-email').fill(ownerEmail);
    await login390.locator('#login-password').fill(fixtureLib.FIXTURE_PASSWORD);
    await login390.getByRole('button', { name: '로그인', exact: true }).click();
    await login390.waitForURL(/\/console/, { timeout: 20000 });
    await login390.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/settings`);
    await login390.getByRole('tab', { name: '참가 접수' }).click();
    await login390.locator('#panel-settings-intake p[role="note"]', { hasText: '접수를 열려면 양식을 게시하고' }).first().waitFor({ timeout: 15000 });
    await login390.screenshot({ path: path.join(OUT, '05d-intake-closed-note-390-first.png') });
    await geometry(login390, 'intake closed note 390', null);
    // Public DRAFT-closed: no entry, no register form (stage gate, not assumed).
    const pubClosed = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pubClosedEntry = await pubClosed.newPage();
    await pubClosedEntry.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}`);
    await pubClosedEntry.getByRole('heading', { name: '행사를 찾을 수 없습니다' }).waitFor({ timeout: 15000 });
    check('DRAFT-closed event has no public entry', true);
    const pubClosedReg = await pubClosed.newPage();
    await pubClosedReg.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}/register`);
    await pubClosedReg.getByRole('heading', { name: '신청할 수 없는 행사입니다' }).waitFor({ timeout: 15000 });
    check('DRAFT-closed event offers no signup form',
      (await pubClosedReg.locator('form.registration-form').count()) === 0);
    await pubClosed.close();

    // ---- 4. Publish while still DRAFT: open-DRAFT variant + mouse link ----
    await login.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click();
    await login.getByText('양식을 게시했습니다. 진행 단계에서 운영 준비(으)로 전환하면 접수가 열립니다.').first().waitFor({ timeout: 15000 });
    check('DRAFT publish success names the remaining stage step', true);
    check('registration published through settings UI', (await snapshot()).registrationOpen === true);
    check('approval gate persists server-side', (await snapshot()).approvalRequired === true);
    await login.locator('#panel-settings-intake p[role="note"]', { hasText: '공개 페이지가 열리지 않아 참가 신청을 받을 수 없습니다' }).first().waitFor({ timeout: 15000 });
    check('open DRAFT intake names the stage step only', true);
    check('open DRAFT note labels the public acceptance',
      (await login.locator('#panel-settings-intake p[role="note"]', { hasText: '공개 접수: 닫힘' }).count()) >= 1);
    check('open DRAFT stored line names itself a setting',
      (await login.getByText(/현재 접수 중 \(설정\)/).count()) >= 1);
    await login.screenshot({ path: path.join(OUT, '07c-intake-open-note-1280.png') });
    await login390.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/settings`);
    await login390.getByRole('tab', { name: '참가 접수' }).click();
    await login390.locator('#panel-settings-intake p[role="note"]', { hasText: '공개 페이지가 열리지 않아' }).first().waitFor({ timeout: 15000 });
    await login390.screenshot({ path: path.join(OUT, '07d-intake-open-note-390-first.png') });
    await geometry(login390, 'intake open note 390', null);
    // The in-note stage link itself (mouse path) lands on the stage tab.
    await login.locator('#panel-settings-intake a[href="#settings-stage"]').first().click();
    await login.locator('#panel-settings-stage').waitFor({ state: 'visible', timeout: 15000 });
    check('stage link lands on the stage tab via mouse click', true);
    await op390.close();
    // Public DRAFT-open: publish alone still opens nothing (proven, not assumed).
    const pubOpen = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pubOpenEntry = await pubOpen.newPage();
    await pubOpenEntry.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}`);
    await pubOpenEntry.getByRole('heading', { name: '행사를 찾을 수 없습니다' }).waitFor({ timeout: 15000 });
    check('DRAFT-open event still has no public entry', true);
    const pubOpenReg = await pubOpen.newPage();
    await pubOpenReg.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}/register`);
    await pubOpenReg.getByRole('heading', { name: '신청할 수 없는 행사입니다' }).waitFor({ timeout: 15000 });
    check('DRAFT-open event still offers no signup form',
      (await pubOpenReg.locator('form.registration-form').count()) === 0);
    await pubOpen.close();

    // ---- 5. DRAFT→READY; both note variants clear once public ----
    await login.getByRole('tab', { name: '진행 단계' }).click();
    await login.getByRole('button', { name: '운영 준비(으)로 전환', exact: true }).click();
    await login.getByRole('button', { name: '정말 전환합니다 · 운영 준비 단계로', exact: true }).waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '07b-stage-to-ready-1280.png') });
    await login.getByRole('button', { name: '정말 전환합니다 · 운영 준비 단계로', exact: true }).click();
    await login.getByText(/행사를 운영 준비\(으\)로 전환했습니다/).first().waitFor({ timeout: 15000 });
    check('event reaches READY before public signup', (await eventRow()).payload.stage === 'READY');
    await login.getByRole('tab', { name: '참가 접수' }).click();
    check('DRAFT gate notes clear once the event is public (READY)',
      (await login.locator('#panel-settings-intake p[role="note"]', { hasText: '기획 단계에서는' }).count()) === 0
      && (await login.locator('#panel-settings-intake p[role="note"]', { hasText: '접수를 열려면 양식을 게시하고' }).count()) === 0);

    // ---- 6. Public entry proves the publish (no auth cookie) ----
    const pub = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const entry = await pub.newPage();
    entry.on('pageerror', (error) => errors.push(`entry: ${error.message}`));
    await entry.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}`);
    await entry.getByRole('link', { name: '참가 신청하기' }).waitFor({ timeout: 15000 });
    await entry.screenshot({ path: path.join(OUT, '08-public-entry-390-first.png') });
    await geometry(entry, 'public entry 390', 'a:has-text("참가 신청하기")');
    await axePage(entry, 'public entry 390');

    // ---- 7. Participant A @390 signs up through the rendered form ----
    await entry.getByRole('link', { name: '참가 신청하기' }).click();
    await entry.locator('form.registration-form').waitFor({ timeout: 15000 });
    await entry.screenshot({ path: path.join(OUT, '09-register-390-first.png') });
    await geometry(entry, 'register 390', 'form.registration-form button[type="submit"]', true);
    check('gated register lead promises approval, not instant issuance',
      (await entry.getByText('아래 정보를 입력하면 신청이 접수되고, 운영자 승인 뒤 입장 QR이 표시됩니다.').count()) === 1);
    await entry.locator('#field-name').fill(participantName);
    await entry.locator('#field-phone').fill(participantPhone);
    if (await entry.locator('#consent').count()) await entry.locator('#consent').check();
    await entry.getByRole('button', { name: '신청하기', exact: true }).click();
    await entry.getByText('승인 대기').first().waitFor({ timeout: 15000 });
    check('signup A lands on a pending receipt', true);
    await entry.screenshot({ path: path.join(OUT, '10-ticket-pending-390-first.png') });
    await entry.screenshot({ path: path.join(OUT, '10-ticket-pending-390-full.png'), fullPage: true });
    check('pending ticket shows no entry QR',
      (await entry.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 0);
    const peopleA = (await snapshot()).participants.filter((p) => p.phone === participantPhone);
    check('signup A persists exactly one PENDING participant', peopleA.length === 1 && peopleA[0].status === 'PENDING');

    // ---- 8. Operator approves A through the roster UI ----
    const roster = await op.newPage();
    roster.on('pageerror', (error) => errors.push(`roster: ${error.message}`));
    await roster.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`);
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').waitFor({ timeout: 15000 });
    await roster.screenshot({ path: path.join(OUT, '11-roster-1280-first.png') });
    await geometry(roster, 'roster 1280', null);
    await axePage(roster, 'roster 1280');
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill(participantName);
    await roster.getByRole('button', { name: '승인', exact: true }).first().click();
    await roster.getByText(/승인했습니다|바꿨습니다/).first().waitFor({ timeout: 15000 });
    check('operator approval persists APPROVED for A',
      (await snapshot()).participants.find((p) => p.phone === participantPhone)?.status === 'APPROVED');

    // ---- 9. A re-checks by keyboard; rendered QR decodes to the server ticket ----
    let recheckFocused = false;
    for (let i = 0; i < 40; i++) {
      await entry.keyboard.press('Tab');
      const label = await entry.evaluate(
        () => ((document.activeElement && document.activeElement.textContent) || '').trim(),
      );
      if (label === '상태 다시 확인') { recheckFocused = true; break; }
    }
    check('pending re-check is reachable by keyboard (Tab)', recheckFocused);
    await entry.keyboard.press('Enter');
    await entry.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 15000 });
    check('keyboard re-check reaches the approved QR', true);
    await entry.getByText('참가 확정').first().waitFor({ timeout: 15000 });
    await entry.screenshot({ path: path.join(OUT, '12-ticket-approved-390.png'), fullPage: true });
    const decodedA = await decodeRenderedTicket(entry);
    const serverTicketA = (await snapshot()).participants.find((p) => p.phone === participantPhone)?.ticket;
    check('rendered QR decodes to the server-issued ticket (sha256 match, bearer never logged)',
      typeof decodedA === 'string' && decodedA.length > 0 && sha256(decodedA) === sha256(serverTicketA));

    // ---- 10. Desk created through the operations UI ----
    await login.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/operations`);
    await login.getByRole('button', { name: '데스크 추가', exact: true }).waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '13-operations-1280-first.png') });
    await geometry(login, 'operations 1280', 'button:has-text("데스크 추가")');
    await axePage(login, 'operations 1280');
    await login.getByRole('button', { name: '데스크 추가', exact: true }).click();
    await login.locator('#desk-name').waitFor({ timeout: 15000 });
    await login.locator('#desk-name').fill('완주 입장 데스크');
    await login.getByRole('button', { name: '데스크 저장', exact: true }).click();
    await login.getByText('데스크를 저장했습니다').first().waitFor({ timeout: 15000 });
    const deskId = (await snapshot()).desks[0]?.id;
    check('desk created through operations UI', typeof deskId === 'string' && deskId.length > 0);
    await login.screenshot({ path: path.join(OUT, '14-desk-created-1280.png') });

    // ---- 11. Staff sees the unassigned state first (empty/permission state) ----
    const st = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const staffLogin = await st.newPage();
    staffLogin.on('pageerror', (error) => errors.push(`staff-login: ${error.message}`));
    await staffLogin.goto(`${baseUrl}/login`);
    await staffLogin.locator('#login-email').fill(staffEmail);
    await staffLogin.locator('#login-password').fill(fixtureLib.FIXTURE_PASSWORD);
    await staffLogin.getByRole('button', { name: '로그인', exact: true }).click();
    await staffLogin.waitForURL(/\/staff/, { timeout: 20000 });
    check('staff login lands on the staff hub', true);
    const staffWork = await st.newPage();
    staffWork.on('pageerror', (error) => errors.push(`staff: ${error.message}`));
    await staffWork.goto(`${baseUrl}/staff/events/${encodeURIComponent(eventId)}`);
    await staffWork.getByText(/업무 배정이 없습니다/).waitFor({ timeout: 15000 });
    check('unassigned staff sees a stable explanation, not a loop', true);
    await staffWork.screenshot({ path: path.join(OUT, '15-staff-unassigned-390-first.png') });
    await geometry(staffWork, 'staff unassigned 390', null);

    // ---- 12. Operator assigns the staff through the assignment UI ----
    await login.getByRole('button', { name: '스태프 배정', exact: true }).first().click();
    await login.locator('#assign-account').waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '16-assign-dialog-1280.png') });
    await login.locator('#assign-account').selectOption(staffId);
    const assignTarget = await login.locator('#assign-target').inputValue().catch(() => '');
    if (!assignTarget) {
      await login.locator('#assign-type').selectOption('DESK');
      await login.locator('#assign-target').selectOption(deskId);
    }
    await login.getByRole('button', { name: '배정 저장', exact: true }).click();
    await login.getByText('스태프를 배정했습니다').first().waitFor({ timeout: 15000 });
    check('staff assignment persists through operations UI',
      (await snapshot()).assignments.some((a) => a.accountId === staffId && a.targetId === deskId));
    await login.screenshot({ path: path.join(OUT, '17-assigned-1280.png') });

    // ---- 13. READY→LIVE with the intake still open (ENDED edge needs it) ----
    await login.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/settings`);
    await login.getByRole('tab', { name: '진행 단계' }).click();
    await login.getByRole('button', { name: '진행 중(으)로 전환', exact: true }).click();
    await login.getByRole('button', { name: '정말 전환합니다 · 진행 중 단계로', exact: true }).waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '18-stage-to-live-1280.png') });
    await login.getByRole('button', { name: '정말 전환합니다 · 진행 중 단계로', exact: true }).click();
    await login.getByText(/행사를 진행 중\(으\)로 전환했습니다/).first().waitFor({ timeout: 15000 });
    check('event reaches LIVE through settings UI', (await eventRow()).payload.stage === 'LIVE');
    await login.screenshot({ path: path.join(OUT, '19-stage-live-1280.png') });

    // ---- 14. Staff checks in A with the decoded QR: loss → same-request retry ----
    await staffWork.goto(`${baseUrl}/staff/events/${encodeURIComponent(eventId)}`);
    await staffWork.locator('#staff-desk').waitFor({ timeout: 15000 });
    await staffWork.screenshot({ path: path.join(OUT, '20-staff-work-390-first.png') });
    await geometry(staffWork, 'staff work 390', 'button:has-text("카메라로 스캔")');
    await axePage(staffWork, 'staff work 390');
    if ((await staffWork.locator('#staff-desk').inputValue()) !== deskId) {
      await staffWork.locator('#staff-desk').selectOption(deskId);
    }
    const scanAttempts = [];
    await staffWork.route('**/api/events/*/commands', async (route) => {
      const body = route.request().postDataJSON() || {};
      if (body.command === 'check.scan') {
        if (scanAttempts.length === 0) {
          scanAttempts.push(body);
          const actual = await route.fetch();
          check('first scan commits on the real API', actual.status() === 200);
          return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture response lost"}' });
        }
        scanAttempts.push(body);
      }
      return route.continue();
    });
    await staffWork.locator('#staff-ticket').fill(decodedA);
    await geometry(staffWork, 'staff submit 390', 'button:has-text("입장 처리")', true);
    await staffWork.getByRole('button', { name: '입장 처리', exact: true }).click();
    await staffWork.getByText(/확인하지 못했습니다|다시 시도/).first().waitFor({ timeout: 15000 });
    check('lost scan response stays uncertain, not failed', true);
    await maskTicketInput(staffWork);
    await staffWork.screenshot({ path: path.join(OUT, '21-scan-uncertain-390.png') });
    await unmaskTicketInput(staffWork);
    await staffWork.getByRole('button', { name: /다시 시도/ }).first().click().catch(() => {});
    if ((await staffWork.getByRole('button', { name: '다음 참가자', exact: true }).count()) === 0) {
      await staffWork.getByRole('button', { name: '입장 처리', exact: true }).click();
    }
    await staffWork.getByRole('button', { name: '다음 참가자', exact: true }).waitFor({ timeout: 15000 });
    check('retry of the identical scan completes check-in', true);
    check('retry replays the identical request (body and command id)',
      scanAttempts.length === 2
      && JSON.stringify(scanAttempts[0]) === JSON.stringify(scanAttempts[1])
      && typeof scanAttempts[0].commandId === 'string'
      && scanAttempts[0].commandId.length > 0);
    await staffWork.screenshot({ path: path.join(OUT, '22-checkin-ok-390.png'), fullPage: true });
    check('checked-in A is inside', (await snapshot()).participants.find((p) => p.phone === participantPhone)?.inside === true);
    const personAId = (await snapshot()).participants.find((p) => p.phone === participantPhone)?.id;
    check('exactly one IN check for A (no duplicate from retry)',
      (await snapshot()).checks.filter((c) => c.participantId === personAId && c.action === 'IN').length === 1);

    // ---- 15. Staff failure state: unknown ticket keeps the typed input ----
    await staffWork.getByRole('button', { name: '다음 참가자', exact: true }).click();
    await staffWork.locator('#staff-ticket').fill('ET-INVALID-CODE-0000');
    await staffWork.getByRole('button', { name: '입장 처리', exact: true }).click();
    const failureSection = staffWork.locator('section[aria-label="스캔 실패"]');
    await failureSection.waitFor({ timeout: 15000 });
    const failureText = ((await failureSection.getByRole('alert').first().innerText()) || '').trim();
    check('failed scan states the error explicitly (alert, not a silent wait)',
      failureText.length > 0 && /티켓|스캔|다시|확인/.test(failureText));
    await maskTicketInput(staffWork);
    await staffWork.screenshot({ path: path.join(OUT, '23-scan-failed-390.png') });
    await unmaskTicketInput(staffWork);
    check('failed scan keeps the typed code for correction', (await staffWork.locator('#staff-ticket').inputValue()) === 'ET-INVALID-CODE-0000');
    await staffWork.unrouteAll({ behavior: 'wait' }).catch(() => {});

    // ---- Staff @320: assigned work on the narrow viewport ----
    const st320 = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' });
    const staffLogin320 = await st320.newPage();
    staffLogin320.on('pageerror', (error) => errors.push(`staff320: ${error.message}`));
    await staffLogin320.goto(`${baseUrl}/login`);
    await staffLogin320.locator('#login-email').fill(staffEmail);
    await staffLogin320.locator('#login-password').fill(fixtureLib.FIXTURE_PASSWORD);
    await staffLogin320.getByRole('button', { name: '로그인', exact: true }).click();
    await staffLogin320.waitForURL(/\/staff/, { timeout: 20000 });
    const work320 = await st320.newPage();
    work320.on('pageerror', (error) => errors.push(`staff320: ${error.message}`));
    await work320.goto(`${baseUrl}/staff/events/${encodeURIComponent(eventId)}`);
    await work320.locator('#staff-desk').waitFor({ timeout: 15000 });
    await work320.screenshot({ path: path.join(OUT, '22b-staff-work-320-first.png') });
    await geometry(work320, 'staff work 320', 'button:has-text("입장 처리")', true);
    await axePage(work320, 'staff work 320');
    check('assigned staff work renders on 320', true);
    await st320.close();

    // ---- 16. Usable-ticket re-check: transient loss keeps the mounted QR ----
    {
      let ticketCalls = 0;
      await entry.route('**/api/public/events/*/ticket', async (route) => {
        ticketCalls += 1;
        if (ticketCalls === 1) {
          return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"fixture ticket read lost"}' });
        }
        return route.continue();
      });
      await entry.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
      await entry.getByText('입장 가능 여부는 확정되지 않았습니다').first().waitFor({ timeout: 15000 });
      check('transient re-check failure keeps the mounted QR with a retry path',
        (await entry.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 1);
      await entry.screenshot({ path: path.join(OUT, '23b-recheck-transient-390.png') });
      await entry.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
      await entry.getByText('참가 확정').first().waitFor({ timeout: 15000 });
      // Settle gate: the resting label is back, so the counts below cannot
      // race the in-flight retry (waitFor polls until the resting label
      // matches, which is only true after the retry settles).
      await entry.getByRole('button', { name: '상태 다시 확인', exact: true }).waitFor({ timeout: 15000 });
      check('usable re-check succeeds on retry without reload',
        (await entry.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 1
        && (await entry.getByText('입장 가능 여부는 확정되지 않았습니다').count()) === 0);
      await entry.unrouteAll({ behavior: 'wait' }).catch(() => {});
    }

    // ---- 17. B @320: signup → approval → decoded usable QR ----
    const ctxB = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' });
    const regB = await ctxB.newPage();
    regB.on('pageerror', (error) => errors.push(`registerB: ${error.message}`));
    await regB.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}/register`);
    await regB.locator('form.registration-form').waitFor({ timeout: 15000 });
    await regB.screenshot({ path: path.join(OUT, '24-register-b-320-first.png') });
    await geometry(regB, 'register B 320', 'form.registration-form button[type="submit"]', true);
    await regB.locator('#field-name').fill(participantBName);
    await regB.locator('#field-phone').fill(participantBPhone);
    if (await regB.locator('#consent').count()) await regB.locator('#consent').check();
    await regB.getByRole('button', { name: '신청하기', exact: true }).click();
    await regB.getByText('승인 대기').first().waitFor({ timeout: 15000 });
    await roster.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`);
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill(participantBName);
    await roster.getByRole('button', { name: '승인', exact: true }).first().click();
    await roster.getByText(/승인했습니다|바꿨습니다/).first().waitFor({ timeout: 15000 });
    await regB.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await regB.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 15000 });
    check('participant B reaches a usable QR before cancellation', true);
    await regB.screenshot({ path: path.join(OUT, '25-ticket-b-approved-320.png'), fullPage: true });
    const decodedB = await decodeRenderedTicket(regB);
    const serverTicketB = (await snapshot()).participants.find((p) => p.phone === participantBPhone)?.ticket;
    check('rendered B QR decodes to the server-issued ticket (sha256 match, bearer never logged)',
      typeof decodedB === 'string' && decodedB.length > 0 && sha256(decodedB) === sha256(serverTicketB));
    const personBId = (await snapshot()).participants.find((p) => p.phone === participantBPhone)?.id;

    // ---- 18. Cancel B: usable re-check ends the stale QR without reload ----
    await roster.keyboard.press('Escape').catch(() => {});
    await roster.getByRole('button', { name: /새로고침( 중…)?/, exact: true }).click();
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill(participantBName);
    await roster.getByRole('button', { name: `${participantBName} 참가자 상세`, exact: true }).click();
    await roster.getByLabel(`${participantBName} 상태 변경`).selectOption('CANCELLED');
    await roster.getByRole('button', { name: '신청 취소', exact: true }).click();
    await roster.getByText(/바꿨습니다/).first().waitFor({ timeout: 15000 });
    check('operator cancel persists CANCELLED for B',
      ((await snapshot()).participants.find((p) => p.phone === participantBPhone) || {}).status === 'CANCELLED');
    await regB.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
    await regB.getByText('티켓을 사용할 수 없습니다').waitFor({ timeout: 15000 });
    check('usable re-check ends the stale QR without reload', true);
    check('invalidated ticket shows no entry QR after re-check',
      (await regB.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 0);
    await regB.screenshot({ path: path.join(OUT, '26-ticket-b-invalidated-320.png'), fullPage: true });
    // Staff scans the decoded (now revoked) B ticket: rejected, no new IN.
    await staffWork.getByRole('button', { name: '다음 참가자', exact: true }).click().catch(() => {});
    await staffWork.locator('#staff-ticket').fill(decodedB);
    await staffWork.getByRole('button', { name: '입장 처리', exact: true }).click();
    await staffWork.locator('section[aria-label="스캔 실패"]').waitFor({ timeout: 15000 });
    check('staff scan of the cancelled ticket is rejected',
      ((await staffWork.locator('section[aria-label="스캔 실패"]').getByRole('alert').first().innerText()) || '').trim().length > 0);
    await maskTicketInput(staffWork);
    await staffWork.screenshot({ path: path.join(OUT, '26b-scan-cancelled-rejected-390.png') });
    await unmaskTicketInput(staffWork);
    check('cancelled scan leaves no extra IN record',
      (await snapshot()).checks.filter((c) => c.participantId === personBId && c.action === 'IN').length === 0);
    // Recovery: re-approve B. The server rotates the bearer on reinstatement
    // (setParticipantStatus → reissueTicket), so the previously decoded QR
    // must stay dead at the desk while the record is live again.
    await roster.keyboard.press('Escape').catch(() => {});
    await roster.getByRole('button', { name: /새로고침( 중…)?/, exact: true }).click();
    await roster.locator('input[placeholder*="이름·소속·연락처 검색"]').fill(participantBName);
    await roster.getByRole('button', { name: `${participantBName} 참가자 상세`, exact: true }).click();
    await roster.getByLabel(`${participantBName} 상태 변경`).selectOption('APPROVED');
    await roster.getByText(/바꿨습니다/).first().waitFor({ timeout: 15000 });
    const reapprovedB = (await snapshot()).participants.find((p) => p.phone === participantBPhone) || {};
    check('operator re-approval persists APPROVED for B (recovery)', reapprovedB.status === 'APPROVED');
    check('reinstatement rotates the bearer (old decoded QR stays dead)',
      typeof reapprovedB.ticket === 'string' && sha256(reapprovedB.ticket) !== sha256(decodedB));
    // Staff scans the OLD decoded B ticket after rotation: rejected, no IN.
    await staffWork.getByRole('button', { name: '다음 참가자', exact: true }).click().catch(() => {});
    await staffWork.locator('#staff-ticket').fill(decodedB);
    await staffWork.getByRole('button', { name: '입장 처리', exact: true }).click();
    await staffWork.locator('section[aria-label="스캔 실패"]').waitFor({ timeout: 15000 });
    check('rotated-out bearer is rejected after reinstatement',
      ((await staffWork.locator('section[aria-label="스캔 실패"]').getByRole('alert').first().innerText()) || '').trim().length > 0);
    check('rotated-out scan leaves no IN record',
      (await snapshot()).checks.filter((c) => c.participantId === personBId && c.action === 'IN').length === 0);
    // B's device held the cleared bearer: reload lands on missing (no
    // resurrection without the recovery route, which mock-SMS events
    // honestly do not offer — production shows the recover link instead).
    await regB.reload();
    await regB.getByText('티켓이 확인되지 않습니다').waitFor({ timeout: 15000 });
    check('cleared bearer cannot regain authority, even after re-approval', true);
    check('missing state shows no entry QR',
      (await regB.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).count()) === 0);
    await regB.screenshot({ path: path.join(OUT, '26c-ticket-b-missing-320.png'), fullPage: true });
    await ctxB.close();

    // ---- 19. Operator report reflects the persisted journey (still LIVE) ----
    const rep = await op.newPage();
    rep.on('pageerror', (error) => errors.push(`report: ${error.message}`));
    await rep.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/reports`);
    await rep.locator('#reports-list').waitFor({ timeout: 15000 });
    await rep.screenshot({ path: path.join(OUT, '27-reports-1280-first.png') });
    await geometry(rep, 'reports 1280', 'button:has-text("보고서 만들기")');
    await axePage(rep, 'reports 1280');
    await rep.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
    await rep.locator('#report-title').waitFor({ timeout: 15000 });
    await rep.screenshot({ path: path.join(OUT, '28-report-create-1280.png') });
    await rep.locator('#report-title').fill('완주 여정 결과 보고서');
    await rep.locator('#report-summary').fill('신청부터 승인·입장·취소까지 이어진 여정을 확인한 보고서입니다.');
    await rep.getByRole('button', { name: '보고서 만들기', exact: true }).last().click();
    await rep.getByText(/보고서 초안을 만들었습니다/).first().waitFor({ timeout: 15000 });
    await rep.getByRole('button', { name: '내용 보기', exact: true }).first().click();
    await rep.locator('#report-detail').waitFor({ timeout: 15000 });
    await rep.screenshot({ path: path.join(OUT, '29-report-detail-1280.png'), fullPage: true });
    check('report snapshot counts the real check-in',
      (await rep.getByText(/누적 입장 1명/).count()) > 0 && (await rep.getByText(/현재 입장 1명/).count()) > 0);

    // ---- 20. LIVE→ENDED with the intake still open (server permits it) ----
    const peopleBefore = (await snapshot()).participants.length;
    await login.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/settings`);
    await login.getByRole('tab', { name: '진행 단계' }).click();
    check('ENDED transition is offered while the intake is still open',
      (await login.getByRole('button', { name: '종료(으)로 전환', exact: true }).count()) === 1
      && (await login.locator('#settings-stage-precondition').count()) === 0);
    await login.getByRole('button', { name: '종료(으)로 전환', exact: true }).click();
    await login.getByRole('button', { name: '정말 전환합니다 · 종료 단계로', exact: true }).waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '30a-stage-to-ended-open-1280.png') });
    await login.getByRole('button', { name: '정말 전환합니다 · 종료 단계로', exact: true }).click();
    await login.getByText(/행사를 종료\(으\)로 전환했습니다/).first().waitFor({ timeout: 15000 });
    check('LIVE→ENDED persists with registrationOpen still true',
      (await eventRow()).payload.stage === 'ENDED' && (await snapshot()).registrationOpen === true);
    await login.getByRole('tab', { name: '참가 접수' }).click();
    await login.locator('#panel-settings-intake p[role="note"]', { hasText: '종료된 행사에서는 신청을 받을 수 없습니다' }).first().waitFor({ timeout: 15000 });
    check('ENDED-open intake names the closed public route', true);
    check('ENDED-open note labels the public acceptance',
      (await login.locator('#panel-settings-intake p[role="note"]', { hasText: '공개 접수: 닫힘' }).count()) >= 1);
    check('ENDED-open publish action is honestly disabled',
      await login.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).isDisabled());
    check('ENDED-open names the impossible publish inline',
      (await login.getByText('종료된 행사에서는 양식을 게시할 수 없습니다. 접수를 닫은 뒤 보관하세요.').count()) === 1);
    await login.screenshot({ path: path.join(OUT, '30b-intake-ended-note-1280.png') });
    // Public ENDED-open: entry hides the signup link, register hides the form.
    const pubEnded = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pubEndedEntry = await pubEnded.newPage();
    await pubEndedEntry.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}`);
    await pubEndedEntry.getByText('현재 신청을 받지 않습니다').first().waitFor({ timeout: 15000 });
    check('ENDED-open entry no longer offers a signup link',
      (await pubEndedEntry.getByRole('link', { name: '참가 신청하기' }).count()) === 0);
    await pubEndedEntry.screenshot({ path: path.join(OUT, '30c-entry-ended-closed-390-first.png') });
    const pubEndedReg = await pubEnded.newPage();
    await pubEndedReg.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}/register`);
    await pubEndedReg.getByText('현재 신청을 받지 않습니다').first().waitFor({ timeout: 15000 });
    check('ENDED-open register renders the closed state, not a live form',
      (await pubEndedReg.locator('form.registration-form').count()) === 0);
    await pubEndedReg.screenshot({ path: path.join(OUT, '30d-register-ended-closed-390.png') });
    await pubEnded.close();
    // Server authority: direct signup in ENDED fails 409 and persists nothing.
    {
      const version = (await snapshot()).publishedVersion;
      const res = await helpers.requestJson(harness.baseUrl, `/api/events/${encodeURIComponent(eventSlug)}/signup`, {
        method: 'POST',
        body: { commandId: crypto.randomUUID(), formVersion: version, name: '종료 후 신청자', phone: '01090000999' },
      });
      check('direct signup in ENDED is rejected 409 by the server', res.status === 409);
      check('rejected signup persists no participant',
        (await snapshot()).participants.length === peopleBefore);
    }
    // Intake can still be closed from ENDED through the same UI.
    await login.getByRole('button', { name: '접수 닫기', exact: true }).click();
    await login.getByText('접수를 닫았습니다').first().waitFor({ timeout: 15000 });
    check('intake closed through settings UI in ENDED', (await snapshot()).registrationOpen === false);
    await login.getByRole('tab', { name: '진행 단계' }).click();
    await login.getByRole('button', { name: '보관(으)로 전환', exact: true }).click();
    await login.getByRole('button', { name: '정말 전환합니다 · 보관 단계로', exact: true }).waitFor({ timeout: 15000 });
    await login.screenshot({ path: path.join(OUT, '30-stage-to-보관-1280.png') });
    await login.getByRole('button', { name: '정말 전환합니다 · 보관 단계로', exact: true }).click();
    await login.getByText(/행사를 보관\(으\)로 전환했습니다/).first().waitFor({ timeout: 15000 });
    check('event reaches ARCHIVED through settings UI', (await eventRow()).payload.stage === 'ARCHIVED');
    await login.screenshot({ path: path.join(OUT, '31-stage-archived-1280.png') });
    // Closed public state: registration no longer accepts (reliable marker, no fixed sleep).
    const closed = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const closedPage = await closed.newPage();
    await closedPage.goto(`${baseUrl}/event/${encodeURIComponent(eventSlug)}/register`);
    await closedPage.getByRole('heading', { name: '신청할 수 없는 행사입니다' }).waitFor({ timeout: 15000 });
    await closedPage.screenshot({ path: path.join(OUT, '32-register-closed-390.png') });
    check('closed event no longer offers a live signup form',
      (await closedPage.locator('form.registration-form').count()) === 0);
    await closed.close();

    check('no unexpected browser runtime errors', errors.length === 0);
    completed = true;
  } finally {
    let finalBuildId = '';
    try {
      finalBuildId = fs.readFileSync(buildPath, 'utf8').trim();
    } catch { /* A removed artifact cannot substantiate a successful audit. */ }
    if (finalBuildId !== buildId) {
      completed = false;
      errors.push('Next build changed or disappeared during the audit');
      process.exitCode = 1;
    }
    try {
      const finalPayload = eventId
        ? (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0]?.payload || null
        : null;
      const finalEvent = eventId
        ? (await harness.database.query('SELECT slug, payload FROM events WHERE id=$1', [eventId])).rows[0] || null
        : null;
      fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({
        completed, checks, errors,
        build: buildId,
        buildSource: 'apps/web/.next/BUILD_ID',
        subject: eventId ? {
          eventId, slug: eventSlug, name: eventName,
          stage: finalEvent?.payload?.stage || null,
          participants: Array.isArray(finalPayload?.participants) ? finalPayload.participants.map((p) => ({
            id: p.id, name: p.name, phone: String(p.phone || '').replace(/\d(?=\d{4})/g, '*'),
            status: p.status, inside: p.inside === true,
          })) : [],
          checks: Array.isArray(finalPayload?.checks) ? finalPayload.checks.map((c) => ({
            participantId: c.participantId, action: c.action,
          })) : [],
          reports: Array.isArray(finalPayload?.reports) ? finalPayload.reports.map((r) => ({
            id: r.id, title: r.title, status: r.status, version: r.version,
          })) : [],
          assignments: Array.isArray(finalPayload?.assignments) ? finalPayload.assignments.map((a) => ({
            accountId: a.accountId, type: a.type,
          })) : [],
          registrationOpen: finalPayload?.registrationOpen === true,
        } : null,
        disclosures: [
          'isolated synthetic accounts (agency owner + staff) seeded with an isolated-test-only password; logins driven through the rendered login form',
          'ONE subject event created through the rendered create dialog; every setting, desk, assignment, approval, check-in, report, and stage transition driven through rendered UI on the same isolated API/PostgreSQL and the same production Next build',
          'QR reads are software simulation, not camera scans: each participant-rendered SVG QR is rasterized in-browser and decoded with jsQR, compared by sha256 to the server-issued subject ticket in memory, and the decoded value is typed into the staff form; no raw bearer is logged (phones masked, ticket hashes compared, never printed)',
          'first staff scan response replaced with intercepted 502 after a real 200 commit (simulated loss); both request bodies and command ids captured and compared, exactly one persisted check asserted',
          'staff ticket entry is manual typing of the decoded bearer (simulated QR read); input masked as password dots for failure screenshots only, value asserted separately and restored',
          'QR images necessarily encode synthetic bearers of the dropped disposable schema; no raw bearer appears in logs',
          'usable-ticket re-check (manual, same in-tab bearer, no new persistence): transient 500 keeps the mounted QR with a retry path; definitive 404 clears the bearer and ends the stale QR without reload; cancellation plus re-approval proven at 320/390 — reinstatement rotates the bearer (old decoded QR stays rejected at the desk with no IN), and the cleared device lands on missing without resurrection (mock-SMS events honestly offer no recovery link; production shows it)',
          'cancelled-ticket staff scan proven rejected with no extra IN record, using the same decoded rendered QR',
          'LIVE→ENDED with the intake still open covered end-to-end (settings UI permits it, server persists it): public entry and register provably render the closed state, direct API signup provably 409s with no persisted participant, then intake closed through the same UI before ARCHIVED',
          'intake distinguishes the stored setting from public acceptance outside READY/LIVE (stored line carries the (설정) qualifier, acceptance lines carry the 공개 접수: 닫힘 label, DRAFT publish success names the remaining stage step, ENDED publish is disabled with the reason inline; READY/LIVE wording kept verbatim for the flows asserting on it)',
          'keyboard paths use real key presses throughout: pending re-check reached by Tab cycling (up to 40 Tabs) + Enter, intake stage link reached by Shift+Tab from the consent field + Enter, usable re-check and staff retry driven by click only',
          'no fixed sleeps on loaded/closed-state assertions; every readiness gate waits on a rendered marker',
          'Chromium only; no real device, Safari, screen-reader listening, real messages, or customer acceptance',
        ],
      }, null, 2), { mode: 0o600 });
      if (completed) console.log(`[lifecycle-journey] ${checks.length} checks passed; evidence: ${OUT}`);
    } finally {
      try {
        if (browser) await browser.close();
      } finally {
        try { if (gateway) await gateway.close(); } finally {
          try { if (owned) await owned.close(); } finally {
            await harness.close();
          }
        }
      }
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
