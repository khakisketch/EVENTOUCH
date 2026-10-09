// Event operations console verification (actual fixture; synthetic states in-memory only).
// playwright-cli -s=eventouch-event-redesign run-code --filename=tests/browser/event-operations-overview.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const root = 'design-inputs/uiux-audit/event-operations';
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const capture = name => page.screenshot({ path: `${root}/${name}.png`, scale: 'css', type: 'png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/?__event_ops_console=verify#/console/events/map-event/overview`);
  await page.waitForFunction(() => document.querySelector('.admin-shell') || document.querySelector('#dev-quick-login'));
  if (!await page.locator('.admin-shell').count()) await page.getByRole('button', { name: '빠른 로그인' }).click();
  await page.waitForFunction(() => location.hash.includes('/overview') && window.ET);
  await page.reload();
  await page.waitForFunction(() => location.hash.includes('/overview') && window.ET);
  await page.waitForSelector('.overview-page');

  const baseline390 = 1882;
  for (const width of [320, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const layout = await page.evaluate(() => {
      const q = s => document.querySelector(s);
      const b = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { y: Math.round(r.y), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
      return {
        width: innerWidth, viewportHeight: innerHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        heading: b(q('.overview-page .overview-heading h1')),
        metricCount: document.querySelectorAll('.overview-page .metric-box').length,
        metricIcons: [...document.querySelectorAll('.overview-page .overview-metric-icon svg path')].map(p => p.getAttribute('d').length > 10),
        tasks: b(q('.overview-page .overview-task-panel')),
        taskQuantities: [...document.querySelectorAll('.overview-page .overview-task-quantity')].map(n => n.innerText.replace(/\s+/g, ' ')),
        primary: (() => { const a = document.querySelector('.overview-page .overview-quick-link.primary'); const r = a?.getBoundingClientRect(); return a ? { href: a.getAttribute('href'), h: Math.round(r.height) } : null; })(),
        quickLabels: [...document.querySelectorAll('.overview-page .overview-quick-link span')].map(n => n.innerText),
        timelineRows: document.querySelectorAll('.overview-page .overview-timeline-item').length,
        timelineTimes: [...document.querySelectorAll('.overview-page .overview-timeline time')].map(n => n.innerText),
        allRecords: document.querySelector('.overview-page .overview-activity-footer a')?.getAttribute('href') || '',
        smallTargets: [...document.querySelectorAll('.overview-page a[href], .overview-page button, .overview-page summary')].filter(el => { const r = el.getBoundingClientRect(); return (r.width < 44 || r.height < 44) && r.width > 0 && r.height > 0; }).length,
        topbarActionsVisible: (() => { const a = document.querySelector('.admin-main>.topbar>.actions'); const r = a?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0; })(),
        topbarH: Math.round(document.querySelector('.admin-main>.topbar')?.getBoundingClientRect().height || 0),
        footerHidden: (() => { const f = document.querySelector('.workspace-footer'); if (!f) return true; const r = f.getBoundingClientRect(); return r.height === 0; })(),
      };
    });
    check(layout.scrollWidth <= width + 1, `${width}px must not overflow horizontally (scrollWidth=${layout.scrollWidth}).`);
    check(layout.metricCount === 4 && layout.metricIcons.length === 4 && layout.metricIcons.every(Boolean), `${width}px must show 4 metrics with real icons.`);
    check(layout.smallTargets === 0, `${width}px must keep every overview control at least 44px (small=${layout.smallTargets}).`);
    check(layout.primary && layout.primary.href.includes('/checkin') && layout.primary.h >= 44, `${width}px must emphasize 체크인 as the single primary quick action.`);
    check(layout.timelineRows <= 3, `${width}px recent activity must cap at 3 rows (got ${layout.timelineRows}).`);
    check(layout.timelineTimes.every(t => /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(t)), `${width}px timeline must use short times (got ${layout.timelineTimes.join('|')}).`);
    check(layout.allRecords.includes('/checks'), `${width}px must link full history to the checks route.`);
    check(layout.topbarActionsVisible === false, `${width}px overview must hide topbar actions (badge/button live in body).`);
    check(layout.footerHidden === true, `${width}px overview must hide the product footer.`);
    if (width <= 390) {
      check(layout.scrollHeight < baseline390, `${width}px scroll height must beat the 1882px baseline (got ${layout.scrollHeight}).`);
      check(layout.tasks && layout.tasks.y < layout.viewportHeight, `${width}px tasks must begin inside the first screen (y=${layout.tasks?.y}).`);
    }
    if (width === 390) await capture('after-390');
    if (width === 320) await capture('after-320');
    if (width === 768) await capture('after-768');
    if (width === 1024) await capture('after-1024');
    if (width === 1280) await capture('after-1280');
  }

  // Collapsing header: scrolled state shrinks the bar but keeps menu + name reachable.
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
    name: (() => { const r = document.querySelector('.topbar .event-context')?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= innerHeight; })(),
  }));
  check(collapsed.cls && collapsed.h < top0 && collapsed.h <= 56, `Header must collapse on scroll (top=${top0}, collapsed=${collapsed.h}).`);
  check(collapsed.menu && collapsed.name, 'Collapsed header must keep menu and event name reachable.');
  await capture('after-collapsed-390');

  // Other event pages must keep their chrome (spot-check).
  await page.goto(`${baseUrl}/?__event_ops_console=verify#/console/events/map-event/checkin`);
  await page.waitForFunction(() => location.hash.includes('/checkin'));
  await page.waitForTimeout(300);
  const other = await page.evaluate(() => {
    const a = document.querySelector('.admin-main>.topbar>.actions'), r = a?.getBoundingClientRect();
    const f = document.querySelector('.workspace-footer'), fr = f?.getBoundingClientRect();
    return { actionsVisible: r && r.width > 0, footerVisible: fr && fr.height > 0, noCollapse: !document.body.classList.contains('overview-scrolled') };
  });
  check(other.actionsVisible && other.footerVisible && other.noCollapse, 'Non-overview pages must keep topbar actions and footer.');
  await page.goto(`${baseUrl}/?__event_ops_console=verify#/console/events/map-event/overview`);
  await page.waitForFunction(() => location.hash.includes('/overview') && window.ET);
  await page.waitForSelector('.overview-page');

  // Keyboard order from the primary quick action.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.overview-page .overview-quick-link.primary').focus();
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

  if (failures.length) throw new Error(`Overview console failures:\n- ${failures.join('\n- ')}`);
  return { result: 'pass', viewports: [320, 390, 768, 1024, 1280], checks: failures.length };
}
