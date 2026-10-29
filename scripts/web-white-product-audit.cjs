'use strict';

// Approved white product system: real routes and real API, synthetic data in
// the fixture's owned PostgreSQL schema. No production service, real delivery,
// operational database or customer file is used. Run serially with other audits.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const axe = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const OUT = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'white-product')
  : defaultCaptureDir(`white-product-${runStamp()}`);
const CONSOLE = [
  ['events', '/console', '#console-event-directory'],
  ['clients', '/console/clients', '#client-list-heading'],
  ['team', '/console/team', '#team-members'],
  ['overview', '/console/events/:id', '#event-metrics-heading'],
  ['participants', '/console/events/:id/participants', '#roster-search'],
  ['import', '/console/events/:id/participants/import', '#participant-import-file-heading'],
  ['messages', '/console/events/:id/messages', '#history-heading'],
  ['operations', '/console/events/:id/operations', '#ops-desks'],
  ['programs', '/console/events/:id/programs', 'button:has-text("프로그램 만들기")'],
  ['draws', '/console/events/:id/draws', '#draws-vote'],
  ['photos', '/console/events/:id/photos', '#evidence-photo-sections'],
  ['content', '/console/events/:id/content', '#content-notices'],
  ['page', '/console/events/:id/page', '#home-intro'],
  ['rewards', '/console/events/:id/rewards', '#rewards-list'],
  ['settings', '/console/events/:id/settings', '#set-name'],
  ['reports', '/console/events/:id/reports', '#reports-list'],
];

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const buildId = fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim();
  const checks = [], errors = [];
  const check = (name, ok, detail = null) => {
    checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) console.error(`[white-product] FAIL ${name}: ${JSON.stringify(detail)}`);
  };
  let f, browser, completed = false;
  try {
    f = await startAuditFixture();
    const ownerCookie = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
    const command = async (command, payload) => {
      const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie,
        body: { commandId: `white-${crypto.randomUUID()}`, command, payload },
      });
      assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.json));
      return response.json;
    };
    const workspace = async () => (await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: f.manager.cookie })).json.state.workspaces[f.eventId];
    await command('event.features', { features: ['poll', 'quiz', 'qa', 'draw', 'survey', 'stamp', 'photo', 'board', 'screen', 'venue', 'reward'] });
    // Display content is synthetic. This SQL only changes the fixture's event.
    await f.harness.database.query("UPDATE events SET payload=payload || $2::jsonb WHERE id=$1", [f.eventId, JSON.stringify({ name: '2027 파트너 서밋', location: '서울 컨벤션센터 · 그랜드홀' })]);
    const people = (await workspace()).participants;
    const names = ['김서연', '이준호', '박지민', '최유진', '정민수', '한지우', '윤하늘', '오수빈'];
    for (const [index, person] of people.entries()) {
      await command('participant.update', { id: person.id, name: names[index], company: ['에버그린', '넥스트랩', '브릿지컴퍼니', '스튜디오 오름'][index % 4] });
      if ([1, 4].includes(index)) await command('participant.status', { id: person.id, status: 'PENDING' });
    }
    await command('template.save', { name: '서밋 입장 안내', channel: 'SMS', body: '{{이름}}님, {{행사명}}에서 뵙겠습니다.' });
    await command('message.create', { ids: [people[0].id], title: '행사장 입장 안내', channel: 'SMS', body: '행사장 입구에서 모바일 티켓을 준비해 주세요.', simulate: true });
    await command('booth.save', { name: '파트너 라운지', zone: '1층 로비', status: 'OPEN', capacity: 0, limit: 1 });
    await command('module.save', { type: 'survey', title: '서밋 만족도 설문', questions: '전반적인 행사 만족도\n다음 행사에서 만나고 싶은 주제' });
    await command('program.save', { title: '등록 및 네트워킹', date: '2027-01-16', start: '09:00', end: '10:00', place: '그랜드홀', published: true });
    await command('program.save', { title: '파트너 라운드테이블', date: '2027-01-16', start: '14:00', end: '15:30', place: '그랜드홀', published: true });
    await command('report.create', { title: '파트너 서밋 운영 결과', subtitle: '운영 검토용', summary: '참가 신청과 현장 입장 결과를 확인합니다.', sections: ['overview', 'attendance'], color: '#C2410C' });
    const invitation = await f.helpers.requestJson(f.harness.baseUrl, '/api/auth/invitations', {
      method: 'POST', cookie: ownerCookie,
      body: { commandId: crypto.randomUUID(), name: '김운영', email: `white-invite-${f.suffix}@example.test`, role: 'MANAGER', eventId: f.eventId },
    });
    assert.ok(invitation.json.token, 'a real isolated invitation exists');
    // A second assignment prevents the intentional one-event staff shortcut;
    // the assignment hub itself must also be rendered and reviewed.
    const secondId = `white-second-${f.suffix}`;
    const secondWorkspace = f.helpers.emptyWorkspace();
    secondWorkspace.desks = [{ id: 'white-second-desk', name: '파트너 데스크', action: 'IN', mode: 'desk', open: true }];
    await f.helpers.insertEvent(f.harness.database, {
      orgId: f.helpers.LEGACY_ORG, id: secondId, slug: secondId,
      payload: { id: secondId, slug: secondId, name: '파트너 네트워킹', stage: 'READY', date: '2027-01-17', start: '10:00', end: '17:00', features: [] }, workspace: secondWorkspace,
    });
    await f.helpers.insertAssignment(f.harness.database, { id: `white-second-assignment-${f.suffix}`, accountId: f.staff.id, eventId: secondId, type: 'DESK', targetId: 'white-second-desk' });
    const ticket = (await workspace()).participants.find(person => person.id === people[0].id).ticket;
    const publics = [
      ['landing', '/', '#home-title'], ['login', '/login', '#login-email'],
      ['event', `/event/${f.slug}`, 'main h1'], ['attendee', `/event/${f.slug}/home`, 'nav[aria-label="참가 메뉴"]'],
      ['register', `/event/${f.slug}/register`, '#field-name'],
      ['recover-unavailable', `/event/${f.slug}/ticket/recover`, '.verification-unavailable'],
      ['ticket', `/event/${f.slug}/ticket?ticket=${encodeURIComponent(ticket)}`, '[class*="ticketQr"] svg'],
      ['engage', `/event/${f.slug}/engage?ticket=${encodeURIComponent(ticket)}`, 'main h1'],
      ['screen', `/screen/${f.slug}`, '.display-board'],
      ['invite', `/invite/${invitation.json.token}`, 'input[type="password"]'],
    ];
    browser = await launchBrowser();
    const contextFor = async (role, width) => {
      const context = await browser.newContext({ viewport: { width, height: width > 768 ? 1000 : 844 }, reducedMotion: 'reduce', timezoneId: 'Asia/Seoul' });
      if (role !== 'public') {
        const cookie = role === 'owner'
          ? { ...cookieForContext(f, 'manager'), value: decodeURIComponent(ownerCookie.slice('etko_session='.length)) }
          : cookieForContext(f, 'staff');
        await context.addCookies([{ ...cookie, url: f.baseUrl }]);
      }
      return context;
    };
    const observe = page => page.on('pageerror', error => errors.push(error.message));
    const render = async (page, name, width) => {
      await page.evaluate(() => document.fonts.ready);
      // Full-page screenshots do not reliably trigger below-fold lazy images.
      // Exercise their real scroll-to-load path before returning to the top;
      // a white placeholder is not evidence of the product image surface.
      const images = page.locator('img');
      for (let index = 0; index < await images.count(); index += 1) {
        const image = images.nth(index);
        if (await image.isVisible()) {
          await image.scrollIntoViewIfNeeded();
          await image.evaluate(element => element.decode());
        }
      }
      if (name === 'landing') {
        check(`landing@${width}: all product illustrations decoded`, await images.evaluateAll(elements => elements.every(image => image.complete && image.naturalWidth > 0)));
        await page.locator('[class*="mobileEvidence"]').evaluate(element => { element.scrollLeft = 0; });
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.mouse.move(width - 2, 2);
      await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage: true });
      await page.screenshot({ path: path.join(OUT, `${name}-${width}-viewport.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(`${name}@${width}: document fits`, overflow <= 1, overflow);
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => (await window.axe.run()).violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })));
      check(`${name}@${width}: axe`, violations.length === 0, violations);
    };
    for (const width of [1440, 1280, 390, 320]) {
      for (const role of ['owner', 'public', 'staff']) {
        const context = await contextFor(role, width);
        const page = await context.newPage(); observe(page);
        const routes = role === 'owner' ? CONSOLE : role === 'public' ? publics : [
          ['staff', '/staff', '.staff-assignment-list'], ['staff-work', `/staff/events/${f.eventId}`, '#staff-desk'],
        ];
        for (const [name, route, marker] of routes) {
          const target = route.replace(':id', f.eventId);
          await page.goto(f.baseUrl + target, { waitUntil: 'networkidle' });
          await page.locator(marker).first().waitFor({ state: 'visible' });
          check(`${name}@${width}: actual destination`, new URL(page.url()).pathname === target.split('?')[0]);
          if (role === 'owner') {
            const visual = await page.evaluate(() => ({
              body: getComputedStyle(document.body).backgroundColor,
              nav: getComputedStyle(document.querySelector('.console-sidebar')).backgroundColor,
              title: getComputedStyle(document.querySelector('main h1')).fontSize,
              font: getComputedStyle(document.querySelector('main h1')).fontFamily,
              headings: document.querySelectorAll('main h1').length,
            }));
            check(`${name}@${width}: white shared frame`, visual.body === 'rgb(255, 255, 255)' && visual.nav === 'rgb(250, 251, 252)' && visual.title === '28px' && visual.font.includes('Pretendard') && visual.headings === 1, visual);
          }
          if (name === 'attendee') check(`attendee@${width}: customer sky theme preserved`, await page.locator('[class*="homePage"]').first().evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(185, 222, 240)'));
          await render(page, name, width);
        }
        if (role === 'owner') {
          await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`, { waitUntil: 'networkidle' });
          await page.locator('#message-compose-open').click();
          await page.locator('#campaign-title').fill('서밋 입장 안내');
          const body = '{{이름}}님, 반갑습니다.\n행사장 입구에서 모바일 티켓을 준비해 주세요.';
          await page.locator('#campaign-body').fill(body);
          check(`compose@${width}: raw draft preview, no fabricated personal content`, await page.locator('#message-draft-preview').innerText() === body);
          await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
          const recipients = page.locator('#campaign-recipients details');
          if (!await recipients.evaluate(el => el.open)) await recipients.locator('summary').click();
          await recipients.locator('ul input[type="checkbox"]').first().check();
          await render(page, 'compose', width);
          await page.locator('#campaign-submit').click();
          await page.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).waitFor();
          await render(page, 'message-review', width);
          check(`review@${width}: preview and review do not dispatch`, f.gateway.commands.length === 0);
          await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '취소', exact: true }).click();
          await page.locator('#campaign-title').fill(''); await page.locator('#campaign-body').fill('');
          await page.locator('#recipient-clear-all').click();
        }
        await context.close();
      }
    }

    // State evidence is deliberately simulated at the browser transport only.
    // The recovery still returns the real server fixture, never fake success.
    for (const width of [1280, 320]) {
      const context = await contextFor('owner', width);
      const page = await context.newPage(); observe(page);
      const roster = `${f.baseUrl}/console/events/${f.eventId}/participants`;
      let mode = 'loading', release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route(`**/api/events/${f.eventId}/bootstrap`, async route => {
        if (mode === 'loading') await gate;
        if (mode === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture-unavailable' }) });
        return route.continue();
      });
      await page.goto(roster, { waitUntil: 'domcontentloaded' });
      await page.getByText('참가자 목록을 불러오고 있습니다.', { exact: true }).waitFor();
      await render(page, 'roster-loading', width);
      mode = 'error'; release();
      await page.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor();
      await render(page, 'roster-error', width);
      mode = 'healthy';
      await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
      await page.locator('#roster-search').waitFor();
      check(`roster@${width}: real recovery`, await page.getByText('김서연', { exact: true }).evaluateAll(elements => elements.some(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')));
      await page.locator('#roster-search').fill('일치하지 않는 이름');
      await page.getByRole('heading', { name: '조건에 맞는 참가자가 없습니다.', exact: true }).waitFor();
      await render(page, 'roster-no-results', width);
      await page.getByRole('button', { name: '검색·필터 초기화', exact: true }).click();
      await page.getByRole('button', { name: '김서연 참가자 상세', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await render(page, 'participant-detail', width);
      await page.keyboard.press('Escape');
      check(`detail@${width}: keyboard exit returns focus`, await page.getByRole('button', { name: '김서연 참가자 상세', exact: true }).evaluate(el => el === document.activeElement));
      await page.goto(`${f.baseUrl}/console/events/${secondId}/participants`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '아직 등록된 참가자가 없습니다.', exact: true }).waitFor();
      await render(page, 'roster-first-use', width);
      await f.harness.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}','\"ARCHIVED\"'::jsonb) WHERE id=$1", [f.eventId]);
      await page.goto(roster, { waitUntil: 'networkidle' });
      await page.locator('#roster-search').waitFor();
      check(`readonly@${width}: no create action`, await page.getByRole('button', { name: '참가자 추가', exact: true }).count() === 0);
      await render(page, 'roster-readonly', width);
      await f.harness.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}','\"LIVE\"'::jsonb) WHERE id=$1", [f.eventId]);
      await context.close();
    }
    // Lose a real committed message response: preview copy must not claim
    // that nothing was saved/sent, and retry must resolve the same receipt.
    const uncertainContext = await contextFor('owner', 390);
    const uncertainPage = await uncertainContext.newPage(); observe(uncertainPage);
    const attempts = [];
    let committedStatus;
    await uncertainPage.route(`**/api/events/${f.eventId}/commands`, async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'message.create') return route.continue();
      attempts.push(body);
      if (attempts.length === 1) {
        const actual = await route.fetch();
        committedStatus = actual.status();
        if (!actual.ok()) return route.fulfill({ response: actual });
        return route.fulfill({ response: actual, status: 502, json: { error: '합성 커밋 후 응답 유실' } });
      }
      return route.continue();
    });
    await uncertainPage.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`, { waitUntil: 'networkidle' });
    await uncertainPage.locator('#message-compose-open').click();
    const uncertainTitle = '응답 확인 재시도 검증';
    await uncertainPage.locator('#campaign-title').fill(uncertainTitle);
    await uncertainPage.locator('#campaign-body').fill('{{이름}}님, 행사장 입구에서 티켓을 준비해 주세요.');
    await uncertainPage.getByLabel('모의 발송으로 기록', { exact: false }).check();
    const recipientDetails = uncertainPage.locator('#campaign-recipients details');
    if (!await recipientDetails.evaluate(element => element.open)) await recipientDetails.locator('summary').click();
    await recipientDetails.locator('ul input[type="checkbox"]').first().check();
    const confirmMessage = async () => {
      await uncertainPage.locator('#campaign-submit').click();
      await uncertainPage.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
    };
    await confirmMessage();
    await uncertainPage.getByText('응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.', { exact: true }).waitFor();
    check('unknown message response follows a real commit', committedStatus >= 200 && committedStatus < 300, committedStatus);
    const previewCopy = await uncertainPage.locator('section[aria-labelledby="message-preview-heading"]').innerText();
    check('unknown message preview never claims non-delivery', !previewCopy.includes('아직 저장·발송하지 않았습니다') && previewCopy.includes('처리 결과는 아래 요청 안내와 발송 기록'), previewCopy);
    await render(uncertainPage, 'compose-response-unknown', 390);
    await confirmMessage();
    await uncertainPage.getByText('모의 발송을 기록했습니다. 수신자에게 전달되지 않았습니다.', { exact: true }).waitFor();
    check('message retry uses identical command bytes', attempts.length === 2 && JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]));
    check('message retry records once', (await workspace()).messages.filter(message => message.title === uncertainTitle).length === 1);
    await uncertainContext.close();

    // Terminal invitation screens use real server metadata, not fake success.
    const inviteStateContext = await contextFor('public', 390);
    const inviteStatePage = await inviteStateContext.newPage(); observe(inviteStatePage);
    await f.harness.database.query("UPDATE invitations SET expires_at=now()-interval '1 hour' WHERE org_id=$1 AND email=$2", [f.helpers.LEGACY_ORG, `white-invite-${f.suffix}@example.test`]);
    await inviteStatePage.goto(`${f.baseUrl}/invite/${invitation.json.token}`, { waitUntil: 'networkidle' });
    await inviteStatePage.getByRole('heading', { name: '초대 링크가 만료되었습니다', exact: true }).waitFor();
    await render(inviteStatePage, 'invite-expired', 390);
    await f.harness.database.query("UPDATE invitations SET status='REVOKED', expires_at=now()+interval '1 hour' WHERE org_id=$1 AND email=$2", [f.helpers.LEGACY_ORG, `white-invite-${f.suffix}@example.test`]);
    await inviteStatePage.reload({ waitUntil: 'networkidle' });
    await inviteStatePage.getByRole('heading', { name: '이미 처리된 초대입니다', exact: true }).waitFor();
    await render(inviteStatePage, 'invite-processed', 390);
    await inviteStateContext.close();

    // A non-white published choice remains local to attendee content.
    const saved = await command('attendee.page.save', { intro: '파트너와 함께하는 하루입니다.', showAnnouncements: true, showSchedule: true, showVenue: true, showPrograms: true, homeStyle: { backgroundColor: '#DDEBD4' } });
    assert.ok(saved.draft, 'saved attendee draft');
    await command('attendee.page.publish', { expectedDraftVersion: saved.draftVersion });
    const publicContext = await contextFor('public', 390);
    const attendee = await publicContext.newPage(); observe(attendee);
    await attendee.goto(`${f.baseUrl}/event/${f.slug}/home`, { waitUntil: 'networkidle' });
    check('published customer style survives the white shell', await attendee.locator('[class*="homePage"]').first().evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(221, 235, 212)'));
    await render(attendee, 'attendee-custom-published', 390);
    await publicContext.close();
    check('runtime page errors', errors.length === 0, errors);
    check('same build throughout', fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim() === buildId);
    assert.equal(checks.filter(item => !item.ok).length, 0, 'all collected checks must pass');
    completed = true;
  } finally {
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({ buildId, completed, checks, errors, disclosures: ['Synthetic isolated PostgreSQL/API/Next fixture', 'SMS simulation only; no delivery', 'Browser transport loading/error simulation, real recovery', 'Chromium, not real devices or screen-reader listening'] }, null, 2), { mode: 0o600 });
    if (browser) await browser.close();
    if (f) await f.close();
  }
  console.log(`[white-product] ${checks.length} checks passed; evidence: ${OUT}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
