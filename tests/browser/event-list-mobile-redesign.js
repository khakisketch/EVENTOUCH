// Run against the actual EVENTOUCH fixture; synthetic variants stay in memory only.
// playwright-cli -s=eventouch-event-redesign --config=/home/ksi/.config/opencode/browser/playwright.json open about:blank
// playwright-cli -s=eventouch-event-redesign run-code --filename=tests/browser/event-list-mobile-redesign.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const root = 'design-inputs/uiux-audit/event-list-redesign';
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const capture = name => page.screenshot({ path: `${root}/${name}.png`, scale: 'css', type: 'png' });
  const navigateList = async () => {
    await page.goto(`${baseUrl}/?__event_list_redesign=verify#/console/agency/events`);
    await page.reload();
    await page.waitForFunction(() => location.hash === '#/console/agency/events' && window.ET);
    await page.evaluate(() => { window.ET.ui.filters.events='';window.ET.ui.filters.eventStatus='';window.ET.render(); });
    await page.waitForSelector('.event-card');
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/?__event_list_redesign=verify#/console/agency/events`);
  await page.waitForFunction(() => document.querySelector('.admin-shell') || document.querySelector('#dev-quick-login'));
  if (!await page.locator('.admin-shell').count()) {
    await page.getByRole('button', { name: '빠른 로그인' }).click();
  }
  await page.waitForFunction(() => location.hash === '#/console/agency/events' && window.ET);
  await page.reload();
  await page.waitForFunction(() => location.hash === '#/console/agency/events' && window.ET);
  if (await page.locator('.overlay').count()) await page.locator('.overlay [aria-label="닫기"]').click();
  await page.evaluate(() => { window.ET.ui.filters.events='';window.ET.ui.filters.eventStatus='';window.ET.render(); });
  await page.waitForSelector('.event-card');

  const baseline = await page.evaluate(() => ({
    count: window.ET.state.events.filter(event => window.ET.eventAllowed(event.id)).length,
    eventId: window.ET.state.events.find(event => window.ET.eventAllowed(event.id))?.id,
    event: window.ET.state.events.find(event => window.ET.eventAllowed(event.id)),
  }));
  check(baseline.count === 1, 'The preserved actual fixture should expose its single assigned event.');
  const event = baseline.event || {};

  for (const width of [320, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(80);
    const layout = await page.evaluate(() => {
      const card = document.querySelector('.event-card');
      const action = card?.querySelector('a[href]');
      const button = document.querySelector('[data-action="new-event"]');
      const input = document.querySelector('#event-query');
      const select = document.querySelector('#event-status');
      const image = card?.querySelector('img');
      const scheduleDate=card?.querySelector('.event-schedule-date');
      const scheduleTime=card?.querySelector('.event-schedule-time');
      const singleGrid=document.querySelector('.event-card-grid-single');
      const box = node => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom };
      };
      return {
        width:innerWidth, viewportHeight:innerHeight, scrollY, scrollWidth:document.documentElement.scrollWidth,
        card:box(card), action:box(action), button:box(button), input:box(input), select:box(select), image:box(image),
        topbar:box(document.querySelector('.topbar')), menu:box(document.querySelector('.topbar .menu-button')),
        imageLoaded:!!image?.complete&&image.naturalWidth>0,
        scheduleDate:box(scheduleDate),scheduleTime:box(scheduleTime),scheduleTimeLines:scheduleTime?.getClientRects().length||0,
        scheduleGap:scheduleDate&&scheduleTime?scheduleTime.getBoundingClientRect().left-scheduleDate.getBoundingClientRect().right:null,
        singleGrid:box(singleGrid),content:box(document.querySelector('.content')),
        cardText:card?.innerText||'', eventTitle:card?.querySelector('h2')?.innerText||'',
        toolbar:box(document.querySelector('.toolbar')),
      };
    });
    check(layout.scrollWidth <= width + 1, `${width}px layout must not overflow horizontally (scrollWidth=${layout.scrollWidth}).`);
    check(layout.button && layout.button.height >= 44 && layout.button.width >= 44, `${width}px create action must retain a 44×44px minimum target.`);
    check(layout.input && layout.input.height >= 44, `${width}px search target must remain at least 44px high.`);
    check(layout.select && layout.select.height >= 44, `${width}px status filter must remain at least 44px high.`);
    check(layout.action && layout.action.height >= 44 && layout.action.width >= 44, `${width}px event-management action must retain a 44×44px minimum target.`);
    check(/일정/.test(layout.cardText) && /운영 상태/.test(layout.cardText), `${width}px card must label schedule separately from operational stage.`);
    check(/등록\s*\d+명/.test(layout.cardText.replace(/\n/g,' ')), `${width}px card should expose the event's registration count.`);
    check(layout.scheduleTime && layout.scheduleTimeLines===1, `${width}px scheduled time range should stay together on one line.`);
    if(width<=390) check(layout.scheduleDate?.y < layout.scheduleTime?.y, `${width}px date and time should occupy distinct, scannable lines.`);
    if(width>=1024) check(layout.scheduleGap>=3, `${width}px inline date and time should have a visible separator (gap=${layout.scheduleGap}).`);
    if(width>=768){
      check(layout.singleGrid?.width<=700, `${width}px one-event card should stay compact (width=${layout.singleGrid?.width}).`);
      check(Math.abs(layout.singleGrid?.x-layout.toolbar?.x)<=2, `${width}px one-event card should align with the event-list controls.`);
    }
    if (layout.image) check(layout.image.height <= 120, `${width}px low-information event image must not dominate the card (height=${layout.image.height}).`);
    if(width===390) check(layout.imageLoaded, 'The preserved actual fixture should exercise its loaded key visual, not silently skip the image check.');
    if (width <= 390) {
      check(layout.scrollY===0, `${width}px initial capture should begin at the top of the event-list page.`);
      check(layout.topbar?.y>=0 && layout.topbar?.bottom<=layout.viewportHeight, `${width}px first-screen workspace header should remain visible.`);
      check(layout.menu?.y>=layout.topbar?.y && layout.menu?.bottom<=layout.topbar?.bottom, `${width}px first-screen workspace menu should remain fully reachable.`);
      check(layout.card?.y < 350, `${width}px first event should begin in the initial scan region (y=${layout.card?.y}).`);
      check(layout.action?.bottom <= 0.75 * 844, `${width}px management action should be reachable in the initial screen without a long scroll (bottom=${layout.action?.bottom}).`);
    }
    if (width === 390) await capture('after-390');
    if (width === 320) await capture('after-320');
    if (width === 768) await capture('after-768');
    if (width === 1024) await capture('after-1024');
    if (width === 1280) await capture('after-1280');
  }

  await page.setViewportSize({ width:390, height:844 });
  await navigateList();
  await page.locator('#event-query').fill('없는 행사');
  await page.waitForFunction(() => document.querySelector('.empty'));
  const noResults = await page.locator('.empty').innerText();
  const noResultsCount = await page.locator('.event-list-count').innerText();
  const reset = page.locator('[data-action="clear-event-filters"]');
  check(/검색 결과|조건에 맞는 행사/.test(noResults), 'A zero-match query must explain that filters returned no results.');
  check(!/담당 행사가 없습니다|접근 권한/.test(noResults), 'A zero-match query must not imply missing event access.');
  check(noResultsCount === '0개 행사', `A zero-match query should announce zero visible events (got ${noResultsCount}).`);
  check(await reset.isVisible().catch(() => false), 'Zero-result state must provide a direct filter-reset action.');
  await capture('after-no-results-390');
  if (await reset.count()) await reset.click();
  else {
    await page.evaluate(() => { window.ET.ui.filters.events='';window.ET.ui.filters.eventStatus='';window.ET.render(); });
  }
  await page.waitForSelector('.event-card');
  check(await page.locator('#event-query').inputValue() === '', 'Reset must clear the event search query.');
  check(await page.locator('#event-status').inputValue() === '', 'Reset must clear the event-stage filter.');
  check(await page.evaluate(() => document.activeElement?.id==='event-query'), 'Reset should return keyboard focus to the search field.');
  const visibleCount = await page.evaluate(() => (document.querySelector('.event-list-count')||document.querySelector('.toolbar span'))?.textContent.trim());
  check(/1개 행사/.test(visibleCount||''), `Reset should restore the visible result count (got ${visibleCount}).`);
  check(await page.locator('label[for="event-query"]').count()===1, 'Search control must retain its accessible label.');
  check(await page.locator('label[for="event-status"]').count()===1, 'Status control must retain its accessible label.');
  check(await page.locator('.toolbar [role="status"], .toolbar [aria-live="polite"]').count()===1, 'Visible result count should be announced politely to assistive technology.');

  await page.evaluate(() => {
    const E=window.ET,original=E.state.events.find(event=>E.eventAllowed(event.id));
    window.__eventListCustomerSnapshot={events:E.state.events,clients:E.state.clients};
    E.state.events=E.state.events.map(event=>event.id===original.id?{...event,clientId:'synthetic-search-client'}:event);
    E.state.clients=[...E.state.clients,{id:'synthetic-search-client',name:'검색 고객사 샘플'}];
    E.render();
  });
  await page.locator('#event-query').fill('검색 고객사 샘플');
  await page.waitForSelector('.event-card');
  check(await page.locator('.event-card').count()===1, 'Searching by customer name should find its assigned event.');
  await page.locator('#event-query').fill('');
  await page.waitForSelector('.event-card');
  await page.evaluate(() => {const E=window.ET,s=window.__eventListCustomerSnapshot;E.state.events=s.events;E.state.clients=s.clients;delete window.__eventListCustomerSnapshot;E.render();});
  await page.waitForTimeout(150); // Let the restored render settle before keyboard traversal.

  await page.locator('#event-query').focus();
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement?.id==='event-status'), 'Keyboard order should move from search to status filter.');
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement?.matches('.event-card a[href]')), 'Keyboard order should continue from filters to event management.');
  await capture('after-focus-390');

  await page.locator('#event-status').selectOption('LIVE');
  await page.waitForTimeout(200); // Let the stage-filter render settle before counting.
  check(await page.locator('.event-card').count() === 1, 'The stored LIVE filter should preserve the existing event result.');
  await page.locator('#event-status').selectOption('DRAFT');
  check(await page.locator('.event-card').count() === 0, 'A non-matching stage filter should produce zero results.');
  check(await page.locator('.event-list-count').innerText() === '0개 행사', 'A non-matching stage filter should announce zero visible events.');
  const stageReset=page.locator('[data-action="clear-event-filters"]');
  check(await stageReset.isVisible().catch(() => false), 'Status-only zero results must also provide recovery.');
  if(await stageReset.count()) await stageReset.click();
  else await page.evaluate(() => { window.ET.ui.filters.events='';window.ET.ui.filters.eventStatus='';window.ET.render(); });
  await page.waitForSelector('.event-card');

  const management = page.locator('.event-card a[href]').first();
  const managementHref = await management.getAttribute('href');
  check(/\/overview/.test(managementHref||''), 'Event-management link should retain its existing overview route.');
  await management.click();
  await page.waitForFunction(() => /\/overview$/.test(location.hash));
  await page.goto(`${baseUrl}/?__event_list_redesign=verify#/console/agency/events`);
  await page.waitForSelector('.event-card');

  const create = page.locator('[data-action="new-event"]');
  await create.click();
  await page.waitForSelector('.overlay .modal[role="dialog"]');
  await page.waitForTimeout(300); // Capture the settled dialog, not its entrance transition.
  const modalFocus=await page.evaluate(()=>{
    const overlay=document.querySelector('.overlay'),dialog=overlay?.querySelector('[role="dialog"]');
    const nodes=Array.from(overlay?.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')||[]).filter(node=>!node.disabled&&node.tabIndex!==-1&&node.type!=='hidden'&&node.getClientRects().length);
    return {inside:!!dialog?.contains(document.activeElement),index:nodes.indexOf(document.activeElement),count:nodes.length};
  });
  check(modalFocus.inside&&modalFocus.index===0, 'Opening the create dialog should move focus to its first in-dialog control.');
  check(await page.locator('.overlay').innerText().then(text => text.includes('행사 만들기')), 'Create action should still enter the existing event-creation flow.');
  await capture('after-create-dialog-390');
  await page.keyboard.press('Shift+Tab');
  check(await page.evaluate(()=>{const overlay=document.querySelector('.overlay'),nodes=Array.from(overlay?.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')||[]).filter(node=>!node.disabled&&node.tabIndex!==-1&&node.type!=='hidden'&&node.getClientRects().length);return nodes.indexOf(document.activeElement)===nodes.length-1;}), 'Shift+Tab from the first dialog control should wrap to the last control.');
  await page.keyboard.press('Tab');
  check(await page.evaluate(()=>{const overlay=document.querySelector('.overlay'),nodes=Array.from(overlay?.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')||[]).filter(node=>!node.disabled&&node.tabIndex!==-1&&node.type!=='hidden'&&node.getClientRects().length);return nodes.indexOf(document.activeElement)===0;}), 'Tab from the last dialog control should wrap to the first control.');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.overlay', { state:'detached' });
  check(await page.evaluate(() => document.activeElement?.matches('[data-action="new-event"]')), 'Closing the create dialog with Escape should restore focus to its launch button.');

  // Render long-title and no-image variants by changing in-memory client state only.
  await page.evaluate(() => {
    const E=window.ET, original=E.state.events.find(item=>E.eventAllowed(item.id));
    window.__eventListRedesignSnapshot={events:E.state.events, workspace:E.state.workspaces[original.id], originalId:original.id, syntheticIds:[]};
    const synthetic=Array.from({length:7},(_,index)=>({
      ...original,id:`synthetic-event-${index+1}`,slug:`synthetic-event-${index+1}`,
      name:index===0?'긴 행사 이름 검증용 '.repeat(12)+'EVENTOUCH':`추가 행사 ${index+1} · 모바일 목록 밀도 확인`,
      date:`2026-12-${String(index+1).padStart(2,'0')}`,stage:['DRAFT','READY','ENDED','ARCHIVED','DRAFT','READY','ENDED'][index],
    }));
    E.state.events=[original,...synthetic];
    for(const event of synthetic){
      E.state.workspaces[event.id]=structuredClone(E.state.workspaces[original.id]);
      E.state.workspaces[event.id].branding={...(E.state.workspaces[event.id].branding||{}),keyvisual:null};
      window.__eventListRedesignSnapshot.syntheticIds.push(event.id);
    }
    E.ui.filters.events='';E.ui.filters.eventStatus='';E.render();
  });
  await page.waitForFunction(() => document.querySelectorAll('.event-card').length===8);
  await page.setViewportSize({ width:320, height:844 });
  await page.evaluate(() => window.scrollTo(0,0));
  const synthetic = await page.evaluate(() => ({
    scrollWidth:document.documentElement.scrollWidth,
    titles:[...document.querySelectorAll('.event-card h2')].map(node=>node.innerText),
    imageCounts:[...document.querySelectorAll('.event-card')].map(card=>card.querySelectorAll('img').length),
    cardCount:document.querySelectorAll('.event-card').length,
    noImageReservedWidth:(()=>{const card=document.querySelectorAll('.event-card')[1],main=card?.querySelector('.event-card-main')?.getBoundingClientRect(),info=card?.querySelector('.event-card-info')?.getBoundingClientRect();return main&&info?main.width-info.width:null;})(),
  }));
  check(synthetic.scrollWidth <= 321, 'Long titles and multiple events must not create horizontal overflow at 320px.');
  check(synthetic.titles.some(title=>title.includes('EVENTOUCH')), 'Long-title synthetic event should render in the list.');
  check(synthetic.cardCount===8, 'The list should remain renderable with eight events.');
  check(synthetic.imageCounts[1]===0, 'An event without an image should not receive a large empty image placeholder.');
  check(synthetic.noImageReservedWidth!==null && synthetic.noImageReservedWidth<=24, `An image-free card should not reserve an empty thumbnail column (reserved=${synthetic.noImageReservedWidth}).`);
  for(const [stage,expectedCount] of [['DRAFT',2],['READY',2],['LIVE',1],['ENDED',2],['ARCHIVED',1]]){
    await page.locator('#event-status').selectOption(stage);
    check(await page.locator('.event-card').count()===expectedCount, `${stage} filter should show its matching synthetic/fixture events.`);
    check(await page.locator('.event-list-count').innerText()===`${expectedCount}개 행사`, `${stage} filter should announce its matching result count.`);
  }
  await page.locator('#event-status').selectOption('');
  await page.waitForFunction(()=>document.querySelectorAll('.event-card').length===8);
  await capture('after-many-long-no-image-320');
  await page.locator('.event-card').last().scrollIntoViewIfNeeded();
  const deepScroll=await page.evaluate(() => ({
    scrollY:window.scrollY,
    scrollWidth:document.documentElement.scrollWidth,
    topbarTop:document.querySelector('.topbar')?.getBoundingClientRect().top,
    topbarBottom:document.querySelector('.topbar')?.getBoundingClientRect().bottom,
    menuTop:document.querySelector('.topbar .menu-button')?.getBoundingClientRect().top,
    menuBottom:document.querySelector('.topbar .menu-button')?.getBoundingClientRect().bottom,
    viewportHeight:innerHeight,
  }));
  check(deepScroll.scrollWidth<=321, 'Deep-scrolled multi-event list must not overflow horizontally at 320px.');
  check(deepScroll.topbarTop>=0 && deepScroll.topbarBottom<=deepScroll.viewportHeight, 'The full workspace header should remain visible during deep list scrolling.');
  check(deepScroll.menuTop>=deepScroll.topbarTop && deepScroll.menuBottom<=deepScroll.topbarBottom && deepScroll.menuBottom<=deepScroll.viewportHeight, 'The mobile menu control should remain fully reachable during deep list scrolling.');
  await capture('after-many-deep-scroll-320');
  await page.evaluate(() => {
    const E=window.ET,s=window.__eventListRedesignSnapshot;
    E.state.events=s.events;E.state.workspaces[s.originalId]=s.workspace;for(const id of s.syntheticIds)delete E.state.workspaces[id];
    delete window.__eventListRedesignSnapshot;E.render();
  });
  await page.waitForSelector('.event-card');

  // Thirty-event synthetic list (in-memory only): rows must stay compact and scannable.
  await page.evaluate(() => {
    const E=window.ET, original=E.state.events.find(item=>E.eventAllowed(item.id));
    window.__eventListManySnapshot={events:E.state.events};
    const many=Array.from({length:29},(_,index)=>({...original,id:`many-event-${index+1}`,slug:`many-event-${index+1}`,name:`합성 행사 ${index+1}`,date:`2026-12-${String((index%28)+1).padStart(2,'0')}`,stage:['DRAFT','READY','LIVE','ENDED','ARCHIVED'][index%5]}));
    E.state.events=[original,...many];
    for(const event of many){E.state.workspaces[event.id]=structuredClone(E.state.workspaces[original.id]);E.state.workspaces[event.id].branding={...(E.state.workspaces[event.id].branding||{}),keyvisual:null};}
    E.ui.filters.events='';E.ui.filters.eventStatus='';E.render();
  });
  await page.waitForFunction(()=>document.querySelectorAll('.event-card').length===30);
  await page.setViewportSize({width:320,height:844});
  await page.evaluate(()=>window.scrollTo(0,0));
  const many=await page.evaluate(()=>({count:document.querySelectorAll('.event-card').length,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,firstTop:document.querySelector('.event-card')?.getBoundingClientRect().y||0}));
  check(many.count===30,'Thirty-event list must render all rows.');
  check(many.scrollWidth<=321,'Thirty-event list must not overflow horizontally at 320px.');
  check(many.scrollHeight>844,'Thirty-event list should scroll rather than squeeze.');
  check(many.firstTop>=0&&many.firstTop<350,`First event must be reachable in the initial scan region (y=${many.firstTop}).`);
  await page.locator('#event-status').selectOption('LIVE');
  check((await page.locator('.event-card').count())>=1,'Stage filter must still work across thirty events.');
  await page.locator('#event-status').selectOption('');
  await page.evaluate(()=>{const E=window.ET,s=window.__eventListManySnapshot;E.state.events=s.events;for(const id of Object.keys(E.state.workspaces))if(id.startsWith('many-event-'))delete E.state.workspaces[id];delete window.__eventListManySnapshot;E.render();});
  await page.waitForFunction(()=>document.querySelectorAll('.event-card').length===1);

  await page.setViewportSize({ width:390, height:844 });
  await page.evaluate(() => {
    const E=window.ET;window.__eventListEmptySnapshot=E.state.events;E.state.events=[];E.render();
  });
  await page.waitForSelector('.empty');
  const trueEmpty = await page.locator('.empty').innerText();
  check(/담당 행사가 없습니다/.test(trueEmpty), 'A genuinely empty event scope should remain distinct from zero search results.');
  await capture('after-true-empty-390');
  await page.evaluate(() => { const E=window.ET;E.state.events=window.__eventListEmptySnapshot;delete window.__eventListEmptySnapshot;E.render(); });

  const permissionLimited = await page.evaluate(() => {
    const E=window.ET;
    const snapshot={memberships:E.state.memberships,orgOwner:E.session.orgOwner,orgPermissions:E.session.orgPermissions};
    E.state.memberships=[];E.session.orgOwner=false;E.session.orgPermissions=['events.view'];E.render();
    const result={eventCount:E.state.events.length,allowedCount:E.state.events.filter(event=>E.eventAllowed(event.id)).length,copy:document.querySelector('.empty')?.innerText||''};
    E.state.memberships=snapshot.memberships;E.session.orgOwner=snapshot.orgOwner;E.session.orgPermissions=snapshot.orgPermissions;E.render();
    return result;
  });
  check(permissionLimited.eventCount>0&&permissionLimited.allowedCount===0, 'Permission-limited verification should keep events in scope while exposing none to the current member.');
  check(/담당 행사가 없습니다/.test(permissionLimited.copy)&&/접근 권한/.test(permissionLimited.copy), 'A member with no assigned event access should retain the existing permission guidance.');

  if (failures.length) throw new Error(`Event-list redesign failures:\n- ${failures.join('\n- ')}`);
  return { result:'pass', viewports:[320,390,768,1024,1280], syntheticVariants:['many events','thirty events','long title','no image','true empty','permission-limited'], checks:failures.length };
}
