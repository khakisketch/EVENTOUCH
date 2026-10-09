// Event operations overview redesign verification (actual fixture; synthetic states in-memory only).
// playwright-cli -s=eventouch-event-redesign run-code --filename=tests/browser/event-operations-overview.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const root = 'design-inputs/uiux-audit/event-operations';
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const capture = name => page.screenshot({ path: `${root}/${name}.png`, scale: 'css', type: 'png' });
  const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/?__event_ops_redesign=verify#/console/events/map-event/overview`);
  await page.waitForFunction(() => document.querySelector('.admin-shell') || document.querySelector('#dev-quick-login'));
  if (!await page.locator('.admin-shell').count()) await page.getByRole('button', { name: '빠른 로그인' }).click();
  await page.waitForFunction(() => location.hash.includes('/overview') && window.ET);
  await page.reload();
  await page.waitForFunction(() => location.hash.includes('/overview') && window.ET);
  await page.waitForSelector('.overview-page');

  // Topbar must still carry the event name (page heading no longer repeats it).
  check(/부스 지도 검증 행사/.test(await page.locator('.topbar').innerText()), 'Topbar must retain the event name after heading dedup.');

  const baseline390 = 1882;
  for (const width of [320, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => {
      const q = s => document.querySelector(s);
      const b = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { y: r.y, bottom: r.bottom, width: r.width, height: r.height }; };
      const t = (el, min) => { const r = el.getBoundingClientRect(); return r.width >= min && r.height >= 44; };
      return {
        width: innerWidth, viewportHeight: innerHeight, scrollY,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        heading: b(q('.overview-page .overview-heading h1')),
        metrics: [...document.querySelectorAll('.overview-page .metric-box')].map(b),
        metricCount: document.querySelectorAll('.overview-page .metric-box').length,
        tasks: b(q('.overview-page .overview-task-list, .overview-page .overview-task-empty')),
        taskActions: [...document.querySelectorAll('.overview-page .overview-task-list a[href]')].map(a => a.getAttribute('href')),
        primary: (() => { const a = document.querySelector('.overview-page .overview-heading .actions a[href], .overview-page .overview-heading .actions button'); return a ? { tag: a.tagName, ok: t(a), href: a.getAttribute('href') || '' } : null; })(),
        quickMoves: [...document.querySelectorAll('.overview-page .overview-quick-moves a[href]')].map(a => a.getAttribute('href')),
        smallTargets: [...document.querySelectorAll('.overview-page a[href], .overview-page button, .overview-page summary')].filter(el => { const r = el.getBoundingClientRect(); return (r.width < 44 || r.height < 44) && r.width > 0 && r.height > 0; }).length,
      };
    });
    check(layout.scrollWidth <= width + 1, `${width}px must not overflow horizontally (scrollWidth=${layout.scrollWidth}).`);
    check(layout.metricCount === 4, `${width}px must show all four metrics (got ${layout.metricCount}).`);
    check(layout.smallTargets === 0, `${width}px must keep every overview control at least 44px (small=${layout.smallTargets}).`);
    if (width <= 390) {
      check(layout.scrollHeight < baseline390, `${width}px scroll height must beat the 1882px baseline (got ${layout.scrollHeight}).`);
      check(layout.heading && layout.heading.y < 300, `${width}px compact heading must start near the top (y=${layout.heading?.y}).`);
      check(layout.tasks && layout.tasks.y < layout.viewportHeight, `${width}px pending tasks must begin inside the first screen (y=${layout.tasks?.y}).`);
    }
    if (width === 390) await capture('after-390');
    if (width === 320) await capture('after-320');
    if (width === 768) await capture('after-768');
    if (width === 1024) await capture('after-1024');
    if (width === 1280) await capture('after-1280');
  }

  // Route preservation: every previously reachable destination must remain reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const routes = await page.evaluate(() => [...document.querySelectorAll('.overview-page a[href]')].map(a => a.getAttribute('href')));
  for (const need of ['/checkin', '/participants']) check(routes.some(h => h.includes(need)), `Overview must keep a path to ${need}.`);
  check(routes.some(h => h.includes('/booths') || h.includes('/page')), 'Overview must keep booth or participant-page access.');

  // Keyboard order: summary/details and task actions reachable by Tab from heading action.
  await page.locator('.overview-page .overview-heading .actions a, .overview-page .overview-heading .actions button').first().focus();
  const tabStops = [];
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); tabStops.push(await page.evaluate(() => document.activeElement?.tagName + '.' + (document.activeElement?.className?.baseVal ?? document.activeElement?.className ?? ''))); }
  check(tabStops.some(s => s.includes('A')), 'Keyboard must reach overview links from the heading action.');

  // Details disclosure opens and reveals venue info.
  const summary = page.locator('.overview-page .overview-details summary');
  if (await summary.count()) {
    await summary.click();
    check(await page.locator('.overview-page .overview-details').getAttribute('open') !== null, 'Schedule/venue summary must expand on demand.');
    await capture('after-details-390');
    await summary.click();
  }

  // Synthetic prep/ended states in memory only.
  const states = await page.evaluate(() => {
    const E = window.ET, ev = E.state.events.find(x => x.id === 'map-event');
    const keep = ev.stage; const out = {};
    for (const stage of ['READY', 'ENDED']) {
      ev.stage = stage; E.render();
      out[stage] = { html: document.querySelector('.overview-page')?.innerText.slice(0, 400) || '', links: [...document.querySelectorAll('.overview-page a[href]')].map(a => a.getAttribute('href')) };
    }
    ev.stage = keep; E.render();
    return out;
  });
  check(/운영 준비|준비할 업무/.test(states.READY.html), 'Prep state must keep its preparation tasks.');
  check(/운영 마감|마감할 업무/.test(states.ENDED.html), 'Ended state must keep its wrap-up tasks.');
  await page.waitForSelector('.overview-page');

  if (failures.length) throw new Error(`Overview redesign failures:\n- ${failures.join('\n- ')}`);
  return { result: 'pass', viewports: [320, 390, 768, 1024, 1280], checks: failures.length };
}
