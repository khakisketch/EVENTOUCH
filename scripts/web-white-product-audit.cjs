'use strict';
const { messageStep, waitForDialogExitFocus, openRecipientList } = require('./ui-journey-helpers.cjs');


// Approved white product system: real routes and real API, synthetic data in
// the fixture's owned PostgreSQL schema. No production service, real delivery,
// operational database or customer file is used. Run serially with other audits.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
// Account-form display only. No provider is selected and the origin is never fetched.
process.env.EVENTOUCH_MAIL_MOCK = '1';
process.env.EVENTOUCH_PUBLIC_URL = 'http://127.0.0.1:1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const axe = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { mockOutbox } = require('../server/email-transport');

const OUT = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'white-product')
  : defaultCaptureDir(`white-product-${runStamp()}`);
function contrastRatio(foreground, background) {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255);
    const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const CONSOLE = [
  ['events', '/console', '#console-event-directory'],
  ['clients', '/console/clients', '#client-list-heading'],
  ['team', '/console/team', '#team-members'],
  ['overview', '/console/events/:id', '#event-metrics-heading'],
  ['participants', '/console/events/:id/participants', '#roster-search'],
  ['import', '/console/events/:id/participants/import', '#participant-import-file-heading'],
  ['messages', '/console/events/:id/messages', '#history-heading'],
  ['operations', '/console/events/:id/operations', '#ops-desks'],
  ['live', '/console/events/:id/live', '[data-console-page="live"]'],
  ['programs', '/console/events/:id/programs', 'button:has-text("이벤트 만들기")'],
  ['draws', '/console/events/:id/draws', 'section[aria-label="무대"]'],
  ['photos', '/console/events/:id/photos', '#evidence-photo-sections'],
  ['content', '/console/events/:id/content', '#content-panel'],
  ['page', '/console/events/:id/page', '#theme-save-draft'],
  ['rewards', '/console/events/:id/rewards', { role: 'link', name: '참가자 명단' }],
  ['settings', '/console/events/:id/settings', '#settings-basics'],
  ['application-fields', '/console/events/:id/settings/fields', '#application-fields-heading'],
  ['reports', '/console/events/:id/reports', { role: 'tab', name: /^보고서/ }],
  ['analysis', '/console/events/:id/analysis', '#period-preset-2'],
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
      ['recover', '/recover', '#recover-email'],
      ['event', `/event/${f.slug}`, 'main h1'], ['attendee', `/event/${f.slug}/home`, 'nav[aria-label="참가 메뉴"]'],
      ['register', `/event/${f.slug}/register`, '#field-name'],
      ['recover-unavailable', `/event/${f.slug}/ticket/recover`, '.verification-unavailable'],
      ['ticket', `/event/${f.slug}/ticket?ticket=${encodeURIComponent(ticket)}`, '[class*="ticketQr"] svg'],
      ['engage', `/event/${f.slug}/engage?ticket=${encodeURIComponent(ticket)}`, 'main h1'],
      ['screen', `/screen/${f.slug}`, '.display-board'],
      ['invite', `/invite/${invitation.json.token}`, 'input[type="password"]'],
    ];
    const initialMailCount = mockOutbox.length;
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
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.mouse.move(width - 2, 2);
      await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage: true });
      await page.screenshot({ path: path.join(OUT, `${name}-${width}-viewport.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(`${name}@${width}: document fits`, overflow <= 1, overflow);
      if (name === 'participants') {
        const geometry = await page.getByRole('button', { name: /^(명단 가져오기|참가자 추가)$/ }).evaluateAll(buttons => buttons.map(button => {
          const icon = button.querySelector('svg')?.getBoundingClientRect();
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
          let label;
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(walker.currentNode);
            label = [...range.getClientRects()].find(rect => rect.width && rect.height);
            if (label) break;
          }
          return { iconRight: icon?.right, labelLeft: label?.left, labelWidth: label?.width };
        }));
        check(`${name}@${width}: toolbar icons share the label row`, geometry.length === 2 && geometry.every(item => item.iconRight <= item.labelLeft + 1 && item.labelWidth >= 20), geometry);
      }
      if (name === 'attendee') {
        const geometry = await page.locator('nav[aria-label="참가 메뉴"] button').evaluateAll(buttons => buttons.map(button => {
          const icon = button.querySelector('svg')?.getBoundingClientRect();
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
          let label;
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            label = [...range.getClientRects()].find(rect => rect.width > 1 && rect.height > 1);
            if (label) break;
          }
          const bounds = button.getBoundingClientRect();
          return { iconRight: icon?.right, iconBottom: icon?.bottom, labelLeft: label?.left, labelTop: label?.top,
            labelWidth: label?.width, labelRight: label?.right, labelBottom: label?.bottom,
            buttonLeft: bounds.left, buttonRight: bounds.right, buttonBottom: bounds.bottom };
        }));
        check(`${name}@${width}: menu icons and labels do not overlap or clip`, geometry.length > 0 && geometry.every(item => (item.iconRight <= item.labelLeft + 1 || item.iconBottom <= item.labelTop + 1) && item.labelWidth > 0 && item.labelLeft >= item.buttonLeft - 1 && item.labelRight <= item.buttonRight + 1 && item.labelBottom <= item.buttonBottom + 1), geometry);
      }
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => (await window.axe.run()).violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })));
      check(`${name}@${width}: axe`, violations.length === 0, violations);
    };
    for (const width of [1440, 1280, 390, 320]) {
      for (const role of ['owner', 'public', 'staff']) {
        const context = await contextFor(role, width);
        const page = await context.newPage(); observe(page);
        const routes = role === 'owner' ? [...CONSOLE, ['account-email', '/account/email', '.account-email-page h1']] : role === 'public' ? publics : [
          ['staff', '/staff', '.staff-assignment-list'], ['staff-work', `/staff/events/${f.eventId}`, '#staff-desk'],
        ];
        for (const [name, route, marker] of routes) {
          const target = route.replace(':id', f.eventId);
          await page.goto(f.baseUrl + target, { waitUntil: 'networkidle' });
          const ready = typeof marker === 'string' ? page.locator(marker).first() : page.locator('main').getByRole(marker.role, { name: marker.name, exact: true });
          try {
            await ready.waitFor({ state: 'visible' });
          } catch (error) {
            console.error(`[white-product] readiness ${name}@${width}: ${page.url()}`, (await page.locator('main').innerText({ timeout: 2000 }).catch(readError => readError.message)).slice(0, 2000));
            throw error;
          }
          check(`${name}@${width}: actual destination`, new URL(page.url()).pathname === target.split('?')[0]);
          if (role === 'public' && name === 'engage' && await page.getByText('게시된 프로그램이 없습니다.', { exact: true }).isVisible()) {
            check(`engage@${width}: empty state has one return to the menu`, await page.getByRole('link', { name: /참가 메뉴로/ }).count() === 1);
            check(`engage@${width}: empty state retains ticket and event guidance`, await page.getByRole('link', { name: '내 티켓으로 이동', exact: true }).isVisible() && await page.getByRole('link', { name: '행사 안내로', exact: true }).isVisible());
          }
          if (name === 'account-email') {
            const account = page.locator('.account-email-page');
            await account.locator('#verify-current-password').waitFor({ state: 'visible' });
            check(`account-email@${width}: signed-in account surface`, await account.getByRole('link', { name: '로그인으로 이동', exact: true }).count() === 0 && await account.getByRole('alert').count() === 0 && await account.locator('#verify-current-password').isVisible());
          }
          if (role === 'owner' && name !== 'account-email') {
            if (name === 'draws') {
              // 무대 ID는 선택 종류마다 달라지므로 이름 있는 영역과 별도 선택기를 확인한다.
              const picker = page.getByRole('heading', { name: '무대 선택', exact: true }).locator('xpath=following-sibling::ul[1]');
              await picker.getByRole('button', { pressed: true }).waitFor({ state: 'visible' });
              const prerequisite = page.getByRole('link', { name: '참여 이벤트에서 추첨 무대를 만들고 공개하세요.', exact: true });
              check(`draws@${width}: prerequisite action is separate from its explanation`,
                await prerequisite.isVisible() && await prerequisite.evaluate(link => !link.closest('p')));
              check(`draws@${width}: prerequisite retains its destination`,
                new URL(await prerequisite.getAttribute('href'), f.baseUrl).pathname === `/console/events/${f.eventId}/programs`);
            }
            const visual = await page.evaluate(() => ({
              body: getComputedStyle(document.body).backgroundColor,
              nav: getComputedStyle(document.querySelector('.console-sidebar')).backgroundColor,
              workspace: getComputedStyle(document.querySelector('main')).backgroundColor,
              shell: getComputedStyle(document.querySelector('.console-shell')).backgroundColor,
              title: getComputedStyle(document.querySelector('main h1')).fontSize,
              font: getComputedStyle(document.querySelector('main h1')).fontFamily,
              headings: document.querySelectorAll('main h1').length,
            }));
            const expectedTitle = width <= 768 ? '26px' : '30px';
            check(`${name}@${width}: white workspace and ink rail`, visual.body === 'rgb(255, 255, 255)' && visual.nav === 'rgb(16, 17, 20)' && visual.workspace === 'rgb(255, 255, 255)' && visual.shell === 'rgb(255, 255, 255)' && visual.title === expectedTitle && visual.font.includes('Pretendard') && visual.headings === 1, visual);
            if (name === 'overview') {
              // 화면 색상에서 정답을 역추론하지 않고 실제 행사 단계의 역할 계약을 확인한다.
              const stageResponse = await context.request.get(`${f.baseUrl}/api/events/${f.eventId}/bootstrap`);
              if (!stageResponse.ok()) throw new Error(`overview stage read: ${stageResponse.status()}`);
              const stageBody = await stageResponse.json();
              const overviewStage = stageBody.state.events.find(event => event.id === f.eventId)?.stage;
              if (!overviewStage) throw new Error('overview stage is missing');
              const actions = await page.locator('[data-task] a, a:has-text("현장 모드 열기")').evaluateAll(elements => elements.map(element => ({
                task: element.closest('[data-task]')?.getAttribute('data-task') ?? null,
                variant: element.getAttribute('data-action-variant'),
                background: getComputedStyle(element).backgroundColor,
                color: getComputedStyle(element).color,
              })));
              const isPrimary = action => action?.variant === 'primary' && action.background === 'rgb(199, 68, 28)' && action.color === 'rgb(255, 255, 255)' && contrastRatio(action.color, action.background) >= 4.5;
              const isGhost = action => action?.variant === 'ghost' && contrastRatio(action.color, 'rgb(255, 255, 255)') >= 4.5;
              const field = actions.find(action => action.task === null);
              const queue = actions.filter(action => action.task !== null);
              const primaryCount = await page.locator('main [data-action-variant="primary"]:visible').count();
              if (overviewStage === 'LIVE') {
                check(`overview@${width}: live primary keeps its distinct fill`, isPrimary(field) && primaryCount === 1, field);
                check(`overview@${width}: live task queue stays ghost`, queue.every(isGhost), queue);
              } else if (overviewStage === 'ARCHIVED') {
                check(`overview@${width}: archived overview keeps no primary`, primaryCount === 0);
              } else if (queue.length) {
                check(`overview@${width}: field action stays ghost away from live`, !field || isGhost(field), field ?? null);
                check(`overview@${width}: first task owns the single primary`, isPrimary(queue[0]) && primaryCount === 1, queue[0]);
                check(`overview@${width}: remaining tasks stay ghost`, queue.slice(1).every(isGhost), queue.slice(1));
              } else {
                check(`overview@${width}: overview without tasks keeps no primary`, primaryCount === 0);
              }
              const contrast = await page.evaluate(() => {
                const rgb = value => value.match(/[\d.]+/g).map(Number);
                const blend = (foreground, background) => {
                  const alpha = foreground[3] ?? 1;
                  return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
                };
                const luminance = channels => {
                  const linear = channels.map(value => {
                    const channel = value / 255;
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                  });
                  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
                };
                const ratio = (foreground, background) => {
                  const a = luminance(foreground), b = luminance(background);
                  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
                };
                const rail = rgb(getComputedStyle(document.querySelector('.console-sidebar')).backgroundColor);
                const wordmark = document.querySelector('.console-wordmark');
                const avatar = document.querySelector(innerWidth <= 768 ? '.operator-mobile-trigger .operator-avatar' : '.sidebar-bottom .operator-avatar');
                const avatarStyle = getComputedStyle(avatar);
                const avatarBackground = blend(rgb(avatarStyle.backgroundColor), rail);
                return {
                  wordmark: ratio(rgb(getComputedStyle(wordmark, '::first-letter').color), rail),
                  avatar: ratio(rgb(avatarStyle.color), avatarBackground),
                };
              });
              check(`overview@${width}: rail wordmark and account avatar contrast`, contrast.wordmark >= 4.5 && contrast.avatar >= 4.5, contrast);
              if (width <= 768) {
                const trigger = page.getByRole('button', { name: '메뉴', exact: true });
                await trigger.click();
                await page.locator('#console-global-menu').waitFor({ state: 'visible' });
                await page.evaluate(axe);
                const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('#console-global-menu'), { runOnly: ['color-contrast'] })).violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })));
                check(`overview@${width}: expanded mobile navigation contrast`, violations.length === 0, violations);
                if (width === 390) await page.screenshot({ path: path.join(OUT, 'overview-mobile-menu-390.png') });
                await trigger.click();
              }
            }
          }
          if (name === 'attendee') check(`attendee@${width}: customer sky theme preserved`, await page.locator('[class*="homePage"]').first().evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(185, 222, 240)'));
          await render(page, name, width);
          if (role === 'owner' && name === 'participants') {
            const rows = page.locator(width <= 768 ? 'ul[class*="participantList"] > li' : 'table[class*="rosterTable"] tbody > tr');
            await rows.first().getByRole('checkbox').check();
            await page.locator('#roster-selection-count').waitFor({ state: 'visible' });
            await page.mouse.move(width - 2, 2);
            const backgrounds = await Promise.all([rows.nth(0), rows.nth(1)].map(row => row.evaluate(element => getComputedStyle(element).backgroundColor)));
            check(`participants@${width}: selected row is visually distinct`, backgrounds[0] !== backgrounds[1], backgrounds);
            if (width > 768) {
              await rows.nth(1).getByRole('button', { name: /참가자 상세/ }).click();
              await page.getByRole('dialog').waitFor();
              await page.mouse.move(width - 2, 2);
              const selectedAndInspected = await Promise.all([rows.nth(0), rows.nth(1)].map(row => row.evaluate(element => getComputedStyle(element).backgroundColor)));
              check(`participants@${width}: inspected row does not look selected`, selectedAndInspected[0] !== selectedAndInspected[1], selectedAndInspected);
              await page.keyboard.press('Escape');
              await page.getByRole('dialog').waitFor({ state: 'hidden' });
            }
            const clearColors = await page.locator('[aria-label="선택한 참가자 작업"]').getByRole('button', { name: /^선택 해제/ }).evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element.closest('[aria-label="선택한 참가자 작업"]')).backgroundColor }));
            check(`participants@${width}: clear selection text contrast`, contrastRatio(clearColors.foreground, clearColors.background) >= 4.5, clearColors);
            if (width === 390) await page.screenshot({ path: path.join(OUT, 'participants-selected-390.png') });
            await page.evaluate(axe);
            const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('[aria-label="선택한 참가자 작업"]'), { runOnly: ['color-contrast'] })).violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target), details: item.nodes.map(node => ({ html: node.html, checks: node.any.map(check => ({ id: check.id, data: check.data })) })) })));
            check(`participants@${width}: selection actions contrast`, violations.length === 0, violations);
          }
        }
        if (role === 'owner') {
          await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`, { waitUntil: 'networkidle' });
          await page.locator('#message-compose-open').click();
          await openRecipientList(page);
          await page.locator('ul[aria-label="참가자 선택"] input[type="checkbox"]').first().check();
          await messageStep(page, 2);
          await page.locator('#campaign-title').fill('서밋 입장 안내');
          const body = '{{이름}}님, 반갑습니다.\n행사장 입구에서 모바일 티켓을 준비해 주세요.';
          await page.locator('#campaign-body').fill(body);
          check(`compose@${width}: preview substitutes an anonymous example without changing the draft`, (await page.locator('#message-draft-preview').innerText()).includes('홍길동님') && await page.locator('#campaign-body').inputValue() === body);
          if (width <= 390) {
            // Reopened 2026-11-23: the step buttons became checklist links; the same readability promise
            // holds for the checklist labels and the one primary 발송 검토 action (one line, touch width).
            const actionLines = await page.locator('nav[aria-label="메시지 작성 항목"] a, #campaign-submit').evaluateAll(buttons => buttons.map(button => {
              // Each checklist link names its zone in a <strong>; the one-line promise applies to that label, the touch width to the whole link.
              const walker = document.createTreeWalker(button.querySelector('strong') || button, NodeFilter.SHOW_TEXT);
              const lines = new Set();
              while (walker.nextNode()) {
                if (!walker.currentNode.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(walker.currentNode);
                for (const rect of range.getClientRects()) if (rect.width && rect.height) lines.add(Math.round(rect.y));
              }
              return { text: button.textContent.trim(), lines: lines.size, width: button.getBoundingClientRect().width };
            }));
            check(`compose@${width}: checklist labels and review action remain readable`, actionLines.length === 5 && actionLines.every(action => action.lines === 1 && action.width >= 44), actionLines);
            check(`compose@${width}: guidance does not contain an inline button`, await page.locator('#campaign-variables a').count() === 0 && await page.locator('#campaign-variables + a[href*="/draws"]').isVisible());
          }
          await render(page, 'compose', width);
          await messageStep(page, 3);
          await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
          await page.locator('#campaign-submit').click();
          await page.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).waitFor();
          await render(page, 'message-review', width);
          check(`review@${width}: preview and review do not dispatch`, f.gateway.commands.length === 0);
          await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '취소', exact: true }).click();
          await messageStep(page, 2);
          await page.locator('#campaign-title').fill(''); await page.locator('#campaign-body').fill('');
          await messageStep(page, 1);
          await openRecipientList(page);
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
      await waitForDialogExitFocus(page, page.getByRole('button', { name: '김서연 참가자 상세', exact: true }));
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
    const attemptBytes = [];
    let committedStatus;
    await uncertainPage.route(`**/api/events/${f.eventId}/commands`, async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'message.create-charset-reviewed') return route.continue();
      attempts.push(body);
      attemptBytes.push(route.request().postData());
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
    await openRecipientList(uncertainPage);
    await uncertainPage.locator('ul[aria-label="참가자 선택"] input[type="checkbox"]').first().check();
    await messageStep(uncertainPage, 2);
    await uncertainPage.locator('#campaign-title').fill(uncertainTitle);
    await uncertainPage.locator('#campaign-body').fill('{{이름}}님, 행사장 입구에서 티켓을 준비해 주세요.');
    await messageStep(uncertainPage, 3);
    await uncertainPage.getByLabel('모의 발송으로 기록', { exact: false }).check();
    const confirmMessage = async () => {
      await uncertainPage.locator('#campaign-submit').click();
      await uncertainPage.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
    };
    const lostResponse = uncertainPage.waitForResponse(response => response.url().endsWith(`/api/events/${f.eventId}/commands`) &&
      response.request().method() === 'POST' && response.request().postDataJSON().command === 'message.create-charset-reviewed');
    await confirmMessage();
    assert.equal((await lostResponse).status(), 502, 'the browser must actually lose the committed create result');
    assert.equal(attempts.length, 1, 'loss injection must intercept the current reviewed create command');
    const recovery = uncertainPage.locator(':is(section,[role="region"])[aria-labelledby="message-recovery-heading"]');
    await recovery.getByRole('heading', { name: '발송 요청 확인 필요', exact: true }).waitFor();
    check('unknown message response follows a real commit', committedStatus >= 200 && committedStatus < 300, committedStatus);
    const recoveryCopy = await recovery.innerText();
    check('unknown message recovery warns about a possible commit', recoveryCopy.includes('이미 요청이 기록됐을 수 있습니다.') && recoveryCopy.includes('서버 확인은 메시지를 다시 보내지 않습니다.'), recoveryCopy);
    check('unknown message retains its original simulated draft', attempts[0].payload.title === uncertainTitle && attempts[0].payload.simulate === true &&
      await uncertainPage.locator('#campaign-title').inputValue() === uncertainTitle &&
      await uncertainPage.locator('#campaign-body').inputValue() === attempts[0].payload.body);
    const previewCopy = await uncertainPage.locator(':is(section,[role="region"])[aria-labelledby="message-preview-heading"]').innerText();
    check('unknown message preview never claims non-delivery', !previewCopy.includes('아직 저장·발송하지 않았습니다') && previewCopy.includes('이름·티켓 링크·번호는 예시입니다'), previewCopy);
    await render(uncertainPage, 'compose-response-unknown', 390);
    const receiptResponse = uncertainPage.waitForResponse(response => response.url().endsWith(`/api/events/${f.eventId}/command-receipts/${attempts[0].commandId}`));
    await recovery.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    const receipt = await receiptResponse;
    const receiptState = await receipt.json();
    check('unknown message read-only lookup confirms the original receipt', receipt.ok() && receiptState.status === 'APPLIED' && receiptState.command === attempts[0].command, receiptState);
    await recovery.getByRole('alert').getByText(/서버에 발송 요청 기록이 있습니다/).waitFor();
    check('message receipt lookup never resubmits the create', attempts.length === 1);
    await recovery.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await uncertainPage.getByText('모의 발송을 기록했습니다. 수신자에게 전달되지 않았습니다.', { exact: true }).waitFor();
    check('message retry uses identical command bytes', attempts.length === 2 && attemptBytes[0] === attemptBytes[1]);
    check('message retry settles the recovery panel', await recovery.count() === 0);
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
    check('account screenshots do not request or send mail', mockOutbox.length === initialMailCount);
    check('runtime page errors', errors.length === 0, errors);
    check('same build throughout', fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim() === buildId);
    assert.equal(checks.filter(item => !item.ok).length, 0, 'all collected checks must pass');
    completed = true;
  } finally {
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({ buildId, completed, checks, errors, disclosures: ['Synthetic isolated PostgreSQL/API/Next fixture', 'SMS simulation only; no delivery', 'Mock-only email for account form display; no mail requested or delivered', 'Browser transport loading/error simulation, real recovery', 'Chromium, not real devices or screen-reader listening'] }, null, 2), { mode: 0o600 });
    if (browser) await browser.close();
    if (f) await f.close();
  }
  console.log(`[white-product] ${checks.length} checks passed; evidence: ${OUT}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
