'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { messageStep, chooseRadio, selectTask, openRecipientList, openMessagePanel, openMessageMore, openTemplatePicker } = require('./ui-journey-helpers.cjs');
const axeSource = require('axe-core').source;
let phase = 'setup';
(async () => {
  const out = process.env.EVENTOUCH_CAPTURE_ROOT ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-targeting') : defaultCaptureDir(`message-targeting-${runStamp()}`);
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, page;
  const checks = [], errors = [], commands = [];
  const observePage = target => {
    target.setDefaultTimeout(12000);
    target.on('pageerror', error => errors.push(error.message));
    target.on('dialog', dialog => dialog.dismiss());
    target.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
      const body = request.postDataJSON();
      if (['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(body.command)) assert.equal(body.payload.simulate, true, 'only synthetic records may be created');
      commands.push(body);
    });
  };
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  // Reopened 2026-11-24 (시안 A): the picker lives in the 받는 사람 panel and its list is folded by default.
  const ensureListOpen = () => openRecipientList(page);
  const selectedRows = () => page.getByRole('list', { name: '참가자 선택', exact: true }).locator('li');
  const call = async (command, payload) => {
    const result = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload } });
    assert.ok(result.status >= 200 && result.status < 300, `${command}: ${result.status}`); return result.json;
  };
  try {
    const ws = await read();
    const fixtureGroups = ['파트너', '파트너', '스피커', '', '파트너', '일반', '파트너', '일반'];
    ws.groups = ['일반', '파트너', '스피커'];
    ws.participants.forEach((person, index) => { person.group = fixtureGroups[index % fixtureGroups.length]; person.status = index === 4 ? 'PENDING' : index === 5 ? 'WAITLIST' : index === 6 ? 'CANCELLED' : 'APPROVED'; });
    const legacyId = 'legacy-mms-' + crypto.randomUUID();
    ws.messages.unshift({ id: legacyId, title: '합성 이전 MMS', body: '예전 사진 안내 문구입니다.', channel: 'MMS', status: 'FAILED', recipientIds: [ws.participants[0].id], simulate: true, at: new Date().toISOString(), deliveries: [] });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]);
    const template = (await call('template.save', { name: '합성 승인 문구', channel: 'ALIMTALK', body: '{{이름}}님, {{행사명}} 참여를 안내합니다.', solapiTemplateId: 'KAFIXTURE_ONLY' })).template;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await context.newPage(); observePage(page);
    const base = `${f.baseUrl}/console/events/${f.eventId}/messages`;
    const capture = async name => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(out, name + '.png') }); };
    phase = 'recipient controls';
    await page.goto(base + '?to=' + encodeURIComponent(ws.participants[0].id), { waitUntil: 'networkidle' });
    // The composer starts collapsed behind the compose button unless the link already opened it.
    if (await page.locator('#message-compose-open').isVisible()) await page.locator('#message-compose-open').click();
    await messageStep(page, 1); await capture('01-recipients-1280');
    await messageStep(page, 2); await openMessageMore(page); await page.locator('#campaign-title').fill('합성 업무 안내');
    await page.locator('#campaign-body').fill('행사 시작 시간과 등록 데스크를 확인해 주세요.'); await capture('02-composition-1280');
    await (await openTemplatePicker(page)).selectOption(template.id);
    const replace = page.getByRole('button', { name: '템플릿 적용', exact: true }); if (await replace.count()) await replace.click();
    await page.getByText('카카오 알림톡 도착 예시', { exact: true }).waitFor(); await capture('03-alimtalk-1280');
    await page.setViewportSize({ width: 390, height: 844 }); await capture('03-alimtalk-390');
    const before = process.argv.includes('--before');
    if (!before) {
      const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
      const assess = async name => {
        await page.evaluate(axeSource);
        const violations = await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['moderate', 'serious', 'critical'].includes(v.impact)).map(v => v.id));
        check(name + ': axe moderate or above = 0', violations.length === 0);
        check(name + ': no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      };
      // Reopened 2026-11-23: the separate 선택한 수신자 요약 group is gone; the always-visible
      // #recipient-summary line carries the count and statuses, and the picker row names the person.
      const summary = page.locator('#recipient-summary');
      phase = 'approved wording and selected identity';
      check('approved wording is read only', await page.locator('#campaign-body').getAttribute('readonly') !== null);
      check('approval binding keeps the selected body', await page.locator('#campaign-body').inputValue() === template.body);
      check('Alimtalk does not offer changes outside the approved wording', await page.getByRole('group', { name: '개인화 정보 넣기', exact: true }).count() === 0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await ensureListOpen();
      check('one-person summary counts the recipient and actual status, and the checked row names them', /선택 1명/.test(await summary.innerText()) && (await summary.innerText()).includes('확정 1명') && await selectedRows().filter({ hasText: ws.participants[0].name }).getByRole('checkbox').isChecked());
      await assess('approved wording desktop'); await capture('04-approved-wording-1280');
      phase = 'group selection and preservation';
      await messageStep(page, 1); await ensureListOpen(); await page.locator('#recipient-selected-only').uncheck(); await page.locator('#recipient-clear-all').click();
      await page.locator('#recipient-status-filter').selectOption('APPROVED');
      await page.locator('#recipient-group-filter').selectOption('파트너');
      check('group and status filters intersect to two approved partners', await page.getByRole('list', { name: '참가자 선택', exact: true }).locator('li').count() === 2);
      await page.getByRole('checkbox', { name: '표시 2명 모두 선택', exact: true }).check();
      await page.locator('#recipient-status-filter').selectOption('ALL');
      check('a broader filter does not automatically select a pending participant', await page.getByRole('list', { name: '참가자 선택', exact: true }).locator('input:checked').count() === 2 && await page.getByRole('list', { name: '참가자 선택', exact: true }).locator('li').count() === 3);
      await page.locator('#recipient-group-filter').selectOption('일반');
      check('legacy empty groups are discoverable under the general group', await page.getByRole('list', { name: '참가자 선택', exact: true }).locator('li').count() === 3);
      await page.locator('#recipient-group-filter').selectOption('스피커');
      await page.getByRole('checkbox', { name: '표시 1명 모두 선택', exact: true }).check();
      await page.locator('#recipient-selected-only').check();
      await page.locator('#recipient-search').fill('이 필터로 숨기면 안 됩니다');
      check('selected-only review shows all three across groups and filters', await page.getByRole('list', { name: '참가자 선택', exact: true }).locator('li').count() === 3);
      await capture('05-groups-1280');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 }); await assess('group picker ' + width); await capture('05-groups-' + width);
      }
      await messageStep(page, 2);
      check('composition summary describes the actual selected groups', /선택 3명/.test(await summary.innerText()) && (await summary.innerText()).includes('확정 3명') && await page.locator('#recipient-selected-only').isChecked() && /파트너/.test(await selectedRows().allInnerTexts().then(rows => rows.join(' '))) && /스피커/.test(await selectedRows().allInnerTexts().then(rows => rows.join(' '))));
      phase = 'automatic length and validation';
      await openMessagePanel(page, 'how'); await chooseRadio(page, 'campaign-channel', 'SMS');
      check('ordinary text remains editable', await page.locator('#campaign-body').getAttribute('readonly') === null);
      await page.locator('#campaign-body').fill('가'.repeat(45));
      check('90-byte Korean source has SMS feedback', /^45자.*지금은 단문 SMS/s.test(await page.locator('#campaign-body-length').innerText()));
      await page.locator('#campaign-body').fill('가'.repeat(46));
      check('92-byte Korean source has LMS feedback', /^46자.*지금은 장문 LMS/s.test(await page.locator('#campaign-body-length').innerText()));
      await page.locator('#campaign-body').fill('가'.repeat(1001));
      await page.locator('#campaign-submit').click();
      await page.locator('#campaign-body-error').waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'campaign-body');
      check('over-limit plain text is kept and focused before review', await page.locator('#campaign-body').inputValue() === '가'.repeat(1001) && await page.locator('#campaign-body').evaluate(element => element === document.activeElement));
      check('invalid content has sent no campaign command', commands.filter(row => ['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(row.command)).length === 0);
      await page.locator('#campaign-body').fill('그룹 대상 합성 안내입니다.');
      await page.setViewportSize({ width: 1280, height: 900 }); await capture('06-recipient-summary-1280');
      await page.setViewportSize({ width: 390, height: 844 }); await assess('composition 390'); await capture('06-recipient-summary-390');
      phase = 'explicit synthetic campaign';
      await messageStep(page, 3);
      await page.getByRole('checkbox', { name: /^모의 발송으로 기록/ }).check();
      await page.locator('#campaign-submit').click();
      const confirmSimulation = page.getByRole('group', { name: '실행 확인', exact: true }).getByRole('button', { name: '모의 발송 기록', exact: true });
      await confirmSimulation.waitFor();
      const changed = ws.participants[0];
      await call('group.assign', { ids: [changed.id], group: '스피커' });
      await call('participant.status', { ids: [changed.id], status: 'PENDING' });
      await call('participant.update', { id: changed.id, phone: '01090001234' });
      const beforeConflict = (await read()).messages.length;
      const [rejected] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/commands')),
        confirmSimulation.click(),
      ]);
      check('a stale review is rejected before creating a campaign', rejected.status() === 409 && (await rejected.json()).field === 'expectedRecipientVersions' && (await read()).messages.length === beforeConflict);
      const reloadRecipients = page.getByRole('button', { name: '최신 수신자 불러오기', exact: true });
      await reloadRecipients.waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'recipient-review-refresh');
      check('a required recipient review opens the 받는 사람 panel by itself', await page.locator('#campaign-recipients').isVisible());
      check('recipient conflict returns to the recipients zone and preserves the message', await page.locator('#campaign-title').inputValue() === '합성 업무 안내' && await page.locator('#campaign-body').inputValue() === '그룹 대상 합성 안내입니다.');
      // Reopened 2026-11-23: one-screen checklist. Zones no longer gate each other, so the same
      // guarantee is: 발송 검토 on the stale list shows the review-required warning, opens no
      // confirmation and issues no command.
      const staleCommands = commands.length;
      await page.locator('#campaign-submit').click();
      await page.locator('#campaign-recipients-error').waitFor();
      check('review cannot continue from the stale list', await page.getByRole('group', { name: '실행 확인', exact: true }).count() === 0 && commands.length === staleCommands && await page.getByRole('button', { name: '최신 수신자 불러오기', exact: true }).isEnabled());
      await capture('07-recipient-conflict-390'); await assess('recipient conflict 390');
      const reviewBootstrap = `**/api/events/${f.eventId}/bootstrap?messageRecipientReview=1`;
      await page.route(reviewBootstrap, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
      await reloadRecipients.press('Enter');
      await page.getByText(/최신 수신자를 불러오지 못했습니다/).waitFor();
      const failedRefreshCommands = commands.length;
      await page.locator('#campaign-submit').click();
      check('a failed refresh keeps the draft and the review lock', await reloadRecipients.isEnabled() && await page.getByRole('group', { name: '실행 확인', exact: true }).count() === 0 && commands.length === failedRefreshCommands && await page.locator('#campaign-body').inputValue() === '그룹 대상 합성 안내입니다.');
      await reloadRecipients.click();
      await page.getByText(/최신 수신자를 불러왔습니다/).waitFor();
      await ensureListOpen();
      const changedRow = page.getByRole('list', { name: '참가자 선택', exact: true }).locator('li').filter({ hasText: changed.name });
      check('the refreshed selected row shows the changed group, contact and approval state', /스피커.*1234.*승인 대기/.test(await changedRow.innerText()) && await changedRow.getByRole('checkbox').isChecked());
      await messageStep(page, 2);
      await messageStep(page, 3);
      await page.locator('#campaign-submit').click();
      await confirmSimulation.click();
      await page.locator('#message-compose-open').waitFor();
      const created = commands.filter(row => ['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(row.command));
      const accepted = created.at(-1);
      check('only the newly confirmed synthetic command creates the grouped record', created.length === 2 && accepted.commandId !== created[0].commandId && accepted.payload.simulate === true);
      check('grouped payload contains exactly the selected eligible participants', JSON.stringify([...accepted.payload.ids].sort()) === JSON.stringify(ws.participants.slice(0, 3).map(person => person.id).sort()));
      check('ordinary grouped message is stored in the automatic text family', accepted.payload.channel === 'SMS');
      const saved = (await read()).messages.find(message => message.id === accepted.commandId);
      check('the stored grouped record keeps all three recipients', saved.status === 'SIMULATED' && saved.recipientIds.length === 3);
      phase = 'legacy MMS without its photo';
      await page.locator(`[id="campaign-${legacyId}"]`).getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
      const reload = page.getByRole('button', { name: '불러오기', exact: true }); if (await reload.count()) await reload.click();
      await page.locator('#campaign-body').waitFor({ state: 'visible' });
      await openMessagePanel(page, 'how');
      check('legacy MMS without a stored photo becomes ordinary text', await page.locator('#campaign-channel input[value="SMS"]').isChecked() && (await page.locator('aside[aria-labelledby="message-preview-heading"]').textContent()).includes('SMS/LMS · 내용에 따라 자동'));
      check('missing legacy photo is explained without discarding the message', await page.getByText(/기존 사진이 없어 일반 문자로 불러왔습니다/).isVisible() && await page.locator('#campaign-body').inputValue() === '예전 사진 안내 문구입니다.');
      check('instant reload omits irrelevant reservation and zero-exclusion wording', !/예약 시각|제외 0명/.test(await page.locator('#campaign-reload-summary').innerText()));
      check('loading legacy content never sends another message', commands.filter(row => ['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(row.command)).length === 2);
      await assess('legacy text recovery 390'); await capture('07-legacy-mms-390');
      phase = 'stale approved-template binding in a new history tab';
      const older = (await call('message.create', { title: '합성 이전 알림톡', ids: [ws.participants[0].id], body: template.body, channel: 'ALIMTALK', templateId: template.id, simulate: true })).message;
      const latestBody = '{{이름}}님, {{행사명}} 변경된 승인 안내입니다.';
      await call('template.save', { ...template, expectedVersion: template.version, body: latestBody });
      const latest = await read(); latest.messages.find(message => message.id === older.id).status = 'FAILED';
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(latest)]);
      const previousPage = page;
      page = await context.newPage(); observePage(page);
      await page.goto(base, { waitUntil: 'networkidle' }); await previousPage.close();
      await page.locator(`[id="campaign-${older.id}"]`).getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
      await page.locator('#campaign-body').waitFor({ state: 'visible' });
      check('historical Alimtalk keeps its old body without claiming a current approval', await page.locator('#campaign-body').inputValue() === template.body && await page.locator('#campaign-template').inputValue() === '');
      check('historical approval mismatch requests reselection', await page.getByText(/승인된 알림톡 템플릿을 다시 선택하세요/).isVisible());
      const unboundCommands = commands.length;
      await page.locator('#campaign-submit').click();
      await page.locator('#campaign-template-error').waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'campaign-template');
      check('unbound history cannot advance to send review', await page.getByRole('group', { name: '실행 확인', exact: true }).count() === 0 && commands.length === unboundCommands);
      await (await openTemplatePicker(page)).selectOption(template.id);
      await page.getByRole('button', { name: '템플릿 적용', exact: true }).click();
      check('explicit template replacement uses the current saved approved wording', await page.locator('#campaign-body').inputValue() === latestBody && await page.locator('#campaign-body').getAttribute('readonly') !== null);
      check('reselecting current wording clears the resolved historical approval warning', await page.locator('#campaign-reload-summary').count() === 0);
      await capture('08-stale-template-reselected-1280'); await assess('reselected Alimtalk desktop');
      phase = 'server rejects known invalid content before a record exists';
      const beforeCount = (await read()).messages.length;
      for (const [body, channel, templateId, status, field] of [
        ['다른 알림톡 문구', 'ALIMTALK', template.id, 409, 'templateId'],
        ['가'.repeat(1001), 'SMS', undefined, 400, 'body'],
      ]) {
        const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command: 'message.create', payload: { title: '합성 사전 검토', ids: [ws.participants[0].id], body, channel, templateId, simulate: true } } });
        check(`server blocks invalid ${channel} content`, response.status === status && response.json.field === field);
      }
      check('rejected content creates no campaign', (await read()).messages.length === beforeCount);
      phase = 'Alimtalk fallback is disclosed before real delivery';
      await messageStep(page, 3);
      await page.getByRole('checkbox', { name: /^모의 발송으로 기록/ }).uncheck();
      const beforeReview = commands.length;
      await page.locator('#campaign-submit').click();
      const confirmation = page.getByRole('group', { name: '실행 확인', exact: true });
      check('real Alimtalk review discloses the existing text fallback and its cost', /문자\(SMS\/LMS\)로 대체 발송.*대체 문자 요금/.test(await confirmation.innerText()));
      check('opening delivery review never issues a command', commands.length === beforeReview);
      await confirmation.getByRole('button', { name: '취소', exact: true }).click();
      await page.getByRole('checkbox', { name: /^모의 발송으로 기록/ }).check();
      await page.locator('#campaign-submit').click();
      check('synthetic review does not claim fallback delivery or charges', !/대체 발송|대체 문자 요금/.test(await confirmation.innerText()));
      await confirmation.getByRole('button', { name: '취소', exact: true }).click();
      phase = 'archive keeps an existing draft inspectable without write controls';
      await page.getByRole('button', { name: '발송 기록 보기', exact: true }).click();
      await f.harness.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}',to_jsonb($1::text)) WHERE id=$2", ['ARCHIVED', f.eventId]);
      await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
      const viewDraft = page.getByRole('button', { name: '작성 내용 보기', exact: true });
      await viewDraft.waitFor();
      check('retained draft has an explicit read action after archive', await viewDraft.isEnabled());
      const beforeArchiveViews = commands.length;
      await viewDraft.click(); await page.getByRole('heading', { name: '작성 내용 확인', exact: true }).waitFor();
      check('archiving preserves the current approved body and disables editing', await page.locator('#campaign-body').inputValue() === latestBody && await page.locator('#campaign-body').isDisabled());
      // Reopened 2026-11-24 (시안 A): a locked composer opens the 받는 사람 panel and its selected-only
      // list by itself (the pills are disabled with the rest of the form), so no navigation is needed.
      await page.locator('#campaign-recipients').waitFor({ state: 'visible' });
      check('read-only recipient review remains reachable and shows the selected person', await page.locator('#recipient-selected-only').isChecked() && await page.getByRole('list', { name: '참가자 선택', exact: true }).locator('li').count() === 1);
      check('read-only review cannot change recipients', await page.locator('#recipient-status-filter').isDisabled());
      await messageStep(page, 3);
      check('read-only send review can be inspected but never submitted', await page.locator('#campaign-submit').isVisible() && await page.locator('#campaign-submit').isDisabled());
      await messageStep(page, 2);
      await capture('09-archived-draft-1280'); await assess('archived draft desktop');
      await page.setViewportSize({ width: 390, height: 844 }); await capture('09-archived-draft-390'); await assess('archived draft 390');
      check('viewing a retained archived draft issues no command', commands.length === beforeArchiveViews);
      phase = 'a fresh archived page exposes history and read-only template content';
      const draftPage = page;
      page = await context.newPage(); observePage(page); await page.goto(base, { waitUntil: 'networkidle' }); await draftPage.close();
      check('a fresh archived page disables new composition', await page.locator('#message-compose-open').isDisabled());
      await selectTask(page, '템플릿 관리');
      const archivedTemplate = page.locator(`[data-template-id="${template.id}"]`);
      check('archived templates cannot be applied or changed', await archivedTemplate.getByRole('button', { name: '사용', exact: true }).isDisabled() && await archivedTemplate.getByRole('button', { name: '보관', exact: true }).isDisabled());
      await archivedTemplate.getByRole('button', { name: '내용 보기', exact: true }).click();
      check('read-only template content is still inspectable', await page.locator('#template-body').inputValue() === latestBody && await page.locator('#template-body').isDisabled() && await page.getByRole('button', { name: '템플릿 저장', exact: true }).isDisabled());
      await capture('10-archived-template-1280'); await assess('archived template desktop');
      await page.setViewportSize({ width: 390, height: 844 }); await capture('10-archived-template-390'); await assess('archived template 390');
      check('all archived read-only actions issue no command or new record', commands.length === beforeArchiveViews && (await read()).messages.length === beforeCount);
      check('all browser campaign requests were synthetic', commands.filter(row => ['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(row.command)).every(row => row.payload.simulate === true));
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ before, build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), checks, errors, synthetic: true, browserCampaignRequests: commands.filter(row => ['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(row.command)).length }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ before, checks: checks.length, output: out }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    console.error('PHASE', phase); throw error;
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
