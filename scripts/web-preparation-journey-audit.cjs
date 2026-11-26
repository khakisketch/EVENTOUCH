'use strict';

// Real isolated API/PostgreSQL journey, not the static proposal. --before
// measures the incumbent build with the same data/actions. No deployed data.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const BEFORE = process.argv.includes('--before');
const ROOT = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`round-preparation-${runStamp()}`);
const OUT = path.join(ROOT, BEFORE ? 'before' : 'after');
const OPERATOR_CAP = 12;
const KEYBOARD_CAP = 40;

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const checks = [], renders = [], journeys = [], errors = [], states = [];
  const check = (name, ok, detail = null) => {
    checks.push({ name, ok: Boolean(ok), detail });
    assert.ok(ok, `${name}: ${JSON.stringify(detail)}`);
  };
  let f, browser, failure;
  try {
    f = await startAuditFixture();
    browser = await launchBrowser();
    const bootstrap = async () => (await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: f.manager.cookie })).json.state;
    for (const width of [1280, 390]) {
      const id = `${f.eventId}-preparation-${width}`;
      const base = `/console/events/${id}`;
      const slug = `preparation-${width}-${f.suffix.slice(0, 12)}`;
      await f.helpers.insertEvent(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id, slug,
        payload: { id, slug, name: '모집 준비 흐름 검증 행사', stage: 'DRAFT', date: '2027-01-16', start: '09:00', end: '17:00', capacity: 100, features: [] },
        workspace: f.helpers.emptyWorkspace(),
      });
      await f.helpers.insertMembership(f.harness.database, f.manager.id, id, ['all']);
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(f.manager.cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', e => errors.push(e.message));
      const writes = [];
      page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === `/api/events/${id}/commands`) writes.push(JSON.parse(r.postData())); });
      const ledger = { pathname: null, paths: [], changes: 0 };
      page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return;
        const pathname = new URL(frame.url()).pathname;
        if (pathname !== ledger.pathname) {
          if (ledger.pathname !== null) ledger.changes += 1;
          ledger.paths.push(pathname); ledger.pathname = pathname;
        }
      });
      const snapshot = async label => {
        const s = await bootstrap();
        const event = s.events.find(e => e.id === id), workspace = s.workspaces[id];
        const pub = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${slug}`);
        const state = { width, label, stage: event.stage, registrationOpen: workspace.registrationOpen,
          formVersion: workspace.publishedVersion, homeDesignPublished: Boolean(workspace.pageExperience?.publishedAt),
          publicStatus: pub.status, desks: workspace.desks.length, assignments: workspace.assignments.length };
        states.push(state); return state;
      };
      const capture = async label => {
        await page.screenshot({ path: `${OUT}/${width}-${label}.png`, fullPage: true });
        await page.screenshot({ path: `${OUT}/${width}-${label}-viewport.png`, fullPage: false });
        const measure = await page.evaluate(() => ({ height: document.documentElement.scrollHeight,
          overflow: document.documentElement.scrollWidth - innerWidth,
          visibleHeadings: [...document.querySelectorAll('main h2')].filter(e => e.getClientRects().length).map(e => e.textContent),
          visibleInputs: [...document.querySelectorAll('main input,main textarea,main select')].filter(e => e.getClientRects().length).length,
          stageSettingsDocumentTop: (() => { const e = document.querySelector('main a[href$="/settings#settings-stage"]'); return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null; })(),
          intakeSettingsDocumentTop: (() => { const e = [...document.querySelectorAll('main a')].find(e => e.textContent === '접수 설정'); return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null; })(),
        }));
        renders.push({ width, label, ...measure });
        check(`${width} ${label} no overflow`, measure.overflow <= 0, measure);
      };
      const phase = async (name, fn) => {
        const task = { width, name, operations: 0, pathChanges: 0, scrollEvents: null, backs: 0 };
        const start = ledger.changes;
        const act = async fn => { task.operations += 1; await fn(); };
        await fn(act);
        task.pathChanges = ledger.changes - start;
        journeys.push(task);
        check(`${width} ${name} unchanged 12-step cap`, task.operations <= OPERATOR_CAP, task);
      };
      const overview = async () => { await page.locator('#event-metrics-heading').waitFor(); };
      const toOverview = async act => {
        const target = BEFORE ? page.locator(`.console-subnav-item[href="${base}"]:visible`).first() : page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first();
        await act(() => target.click()); await overview();
      };
      const toStage = async act => {
        await act(() => page.locator(`main a[href="${base}/settings#settings-stage"]`).first().click());
        await page.locator('#settings-stage').waitFor({ state: 'visible', timeout: 15000 });
        if (BEFORE) {
          const d = page.locator('details[data-settings-collapse="stage"]');
          if (!await d.evaluate(e => e.open)) await act(() => d.locator('summary').click());
        } else check(`${width} stage deeplink lands on its section`, await page.locator('#panel-settings-stage:visible').count() === 1);
      };
      await page.goto(f.baseUrl + base); await overview();
      let s = await snapshot('draft-overview');
      check(`${width} DRAFT public stage gate`, s.stage === 'DRAFT' && s.publicStatus === 404 && !s.registrationOpen && !s.homeDesignPublished, s);
      await capture('01-draft-overview');
      if (!BEFORE) {
        check(`${width} draft does not offer broken public link`, await page.getByRole('link', { name: '참가자 페이지 열기', exact: true }).count() === 0);
        check(`${width} counts form three peers plus the capacity share`, await page.locator(':is(section,[role="region"])[aria-labelledby="event-metrics-heading"] a[class*="_chip"]').count() === 4, await page.locator(':is(section,[role="region"])[aria-labelledby="event-metrics-heading"]').innerText());
      }
      await phase('DRAFT → READY → 현황 재확인', async act => {
        await toStage(act);
        await capture('02-stage-settings');
        await act(() => page.getByRole('button', { name: '운영 준비 단계로 전환', exact: true }).click());
        check(`${width} transition review does not write`, (await snapshot('ready-confirm')).stage === 'DRAFT');
        await act(() => page.getByRole('button', { name: '정말 전환합니다 · 운영 준비 단계로', exact: true }).click());
        await page.getByText('행사를 운영 준비 단계로 전환했습니다.', { exact: true }).waitFor();
        await page.getByRole('button', { name: '진행 중 단계로 전환', exact: true }).waitFor();
        s = await snapshot('ready-settings');
        check(`${width} READY default home public without design`, s.stage === 'READY' && s.publicStatus === 200 && !s.registrationOpen && !s.homeDesignPublished, s);
        await capture('03-ready-result');
        await toOverview(act);
        s = await snapshot('ready-overview');
        check(`${width} overview return reads updated stage`, s.stage === 'READY' && (await page.locator('main').textContent()).includes('운영 준비'));
        if (!BEFORE) {
          check(`${width} sidebar and overview stage agree`, (await page.locator('.console-sidebar').textContent()).includes('운영 준비'));
          // Reopened 2026-11-25 (owner): 진행 중 전환 조건이 '데스크 + 스태프 배정'에서 '가동 중인 입장 데스크 하나'로 바뀌었다.
          check(`${width} next LIVE condition visible on overview`, (await page.locator('main').textContent()).includes('진행 중 단계로 넘어가기까지') && (await page.locator('main').textContent()).includes('가동 중인 입장 데스크가 없습니다'));
        }
        await capture('04-ready-overview');
      });
      const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const publicPage = await anon.newPage();
      await publicPage.goto(`${f.baseUrl}/event/${slug}/home`);
      await publicPage.getByRole('button', { name: '모바일 티켓' }).waitFor();
      if (BEFORE) {
        // Historical baseline: the old home exposed every tile regardless of
        // the event's enabled features. Keep it for comparing the old build.
        check(`${width} anonymous baseline home retains six tiles`, await publicPage.locator('button[class*="menuButton"]').count() === 6);
      } else {
        // This READY fixture intentionally has no optional features and no
        // custom home design. Its usable default menu is the ticket, the
        // notices entry and the application tile (the tile composition keeps
        // the application entry inside the menu grid); the separate
        // all-enabled web audit still exercises all six entries.
        const menu = publicPage.getByRole('navigation', { name: '참가 메뉴' });
        // The ticket card floats above the menu grid, outside the menu nav.
        check(`${width} anonymous default home shows ticket and notice`,
          await menu.getByRole('button').count() === 2
          && await publicPage.getByRole('button', { name: '모바일 티켓' }).isVisible()
          && await menu.getByRole('button', { name: '공지사항', exact: true }).isVisible()
          && await menu.getByRole('button', { name: '내 신청 정보', exact: true }).isVisible());
        for (const label of ['럭키드로우 번호', '룰렛 이벤트', '순위 투표', '부스 인증']) {
          check(`${width} anonymous default home hides disabled ${label}`,
            await menu.getByRole('button', { name: label, exact: true }).count() === 0);
        }
        check(`${width} anonymous default home offers application and event guide`,
          await publicPage.getByRole('button', { name: '내 신청 정보', exact: true }).isVisible()
          && await publicPage.getByRole('link', { name: '행사 안내 보기', exact: true }).isVisible());
        check(`${width} anonymous default home does not expose a ticket QR`,
          await publicPage.locator('[aria-label*="입장 및 퇴장용 QR"]').count() === 0);
      }
      await publicPage.screenshot({ path: `${OUT}/${width}-public-ready-default-home.png`, fullPage: true });
      await phase('접수 게시 → 현황 재확인', async act => {
        await act(() => page.getByRole('link', { name: '접수 설정', exact: true }).click());
        await page.locator('#set-consent').waitFor();
        if (!BEFORE) {
          check(`${width} intake deeplink lands on its section`, await page.locator('#panel-settings-intake:visible').count() === 1);
          const fieldLink = page.getByRole('link', { name: '신청 항목 편집', exact: true });
          check(`${width} field editing is a separate action`, await fieldLink.isVisible() && await fieldLink.evaluate(node => !node.closest('p')) && (await fieldLink.getAttribute('href')) === `${base}/settings/fields`);
          const contactLink = page.getByRole('link', { name: '장소 안내의 문의 정보', exact: true });
          check(`${width} recovery guidance keeps its action outside the sentence`, await contactLink.isVisible() && await contactLink.evaluate(node => {
            const paragraph = node.previousElementSibling;
            return paragraph?.tagName === 'P' && node.getBoundingClientRect().top >= paragraph.getBoundingClientRect().bottom;
          }));
        }
        const beforePublish = (await bootstrap()).workspaces[id];
        await act(() => page.locator('#set-consent').fill('행사 신청과 입장 확인을 위해 이름과 연락처를 사용합니다.'));
        await act(() => page.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click());
        await page.locator('[data-settings-section-status="intake"]').filter({ hasText: '양식을 게시하고 접수를 열었습니다.' }).waitFor();
        const afterPublish = (await bootstrap()).workspaces[id];
        check(`${width} consent publication advances public form version`, afterPublish.publishedVersion > beforePublish.publishedVersion && afterPublish.publishedVersion === afterPublish.formVersion);
        await page.getByText(`현재 접수 중 · 게시된 양식 버전 ${afterPublish.publishedVersion}`, { exact: false }).first().waitFor();
        await capture('05-intake-result');
        await toOverview(act);
        s = await snapshot('intake-open-overview');
        check(`${width} intake independent of custom design`, s.registrationOpen && s.formVersion === afterPublish.publishedVersion && s.publicStatus === 200 && !s.homeDesignPublished, s);
        check(`${width} returned overview refreshed intake`, (await page.locator('main').textContent()).includes('접수 중'));
        await capture('06-open-overview');
      });
      await publicPage.goto(`${f.baseUrl}/event/${slug}/register`);
      await publicPage.locator('form.registration-form').waitFor();
      await publicPage.screenshot({ path: `${OUT}/${width}-public-open-registration.png`, fullPage: true });
      await anon.close();
      await phase('다음 LIVE 전제 확인', async act => {
        await toStage(act);
        check(`${width} LIVE blocked without a running entry desk`, await page.getByRole('button', { name: '진행 중 단계로 전환', exact: true }).isDisabled());
        const reason = await page.locator('#settings-stage-precondition').textContent();
        // Reopened 2026-11-25: 사유는 가동 중인 입장 데스크 하나만 요구한다(배정·꾸미기는 전제가 아니다). 해결하러 갈 링크가 함께 있다.
        check(`${width} blocker is a running entry desk, not assignment or custom design`, reason.includes('입장 데스크를 하나 이상 가동하세요') && !reason.includes('배정') && !reason.includes('미게시'), reason);
        check(`${width} blocker links to the desk setup`, await page.getByRole('link', { name: '입장 데스크 열러 가기', exact: true }).getAttribute('href') === `${base}/operations`);
        s = await snapshot('next-live-blocked');
        check(`${width} blocked action writes no LIVE`, s.stage === 'READY' && s.desks === 0 && s.assignments === 0, s);
        await capture('07-live-blocked');
      });
      if (!BEFORE) {
        // Basics editing lives in a drawer, which is modal: open it to edit,
        // close it (Escape) before touching the page behind it, and reopen
        // it to inspect the preserved draft.
        const openBasics = async () => {
          await page.getByRole('button', { name: '수정', exact: true }).click();
          await page.locator('#set-name').waitFor({ state: 'visible', timeout: 15000 });
        };
        const closeBasics = async () => {
          await page.keyboard.press('Escape');
          await page.getByRole('dialog', { name: '기본 정보' }).waitFor({ state: 'hidden', timeout: 15000 });
        };
        await openBasics();
        await page.locator('#set-name').fill('저장 전 행사명 초안');
        await page.locator('#set-consent').fill('독립 저장 검증 동의 문구');
        check(`${width} dirty basics names itself on the card`, await page.locator('#panel-settings-basics [class*="unsavedTag"]').count() === 1);
        await closeBasics();
        check(`${width} Escape closes the drawer onto its trigger`, await page.getByRole('button', { name: '수정', exact: true }).evaluate(e => e === document.activeElement));
        await page.getByRole('button', { name: '변경 게시', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('#panel-settings-intake [class*="unsavedTag"]'));
        check(`${width} independent consent save persisted`, (await bootstrap()).workspaces[id].consentText === '독립 저장 검증 동의 문구');
        await openBasics();
        check(`${width} save elsewhere preserves basic draft`, await page.locator('#set-name').inputValue() === '저장 전 행사명 초안');
        await closeBasics();
        check(`${width} independent save did not commit basic draft`, (await bootstrap()).events.find(e => e.id === id).name === '모집 준비 흐름 검증 행사');
        page.once('dialog', d => d.dismiss());
        await page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first().click();
        await openBasics();
        check(`${width} dirty return cancellation keeps section and input`, new URL(page.url()).pathname.endsWith('/settings') && await page.locator('#set-name').inputValue() === '저장 전 행사명 초안');
        await page.locator('#set-name').fill('모집 준비 흐름 검증 행사');
        check(`${width} four zones stay mounted`, await page.locator('[data-settings-section]').count() === 4);
        await closeBasics();
        let stops = 0;
        while (stops < KEYBOARD_CAP && !await page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first().evaluate(e => e === document.activeElement)) { await page.keyboard.press('Tab'); stops += 1; }
        check(`${width} return reachable within unchanged keyboard40`, stops <= KEYBOARD_CAP && await page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first().evaluate(e => e === document.activeElement), { stops });
        await capture('08-sections-draft-guard');
        // Hide one REAL committed response; exact request replays its receipt.
        await page.locator('#set-consent').fill('응답 유실 재시도 검증 문구');
        const previousConsentVersion = Number((await bootstrap()).workspaces[id].consentVersion) || 0;
        const attempts = [];
        let lose = true;
        await page.route(`**/api/events/${id}/commands`, async route => {
          const body = route.request().postDataJSON();
          if (body.command !== 'form.publish') return route.continue();
          attempts.push(body);
          const response = await route.fetch();
          if (lose) { lose = false; return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'audit: committed response lost' }) }); }
          return route.fulfill({ response });
        });
        await page.getByRole('button', { name: '변경 게시', exact: true }).click();
        const settingsRecovery = page.getByRole('region', { name: '행사 설정 처리 확인 필요' });
        await settingsRecovery.getByText(/처리 결과를 확인하지 못했습니다/).waitFor();
        check(`${width} committed intake with lost response`, (await bootstrap()).workspaces[id].consentText === '응답 유실 재시도 검증 문구');
        check(`${width} unconfirmed intake keeps its original text locked`, await page.locator('#set-consent').isDisabled() && await page.locator('#set-consent').inputValue() === '응답 유실 재시도 검증 문구');
        page.once('dialog', d => d.dismiss());
        await page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first().click();
        check(`${width} unconfirmed request protects return`, new URL(page.url()).pathname.endsWith('/settings'));
        await settingsRecovery.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('#panel-settings-intake [class*="unsavedTag"]'));
        check(`${width} response loss retries exact commandId and payload`, attempts.length === 2 && JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]));
        check(`${width} retry does not duplicate consent change`, (await bootstrap()).workspaces[id].consentVersion === previousConsentVersion + 1);
        await page.unroute(`**/api/events/${id}/commands`);
        await capture('09-response-loss-recovered');
        await page.addScriptTag({ content: axeSource });
        const violations = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })) })));
        check(`${width} settings axe serious critical zero`, violations.length === 0, violations);
      }
      const eventRow = await f.harness.database.query('SELECT payload FROM events WHERE id=$1', [id]);
      const workspaceRow = await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id]);
      check(`${width} raw DB final preparation state`, eventRow.rows[0].payload.stage === 'READY' && workspaceRow.rows[0].payload.registrationOpen === true && !workspaceRow.rows[0].payload.pageExperience?.publishedAt);
      check(`${width} measured journey only expected writes`, writes.filter(w => w.command === 'event.stage').length === 1 && writes.every(w => ['event.stage', 'form.publish'].includes(w.command)), writes.map(w => w.command));
      if (!BEFORE && width === 390) {
        // Additional REAL fixture data: no simulated display counters. Import
        // 1000 people, set waitlist/pending, then test unlimited/long capacity.
        const boundaryId = `${id}-boundary`;
        const boundarySlug = `boundary-${f.suffix.slice(0, 12)}`;
        await f.helpers.insertEvent(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id: boundaryId, slug: boundarySlug,
          payload: { id: boundaryId, slug: boundarySlug, name: '긴 행사 이름과 대기 명단 정원 표시 경계 검증', stage: 'READY', date: '2027-01-16', start: '09:00', end: '17:00', capacity: 0, features: [] }, workspace: f.helpers.emptyWorkspace() });
        await f.helpers.insertMembership(f.harness.database, f.manager.id, boundaryId, ['all']);
        const setup = async (command, payload) => {
          const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${boundaryId}/commands`, { method: 'POST', cookie: f.manager.cookie,
            body: { commandId: require('node:crypto').randomUUID(), command, payload } });
          assert.ok(r.status >= 200 && r.status < 300, `${command}: ${r.status} ${JSON.stringify(r.json)}`); return r.json;
        };
        const imported = await setup('participant.import', { rows: Array.from({ length: 1000 }, (_, i) => ({ name: `준비 참가자 ${i + 1}`, phone: `0107${String(i + 1).padStart(7, '0')}`, company: '경계 검증' })) });
        const people = imported.participants;
        await setup('participant.status', { ids: people.slice(0, 20).map(p => p.id), status: 'WAITLIST' });
        await setup('participant.status', { ids: people.slice(20, 353).map(p => p.id), status: 'PENDING' });
        await page.goto(`${f.baseUrl}/console/events/${boundaryId}`); await overview();
        check('unlimited capacity and waitlist both retained', (await page.locator('main').textContent()).includes('제한 없음') && (await page.locator('main').textContent()).includes('20명'));
        await capture('10-unlimited-waitlist');
        const event = (await bootstrap()).events.find(e => e.id === boundaryId);
        await setup('event.update', { name: event.name, slug: event.slug, date: event.date, start: event.start, end: event.end, clientId: event.clientId || '', capacity: 1234567890 });
        for (const size of [320, 390, 768, 1024, 1280]) {
          await page.setViewportSize({ width: size, height: 900 });
          await page.reload(); await overview();
          await page.locator(':is(section,[role="region"])[aria-labelledby="event-metrics-heading"] a[class*="_chip"] strong').first().waitFor();
          const values = await page.locator(':is(section,[role="region"])[aria-labelledby="event-metrics-heading"] a[class*="_chip"] strong').allTextContents();
          check(`${size} four-digit counts and full long capacity retained`, values.some(v => v.replaceAll(',', '').includes('1000')) && (await page.locator('main').textContent()).replaceAll(',', '').includes('1234567890'), { values, section: await page.locator('main').innerText().then(t => t.slice(0, 700)) });
          const numbers = await page.locator(':is(section,[role="region"])[aria-labelledby="event-metrics-heading"] a[class*="_chip"] strong').evaluateAll(nodes => nodes.map(e => {
            const range = document.createRange(); range.selectNodeContents(e);
            return { value: e.textContent, lines: range.getClientRects().length, textWidth: range.getBoundingClientRect().width, available: e.clientWidth };
          }));
          check(`${size} numbers remain readable atomic units`, numbers.every(n => n.lines === 1 && n.textWidth <= n.available + 1), numbers);
          check(`${size} long values fit actual viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          if ([320, 1280].includes(size)) await page.screenshot({ path: `${OUT}/boundary-counts-${size}.png`, fullPage: true });
        }
      }
      await context.close();
    }
    check('no browser runtime errors', errors.length === 0, errors);
  } catch (e) {
    failure = String(e.stack || e);
    if (browser) {
      let index = 0;
      for (const context of browser.contexts()) for (const page of context.pages()) {
        await page.screenshot({ path: `${OUT}/failure-${index}.png`, fullPage: true }).catch(() => {});
        fs.writeFileSync(`${OUT}/failure-${index++}.txt`, `${page.url()}\n${await page.locator('body').innerText().catch(() => '')}`, { mode: 0o600 });
      }
    }
    throw e;
  }
  finally {
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ ok: !failure, phase: BEFORE ? 'before' : 'after', build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(),
      environment: 'isolated API + random PostgreSQL schema; real commands; anonymous public context; no deployed data',
      caps: { operator: OPERATOR_CAP, participant: 10, keyboard: KEYBOARD_CAP },
      measurement: 'Each click/fill/key is one operation. Initial goto/login excluded. Scroll gestures are unmeasured (null), not zero. No task time or comprehension claims.',
      checks, journeys, renders, states, errors, failure: failure || null }, null, 2), { mode: 0o600 });
    if (browser) await browser.close();
    if (f) await f.close();
  }
  console.log(`Preparation audit: ${checks.length} checks, ${journeys.length} phases; ${OUT}/verification.json`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
