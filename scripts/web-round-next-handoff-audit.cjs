'use strict';

for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';

// Real client handoffs against the owned Next/API/random PostgreSQL fixture.
// No provider call is made. The message composer is inspected, never sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const root = process.env.CAPTURE_DIR || '/tmp/opencode/eventouch-captures/round-next/after';
const baseline = process.env.ROUND_NEXT_BASELINE === '1';
fs.mkdirSync(root, { recursive: true });

async function resetFocus(page) {
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.body.tabIndex = -1;
    document.body.focus();
  });
}

// Counts real Tab stops plus the same one activation cost used by the
// usability audit's jump-hook metric. Both variants use this exact method.
async function sectionKeyboardPath(page) {
  await resetFocus(page);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.skip-link').first().evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main-content');
  let tabs = 1;
  for (let n = 0; n < 40; n++) {
    await page.keyboard.press('Tab'); tabs++;
    if (await page.evaluate(() => document.activeElement?.getAttribute('href') === '#ops-display')) break;
    assert.ok(n < 39, 'display section link reachable within unchanged 40 cap');
  }
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ops-display');
  let continuation = 0;
  for (; continuation < 40; continuation++) {
    await page.keyboard.press('Tab');
    if (await page.getByRole('button', { name: '출력 적용', exact: true }).evaluate(e => e === document.activeElement)) break;
  }
  assert.ok(continuation < 40);
  return { tabs: tabs + continuation + 1, activations: 2, stopsWithSectionActivation: tabs + continuation + 2 };
}

async function main() {
  const fixture = await startAuditFixture({ loseFirstResponseFor: baseline ? null : 'participant.status' });
  let browser;
  const results = [], errors = [];
  const pass = (name, detail) => results.push({ name, passed: true, detail });
  const { helpers, harness, eventId, baseUrl, suffix } = fixture;
  const ownerCookie = await helpers.sessionCookie(harness, `audit-owner-${suffix}`);
  const cmd = async (command, payload) => {
    const response = await helpers.requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie: ownerCookie, body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.json));
    return response.json;
  };
  const read = async () => (await helpers.requestJson(harness.baseUrl, '/api/bootstrap', { cookie: ownerCookie })).json.state;
  try {
    const otherStaff = `round-staff-${suffix}`;
    const inactiveStaff = `round-inactive-${suffix}`;
    await helpers.insertAccount(harness.database, { id: otherStaff, role: 'STAFF', name: '배정 인계 대상', email: `${otherStaff}@example.test` });
    await helpers.insertAccount(harness.database, { id: inactiveStaff, role: 'STAFF', name: '중지된 대상', email: `${inactiveStaff}@example.test` });
    await harness.database.query('UPDATE accounts SET active=false WHERE id=$1', [inactiveStaff]);
    await cmd('event.features', { features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp'] });
    await cmd('booth.save', { name: '인계 부스', zone: '가구역', status: 'OPEN', capacity: 0, limit: 1 });
    const notice = await cmd('notice.save', { title: '키보드 출력 안내', body: '출력 확인', published: true });
    const boot = await read();
    const noticeId = notice.notice?.id || boot.workspaces[eventId].notices.find(n => n.title === '키보드 출력 안내').id;
    const stages = ['ENDED', 'ARCHIVED', 'DRAFT'];
    for (const stage of stages) {
      const id = `round-${stage.toLowerCase()}-${suffix}`;
      await helpers.insertEvent(harness.database, { id, slug: id, payload: { id, slug: id, name: `${stage} 단계 행사`, stage, date: '2027-02-01', features: [] }, workspace: helpers.emptyWorkspace() });
    }
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(ownerCookie.slice('etko_session='.length)), url: baseUrl }]);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const shot = async (name, fullPage = true) => {
      if (fullPage) await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: path.join(root, name), fullPage });
    };
    const goto = async route => { await page.goto(baseUrl + route, { waitUntil: 'networkidle' }); };
    const eventRoute = `/console/events/${eventId}`;
    await goto(`${eventRoute}/operations`);
    await page.locator('#ops-display-pick').selectOption(`notice|${noticeId}`);
    const keyboard = await sectionKeyboardPath(page);
    pass('display-section-keyboard', keyboard);
    await shot('display-keyboard-1280.png');
    await page.keyboard.press('Enter');
    await page.getByText('전광판 출력을 바꿨습니다。'.replace('。', '.')).waitFor();
    assert.equal((await read()).workspaces[eventId].display.noticeId, noticeId);
    pass('display-keyboard-command-persisted', { noticeId });

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await goto('/console/team');
      const row = page.locator('li').filter({ has: page.getByText('배정 인계 대상', { exact: true }) }).first();
      await row.getByRole('button', { name: '행사 배정', exact: true }).click();
      const select = page.getByRole('combobox', { name: '배정 인계 대상 배정 행사 선택' });
      const options = await select.locator('option').evaluateAll(es => es.filter(e => e.value).map(e => ({ value: e.value, label: e.textContent })));
      await select.selectOption(eventId);
      await shot(`team-picker-${width}.png`);
      if (!baseline) {
        assert.match(options.find(o => o.value === eventId).label, /진행 중/);
        assert.match(options.find(o => o.value.includes('round-ended')).label, /종료/);
        assert.match(options.find(o => o.value.includes('round-archived')).label, /보관/);
        assert.ok(options.findIndex(o => o.value.includes('round-draft')) < options.findIndex(o => o.value.includes('round-ended')));
        await select.selectOption(`round-archived-${suffix}`);
        await shot(`team-picker-archived-${width}.png`);
        await select.selectOption(eventId);
        pass(`lifecycle-options-${width}`, options);
      }
      const commandsBefore = fixture.gateway.commands.length;
      await row.getByRole('link', { name: /현장 운영 · 스태프 배정으로 이동/ }).click();
      if (baseline) {
        assert.equal(await page.getByRole('dialog').count(), 0);
        pass(`baseline-account-handoff-missing-${width}`, { commands: fixture.gateway.commands.length - commandsBefore });
        continue;
      }
      await page.getByRole('dialog', { name: '스태프 배정', exact: true }).waitFor();
      assert.equal(await page.locator('#assign-account').inputValue(), otherStaff);
      assert.equal(fixture.gateway.commands.length, commandsBefore, 'navigation does not write');
      assert.equal(new URL(page.url()).searchParams.has('assignAccount'), false, 'consumed once');
      await shot(`assignment-prefilled-${width}.png`, false);
      await page.getByRole('button', { name: '취소', exact: true }).click();
      const focusAfterCancel = await page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, text: document.activeElement?.textContent?.trim().slice(0, 60) }));
      assert.equal(focusAfterCancel.id, 'ops-staff-assign', 'auto-opened dialog returns focus to a local assignment entry');
      await page.getByRole('button', { name: '스태프 배정', exact: true }).click();
      assert.equal(await page.locator('#assign-account').inputValue(), '', 'generic reopen has no stale person');
      await page.getByRole('button', { name: '취소', exact: true }).click();
      pass(`account-preset-pristine-reopen-${width}`, { automaticWrites: 0, focusAfterCancel });
    }

    if (!baseline) {
      await page.setViewportSize({ width: 1280, height: 900 });
      for (const bad of ['missing', inactiveStaff, fixture.manager.id]) {
        const before = fixture.gateway.commands.length;
        await goto(`${eventRoute}/operations?keep=1&assignAccount=${bad}#ops-staff`);
        await page.locator('#ops-staff').waitFor();
        await page.getByText('요청한 스태프를 찾을 수 없습니다.', { exact: false }).waitFor();
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(new URL(page.url()).searchParams.get('keep'), '1');
        assert.equal(new URL(page.url()).searchParams.has('assignAccount'), false);
        assert.equal(fixture.gateway.commands.length, before);
        pass(`invalid-account-${bad === inactiveStaff ? 'inactive' : bad === fixture.manager.id ? 'role' : 'missing'}`, { automaticWrites: 0 });
      }
      for (const [stage, reason] of [['ARCHIVED', '보관된 행사는 읽기 전용이라 배정을 열 수 없습니다.'], ['DRAFT', '배정할 데스크나 부스가 없어']]) {
        const before = fixture.gateway.commands.length;
        await goto(`/console/events/round-${stage.toLowerCase()}-${suffix}/operations?assignAccount=${otherStaff}#ops-staff`);
        await page.getByText(reason, { exact: false }).waitFor();
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(fixture.gateway.commands.length, before);
        pass(`handoff-${stage.toLowerCase()}-blocked`, { automaticWrites: 0 });
      }
      await goto(`${eventRoute}/operations?assignAccount=${otherStaff}`);
      await page.getByRole('dialog', { name: '스태프 배정', exact: true }).waitFor();
      await page.locator('#assign-target').selectOption(fixture.deskId);
      await page.getByRole('button', { name: '배정 저장', exact: true }).click();
      await page.getByText('스태프를 배정했습니다.', { exact: true }).waitFor();
      assert.ok((await read()).workspaces[eventId].assignments.some(a => a.accountId === otherStaff && a.targetId === fixture.deskId));
      pass('prefilled-assignment-explicit-save', { automaticWrites: 0, explicitWrites: 1 });

      const imported = await cmd('participant.import', { rows: [{ name: '승인 인계 가', phone: '01077770001' }, { name: '승인 인계 나', phone: '01077770002' }] });
      const ids = imported.participants.map(p => p.id);
      await cmd('participant.status', { ids, status: 'PENDING' });
      await goto(`${eventRoute}/participants?status=PENDING`);
      await page.getByRole('checkbox', { name: /승인 인계 가/ }).check();
      await page.getByRole('checkbox', { name: /승인 인계 나/ }).check();
      await page.getByRole('button', { name: '선택 승인', exact: true }).click();
      const handoff = page.getByRole('link', { name: '승인자에게 안내 보내기', exact: true });
      await fixture.gateway.waitForResponseLoss('participant.status');
      await page.getByRole('alert').filter({ hasText: /연결하지 못했습니다/ }).waitFor();
      assert.equal(await handoff.count(), 0, 'lost response must not offer success follow-up');
      assert.ok((await read()).workspaces[eventId].participants.filter(p => ids.includes(p.id)).every(p => p.status === 'APPROVED'), 'server committed before response loss');
      await page.getByRole('button', { name: '선택 승인', exact: true }).click();
      await handoff.waitFor();
      const approvals = fixture.gateway.commands.filter(c => c.command === 'participant.status');
      assert.equal(approvals.length, 2);
      assert.equal(approvals[0].commandId, approvals[1].commandId, 'retry uses the original receipt');
      pass('approval-response-loss-no-premature-link-and-same-receipt', { attempts: approvals.length, duplicateCommandIds: 1 });
      assert.ok((await read()).workspaces[eventId].participants.filter(p => ids.includes(p.id)).every(p => p.status === 'APPROVED'));
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const bounds = await handoff.boundingBox();
        await shot(`approval-handoff-${width}.png`, false);
        assert.ok(bounds?.width >= 44 && bounds?.height >= 44, `approval handoff touch target ${JSON.stringify(bounds)}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(overflow <= 1);
        pass(`approval-next-action-target-${width}`, { bounds, overflow });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      const before = fixture.gateway.commands.filter(c => c.command === 'message.create').length;
      await handoff.click();
      await page.locator('#recipient-status-filter').waitFor();
      await page.getByText('명단에서 2명을 인계받았습니다', { exact: false }).waitFor();
      assert.equal(await page.locator('#recipient-status-filter').inputValue(), 'APPROVED');
      await page.getByText('수신자 목록 열기·닫기', { exact: false }).first().click();
      const selected = await page.getByRole('list', { name: '참가자 선택', exact: true }).locator('input[type="checkbox"]:checked').count();
      assert.equal(selected, 2);
      assert.equal(fixture.gateway.commands.filter(c => c.command === 'message.create').length, before);
      await shot('message-approved-recipients-1280.png');
      pass('approve-to-composer-filter-and-exact-recipients', { approved: ids.length, selected, automaticMessageWrites: 0 });
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    pass('page-errors', { count: errors.length });
    fs.writeFileSync(path.join(root, 'handoff-verification.json'), JSON.stringify({ build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), baseline, results, errors }, null, 2));
    console.log(JSON.stringify({ passed: results.length, errors: errors.length, keyboard }, null, 2));
    await context.close();
  } catch (error) {
    fs.writeFileSync(path.join(root, 'handoff-failure.json'), JSON.stringify({ build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), baseline, results, errors, failure: error.stack || String(error) }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
