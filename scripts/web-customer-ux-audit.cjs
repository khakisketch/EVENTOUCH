'use strict';

// Pre-delivery UX regression: real product routes, isolated synthetic data.
// This is browser-driven validation, NOT a real-customer usability study.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const axe = require('axe-core').source;
const OUT = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'customer-ux')
  : defaultCaptureDir(`customer-ux-${runStamp()}`);

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const checks = [], errors = [];
  const buildId = fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim();
  let completed = false;
  const check = (name, ok, detail = null) => { checks.push({ name, ok: !!ok, detail }); assert.ok(ok, `${name}: ${JSON.stringify(detail)}`); };
  let f, browser;
  try {
    f = await startAuditFixture();
    const base = `${f.baseUrl}/console/events/${f.eventId}`;
    const command = async (command, payload) => {
      const res = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res));
      return res.json;
    };
    const bootstrap = async () => (await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: f.manager.cookie })).json.state;
    const people = (await bootstrap()).workspaces[f.eventId].participants;
    await command('participant.status', { ids: people.slice(0, 2).map(p => p.id), status: 'PENDING' });
    const frozenReport = await command('report.create', { title: '고객 검수용 결과 보고서', sections: ['overview', 'attendance'], color: '#F05A24' });
    browser = await launchBrowser();
    const context = await browser.newContext({ reducedMotion: 'reduce', timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(f.manager.cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const capture = async (name, width) => {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, `${name}-${width}-viewport.png`), fullPage: false });
      await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(`${name}@${width}: no document overflow`, overflow <= 1, overflow);
      await page.evaluate(axe);
      const violations = (await page.evaluate(async () => (await window.axe.run()).violations)).filter(v => ['moderate', 'serious', 'critical'].includes(v.impact));
      check(`${name}@${width}: axe moderate+`, violations.length === 0, violations.map(v => v.id));
    };

    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await page.goto(`${base}/settings`);
      await page.locator('#set-name').waitFor();
      const tabs = page.getByRole('tablist', { name: '행사 설정 구역' }).getByRole('tab');
      check(`settings@${width}: four visible 44px destinations`, await tabs.evaluateAll(elements => elements.length === 4 && elements.every(el => {
        const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height >= 44 && el.scrollWidth <= el.clientWidth + 1;
      })));
      const original = await page.locator('#set-name').inputValue();
      await page.locator('#set-name').fill(`${original} 미저장`);
      await page.getByRole('tab', { name: '진행 단계', exact: false }).click();
      await page.locator('#settings-stage').waitFor();
      check(`settings@${width}: stage deep link`, new URL(page.url()).hash === '#settings-stage');
      await page.getByRole('tab', { name: '기본 정보', exact: false }).click();
      check(`settings@${width}: tab switch retains draft`, await page.locator('#set-name').inputValue() === `${original} 미저장`);
      await page.locator('#set-name').fill(original);
      await page.getByRole('tab', { name: '기본 정보', exact: false }).focus();
      await page.keyboard.press('End');
      check(`settings@${width}: keyboard reaches last tab`, await page.getByRole('tab', { name: '진행 단계', exact: false }).evaluate(el => el === document.activeElement && el.getAttribute('aria-selected') === 'true'));
      await page.getByRole('tab', { name: '기본 정보', exact: false }).click();
      await capture('settings', width);

      await page.goto(`${base}/participants`);
      const firstRow = width > 768 ? page.getByRole('table', { name: /참가자 목록/ }).locator('tbody tr').first() : page.locator('li[class*="participantRow"]').first();
      await firstRow.waitFor();
      check(`participants@${width}: masked contact visible before approval`, await firstRow.locator('small[class*="mobileContact"], td[class*="rosterContact"]').evaluateAll(elements => elements.some(el => el.getClientRects().length > 0 && /010-\*{4}-\d{4}/.test(el.textContent))));
      check(`participants@${width}: approval and details remain available together`, await firstRow.getByRole('button', { name: '승인', exact: true }).isVisible() && await firstRow.getByRole('button', { name: /참가자 상세/ }).isVisible());
      await capture('participants', width);

      await page.goto(`${base}/messages`);
      await page.locator('#message-compose-open').click();
      await page.locator('#campaign-title').waitFor();
      check(`messages@${width}: delivery limit visible without opening help`, await page.getByText('발송 연결 · 미연동 · 실제 전달 안 됨', { exact: true }).isVisible());
      const recipientDetails = page.locator('#campaign-recipients details');
      if (!await recipientDetails.evaluate(el => el.open)) await recipientDetails.locator('summary').click();
      const geometry = await page.locator('#campaign-submit').evaluate(el => {
        const bar = el.closest('[class*="reviewBar"]');
        const recipients = document.getElementById('campaign-recipients');
        const draft = document.querySelector('[class*="composeDraft"]');
        return { position: getComputedStyle(bar).position, reviewTop: bar.getBoundingClientRect().top, recipientsBottom: recipients.getBoundingClientRect().bottom, draftBottom: draft.getBoundingClientRect().bottom };
      });
      check(`messages@${width}: review never covers recipients or draft`, geometry.position === 'static' && geometry.reviewTop >= Math.max(geometry.recipientsBottom, geometry.draftBottom), geometry);
      await capture('messages', width);

      await page.goto(`${base}/reports`);
      await page.locator('#reports-list').waitFor();
      const localTimestamp = await page.evaluate(value => new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(value)), frozenReport.report.snapshot.capturedAt);
      check(`reports@${width}: frozen timestamp uses browser timezone`, await page.getByText(`버전 1 · 집계 기준 ${localTimestamp}`, { exact: true }).isVisible());
      check(`reports@${width}: saved deliverables precede live analysis`, await page.locator('#reports-list').evaluate(el => !!(el.compareDocumentPosition(document.getElementById('reports-analysis')) & Node.DOCUMENT_POSITION_FOLLOWING)));
      const breakdown = page.locator('details').filter({ has: page.getByText('그룹·부스·프로그램별 상세 집계', { exact: true }) });
      check(`reports@${width}: long breakdown initially folded`, !await breakdown.evaluate(el => el.open));
      await capture('reports', width);
      await breakdown.locator('summary').focus();
      await page.keyboard.press('Enter');
      check(`reports@${width}: all detail remains keyboard-accessible`, await breakdown.getByRole('heading', { name: '등록 그룹', exact: true }).isVisible());
      await page.getByRole('button', { name: '내용 보기', exact: true }).click();
      await page.locator('#report-detail').waitFor();
      check(`reports@${width}: frozen detail opens`, await page.locator('[data-layout]').first().isVisible());
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/participants`);
    const pendingRow = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `${people[0].name} 선택`, exact: true }) });
    await pendingRow.getByRole('button', { name: '승인', exact: true }).click();
    await page.getByText(`${people[0].name} 상태를 참가 확정`, { exact: false }).first().waitFor();
    check('participants: explicit approval persisted', (await bootstrap()).workspaces[f.eventId].participants.find(p => p.id === people[0].id).status === 'APPROVED');
    await page.reload();
    await page.locator('#roster-search').waitFor();
    check('participants: approval survives re-entry', !await page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `${people[0].name} 선택`, exact: true }) }).getByRole('button', { name: '승인', exact: true }).count());

    // An actual save, reload and re-entry, not a local optimistic label.
    await page.goto(`${base}/settings`);
    await page.locator('#set-name').fill('납품 전 검수 행사');
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    await page.getByText('기본 정보를 저장했습니다.', { exact: true }).first().waitFor();
    await page.reload();
    check('settings: save persists after reload', await page.locator('#set-name').inputValue() === '납품 전 검수 행사');

    // Simulated delivery only; explicit review must precede the real command.
    await page.goto(`${base}/messages`);
    await page.locator('#message-compose-open').click();
    await page.locator('#campaign-title').fill('검수 안내');
    await page.locator('#campaign-body').fill('행사 안내를 확인해 주세요.');
    const recipients = page.locator('#campaign-recipients details');
    if (!await recipients.evaluate(el => el.open)) await recipients.locator('summary').click();
    await recipients.locator('ul input[type="checkbox"]').first().check();
    await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
    const beforeMessages = (await bootstrap()).workspaces[f.eventId].messages.length;
    await page.locator('#campaign-submit').click();
    await page.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).waitFor();
    check('messages: review alone never sends', (await bootstrap()).workspaces[f.eventId].messages.length === beforeMessages);
    await page.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
    await page.getByText('모의 발송을 기록했습니다', { exact: false }).first().waitFor();
    const messages = (await bootstrap()).workspaces[f.eventId].messages;
    check('messages: confirmed simulation is recorded once', messages.length === beforeMessages + 1 && messages.some(m => m.title === '검수 안내' && m.simulate === true));

    // Display-state fixtures only: no claim of testing real event time passage.
    for (const stage of ['DRAFT', 'READY', 'LIVE', 'ENDED', 'ARCHIVED']) {
      await f.harness.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}',to_jsonb($1::text)) WHERE id=$2", [stage, f.eventId]);
      await page.goto(base);
      await page.locator('#event-metrics-heading').waitFor();
      check(`overview ${stage}: monitor reflects actual stage`, await page.locator('[data-live]').getAttribute('data-live') === String(stage === 'LIVE'));
      if (stage === 'DRAFT' || stage === 'ENDED') await capture(`overview-${stage.toLowerCase()}`, 320);
    }
    check('runtime page errors', errors.length === 0, errors);
    check('same build throughout the review', fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim() === buildId);
    completed = true;
  } finally {
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({
      buildId, completed,
      disclosures: ['synthetic isolated PostgreSQL fixture', 'Chromium browser interaction; not a real-user study', 'simulation only; no external message delivery'],
      checks, errors,
    }, null, 2), { mode: 0o600 });
    if (browser) await browser.close();
    if (f) await f.close();
  }
  console.log(`[customer-ux] ${checks.length} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
