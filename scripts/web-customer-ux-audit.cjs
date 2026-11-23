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
const { messageStep, openSettingsBasics, openRecipientList, openMessageMore } = require('./ui-journey-helpers.cjs');
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
      await page.locator('#settings-stage').waitFor();
      check(`settings@${width}: sections stay mounted`, await page.locator('[data-settings-section]').count() === 4);
      await page.getByRole('button', { name: '수정', exact: true }).click();
      await page.locator('#set-name').waitFor();
      const original = await page.locator('#set-name').inputValue();
      await page.locator('#set-name').fill(`${original} 미저장`);
      await page.locator('#settings-stage').scrollIntoViewIfNeeded();
      check(`settings@${width}: stage deep link`, new URL(page.url()).hash === '#settings-stage' || await page.locator('#settings-stage').isVisible());
      check(`settings@${width}: drawer retains draft`, await page.locator('#set-name').inputValue() === `${original} 미저장`);
      await page.locator('#set-name').fill(original);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: '기본 정보' }).waitFor({ state: 'hidden', timeout: 15000 });
      check(`settings@${width}: Escape closes the drawer onto its trigger`, await page.getByRole('button', { name: '수정', exact: true }).evaluate(el => el === document.activeElement));
      await page.getByRole('button', { name: '수정', exact: true }).click();
      await page.locator('#set-name').waitFor();
      await capture('settings', width);

      await page.goto(`${base}/participants`);
      const firstRow = width > 768 ? page.getByRole('table', { name: /참가자 목록/ }).locator('tbody tr').first() : page.locator('li[class*="participantRow"]').first();
      await firstRow.waitFor();
      // Reopened 2026-11-20: 좁은 폭의 명단 행은 이름·소속·상태·승인만 두고 연락처 열을 숨긴다(참가자 명단 확정 시안). 연락처는 참가자 상세 시트에서
      // 같은 마스킹 형식으로 보이므로, 넓은 폭은 행의 연락처 열, 좁은 폭은 상세 시트에서 '승인 전에 마스킹된 연락처가 보인다'를 확인한다.
      if (width > 768) {
        check(`participants@${width}: masked contact visible before approval`, await firstRow.locator('td[class*="rosterContact"]').evaluateAll(elements => elements.some(el => el.getClientRects().length > 0 && /010-\*{4}-\d{4}/.test(el.textContent))));
      } else {
        await firstRow.getByRole('button', { name: /참가자 상세/ }).click();
        const detail = page.getByRole('dialog');
        await detail.waitFor();
        check(`participants@${width}: masked contact visible before approval`, /010-\*{4}-\d{4}/.test(await detail.innerText()));
        await page.keyboard.press('Escape');
        await detail.waitFor({ state: 'hidden' });
      }
      check(`participants@${width}: approval and details remain available together`, await firstRow.getByRole('button', { name: '승인', exact: true }).isVisible() && await firstRow.getByRole('button', { name: /참가자 상세/ }).isVisible());
      await capture('participants', width);

      await page.goto(`${base}/messages`);
      await page.locator('#message-compose-open').click();
      // Reopened 2026-11-24 (owner: 시안 A): one sentence with folded panels. Open 받는 사람 → 직접 고르기, pick a
      // recipient, write the body, and check the same intent at the end (the send dock never covers the send summary above it).
      const recipientDetails = page.locator('#campaign-recipients details');
      await openRecipientList(page);
      await recipientDetails.locator('ul input[type="checkbox"]').first().check();
      await messageStep(page, 2);
      await openMessageMore(page);
      await page.locator('#campaign-title').fill('검수 안내');
      await page.locator('#campaign-body').fill('행사 안내를 확인해 주세요.');
      check(`messages@${width}: delivery limit visible without opening help`, await page.getByText('발송 연결 · 미연동 · 실제 전달 안 됨', { exact: true }).isVisible());
      await messageStep(page, 3);
      // Reopened 2026-11-24 (시안 A): the 발송 검토 button lives in a sticky dock (an opaque strip that keeps it in reach
      // while writing). At the end of the form the dock must sit below the send summary, never over it.
      const geometry = await page.locator('#campaign-submit').evaluate(el => {
        const dock = el.closest('[class*="sendDock"]');
        // Scroll every scroller to its end: a sticky element is already "in view", so scrollIntoView would not move it.
        for (let node = dock.parentElement; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
        window.scrollTo(0, document.documentElement.scrollHeight);
        const area = dock.parentElement.querySelector('[class*="sendArea"]');
        const style = getComputedStyle(dock);
        return { position: style.position, background: style.backgroundColor, dockTop: dock.getBoundingClientRect().top, areaBottom: area.getBoundingClientRect().bottom, areaHeight: area.getBoundingClientRect().height };
      });
      check(`messages@${width}: review dock never covers the send summary above it`, geometry.position === 'sticky' && geometry.background !== 'rgba(0, 0, 0, 0)' && geometry.areaHeight > 0 && geometry.dockTop >= geometry.areaBottom - 1, geometry);
      await capture('messages', width);

      await page.goto(`${base}/reports`);
      await page.locator('#reports-list').waitFor();
      // Reopened 2026-11-20: 결과 보고서 최종안은 보고서 이름 탭을 고르면 그 문서(표지·집계 기준)가 바로 한 화면에 열린다.
      // 이전의 '내용 보기' 버튼으로 따로 여는 단계는 없으므로, 먼저 보고서를 골라 같은 사실(고정 시각·상세 열림)을 확인한다.
      await page.getByRole('tab', { name: /고객 검수용 결과 보고서/ }).click();
      await page.locator('#report-detail').waitFor();
      const localTimestamp = await page.evaluate(value => new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(value)), frozenReport.report.snapshot.capturedAt);
      // Reopened 2026-11-20: 결과 보고서 최종안은 '버전 1 · 집계 기준 …' 한 줄 대신 문서 표지에 '집계 기준 …'을 따로 둔다(버전은 보고서 이름 옆이 아니라 내보내기·마감 안내에 있음).
      check(`reports@${width}: frozen timestamp uses browser timezone`, await page.getByText(`집계 기준 ${localTimestamp}`, { exact: true }).first().isVisible());
      check(`reports@${width}: saved deliverables precede live analysis`, await page.locator('#reports-list').evaluate(el => !!(el.compareDocumentPosition(document.getElementById('reports-analysis')) & Node.DOCUMENT_POSITION_FOLLOWING)));
      const breakdown = page.locator('details').filter({ has: page.getByText('그룹·부스·프로그램별 상세 집계', { exact: true }) });
      check(`reports@${width}: long breakdown initially folded`, !await breakdown.evaluate(el => el.open));
      await capture('reports', width);
      await breakdown.locator('summary').focus();
      await page.keyboard.press('Enter');
      check(`reports@${width}: all detail remains keyboard-accessible`, await breakdown.getByRole('heading', { name: '등록 그룹', exact: true }).isVisible());
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
    await page.getByRole('button', { name: '수정', exact: true }).click();
    await page.locator('#set-name').fill('납품 전 검수 행사');
    await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click();
    // Reopened 2026-11-20: 저장 결과는 드로어가 닫힌 뒤 설정 하단의 '최근 결과' 줄에 '메시지 · HH:MM'으로 남는다(시각이 붙어 정확히 일치하지 않음).
    await page.getByText('기본 정보를 저장했습니다.', { exact: false }).first().waitFor();
    await page.reload();
    // Reopened 2026-11-20: 기본 정보 입력칸은 드로어 안에 있으므로 다시 열어 저장된 값을 읽는다.
    await openSettingsBasics(page);
    check('settings: save persists after reload', await page.locator('#set-name').inputValue() === '납품 전 검수 행사');

    // Simulated delivery only; explicit review must precede the real command.
    await page.goto(`${base}/messages`);
    await page.locator('#message-compose-open').click();
    // Reopened 2026-11-24 (시안 A): 받는 사람 panel → 직접 고르기 list → body → review; the title is optional, under 더 보기.
    const recipients = page.locator('#campaign-recipients details');
    await openRecipientList(page);
    await recipients.locator('ul input[type="checkbox"]').first().check();
    await messageStep(page, 2);
    await openMessageMore(page);
    await page.locator('#campaign-title').fill('검수 안내');
    await page.locator('#campaign-body').fill('행사 안내를 확인해 주세요.');
    await messageStep(page, 3);
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
      // Reopened 2026-11-20: 운영 현황 캔버스는 data-live 대신 data-stage(prep·live·done)로 단계를 나타낸다. 같은 실제 단계 반영을 DRAFT·READY=prep, LIVE=live, ENDED·ARCHIVED=done으로 확인한다.
      const expectedStage = ['DRAFT', 'READY'].includes(stage) ? 'prep' : stage === 'LIVE' ? 'live' : 'done';
      check(`overview ${stage}: monitor reflects actual stage`, await page.locator('[data-stage]').first().getAttribute('data-stage') === expectedStage);
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
