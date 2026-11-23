'use strict';

// Cross-screen operator outcomes on an owned Next/API/random PostgreSQL schema.
// FAILED is a synthetic history state (no provider is called); all subsequent
// display/assignment/message writes use real product commands and are re-read.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { messageStep, openMessageMore } = require('./ui-journey-helpers.cjs');
const before = process.argv.includes('--before');
const out = (process.env.CAPTURE_DIR || '').trim()
  || path.join(defaultCaptureDir(`task-flow-${runStamp()}`), before ? 'before' : 'after');
prepareCaptureDir(out);

async function main() {
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  const results = [];
  const renderChecks = [];
  const errors = [];
  const boot = async () => (await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: f.manager.cookie })).json.state;
  const run = async (command, payload) => {
    const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r));
    return r.json;
  };
  try {
    browser = await launchBrowser();
    await run('event.features', { features: ['screen', 'stamp', 'venue', 'reward', 'draw'] });
    const desk = (await run('desk.save', { name: '동문 입장 데스크', action: 'IN', mode: 'desk', open: true })).desk;
    const booth = (await run('booth.save', { name: '체험 부스', zone: '동문', status: 'OPEN', capacity: 100, limit: 1 })).booth;
    const notice = (await run('notice.save', { title: '동문 입장 안내', body: '참가자는 동문에서 티켓을 보여 주세요.', published: true })).notice;
    const staffId = `flow-staff-${f.suffix}`;
    await f.helpers.insertAccount(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id: staffId, role: 'STAFF', name: '동문 담당 김', email: `${staffId}@example.test` });
    const people = (await boot()).workspaces[f.eventId].participants.slice(0, 3);
    const old = (await run('message.create', { ids: people.map(p => p.id), title: '입장 안내 재작성', body: '{{이름}}님 동문으로 입장해 주세요.', channel: 'SMS', simulate: true })).message;
    // Provider failure is a fixture, not an asserted delivery result.
    await f.harness.database.query(`UPDATE event_workspaces SET payload = jsonb_set(payload, '{messages}',
      (SELECT jsonb_agg(CASE WHEN item->>'id'=$2 THEN jsonb_set(item,'{status}','"FAILED"') ELSE item END)
       FROM jsonb_array_elements(payload->'messages') item)) WHERE event_id=$1`, [f.eventId, old.id]);
    await run('participant.status', { id: people[2].id, status: 'CANCELLED' });
    const context = await browser.newContext();
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(f.manager.cookie.slice('etko_session='.length)), url: f.baseUrl }]);
    const page = await context.newPage();
    let activeTask = null;
    let lastScrollAt = 0;
    await page.exposeFunction('__flowScrollTick', () => {
      const now = Date.now();
      if (activeTask && now - lastScrollAt > 400) { activeTask.scrolls++; lastScrollAt = now; }
    });
    await page.addInitScript(() => window.addEventListener('scroll', () => window.__flowScrollTick(), { passive: true }));
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(f.baseUrl) && r.url().includes('/api/')) errors.push(`${r.status()} ${r.url()}`); });
    const base = `/console/events/${f.eventId}`;
    // Reopened 2026-11-20: 공지·안내는 탭 화면이라 구역 id #content-notices 대신 탭 패널 #content-panel을 기다린다. 공지 행은 눌러서 여는
    // 한 줄(LedgerRow)이고 전광판 출력·게시 내리기·게시 검토는 열린 편집기(#content-panel form) 안에 있다.
    const openNotice = title => page.locator('li').filter({ hasText: title }).first().getByRole('button').first().click();
    const noticeEditor = () => page.locator('#content-panel form');
    const go = async (suffix, marker) => { await page.goto(f.baseUrl + base + suffix); await page.locator(marker).waitFor(); };
    const shot = async (name, fullPage = false) => { await page.screenshot({ path: path.join(out, `${name}.png`), fullPage }); };
    const rowFor = title => page.locator('li').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
    const failedRowAction = async id => {
      const back = page.getByRole('button', { name: '발송 기록 보기', exact: true });
      if (await back.isVisible()) await back.click();
      const expand = page.locator('summary').filter({ hasText: /^기록 목록 펼치기/ });
      if (await expand.isVisible()) await expand.click();
      await page.locator(`#campaign-${id}`).getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
    };

    const measure = async (key, fn) => {
      const task = { key, steps: 0, scrolls: 0, writes: 0 };
      activeTask = task;
      lastScrollAt = 0;
      const listener = req => { if (req.method() === 'POST' && req.url().includes('/commands')) task.writes++; };
      page.on('request', listener);
      const act = async fn => { task.steps++; await fn(); };
      await fn(act, task);
      activeTask = null;
      page.off('request', listener);
      assert.ok(task.steps <= 12, `${key}: operation cap 12 exceeded`);
      assert.ok(task.scrolls <= 6, `${key}: scroll cap 6 exceeded`);
      results.push(task);
    };
    // Fresh before/after full renders at both required widths, before writes.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const [suffix, marker, name] of [['/content', '#content-panel', 'content'], ['/operations', '#ops-desks', 'operations'], ['/messages', '#history-heading', 'messages']]) {
        await go(suffix, marker);
        await shot(`${name}-${width}`, true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflow`);
        const targets = await page.getByRole('button', { name: /전광판 출력|에 스태프 배정|내용·대상 불러오기/ }).evaluateAll(elements => elements.map(el => {
          const r = el.getBoundingClientRect();
          return { name: el.getAttribute('aria-label') || el.textContent.trim(), width: r.width, height: r.height };
        }));
        for (const target of targets) assert.ok(target.width >= 44 && target.height >= 44, `${name}: target below 44px ${JSON.stringify(target)}`);
        renderChecks.push({ name, width, overflow: false, targets });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await go('/content', '#content-panel');
    await measure('notice-to-display', async act => {
      if (before) {
        await act(() => page.locator(`a[href="${base}/operations"]:visible`).first().click());
        await page.locator('#ops-display').waitFor();
        await act(() => page.getByRole('link', { name: '전광판 출력', exact: true }).click());
        await act(() => page.locator('#ops-display-pick').selectOption(`notice|${notice.id}`));
        await act(() => page.getByRole('button', { name: '출력 적용', exact: true }).click());
      } else {
        await act(() => openNotice('동문 입장 안내'));
        await act(() => noticeEditor().getByRole('button', { name: '전광판 출력', exact: true }).click());
        await shot('notice-output-confirm-390');
        await act(() => noticeEditor().getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '전광판 출력', exact: true }).click());
        await shot('notice-output-result-390');
      }
      await page.getByText('전광판 출력을 바꿨습니다.', { exact: true }).waitFor();
      assert.equal((await boot()).workspaces[f.eventId].display.noticeId, notice.id);
    });
    for (const [kind, target, title] of [['DESK', desk, '동문 입장 데스크'], ['BOOTH', booth, '체험 부스']]) {
      await go('/operations', '#ops-desks');
      await measure(`${kind.toLowerCase()}-assign`, async act => {
        if (before) {
          await act(() => page.getByRole('link', { name: '스태프 배정', exact: true }).click());
          await act(() => page.getByRole('button', { name: '스태프 배정', exact: true }).click());
        } else {
          // Reopened 2026-11-20: 부스는 탭이 아니라 같은 화면의 구역이라 '부스' 탭 누르기가 필요 없다(담당이 없는 곳의 '배정' 버튼이 바로 보인다).
          await act(() => page.getByRole('button', { name: `${title}에 스태프 배정`, exact: true }).click());
          assert.equal(await page.locator('#assign-type').inputValue(), kind);
          assert.equal(await page.locator('#assign-target').inputValue(), target.id);
          await shot(`${kind.toLowerCase()}-prefill-390`);
        }
        await act(() => page.locator('#assign-account').selectOption(staffId));
        if (before) {
          if (kind === 'BOOTH') await act(() => page.locator('#assign-type').selectOption(kind));
          await act(() => page.locator('#assign-target').selectOption(target.id));
        }
        await act(() => page.getByRole('button', { name: '배정 저장', exact: true }).click());
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.ok((await boot()).workspaces[f.eventId].assignments.some(a => a.accountId === staffId && a.targetId === target.id && a.type === kind));
        await shot(`${kind.toLowerCase()}-assigned-390`);
      });
    }
    await go('/messages', '#history-heading');
    await measure('failed-message-recompose', async (act, task) => {
      if (before) {
        if (await page.locator('#message-compose-open').isVisible()) await act(() => page.locator('#message-compose-open').click());
        // Original content is not displayed in history: reconstruction requires
        // an external original. Count actual manual work with that original.
        task.limitation = '본문은 기존 이력에서 볼 수 없어 외부 원문을 알고 있다는 조건의 수동 재작성';
        await act(() => page.locator('#campaign-title').fill(old.title));
        await act(() => page.locator('#campaign-body').fill(old.body));
        await act(() => page.locator('#campaign-recipients summary').click());
        for (const p of people.slice(0, 2)) await act(() => page.getByRole('checkbox', { name: new RegExp(p.name) }).check());
        await act(() => page.getByRole('checkbox', { name: /모의 발송으로 기록/ }).check());
      } else {
        await act(() => failedRowAction(old.id));
        assert.equal(await page.locator('#campaign-title').inputValue(), old.title);
        assert.equal(await page.locator('#campaign-body').inputValue(), old.body);
        // Reopened 2026-11-23: no reservation carried over means 지금 is chosen and no datetime field exists.
        assert.equal(await page.locator('#campaign-scheduled').count(), 0);
        assert.equal(await page.locator('#campaign-schedule-choice input[value="NOW"]').isChecked(), true);
        // A cancelled historical recipient sends the operator through the recipient review first:
        // Reopened 2026-11-24 (시안 A) the reload opens the 받는 사람 panel and focuses its search.
        assert.equal(await page.locator('#campaign-recipients').isVisible(), true);
        await page.waitForFunction(() => document.activeElement?.id === 'recipient-search');
        // The skip link then moves straight to the message body (the record title is optional, under 더 보기).
        await act(async () => { await page.locator('a[data-skip-to="campaign-body"]').focus(); await page.keyboard.press('Enter'); });
        await page.waitForFunction(() => document.activeElement?.id === 'campaign-body');
        assert.equal(await page.locator('#campaign-body').evaluate(el => el === document.activeElement), true);
        await shot('message-recomposed-390');
        await act(() => messageStep(page, 3));
        assert.equal(await page.getByRole('checkbox', { name: /모의 발송으로 기록/ }).isChecked(), true);
      }
      assert.equal(task.writes, 0, 'draft preparation never sends automatically');
      await act(() => page.locator('#campaign-submit').click());
      await act(() => page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: /모의 발송|발송 요청|요청한다|발송한다/ }).click());
      await page.getByText(/모의 발송을 기록했습니다|발송 요청을 기록했습니다/).first().waitFor();
      const campaigns = (await boot()).workspaces[f.eventId].messages;
      const created = campaigns.find(c => c.id !== old.id && c.title === old.title);
      assert.ok(created);
      assert.equal(created.body, old.body);
      assert.deepEqual([...created.recipientIds].sort(), people.slice(0, 2).map(p => p.id).sort());
      assert.equal(created.status, 'SIMULATED');
    });
    if (!before) {
      // Recovering one failed history item must not silently discard another
      // pending draft. Cancel and keyboard-confirm the existing grammar.
      const oldRow = page.locator(`#campaign-${old.id}`);
      await failedRowAction(old.id);
      await messageStep(page, 2);
      await openMessageMore(page);
      await page.locator('#campaign-title').fill('덮어쓰지 말아야 할 초안');
      const writes = f.gateway.commands.length;
      await failedRowAction(old.id);
      const confirm = page.locator(`#campaign-detail-${old.id}`).getByRole('group', { name: '실행 확인' });
      await confirm.getByRole('button', { name: '취소', exact: true }).click();
      assert.equal(await page.locator('#campaign-title').inputValue(), '덮어쓰지 말아야 할 초안');
      await failedRowAction(old.id);
      await confirm.getByRole('button', { name: '불러온다', exact: true }).waitFor();
      assert.equal(await confirm.getByRole('button', { name: '불러온다', exact: true }).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await messageStep(page, 2);
      await page.locator('#campaign-body').waitFor();
      assert.equal(await page.locator('#campaign-title').inputValue(), old.title);
      assert.equal(f.gateway.commands.length, writes, 'loading a draft is not a write');
      await shot('message-overwrite-keyboard-result-390');
      // An unsent confirmation is not a missing server response. Opening a
      // replacement confirmation must work without sending or false alarms.
      await messageStep(page, 3);
      await page.locator('#campaign-submit').click();
      await failedRowAction(old.id);
      await confirm.getByRole('button', { name: '불러온다', exact: true }).waitFor();
      await confirm.getByRole('button', { name: '취소', exact: true }).click();
      assert.equal(f.gateway.commands.length, writes, 'staged send has not posted');
      await failedRowAction(old.id);
      await confirm.getByRole('button', { name: '불러온다', exact: true }).click();
      assert.equal(f.gateway.commands.length, writes);
      // Commit one real create, then lose only its transport response. Loading
      // another draft must now block; retry must use that very same receipt.
      let lostId = null;
      const attempts = [];
      await page.route('**/api/events/*/commands', async route => {
        const data = route.request().postDataJSON();
        // Reopened 2026-11-20: 문자 인코딩 검토를 거친 발송은 message.create-charset-reviewed 명령으로 나간다(다른 메시지 감사의 명령 목록과 같게).
        if (!['message.create', 'message.create-reviewed', 'message.create-charset-reviewed'].includes(data.command)) return route.continue();
        attempts.push(data.commandId);
        if (lostId) return route.continue();
        const response = await route.fetch();
        assert.ok(response.ok());
        lostId = (await response.json()).message.id;
        await route.abort('failed');
      });
      await messageStep(page, 3);
      await page.locator('#campaign-submit').click();
      await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
      const sendRecovery = page.getByRole('region', { name: '발송 요청 확인 필요', exact: true });
      await sendRecovery.getByRole('alert').filter({ hasText: '발송 요청 결과를 확인하지 못했습니다.' }).waitFor();
      await failedRowAction(old.id);
      await page.getByText('응답을 확인하지 못한 발송 요청이 있습니다. 결과를 먼저 확인한 뒤 내용을 불러오세요.', { exact: true }).first().waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'message-recovery-heading');
      const visibleRecoveryError = await sendRecovery.getByRole('alert').filter({ hasText: '응답을 확인하지 못한 발송 요청이 있습니다.' }).evaluate(el => {
        const rect = el.getBoundingClientRect();
        const header = document.querySelector('.console-sidebar')?.getBoundingClientRect().bottom || 0;
        return rect.top >= header && rect.bottom <= innerHeight;
      });
      assert.equal(visibleRecoveryError, true, 'recovery explanation stays with its action in the viewport');
      assert.equal(await page.locator('#campaign-title').inputValue(), old.title);
      assert.equal(attempts.length, 1);
      await shot('message-ambiguous-reload-blocked-390');
      await sendRecovery.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
      await page.getByText('모의 발송을 기록했습니다. 수신자에게 전달되지 않았습니다.', { exact: true }).first().waitFor();
      assert.deepEqual(attempts, [lostId, lostId]);
      assert.equal((await boot()).workspaces[f.eventId].messages.filter(item => item.id === lostId).length, 1);
      await page.unroute('**/api/events/*/commands');
      // A notice can keep an old display reference after unpublishing. It is
      // not evidence of output; stale/off status must be stated accurately.
      await go('/content', '#content-panel');
      await openNotice(notice.title);
      await noticeEditor().getByRole('button', { name: '전광판 출력', exact: true }).click();
      await noticeEditor().getByRole('button', { name: '게시 내리기', exact: true }).click();
      await page.getByRole('dialog', { name: '공지 게시 내리기', exact: true }).getByRole('button', { name: '게시 내리기', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByText('전광판 선택됨 · 비공개로 출력되지 않음', { exact: true }).waitFor();
      // 편집기가 열린 채이므로 같은 편집기(#content-panel form)에서 확인한다(행이 아니라 편집기가 버튼을 가짐).
      assert.equal(await noticeEditor().count(), 1, 'the notice editor stays open after unpublishing');
      assert.equal(await noticeEditor().getByRole('button', { name: '전광판 출력', exact: true }).count(), 0);
      await shot('notice-unpublished-status-390');
      await noticeEditor().getByRole('button', { name: '게시 검토', exact: true }).click();
      await page.getByRole('dialog', { name: '공지 게시 검토', exact: true }).getByRole('button', { name: '게시하기', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.locator('#content-panel').getByText('게시 중', { exact: true }).first().waitFor();
      assert.equal(await noticeEditor().getByRole('group', { name: '실행 확인' }).count(), 0, 'refresh invalidates an old output intention');
      results.push({ key: 'recovery-safety', overwriteCancelPreserved: true, keyboardEnterConfirmed: true, noAutoWrite: true, unsentConfirmationReplaceable: true, attemptedResponseLossBlocked: true, receiptReused: true, unpublishedStatusAccurate: true });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'task-results.json'), JSON.stringify({ before, build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), fixture: 'isolated random schema; FAILED historical state synthetic, commands real; no delivery', renderChecks, results, errors }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(results, null, 2));
    await context.close();
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
