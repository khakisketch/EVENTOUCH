// Operations home simplify verification (actual fixture; synthetic states in-memory only).
// playwright-cli -s=eventouch-event-redesign run-code --filename=tests/browser/event-operations-overview.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const root = '/tmp/opencode/eventouch-captures/event-operations';
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const capture = name => page.screenshot({ path: `${root}/${name}.png`, scale: 'css', type: 'png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/?__event_ops_home=verify#/console/events/map-event/overview`);
  await page.waitForFunction(() => document.querySelector('.admin-shell') || document.querySelector('#dev-quick-login'));
  if (!await page.locator('.admin-shell').count()) await page.getByRole('button', { name: '빠른 로그인' }).click();
  await page.waitForFunction(() => location.hash.includes('/overview') && window.ET);
  await page.reload();
  await page.waitForFunction(() => location.hash.includes('/overview') && window.ET);
  await page.waitForSelector('.overview-page');

  // Event name lives in the sticky topbar, not repeated in the body.
  check(/부스 지도 검증 행사/.test(await page.locator('.topbar').innerText()), 'Topbar must retain the event name.');
  check(!(await page.locator('.overview-page').innerText()).includes('부스 지도 검증 행사'), 'Body must not repeat the event name.');
  // Stage badge must carry its operational-stage label (never date-derived).
  check(/운영 단계/.test(await page.locator('.overview-page').innerText()), 'Stage badge must carry the 운영 단계 label.');

  for (const width of [320, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const layout = await page.evaluate(() => {
      const q = s => document.querySelector(s);
      const b = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { y: Math.round(r.y), bottom: Math.round(r.bottom) }; };
      const hrefs = [...document.querySelectorAll('.overview-page a[href]')].map(a => a.getAttribute('href'));
      const text = document.querySelector('.overview-page')?.innerText || '';
      return {
        width: innerWidth, viewportHeight: innerHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        identity: b(q('.overview-page .overview-identity')),
        primaryRows: document.querySelectorAll('.overview-page .overview-primary-row').length,
        kpiCards: document.querySelectorAll('.overview-page .overview-kpi-card').length,
        checkinHrefs: hrefs.filter(h => h.includes('/checkin')).length,
        taskRows: document.querySelectorAll('.overview-page .overview-task-row').length,
        actionTitle: q('#overview-action-title')?.innerText || '',
        progressTitle: q('#overview-progress-title')?.innerText || '',
        action: b(q('.overview-action-panel')),
        kpis: b(q('.overview-kpi-section')),
        activityRows: document.querySelectorAll('.overview-page .overview-check-activity-list li').length,
        recentSections: [...document.querySelectorAll('.overview-page h2')].map(n => n.innerText).filter(t => /최근 입퇴장/.test(t)).length,
        activityLink: q('.overview-check-activity-heading a')?.getAttribute('href') || '',
        managementLinks: document.querySelectorAll('.overview-page .overview-menu-link').length,
        attendeeLink: q('.overview-page .overview-attendee-link')?.getAttribute('href') || '',
        pendingDupes: (text.match(/1건/g) || []).length,
        smallTargets: [...document.querySelectorAll('.overview-page a[href], .overview-page button, .overview-page summary')].filter(el => { const r = el.getBoundingClientRect(); return (r.width < 44 || r.height < 44) && r.width > 0 && r.height > 0; }).length,
      };
    });
    check(layout.scrollWidth <= width + 1, `${width}px must not overflow horizontally (scrollWidth=${layout.scrollWidth}).`);
    check(layout.kpiCards > 0 && layout.kpiCards <= 4, `${width}px must show no more than 4 permitted KPIs (got ${layout.kpiCards}).`);
    check(layout.actionTitle === '지금 할 일', `${width}px must present the current task group first (got ${layout.actionTitle}).`);
    check(layout.primaryRows === 1, `${width}px must show exactly one primary action row (got ${layout.primaryRows}).`);
    check(layout.checkinHrefs === 1, `${width}px must expose checkin exactly once (got ${layout.checkinHrefs}).`);
    check(layout.smallTargets === 0, `${width}px must keep every overview control at least 44px (small=${layout.smallTargets}).`);
    check(layout.recentSections === 1 && layout.activityRows <= 5, `${width}px must show up to five recent records (sections=${layout.recentSections}, rows=${layout.activityRows}).`);
    check(layout.activityLink.includes('/checks'), `${width}px recent activity must link to the existing checks route.`);
    check(layout.managementLinks === 0, `${width}px must not duplicate the sidebar management menu.`);
    check(layout.attendeeLink.includes('/event/'), `${width}px must keep the attendee-page link in the identity area.`);
    if (width === 1280) {
      check(layout.kpis && layout.kpis.bottom <= layout.viewportHeight, `1280px first screen must contain the KPI group (bottom=${layout.kpis?.bottom}).`);
      check(layout.action && layout.action.bottom <= layout.viewportHeight, `1280px first screen must contain the current tasks (bottom=${layout.action?.bottom}).`);
    }
    if (width <= 390) {
      check(layout.identity && layout.identity.y < 300, `${width}px identity line must start near the top (y=${layout.identity?.y}).`);
      if (width === 390) {
        check(layout.kpis && layout.kpis.bottom <= layout.viewportHeight, `390px first screen must contain the KPI group (bottom=${layout.kpis?.bottom}).`);
        check(layout.action && layout.action.bottom <= layout.viewportHeight, `390px first screen must contain the current tasks (bottom=${layout.action?.bottom}).`);
      }
    }
    if (width === 390) await capture('after-390');
    if (width === 320) await capture('after-320');
    if (width === 768) await capture('after-768');
    if (width === 1024) await capture('after-1024');
    if (width === 1280) await capture('after-1280');
  }

  // Collapsing header: when the page scrolls, it shrinks but keeps menu reachable.
  // (A zero-scroll page is an even stronger result — everything already visible.)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const scrollRoom = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  if (scrollRoom <= 32) {
    check(scrollRoom <= 1, `Short page must fit the viewport without scrolling (overflow=${scrollRoom}).`);
  } else {
    const top0 = await page.evaluate(() => document.querySelector('.admin-main>.topbar').getBoundingClientRect().height);
    await page.evaluate((max) => window.scrollTo(0, max), scrollRoom);
    await page.waitForTimeout(250);
    const collapsed = await page.evaluate(() => ({
      cls: document.body.classList.contains('overview-scrolled'),
      h: Math.round(document.querySelector('.admin-main>.topbar').getBoundingClientRect().height),
      menu: (() => { const r = document.querySelector('.topbar .menu-button')?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= innerHeight; })(),
    }));
    check(collapsed.cls && collapsed.h <= top0 && collapsed.h <= 56, `Header must collapse on scroll (top=${top0}, collapsed=${collapsed.h}).`);
    check(collapsed.menu, 'Collapsed header must keep the menu reachable.');
  }
  await capture('after-collapsed-390');

  // Other event pages keep their chrome.
  await page.goto(`${baseUrl}/?__event_ops_home=verify#/console/events/map-event/checkin`);
  await page.waitForFunction(() => location.hash.includes('/checkin'));
  await page.waitForTimeout(300);
  const other = await page.evaluate(() => {
    const a = document.querySelector('.admin-main>.topbar>.actions'), r = a?.getBoundingClientRect();
    const f = document.querySelector('.workspace-footer'), fr = f?.getBoundingClientRect();
    return { actionsVisible: r && r.width > 0, footerVisible: fr && fr.height > 0, noCollapse: !document.body.classList.contains('overview-scrolled') };
  });
  check(other.actionsVisible && other.footerVisible && other.noCollapse, 'Non-overview pages must keep topbar actions and footer.');
  await page.goto(`${baseUrl}/?__event_ops_home=verify#/console/events/map-event/overview`);
  await page.waitForFunction(() => location.hash.includes('/overview') && window.ET);
  await page.waitForSelector('.overview-page');

  // Keyboard order from the primary row.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.overview-page .overview-primary-row').focus();
  const tabStops = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); tabStops.push(await page.evaluate(() => document.activeElement?.tagName)); }
  check(tabStops.filter(t => t === 'A').length >= 2, 'Keyboard must move through overview actions.');

  // Synthetic prep/ended states in memory only.
  const states = await page.evaluate(() => {
    const E = window.ET, ev = E.state.events.find(x => x.id === 'map-event');
    const keep = ev.stage; const out = {};
    for (const stage of ['READY', 'ENDED']) {
      ev.stage = stage; E.render();
      out[stage] = document.querySelector('.overview-page')?.innerText.slice(0, 300) || '';
    }
    ev.stage = keep; E.render();
    return out;
  });
  check(/운영 준비|준비할 업무|운영 준비 이어하기|접수·준비 현황/.test(states.READY), 'Prep state must keep its preparation context.');
  check(/지금 할 일/.test(states.ENDED) && /결과 분석 보기|닫을 참가 접수|마감/.test(states.ENDED), 'Ended state must keep its wrap-up tasks.');
  await page.waitForSelector('.overview-page');

  if (failures.length) throw new Error(`Operations home failures:\n- ${failures.join('\n- ')}`);
  return { result: 'pass', viewports: [320, 390, 768, 1024, 1280], checks: failures.length };
}
