'use strict';
const { messageStep, openRecipientList, openMessagePanel, openMessageMore } = require('./ui-journey-helpers.cjs');

const { chooseRadio } = require('./ui-journey-helpers.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { extendFixtureSeed } = require('./web-console-audit.cjs');
const { prepareCaptureDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const out = process.env.EVENTOUCH_CAPTURE_ROOT ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'ui') : defaultCaptureDir(`ui-${runStamp()}`);
const axeSource = require('axe-core').source;
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
(async () => {
  prepareCaptureDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const seed = await extendFixtureSeed(f);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, locale: 'ko-KR' });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(seed.ownerCookie.slice('etko_session='.length)), url: f.baseUrl }]);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `${f.baseUrl}/console/events/${f.eventId}`;
    const a11y = async (p, name) => {
      await p.evaluate(axeSource);
      const findings = await p.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] } })).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(' | ')}`));
      check(`${name}: no blocking accessibility findings ${JSON.stringify(findings)}`, findings.length === 0);
    };
    // Event creation asks for its two required fields before optional setup.
    for (const size of [{width:1280,height:900},{width:1280,height:600},{width:390,height:844},{width:320,height:568}]) {
      await page.setViewportSize(size);
      await page.goto(`${f.baseUrl}/console`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name:'새 행사 만들기', exact:true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)))); // measure after the open animation settles (it scales the box mid-flight)
      const advanced = dialog.locator('details[data-create-settings]');
      check(`event optional setup starts closed at ${size.width}x${size.height}`, !await advanced.evaluate(el => el.open));
      const upFront = await dialog.locator('input:not([type="radio"]):visible,select:visible').evaluateAll(els => els.map(el => el.id));
      check(`event starts with name, date and (when customers exist) the customer select at ${size.width}x${size.height}`, upFront.includes('create-name') && upFront.includes('create-date') && upFront.every(id => ['create-name', 'create-date', 'create-client'].includes(id)));
      const visibleTargets = await dialog.locator('#create-name,#create-date,button[form="create-event-form"]').evaluateAll(elements => elements.every(el => {
        const b=el.getBoundingClientRect(); const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
        return b.y>=0 && b.bottom<=innerHeight && b.height>=44 && (hit===el || el.contains(hit));
      }));
      check(`event essentials and submit are directly reachable at ${size.width}x${size.height}`, visibleTargets);
      await a11y(page, `short event form ${size.width}x${size.height}`);
      await page.screenshot({ path:path.join(out, `event-create-short-${size.width}x${size.height}.png`) });
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'detached'});
    }
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button', {name:'새 행사 만들기',exact:true}).click();
    const create = page.getByRole('dialog');
    await create.locator('#create-name').fill('두 항목으로 만든 합성 행사');
    await create.locator('#create-date').fill('2027-04-12');
    check('event auto address remains optional and collapsed', !await create.locator('#create-slug').isVisible());
    await create.getByRole('button',{name:'행사 만들기',exact:true}).click();
    await page.waitForURL(/\/console\/events\/[^/?#]+$/);
    const minimalId = new URL(page.url()).pathname.split('/').pop();
    const saved = (await f.harness.database.query('SELECT payload FROM events WHERE id=$1',[minimalId])).rows[0]?.payload;
    check('two-field create persists the real event with existing defaults', saved?.name==='두 항목으로 만든 합성 행사' && saved.date==='2027-04-12' && saved.start==='09:00' && saved.end==='18:00' && saved.capacity===0 && Boolean(saved.slug));
    await page.goto(`${f.baseUrl}/console`,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'새 행사 만들기',exact:true}).click();
    await create.locator('#create-name').fill('주소 충돌 복구 합성 행사');
    await create.locator('#create-date').fill('2027-04-12');
    const advanced = create.locator('details[data-create-settings]');
    await advanced.locator(':scope > summary').click();
    await create.locator('#create-capacity').fill('120');
    await create.locator('#create-slug').fill(f.slug);
    await advanced.locator(':scope > summary').click();
    await create.getByRole('button',{name:'행사 만들기',exact:true}).click();
    await create.getByText(/행사 주소 코드가 이미 사용 중/).waitFor();
    await page.waitForFunction(() => document.activeElement?.id==='create-slug');
    check('server error reveals and focuses collapsed optional field', await advanced.evaluate(el=>el.open));
    check('optional form preserves its value when folded', await create.locator('#create-capacity').inputValue()==='120');
    await a11y(page,'event optional error');
    await page.screenshot({path:path.join(out,'event-create-optional-error.png')});
    await create.locator('#create-slug').fill(`short-${f.suffix.slice(0,12)}`);
    await create.getByRole('button',{name:'행사 만들기',exact:true}).click();
    await page.waitForURL(/\/console\/events\/[^/?#]+$/);
    const fixedId = new URL(page.url()).pathname.split('/').pop();
    const fixed = (await f.harness.database.query('SELECT payload FROM events WHERE id=$1',[fixedId])).rows[0]?.payload;
    check('optional error correction creates one event with the chosen capacity', fixed?.capacity===120 && fixed.name==='주소 충돌 복구 합성 행사');
    await page.setViewportSize({width:1440,height:1024});
    await page.goto(`${base}/content`, { waitUntil: 'networkidle' });
    // The content tabs carry their counts in the name ("공지 2", "일정 0"), so match the leading word.
    const contentTab = (word) => page.getByRole('tab', { name: new RegExp(`^${word}`) });
    await contentTab('장소 안내').click();
    const input = page.locator('#content-venue-name');
    await input.waitFor();
    const before = await input.inputValue(); await input.fill('보존할 장소 초안');
    await contentTab('공지').click();
    check('inactive task is hidden', !await input.isVisible());
    await contentTab('장소 안내').click();
    check('task switch preserves the venue draft', await input.inputValue() === '보존할 장소 초안');
    await contentTab('장소 안내').press('Home');
    check('Home selects and focuses the first tab', await contentTab('공지').evaluate(el => el === document.activeElement && el.getAttribute('aria-selected') === 'true'));
    await contentTab('공지').press('End');
    check('End selects the last task', await input.isVisible());
    await input.fill(before);
    await page.goto(`${base}/content#content-program`, { waitUntil: 'networkidle' });
    check('deep link selects its task', await contentTab('일정').getAttribute('aria-selected') === 'true');
    await page.goto(`${base}/participants`, { waitUntil: 'networkidle' });
    const trigger = page.getByRole('button', { name: /참가자 상세/ }).first(); await trigger.click();
    const panel = page.getByRole('dialog');
    await panel.waitFor();
    // Reopened 2026-11-20: details are an overlay sheet (modal), not a docked column.
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true');
    check('desktop detail is a modal overlay sheet', await panel.getAttribute('aria-modal') === 'true');
    check('desktop detail locks page scrolling', await page.evaluate(() => document.body.style.overflow === 'hidden'));
    await page.waitForTimeout(400); const sheetBox = await panel.boundingBox();
    check('desktop sheet hugs the right edge, 440-480px wide', Boolean(sheetBox) && Math.abs(sheetBox.x + sheetBox.width - 1440) < 2 && sheetBox.width >= 440 && sheetBox.width <= 480);
    await panel.getByRole('heading', { name: '신청 정보' }).focus(); await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' }); await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, await trigger.getAttribute('aria-label')); check('detail Escape returns focus to its row', await trigger.evaluate(el => el === document.activeElement));
    await trigger.click(); await page.waitForTimeout(600); /* let the sheet's open fade finish: axe reads mid-fade colors */ await a11y(page, 'desktop inspector'); await page.screenshot({ path: path.join(out, 'roster-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true');
    check('phone detail is modal', await page.evaluate(() => document.body.style.overflow === 'hidden'));
    const printDisclosure = panel.locator('summary').filter({ hasText: '네임택 인쇄' });
    const closeDetail = panel.getByRole('button', { name: '닫기', exact: true });
    await closeDetail.focus(); await page.keyboard.press('Tab');
    // The first stop is now the previous/next person control (the first person has no previous), never a collapsed print field.
    check('phone detail wraps to its first visible control, not a collapsed print field', await panel.getByRole('button', { name: '다음 참가자' }).evaluate(el => el === document.activeElement));
    await page.keyboard.press('Shift+Tab');
    check('phone detail wraps backwards to its close action', await closeDetail.evaluate(el => el === document.activeElement));
    // The name-tag preview mounts after the disclosure's toggle event, so wait for it before tabbing.
    await printDisclosure.press('Enter'); await panel.getByLabel('용지 규격', { exact: true }).waitFor(); await printDisclosure.focus(); await page.keyboard.press('Tab');
    check('the paper choice becomes tabbable after opening the print disclosure', await panel.getByLabel('용지 규격', { exact: true }).evaluate(el => el === document.activeElement));
    await printDisclosure.press('Enter');
    await a11y(page, 'phone inspector');
    await page.screenshot({ path: path.join(out, 'roster-phone.png') });
    await panel.getByRole('button', { name: '닫기', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.goto(`${f.baseUrl}/console/clients`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /고객사 (등록|추가)/ }).first().click();
    const form = page.locator('#client-form'); await form.waitFor();
    let writes = 0; page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/clients') writes++; });
    await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
    await form.getByRole('alert').waitFor();
    check('invalid client does not write', writes === 0);
    await a11y(page, 'Korean form errors');
    check('first invalid field receives focus', await page.locator('#client-name').evaluate(el => document.activeElement === el));
    check('invalid field is associated with Korean feedback', await page.locator('#client-name').evaluate(el => el.getAttribute('aria-invalid') === 'true' && document.getElementById(el.getAttribute('aria-describedby').split(' ').at(-1))?.textContent.includes('필수')));
    await page.locator('#client-name').fill('공통 폼 검증 고객사');
    await page.locator('#client-email').fill('invalid-email');
    await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
    check('bad email cannot reach the API', writes === 0 && await page.locator('#client-email').evaluate(el => document.activeElement === el));
    await page.locator('#client-email').fill('');
    await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: '공통 폼 검증 고객사', exact: true }).waitFor();
    check('valid form retains the real create flow', writes === 1 && await page.getByRole('heading', { name: '공통 폼 검증 고객사', exact: true }).isVisible());
    // Reports no longer have separate "보고서 내용" and "행사 마감" tab tasks (retired by the
    // confirmed reports composition, see DESIGN.md "결과 보고서 확정 구성"), so the old
    // select/reopen/return-fragment checks have nothing left to guard; the report screen
    // itself is covered by web-reports-composition and the redesign smoke audit.
    const pub = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    const guest = await pub.newPage(); guest.on('pageerror', error => errors.push(error.message));
    await guest.goto(`${f.baseUrl}/login`, { waitUntil: 'networkidle' });
    await guest.locator('#login-password').fill('local-only-password');
    const show = guest.getByRole('button', { name: '보기', exact: true }); await show.click();
    check('password visibility keeps the typed value', await guest.locator('#login-password').getAttribute('type') === 'text' && await guest.locator('#login-password').inputValue() === 'local-only-password');
    await guest.getByRole('button', { name: '숨기기', exact: true }).click();
    check('password returns to masked mode', await guest.locator('#login-password').getAttribute('type') === 'password');
    const workspace = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const person = workspace.participants.find(p => p.status === 'APPROVED');
    await guest.goto(`${f.baseUrl}/event/${f.slug}/engage?ticket=${encodeURIComponent(person.ticket)}`, { waitUntil: 'networkidle' });
    const disclosure = guest.locator('details').filter({ has: guest.locator('input[type="radio"][value="5"]') }).first();
    if (!await disclosure.getAttribute('open')) { if (!await disclosure.evaluate(el => el.open)) await disclosure.locator('summary').click(); }
    check('open attendee program has a visible collapse indicator', await disclosure.locator('summary').evaluate(el=>getComputedStyle(el,'::after').content.includes('−')));
    const rating = disclosure.locator('input[type="radio"][value="5"]').first(); await rating.check();
    const comment = disclosure.locator('textarea').first(); await comment.fill('접어도 보존할 응답');
    await disclosure.locator('summary').click();
    check('closed attendee program has a visible expand indicator', await disclosure.locator('summary').evaluate(el=>getComputedStyle(el,'::after').content.includes('+')));
    await disclosure.locator('summary').click();
    check('program folding preserves answers', await rating.isChecked() && await comment.inputValue() === '접어도 보존할 응답');
    for (const width of [320, 390]) {
      await guest.setViewportSize({ width, height: 844 });
      const labels = disclosure.locator('fieldset').first().locator('label');
      const boxes = await labels.evaluateAll(nodes => nodes.slice(0, 5).map(el => { const r = el.getBoundingClientRect(); return { y: r.y, width: r.width, height: r.height }; }));
      check(`rating remains a single row of touch targets at ${width}`, boxes.length === 5 && boxes.every(b => b.width >= 44 && b.height >= 44 && Math.abs(b.y - boxes[0].y) < 1));
      check(`no participation overflow at ${width}`, await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await a11y(guest, 'phone participation');
    await guest.screenshot({ path: path.join(out, 'engage-phone.png') });
    // Small saved choices are native radio groups; multi-select and actions
    // keep their original meaning. Changing a draft never dispatches it.
    const choices = await context.newPage(); choices.on('pageerror', error => errors.push(error.message));
    let choiceWrites = 0;
    choices.on('request', request => { if (request.method()==='POST' && /\/api\/events\/[^/]+\/commands$/.test(new URL(request.url()).pathname)) choiceWrites++; });
    await choices.goto(`${base}/messages`,{waitUntil:'networkidle'});
    await choices.locator('#message-compose-open').click();
    // Reopened 2026-11-24 (시안 A): the recipient list is folded in the 받는 사람 panel and the channel choice lives in the 보내는 방법 panel.
    await openRecipientList(choices);
    await choices.locator('ul[aria-label="참가자 선택"] input[type="checkbox"]').first().check();
    await openMessagePanel(choices, 'how');
    const channels = choices.locator('#campaign-channel');
    check('two delivery families are visible single choices', await channels.getByRole('radio').count()===2 && await channels.locator('input:checked').count()===1);
    await choices.locator('#campaign-body').fill('채널을 바꿔도 보존할 문구');
    await channels.getByRole('radio',{name:'문자',exact:true}).focus(); await choices.keyboard.press('ArrowRight');
    await choices.waitForFunction(()=>document.querySelector('#campaign-channel input[value="ALIMTALK"]')?.checked);
    check('radio arrow chooses one message channel', await channels.locator('input:checked').count()===1);
    await channels.focus();
    check('field error focus reaches the checked native radio', await channels.locator('input:checked').evaluate(el=>el===document.activeElement));
    await chooseRadio(choices,'campaign-channel','ALIMTALK');
    check('channel changes preserve message text', await choices.locator('#campaign-body').inputValue()==='채널을 바꿔도 보존할 문구');
    await chooseRadio(choices,'campaign-channel','SMS');
    check('SMS discloses existing content-dependent LMS conversion', await choices.locator('#campaign-channel-hint').innerText().then(t=>t.includes('LMS')));
    await a11y(choices,'message channel choices');
    await choices.screenshot({path:path.join(out,'channel-choices-desktop.png'),fullPage:true});
    await choices.setViewportSize({width:390,height:844});
    const targets = await channels.locator('label').evaluateAll(nodes=>nodes.map(el=>{const b=el.getBoundingClientRect();return{width:b.width,height:b.height}}));
    check('channel labels keep 44px touch targets', targets.every(b=>b.width>=44&&b.height>=44));
    check('message choices have no phone overflow', await choices.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await a11y(choices,'phone message choices');
    await choices.screenshot({path:path.join(out,'channel-choices-phone.png'),fullPage:true});
    await openMessageMore(choices); // the saved-template picker and its 템플릿 관리 link sit under 더 보기 for 문자
    await choices.getByRole('button',{name:'템플릿 관리',exact:true}).click();
    await chooseRadio(choices,'template-channel','ALIMTALK');
    check('template channel reveals required approved template ID', await choices.locator('#template-solapi-id').isVisible() && await choices.locator('#template-solapi-id').getAttribute('required')!==null);
    check('template and campaign selections remain independent', await channels.locator('input:checked').inputValue()==='SMS');
    check('choosing channels never executes a write', choiceWrites===0);
    await choices.close();
    const ops = await context.newPage(); ops.on('pageerror',error=>errors.push(error.message));
    await ops.goto(`${base}/operations#ops-desks`,{waitUntil:'networkidle'}); await ops.getByRole('button',{name:'데스크 추가',exact:true}).click();
    await chooseRadio(ops,'desk-action','OUT'); await chooseRadio(ops,'desk-mode','tablet');
    check('desk direction and display are independent single choices', await ops.locator('#desk-action input:checked').inputValue()==='OUT' && await ops.locator('#desk-mode input:checked').inputValue()==='tablet');
    await a11y(ops,'desk saved choices');
    ops.once('dialog', dialog=>dialog.accept());
    await ops.keyboard.press('Escape'); await ops.getByRole('dialog').waitFor({state:'detached'});
    // Operations is one page now (no tabs): the booth-mode disclosure sits in its own section.
    const modeSummary=ops.locator('summary[data-disclosure-indicator]').filter({hasText:'인증 방식'});
    check('operational settings advertise their closed state', await modeSummary.evaluate(el=>getComputedStyle(el,'::after').content.includes('+')));
    await modeSummary.focus(); await ops.keyboard.press('Enter');
    check('operational settings open with the keyboard and show their state', await modeSummary.evaluate(el=>el.parentElement.open && getComputedStyle(el,'::after').content.includes('−')));
    await ops.close();
    const draw = await context.newPage(); draw.on('pageerror',error=>errors.push(error.message));
    // Draws is master-detail now: deep-link the program so its detail card is the selected one,
    // and "결과 공개 허용" is a switch inside that card.
    const drawProgramId = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload.drawPrograms.find(p=>p.name==='통합 감사 추첨 프로그램').id;
    await draw.goto(`${base}/draws#draw-program-${encodeURIComponent(drawProgramId)}`,{waitUntil:'networkidle'});
    const unpublished = draw.locator('section[id^="draw-program-"]').filter({hasText:'통합 감사 추첨 프로그램'});
    const publishEmpty = unpublished.getByRole('switch',{name:'결과 공개 허용',exact:true});
    check('an open unpublished draw without winners offers a recovery action', await publishEmpty.isVisible() && await unpublished.getByRole('button',{name:'1명 추첨 실행',exact:true}).isDisabled());
    await publishEmpty.focus(); await draw.keyboard.press('Space');
    let review = draw.getByRole('group',{name:'실행 확인',exact:true});
    check('publishing future results explains the effect before confirmation', await review.getByText(/지금 추첨이 실행되지는 않습니다/).isVisible());
    await review.getByRole('button',{name:'취소',exact:true}).focus(); await draw.keyboard.press('Enter');
    await draw.waitForFunction(el=>document.activeElement===el,await publishEmpty.elementHandle());
    check('cancelling an inline confirmation returns keyboard focus to its action', await publishEmpty.evaluate(el=>document.activeElement===el));
    let drawState = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload.drawPrograms.find(p=>p.name==='통합 감사 추첨 프로그램');
    check('cancelling publication does not change or run the draw', drawState.published===false && drawState.winners.length===0);
    await publishEmpty.click(); review=draw.getByRole('group',{name:'실행 확인',exact:true});
    await review.getByRole('button',{name:'공개 허용',exact:true}).click();
    await draw.getByText('추첨 결과를 공개했습니다.',{exact:true}).waitFor();
    drawState = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload.drawPrograms.find(p=>p.name==='통합 감사 추첨 프로그램');
    check('confirming publication persists without drawing anyone', drawState.published===true && drawState.winners.length===0);
    // The success notice can render before the subsequent bootstrap refresh
    // clears the busy gate. Wait for this program's real button to unlock;
    // the database assertion above still proves publication and no draw.
    await draw.waitForFunction(() => [...document.querySelectorAll('section[id^="draw-program-"]')].some(row =>
      row.textContent.includes('통합 감사 추첨 프로그램') && [...row.querySelectorAll('button')].some(button =>
        button.textContent.trim() === '1명 추첨 실행' && !button.disabled)));
    check('confirming publication enables ordinary drawing', await unpublished.getByRole('button',{name:'1명 추첨 실행',exact:true}).isEnabled());
    const moduleUpdate = await f.helpers.requestJson(f.harness.baseUrl,`/api/events/${f.eventId}/commands`,{method:'POST',cookie:f.manager.cookie,body:{commandId:require('node:crypto').randomUUID(),command:'module.status',payload:{id:drawState.moduleId,status:'DRAFT'}}});
    assert.equal(moduleUpdate.status,200,'fixture module can be made private');
    await draw.reload({waitUntil:'networkidle'});
    check('private stage only blocks stage execution, not ordinary drawing', await unpublished.getByRole('button',{name:'1명 추첨 실행',exact:true}).isEnabled() && await unpublished.getByRole('button',{name:'무대 터치 실행',exact:true}).isDisabled());
    check('stage-only blocker is labeled for the stage action', await unpublished.getByText(/무대 터치 실행 전제:.*무대 프로그램 공개 필요/).isVisible() && await unpublished.locator('[id^="run-blockers-"]').count()===0);
    // Program settings open in a dialog from the detail card's 설정 수정 action.
    await unpublished.getByRole('button',{name:'설정 수정',exact:true}).click();
    await chooseRadio(draw,'draws-program-eligibility','COMPANY'); await chooseRadio(draw,'draws-program-overlap','PROGRAM');
    check('draw unit and overlap retain their exact draft values', await draw.locator('#draws-program-eligibility input:checked').inputValue()==='COMPANY' && await draw.locator('#draws-program-overlap input:checked').inputValue()==='PROGRAM');
    await a11y(draw,'draw saved choices'); await draw.close();
    const list = await context.newPage(); list.on('pageerror',error=>errors.push(error.message));
    for (const width of [390,320]) {
      await list.setViewportSize({width,height:844});
      await list.goto(`${base}/programs`,{waitUntil:'networkidle'});
      const createButton=list.getByRole('button',{name:'이벤트 만들기',exact:true});
      const refreshButton=list.getByRole('button',{name:'새로고침',exact:true});
      const pair=await Promise.all([createButton.boundingBox(),refreshButton.boundingBox()]);
      check(`program actions share a touch-sized row at ${width}`, pair.every(b=>b && b.height>=44) && Math.abs(pair[0].y-pair[1].y)<1);
      // The search and status filter only exist once a list is long (more than 8 items) or filtered,
      // so the fixture's short list has no toolbar to measure; web-programs-composition pins it.
      check(`program list does not overflow at ${width}`, await list.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await list.setViewportSize({width:390,height:844});
    await list.goto(`${base}/participants`,{waitUntil:'networkidle'});
    await list.getByRole('checkbox',{name:'감사 참가자 1 선택',exact:true}).check();
    await list.locator('#roster-search').fill('감사 참가자 2');
    const singleScope = list.getByRole('button',{name:'전체 1명 선택',exact:true});
    check('single-page selection needs no extra scope menu and describes the filter scope', !await list.getByText('여러 명 선택',{exact:true}).isVisible() && await singleScope.isVisible() && await singleScope.getAttribute('aria-describedby') === 'roster-select-all-help');
    await singleScope.click();
    check('single-page selection preserves participants hidden by the filter', await list.locator('#roster-selection-count').innerText().then(t=>t.includes('선택 2명')&&t.includes('필터 밖 1명')));
    await list.locator('#roster-search').fill('존재하지 않는 합성 이름');
    check('empty results do not offer an empty select-all action', await list.getByRole('button',{name:/^(?:필터 결과 )?전체 0명 선택$/}).count()===0);
    await list.goto(`${base}/participants`,{waitUntil:'networkidle'});
    await list.getByRole('button',{name:'참가자 추가',exact:true}).click();
    const manual=list.getByRole('dialog',{name:'참가자 추가'});
    await manual.evaluate(el=>Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>undefined)))); // measure after the open animation settles
    const fieldGeometry=await Promise.all([manual.locator('#participant-add-name').boundingBox(),manual.locator('label[for="participant-add-phone"]').boundingBox()]);
    check('manual registration leaves room between a focused field and the next label', fieldGeometry.every(Boolean) && fieldGeometry[1].y-(fieldGeometry[0].y+fieldGeometry[0].height)>=8);
    // On a phone the shared dialog footer stacks its actions full width; a short label like "등록"
    // must still be a comfortable touch target.
    const action=await manual.locator('button[form="participant-add-form"]').boundingBox();
    check('manual registration action is usable across the phone dialog', Boolean(action) && action.width>=88 && action.height>=44);
    check('manual registration mode has one selected native choice', await manual.locator('#participant-add-type input:checked').count()===1);
    await chooseRadio(manual,'participant-add-type','PRE');
    await manual.locator('#participant-add-name').fill('응답 유실 수동 참가자');
    await manual.locator('#participant-add-phone').fill('01078654321');
    const createAttempts=[];
    await list.route('**/api/events/*/commands',async route=>{
      const body=route.request().postDataJSON();
      if(route.request().method()!=='POST'||body?.command!=='participant.create') return route.continue();
      createAttempts.push(body);
      if(createAttempts.length===2) return route.fulfill({status:429,contentType:'application/json',body:'{"error":"fixture retry limited"}'});
      if(createAttempts.length===3) return route.fulfill({status:200,contentType:'application/json',body:'{}'});
      if(createAttempts.length>3) return route.continue();
      const actual=await route.fetch(); assert.ok(actual.ok(),'manual create really commits before the response is lost');
      return route.fulfill({status:502,contentType:'application/json',body:'{"error":"fixture response lost"}'});
    });
    await manual.getByRole('button',{name:'등록',exact:true}).click();
    await manual.getByRole('alert').filter({hasText:'같은 내용으로 다시 시도'}).waitFor();
    check('uncertain manual registration locks all inputs and offers the same retry', await manual.locator('#participant-add-name').isDisabled() && await manual.locator('#participant-add-type input').first().isDisabled() && await manual.getByRole('button',{name:'등록 결과 다시 확인',exact:true}).isEnabled());
    await list.keyboard.press('Escape');
    await list.setViewportSize({width:1280,height:900});
    const leavePrompt=list.waitForEvent('dialog');
    const leaveClick=list.getByRole('link',{name:'운영 현황',exact:true}).first().click(); // Reopened 2026-11-24: 행사 준비 group is collapsed here; 운영 현황 stays visible
    const leaveDialog=await leavePrompt;
    check('leaving warns that an uncertain registration cannot be rechecked elsewhere', leaveDialog.message().includes('등록 결과가 아직 확인되지 않았습니다'));
    await leaveDialog.dismiss(); await leaveClick;
    check('cancelling that warning keeps the original workspace', new URL(list.url()).pathname.endsWith('/participants'));
    await list.getByRole('button',{name:'참가자 추가',exact:true}).click();
    check('reopening an uncertain registration keeps its original values and warning', await manual.locator('#participant-add-name').inputValue()==='응답 유실 수동 참가자' && await manual.locator('#participant-add-type input:checked').inputValue()==='PRE' && await manual.getByRole('alert').isVisible());
    const limited=list.waitForResponse(response=>response.url().includes('/commands') && response.status()===429);
    await manual.getByRole('button',{name:'등록 결과 다시 확인',exact:true}).click();
    await limited;
    await manual.getByRole('button',{name:'등록 결과 다시 확인',exact:true}).waitFor();
    await list.waitForFunction(()=>!document.querySelector('button[form="participant-add-form"]')?.disabled);
    check('a rejected retry cannot unlock an earlier unconfirmed registration', await manual.locator('#participant-add-name').isDisabled() && await manual.getByRole('alert').filter({hasText:'같은 내용으로 다시 시도'}).isVisible());
    const emptyReply=list.waitForResponse(response=>response.url().includes('/commands') && response.status()===200);
    await manual.getByRole('button',{name:'등록 결과 다시 확인',exact:true}).click();
    await emptyReply;
    await list.waitForFunction(()=>!document.querySelector('button[form="participant-add-form"]')?.disabled);
    check('an incomplete success response also keeps the registration locked', await manual.locator('#participant-add-name').isDisabled() && await manual.getByRole('alert').filter({hasText:'같은 내용으로 다시 시도'}).isVisible());
    await manual.getByRole('button',{name:'등록 결과 다시 확인',exact:true}).click();
    await manual.waitFor({state:'detached'});
    check('manual registration always retries the exact command', createAttempts.length===4 && createAttempts.every(attempt=>JSON.stringify(attempt)===JSON.stringify(createAttempts[0])));
    const savedPeople=(await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].payload.participants.filter(p=>p.phone==='01078654321');
    check('lost response and retry leave one participant with the selected mode', savedPeople.length===1 && savedPeople[0].registrationType==='PRE');
    await list.unroute('**/api/events/*/commands');
    await list.close();
    check('no application runtime errors', errors.length === 0);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ result: 'passed', checks, build: fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim() }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ result: 'passed', checks: checks.length, out }));
  } finally { await browser?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
