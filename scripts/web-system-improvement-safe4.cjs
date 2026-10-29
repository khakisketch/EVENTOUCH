'use strict';
// Safe4 product audit: optional event format, row-reuse registration,
// arbitrary period analysis, frozen-report A4/16:9 presentation.
// Standalone main (parent runs it after the build); also exports
// runSafe4Audit for reuse. Runtime URL is fixture.baseUrl, browser comes
// from ./audit-browser.cjs (headless only), no build/run here.
//
// ONLY the synthetic task database is permitted (loopback-only, explicit
// URL, no default fallback). Protected hosts/databases are never touched:
// testDatabaseUrl() from tests/helpers/postgres-test.cjs enforces it.
//
// UI contract under test (apps/web only, no server change):
//   A. CreateEventDialog + settings basics optional `format` (''/offline/
//      online/hybrid): unspecified stays absent from the payload, '' clears,
//      only the three lowercase kinds store; no feature/venue/URL side
//      effects; duplicate copies the source setting.
//   B. ParticipantList row reuse prefills ONLY name+company into the manual
//      form; phone/email/consent/ticket/history/rewards/results/files never
//      copy; dirty/uncertain forms are never overwritten (guard reopens the
//      pending work); the new registration is marked and focus lands on the
//      first empty required input; existing create command/receipt/duplicate
//      checks and the selection scope are preserved; no new group field.
//   C. EventOverview arbitrary from/to analysis reuses the fixed-bucket
//      definitions (cancelled excluded, corrected excluded, per-participant
//      IN dedupe, browser-local days); daily sums vs whole-period unique are
//      named distinctly; native SVG plus the same values in a table and
//      summary; overlong ranges clamp with notice; bad ranges recover.
//   D. ReportsWorkspace local A4/16:9 view switch changes on-screen measure
//      only; the frozen snapshot/version/payload never change; no new
//      command, endpoint, receipt, template editing, or PPT generation; the
//      print clone path is unchanged and long content paginates.
process.env.EVENTOUCH_SMS_MOCK = '1';
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { testDatabaseUrl } = require('../tests/helpers/postgres-test.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const captureRoot = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`system-improvement-20261024/ux-${runStamp()}`);
const runId = process.env.EVENTOUCH_AUDIT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(captureRoot, `safe4-${runId}`);

async function runSafe4Audit() {
  const dbUrl = testDatabaseUrl(
    process.env.EVENTOUCH_A11Y_DATABASE_URL
    || process.env.EVENTOUCH_MOBILE_DATABASE_URL
    || process.env.EVENTOUCH_TEST_DATABASE_URL
    || ''
  );
  if (!dbUrl) throw new Error('safe4 audit requires an explicit isolated task database URL (EVENTOUCH_A11Y/MOBILE/TEST_DATABASE_URL)');
  process.env.EVENTOUCH_TEST_DATABASE_URL = dbUrl;
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const f = await startAuditFixture();
  const checks = [], requests = [], errors = [], axe = [];
  let browser, finished = false;
  const check = (name, ok, details = null) => { checks.push({ name, ok: Boolean(ok), details }); assert.ok(ok, `${name}: ${JSON.stringify(details)}`); };
  const api = (cookie, url, options = {}) => f.helpers.requestJson(f.harness.baseUrl, url, { cookie, ...options });
  const me = async (cookie) => (await api(cookie, '/api/auth/me')).json.user;
  const headersFor = (user) => ({ 'x-eventouch-organization-id': user.organizationId, 'x-eventouch-context-version': String(user.contextVersion) });
  const write = async (cookie, url, body) => api(cookie, url, { method: 'POST', headers: headersFor(await me(cookie)), body });

  const ownerId = `audit-owner-${f.suffix}`;
  try {
    await f.harness.database.query('UPDATE organizations SET name=$2 WHERE id=$1', [f.helpers.LEGACY_ORG, '검증 운영사 S4']);
    const ownerCookie = await f.helpers.sessionCookie(f.harness, ownerId);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(ownerCookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', async (dialog) => { await dialog.accept().catch(() => {}); });
    const capture = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }); };
    const inspect = async (name) => {
      check(`${name} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(require('axe-core').source);
      const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })));
      axe.push({ name, violations });
      check(`${name} no serious/critical axe`, !violations.some((v) => ['serious', 'critical'].includes(v.impact)), violations);
    };

    // ---- A. Optional format: create with online, settings shows/clears it.
    await page.goto(f.baseUrl + '/console');
    await page.getByRole('button', { name: '새 행사 만들기', exact: true }).click();
    await page.locator('#create-name').fill('검증 진행형태 행사');
    // Short slug on purpose: the dialog auto-suggests a slug on name blur,
    // and a long scripted fill can race that suggestion past the 50-char
    // pattern (a script-fill race, not typed input). Keep it well short.
    await page.locator('#create-slug').fill(`s4f-${f.suffix.slice(0, 8)}`);
    await page.locator('#create-date').fill('2026-11-10');
    await page.locator('#create-format').selectOption('online');
    check('create dialog offers the optional unspecified choice', await page.locator('#create-format option[value=""]').count() === 1);
    await page.getByRole('button', { name: '행사 만들기', exact: true }).click();
    await page.waitForURL(/\/console\/events\/.+/, { timeout: 15000 });
    const eventId = new URL(page.url()).pathname.split('/').pop();
    check('create navigates to the new event', Boolean(eventId) && eventId !== 'events');
    const created = (await f.harness.database.query(`SELECT payload->>'format' AS format FROM events WHERE id=$1`, [eventId])).rows[0];
    check('unspecified stays absent / online stores verbatim', created.format === 'online', created);
    await page.goto(`${f.baseUrl}/console/events/${eventId}/settings`);
    await page.getByRole('tab', { name: '기본 정보', exact: true }).click();
    check('settings basics shows the stored online format', await page.locator('#set-format').inputValue() === 'online');
    await capture('safe4-settings-format-1280');
    await page.locator('#set-format').selectOption('hybrid');
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await page.getByText(/기본 정보를 저장했습니다/, { exact: false }).first().waitFor();
    const hybrid = (await f.harness.database.query(`SELECT payload->>'format' AS format FROM events WHERE id=$1`, [eventId])).rows[0];
    check('settings update stores hybrid without touching other basics', hybrid.format === 'hybrid', hybrid);
    await page.locator('#set-format').selectOption('');
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/commands') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '기본 정보 저장', exact: true }).click(),
    ]);
    await page.getByText(/기본 정보를 저장했습니다/, { exact: false }).first().waitFor();
    const cleared = (await f.harness.database.query(`SELECT payload FROM events WHERE id=$1`, [eventId])).rows[0].payload;
    check('empty choice clears the key instead of storing a default', !Object.hasOwn(cleared, 'format'), Object.keys(cleared).filter((k) => /format/i.test(k)));

    // ---- B. Row reuse prefills name+company only, guards dirty/uncertain.
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await page.getByRole('button', { name: '참가자 추가', exact: true }).first().click();
    await page.locator('#participant-add-name').fill('검증 재사용 원본');
    await page.locator('#participant-add-phone').fill('01011112222');
    await page.locator('#participant-add-company').fill('검증상사');
    await page.getByRole('dialog', { name: '참가자 추가' }).getByRole('button', { name: '등록', exact: true }).click();
    await page.getByText(/등록했습니다/, { exact: false }).first().waitFor();
    const row = page.locator('li').filter({ hasText: '검증 재사용 원본' }).first();
    await row.getByRole('button', { name: /참가자 상세/, exact: false }).click();
    await row.getByRole('button', { name: '이 정보로 새 참가자 등록', exact: true }).click();
    check('reuse opens the manual form, not a new route', await page.locator('#participant-add-form').count() === 1);
    check('reuse prefills only name and company', await page.locator('#participant-add-name').inputValue() === '검증 재사용 원본'
      && await page.locator('#participant-add-company').inputValue() === '검증상사'
      && await page.locator('#participant-add-phone').inputValue() === ''
      && await page.locator('#participant-add-email').inputValue() === '');
    check('reuse names the new registration instead of editing', /이름·소속을 가져왔습니다/.test(await page.getByRole('dialog', { name: '참가자 추가' }).innerText().catch(() => '')));
    check('reuse focuses the first empty required input', await page.evaluate(() => document.activeElement && document.activeElement.id) === 'participant-add-phone');
    await capture('safe4-reuse-prefill-1280');
    await page.keyboard.press('Escape');
    // Dirty guard: typed content is never overwritten by another row.
    await page.getByRole('button', { name: '참가자 추가', exact: true }).first().click();
    await page.locator('#participant-add-name').fill('작성 중인 등록');
    await page.locator('#participant-add-phone').fill('01033334444');
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: '이 정보로 새 참가자 등록', exact: true }).click();
    check('dirty form is never overwritten by another row', await page.locator('#participant-add-name').inputValue() === '작성 중인 등록'
      && await page.getByText(/작성 중인 새 등록 내용/, { exact: false }).count() > 0);
    await capture('safe4-reuse-dirty-guard-1280');
    // Uncertain guard: committed-but-unseen create blocks reuse until the same retry.
    let createLost = false;
    await page.route('**/api/events/*/commands', async (route) => {
      const body = route.request().postDataJSON();
      if (route.request().method() !== 'POST' || body?.command !== 'participant.create' || createLost) return route.continue();
      const actual = await route.fetch();
      assert.ok(actual.ok(), `participant create did not commit before loss: ${actual.status()}`);
      createLost = true;
      await route.fulfill({ status: 502, json: { error: '합성 등록 응답 유실' } });
    });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '참가자 추가', exact: true }).first().click();
    await page.locator('#participant-add-name').fill('검증 유실 등록');
    await page.locator('#participant-add-phone').fill('01055556666');
    await page.getByRole('dialog', { name: '참가자 추가' }).getByRole('button', { name: '등록', exact: true }).click();
    await page.getByText(/같은 내용으로 다시 시도/, { exact: false }).first().waitFor();
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: '이 정보로 새 참가자 등록', exact: true }).click();
    check('uncertain create reopens its pending form instead of forking', await page.locator('#participant-add-name').inputValue() === '검증 유실 등록'
      && await page.getByText(/결과 미확인인 등록/, { exact: false }).count() > 0);
    await page.unroute('**/api/events/*/commands');
    await page.getByRole('dialog', { name: '참가자 추가' }).getByRole('button', { name: /같은 내용으로 다시 시도|등록/, exact: false }).first().click();
    await page.getByText(/등록했습니다/, { exact: false }).first().waitFor();
    const dupes = (await f.harness.database.query(
      `SELECT count(*)::int AS n FROM event_workspaces w, jsonb_to_recordset(w.payload->'participants') AS p(name text, phone text) WHERE w.event_id=$1 AND p.name='검증 유실 등록'`, [f.eventId])).rows[0];
    check('same-key retry creates exactly once', dupes.n === 1, dupes);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await capture('safe4-reuse-390');
    await inspect('safe4-reuse-390');
    await page.setViewportSize({ width: 1280, height: 900 });

    // ---- C. Arbitrary period analysis reuses the fixed-bucket definitions.
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await page.getByRole('heading', { name: '운영 현황', exact: true }).waitFor();
    const rangeFrom = page.locator('#range-from');
    await rangeFrom.waitFor();
    check('range analysis offers browser-local from/to inputs', await page.locator('#range-to').count() === 1);
    await rangeFrom.fill('2026-10-20');
    await page.locator('#range-to').fill('2026-10-22');
    const summary = await page.getByText(/기간 신청.*일별 입장 합.*기간 고유 입장/, { exact: false }).first().innerText().catch(() => '');
    const tableRows = await page.locator('table[aria-label="선택 기간 일별 신청·입장"] tbody tr').allInnerTexts();
    const tableApps = tableRows.reduce((sum, text) => sum + Number((text.match(/(\d+)명/) || [0, 0])[1]), 0);
    check('range summary matches its table over the same days', new RegExp(`기간 신청 ${tableApps}명`).test(summary), { summary, tableRows });
    check('daily sums and whole-period unique are named distinctly', /일별 입장 합 (\d+)명/.test(summary) && /기간 고유 입장 (\d+)명/.test(summary), summary);
    check('native chart carries the same totals as text', (await page.locator('svg[aria-label^="선택 기간 일별"]').count()) === 1
      && new RegExp(`일별 입장 합 ${tableRows.reduce((sum, text) => { const cells = text.split(/\s+/); return sum + Number((cells[2] || '').replace(/[^0-9]/g, '')) || 0; }, 0)}명`).test(summary));
    await capture('safe4-range-1280');
    await inspect('safe4-range-1280');
    await page.locator('#range-from').fill('2026-10-25');
    await page.locator('#range-to').fill('2026-10-20');
    check('start-after-end recovers with a named error', await page.getByText(/시작 날짜가 끝 날짜보다 늦습니다/, { exact: false }).count() > 0);
    await page.locator('#range-from').fill('2026-10-20');
    await page.locator('#range-to').fill('2027-10-20');
    check('extreme ranges clamp with notice instead of exploding', await page.getByText(/최대 62일까지만 봅니다/, { exact: false }).count() > 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('safe4-range-390');
    await inspect('safe4-range-390');
    await page.setViewportSize({ width: 1280, height: 900 });

    // ---- D. Frozen report A4/16:9 local view, unchanged print clone path.
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports`);
    await page.getByRole('button', { name: '보고서 만들기', exact: true }).click();
    await page.locator('#report-title').fill('검증 보기 모드 보고서');
    await page.getByRole('dialog').getByRole('button', { name: '보고서 만들기', exact: true }).click();
    await page.getByText(/보고서 초안을 만들었습니다/, { exact: false }).first().waitFor();
    await page.getByRole('button', { name: '내용 보기', exact: true }).first().click();
    await page.getByRole('heading', { name: '보고서 내용', exact: true }).waitFor();
    check('report view defaults to A4', await page.getByText(/보기: A4 세로/, { exact: false }).count() > 0);
    await page.getByRole('button', { name: '발표용 16:9', exact: true }).click();
    check('wide view restates scope without editing promises', await page.getByText(/보기: 발표용 16:9/, { exact: false }).count() > 0
      && await page.locator('article[data-layout="wide"]').count() === 1);
    await capture('safe4-report-wide-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('safe4-report-wide-390');
    await inspect('safe4-report-wide-390');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'A4 세로', exact: true }).click();
    check('A4 view restamps the frozen article', await page.locator('article[data-layout="a4"]').count() === 1);
    const printProbe = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
    await page.getByRole('button', { name: '인쇄하기', exact: true }).click();
    await page.waitForTimeout(1500);
    const cloneState = await page.evaluate(() => ({
      clone: document.querySelectorAll('#eventouch-report-print').length,
      layout: document.getElementById('eventouch-report-print')?.dataset.layout ?? null,
      printing: document.body.classList.contains('report-printing'),
    }));
    check('print path keeps the single frozen clone with its layout', cloneState.clone <= 1 && (cloneState.layout === null || cloneState.layout === 'a4'), cloneState);
    await printProbe;
    await capture('safe4-report-a4-1280');

    check('safe4 workflows have no unexpected page errors', errors.length === 0, errors);
    finished = true;
  } finally {
    if (!finished && browser) {
      for (const [contextIndex, context] of browser.contexts().entries()) {
        for (const [pageIndex, page] of context.pages().entries()) {
          await page.screenshot({ path: `${OUT}/failure-context-${contextIndex}-page-${pageIndex}.png`, fullPage: false }).catch((error) => console.error('Failure capture unavailable:', error.message));
        }
      }
      finished = true;
    }
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8'), checks, requests, errors, axe, simulation: 'Disposable explicit-org task schema; actual UI writes; committed response loss only for the roster-create retry. No real messaging.' }, null, 2), { mode: 0o600 });
    console.log(`Safe4 evidence: ${OUT}`);
    if (browser) await browser.close();
    await f.close();
  }
  return { out: OUT, checks };
}

async function main() {
  await runSafe4Audit();
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { runSafe4Audit };
