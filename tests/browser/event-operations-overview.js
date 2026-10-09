// Operations home console verification (actual fixture; synthetic states in-memory only).
// playwright-cli -s=eventouch-event-redesign run-code --filename=tests/browser/event-operations-overview.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const root = 'design-inputs/uiux-audit/event-operations';
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

  const baseline390 = 1241;
  for (const width of [320, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const layout = await page.evaluate(() => {
      const q = s => document.querySelector(s);
      const b = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { y: Math.round(r.y), bottom: Math.round(r.bottom) }; };
      const hrefs = [...document.querySelectorAll('.overview-page a[href]')].map(a => a.getAttribute('href'));
      return {
        width: innerWidth, viewportHeight: innerHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        identity: b(q('.overview-page .overview-identity')),
        statusCards: document.querySelectorAll('.overview-page .overview-status-card').length,
        primaryCtas: document.querySelectorAll('.overview-page .overview-primary-cta').length,
        checkinHrefs: hrefs.filter(h => h.includes('/checkin')).length,
        taskRows: document.querySelectorAll('.overview-page .overview-task-row').length,
        quickLinks: [...document.querySelectorAll('.overview-page .overview-quick-link span')].map(n => n.innerText),
        timelineRows: document.querySelectorAll('.overview-page .overview-timeline-item').length,
        timelineTimes: [...document.querySelectorAll('.overview-page .overview-timeline time')].map(n => n.innerText),
        allRecords: q('.overview-page .overview-activity-footer a')?.getAttribute('href') || '',
        attendeeLink: q('.overview-page .overview-attendee-link')?.getAttribute('href') || '',
        smallTargets: [...document.querySelectorAll('.overview-page a[href], .overview-page button, .overview-page summary')].filter(el => { const r = el.getBoundingClientRect(); return (r.width < 44 || r.height < 44) && r.width > 0 && r.height > 0; }).length,
      };
    });
    check(layout.scrollWidth <= width + 1, `${width}px must not overflow horizontally (scrollWidth=${layout.scrollWidth}).`);
    check(layout.statusCards === 4, `${width}px must show 4 status values (got ${layout.statusCards}).`);
    check(layout.checkinHrefs === 1, `${width}px must expose checkin exactly once (got ${layout.checkinHrefs}).`);
    check(layout.smallTargets === 0, `${width}px must keep every overview control at least 44px (small=${layout.smallTargets}).`);
    check(layout.timelineRows <= 2, `${width}px recent activity must cap at 2 rows (got ${layout.timelineRows}).`);
    check(layout.timelineTimes.every(t => /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(t)), `${width}px timeline must use short times (got ${layout.timelineTimes.join('|')}).`);
    check(layout.allRecords.includes('/checks'), `${width}px must link full history to the checks route.`);
    check(layout.attendeeLink.includes('/event/'), `${width}px must keep the attendee-page link in the identity area.`);
    check(JSON.stringify(layout.quickLinks) === JSON.stringify(['참가자 관리', '부스 운영', '활동 기록']), `${width}px quick menu must be the 3-destination menu (got ${layout.quickLinks.join('/')}).`);
    if (width <= 390) {
      check(layout.scrollHeight < baseline390, `${width}px scroll height must beat the 1241px baseline (got ${layout.scrollHeight}).`);
      check(layout.identity && layout.identity.y < 300, `${width}px identity line must start near the top (y=${layout.identity?.y}).`);
    }
    if (width === 390) await capture('after-390');
    if (width === 320) await capture('after-320');
    if (width === 768) await capture('after-768');
    if (width === 1024) await capture('after-1024');
    if (width === 1280) await capture('after-1280');
  }

  // Collapsing header still works and keeps menu + name reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const top0 = await page.evaluate(() => document.querySelector('.admin-main>.topbar').getBoundingClientRect().height);
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(250);
  const collapsed = await page.evaluate(() => ({
    cls: document.body.classList.contains('overview-scrolled'),
    h: Math.round(document.querySelector('.admin-main>.topbar').getBoundingClientRect().height),
    menu: (() => { const r = document.querySelector('.topbar .menu-button')?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= innerHeight; })(),
  }));
  check(collapsed.cls && collapsed.h <= top0 && collapsed.h <= 56, `Header must collapse on scroll (top=${top0}, collapsed=${collapsed.h}).`);
  check(collapsed.menu, 'Collapsed header must keep the menu reachable.');
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

  // Keyboard order from the first status card.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.overview-page .overview-status-card[href]').first().focus();
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
  check(/운영 준비|준비할 업무/.test(states.READY), 'Prep state must keep its preparation tasks.');
  check(/운영 마감|마감할 업무/.test(states.ENDED), 'Ended state must keep its wrap-up tasks.');
  await page.waitForSelector('.overview-page');

  if (failures.length) throw new Error(`Operations home failures:\n- ${failures.join('\n- ')}`);
  return { result: 'pass', viewports: [320, 390, 768, 1024, 1280], checks: failures.length };
}
