'use strict';

// Real isolated API/PostgreSQL journey, not the static proposal. --before
// measures the incumbent build with the same data/actions. No deployed data.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const BEFORE = process.argv.includes('--before');
const ROOT = process.env.EVENTOUCH_CAPTURE_ROOT || '/tmp/opencode/eventouch-captures/round-preparation';
const OUT = path.join(ROOT, BEFORE ? 'before' : 'after');
const OPERATOR_CAP = 12;
const KEYBOARD_CAP = 40;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
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
      await f.helpers.insertEvent(f.harness.database, { id, slug,
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
        await page.locator('#settings-stage').waitFor();
        if (BEFORE) {
          const d = page.locator('details[data-settings-collapse="stage"]');
          if (!await d.evaluate(e => e.open)) await act(() => d.locator('summary').click());
        } else check(`${width} stage deeplink selects real tab`, await page.getByRole('tab', { name: '진행 단계', exact: false }).getAttribute('aria-selected') === 'true');
      };
      await page.goto(f.baseUrl + base); await overview();
      let s = await snapshot('draft-overview');
      check(`${width} DRAFT public stage gate`, s.stage === 'DRAFT' && s.publicStatus === 404 && !s.registrationOpen && !s.homeDesignPublished, s);
      await capture('01-draft-overview');
      if (!BEFORE) {
        check(`${width} draft does not offer broken public link`, await page.getByRole('link', { name: '참가자 페이지 열기', exact: true }).count() === 0);
        check(`${width} counts form exactly three peers`, await page.locator('section[aria-labelledby="event-metrics-heading"] [class*="metricCard"]').count() === 3);
      }
      await phase('DRAFT → READY → 현황 재확인', async act => {
        await toStage(act);
        await capture('02-stage-settings');
        await act(() => page.getByRole('button', { name: '운영 준비(으)로 전환', exact: true }).click());
        check(`${width} transition review does not write`, (await snapshot('ready-confirm')).stage === 'DRAFT');
        await act(() => page.getByRole('button', { name: '정말 전환합니다 · 운영 준비 단계로', exact: true }).click());
        await page.getByText('행사를 운영 준비(으)로 전환했습니다.', { exact: true }).waitFor();
        await page.getByRole('button', { name: '진행 중(으)로 전환', exact: true }).waitFor();
        s = await snapshot('ready-settings');
        check(`${width} READY default home public without design`, s.stage === 'READY' && s.publicStatus === 200 && !s.registrationOpen && !s.homeDesignPublished, s);
        await capture('03-ready-result');
        await toOverview(act);
        s = await snapshot('ready-overview');
        check(`${width} overview return reads updated stage`, s.stage === 'READY' && (await page.locator('main').textContent()).includes('운영 준비'));
        if (!BEFORE) {
          check(`${width} sidebar and overview stage agree`, (await page.locator('.console-sidebar').textContent()).includes('운영 준비'));
          check(`${width} next LIVE condition visible on overview`, (await page.locator('main').textContent()).includes('다음 진행 중 조건') && (await page.locator('main').textContent()).includes('등록 데스크 0개 · 데스크 배정 0건'));
        }
        await capture('04-ready-overview');
      });
      const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const publicPage = await anon.newPage();
      await publicPage.goto(`${f.baseUrl}/event/${slug}/home`);
      await publicPage.getByRole('button', { name: '모바일 티켓', exact: true }).waitFor();
      check(`${width} anonymous default home retains six tiles`, await publicPage.locator('button[class*="menuButton"]').count() === 6);
      await publicPage.screenshot({ path: `${OUT}/${width}-public-ready-default-home.png`, fullPage: true });
      await phase('접수 게시 → 현황 재확인', async act => {
        await act(() => page.getByRole('link', { name: '접수 설정', exact: true }).click());
        await page.locator('#set-consent').waitFor();
        if (!BEFORE) check(`${width} intake deeplink selects real tab`, await page.getByRole('tab', { name: '참가 접수', exact: false }).getAttribute('aria-selected') === 'true');
        await act(() => page.locator('#set-consent').fill('행사 신청과 입장 확인을 위해 이름과 연락처를 사용합니다.'));
        await act(() => page.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click());
        await page.locator('[data-settings-section-status="intake"]').filter({ hasText: '양식을 게시하고 접수를 열었습니다.' }).waitFor();
        await page.getByText('현재 접수 중 · 게시된 양식 버전 1', { exact: false }).first().waitFor();
        await capture('05-intake-result');
        await toOverview(act);
        s = await snapshot('intake-open-overview');
        check(`${width} intake independent of custom design`, s.registrationOpen && s.formVersion === 1 && s.publicStatus === 200 && !s.homeDesignPublished, s);
        check(`${width} returned overview refreshed intake`, (await page.locator('main').textContent()).includes('접수 중'));
        await capture('06-open-overview');
      });
      await publicPage.goto(`${f.baseUrl}/event/${slug}/register`);
      await publicPage.locator('form.registration-form').waitFor();
      await publicPage.screenshot({ path: `${OUT}/${width}-public-open-registration.png`, fullPage: true });
      await anon.close();
      await phase('다음 LIVE 전제 확인', async act => {
        await toStage(act);
        check(`${width} LIVE blocked without desks or assignment`, await page.getByRole('button', { name: '진행 중(으)로 전환', exact: true }).isDisabled());
        const reason = await page.locator('#settings-stage-precondition').textContent();
        check(`${width} blocker is desk and assignment, not custom design`, reason.includes('등록 데스크') && reason.includes('데스크 배정') && !reason.includes('미게시'), reason);
        s = await snapshot('next-live-blocked');
        check(`${width} blocked action writes no LIVE`, s.stage === 'READY' && s.desks === 0 && s.assignments === 0, s);
        await capture('07-live-blocked');
      });
      if (!BEFORE) {
        await page.getByRole('tab', { name: '기본 정보', exact: false }).click();
        await page.locator('#set-name').fill('저장 전 행사명 초안');
        await page.getByRole('tab', { name: '참가 접수', exact: false }).click();
        await page.locator('#set-consent').fill('독립 저장 검증 동의 문구');
        check(`${width} dirty basic tab is named`, (await page.getByRole('tab', { name: '기본 정보', exact: false }).textContent()).includes('저장 안 됨'));
        await page.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('#panel-settings-intake [class*="unsavedTag"]'));
        check(`${width} independent consent save persisted`, (await bootstrap()).workspaces[id].consentText === '독립 저장 검증 동의 문구');
        await page.getByRole('tab', { name: '기본 정보', exact: false }).click();
        check(`${width} save elsewhere preserves basic draft`, await page.locator('#set-name').inputValue() === '저장 전 행사명 초안');
        check(`${width} independent save did not commit basic draft`, (await bootstrap()).events.find(e => e.id === id).name === '모집 준비 흐름 검증 행사');
        page.once('dialog', d => d.dismiss());
        await page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first().click();
        check(`${width} dirty return cancellation keeps tab and input`, new URL(page.url()).pathname.endsWith('/settings') && await page.locator('#set-name').inputValue() === '저장 전 행사명 초안');
        await page.locator('#set-name').fill('모집 준비 흐름 검증 행사');
        const tabs = page.getByRole('tab');
        check(`${width} exactly four real tabs`, await tabs.count() === 4);
        await tabs.first().focus(); await page.keyboard.press('End');
        check(`${width} End focuses and selects stage`, await tabs.last().evaluate(e => e === document.activeElement && e.getAttribute('aria-selected') === 'true'));
        await page.keyboard.press('Home');
        check(`${width} Home focuses and selects basics`, await tabs.first().evaluate(e => e === document.activeElement && e.getAttribute('aria-selected') === 'true'));
        let stops = 0;
        while (stops < KEYBOARD_CAP && !await page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first().evaluate(e => e === document.activeElement)) { await page.keyboard.press('Tab'); stops += 1; }
        check(`${width} return reachable within unchanged keyboard40`, stops <= KEYBOARD_CAP && await page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first().evaluate(e => e === document.activeElement), { stops });
        await capture('08-tabs-draft-guard');
        // Hide one REAL committed response; exact request replays its receipt.
        await page.getByRole('tab', { name: '참가 접수', exact: false }).click();
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
        await page.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click();
        await page.getByText('응답을 확인하지 못했습니다. 입력한 내용을 유지한 채 같은 요청으로 다시 시도하세요.', { exact: true }).first().waitFor();
        check(`${width} committed intake with lost response`, (await bootstrap()).workspaces[id].consentText === '응답 유실 재시도 검증 문구');
        page.once('dialog', d => d.dismiss());
        await page.getByRole('link', { name: '현황으로 돌아가기', exact: true }).first().click();
        check(`${width} unconfirmed request protects return`, new URL(page.url()).pathname.endsWith('/settings'));
        await page.getByRole('button', { name: '양식 게시·접수 열기', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('#panel-settings-intake [class*="unsavedTag"]'));
        check(`${width} response loss retries exact commandId and payload`, attempts.length === 2 && JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]));
        check(`${width} retry does not duplicate consent change`, (await bootstrap()).workspaces[id].consentVersion === previousConsentVersion + 1);
        await page.unroute(`**/api/events/${id}/commands`);
        await capture('09-response-loss-recovered');
        await page.addScriptTag({ content: axeSource });
        const violations = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, impact: v.impact })));
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
        await f.helpers.insertEvent(f.harness.database, { id: boundaryId, slug: boundarySlug,
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
          const values = await page.locator('section[aria-labelledby="event-metrics-heading"] [class*="metricValue"]').allTextContents();
          check(`${size} four-digit counts and full long capacity retained`, values.some(v => v.replaceAll(',', '').includes('1000')) && (await page.locator('main').textContent()).replaceAll(',', '').includes('1234567890'), values);
          const numbers = await page.locator('section[aria-labelledby="event-metrics-heading"] [class*="metricValue"]').evaluateAll(nodes => nodes.map(e => {
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
        fs.writeFileSync(`${OUT}/failure-${index++}.txt`, `${page.url()}\n${await page.locator('body').innerText().catch(() => '')}`);
      }
    }
    throw e;
  }
  finally {
    fs.writeFileSync(`${OUT}/verification.json`, JSON.stringify({ ok: !failure, phase: BEFORE ? 'before' : 'after', build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(),
      environment: 'isolated API + random PostgreSQL schema; real commands; anonymous public context; no deployed data',
      caps: { operator: OPERATOR_CAP, participant: 10, keyboard: KEYBOARD_CAP },
      measurement: 'Each click/fill/key is one operation. Initial goto/login excluded. Scroll gestures are unmeasured (null), not zero. No task time or comprehension claims.',
      checks, journeys, renders, states, errors, failure: failure || null }, null, 2));
    if (browser) await browser.close();
    if (f) await f.close();
  }
  console.log(`Preparation audit: ${checks.length} checks, ${journeys.length} phases; ${OUT}/verification.json`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
