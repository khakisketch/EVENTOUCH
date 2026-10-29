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
    const go = async (suffix, marker) => { await page.goto(f.baseUrl + base + suffix); await page.locator(marker).waitFor(); };
    const shot = async (name, fullPage = false) => { await page.screenshot({ path: path.join(out, `${name}.png`), fullPage }); };
    const rowFor = title => page.locator('li').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
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
      for (const [suffix, marker, name] of [['/content', '#content-notices', 'content'], ['/operations', '#ops-desks', 'operations'], ['/messages', '#history-heading', 'messages']]) {
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
    await go('/content', '#content-notices');
    await measure('notice-to-display', async act => {
      if (before) {
        await act(() => page.locator(`a[href="${base}/operations"]:visible`).first().click());
        await page.locator('#ops-display').waitFor();
        await act(() => page.getByRole('link', { name: '전광판 출력', exact: true }).click());
        await act(() => page.locator('#ops-display-pick').selectOption(`notice|${notice.id}`));
        await act(() => page.getByRole('button', { name: '출력 적용', exact: true }).click());
      } else {
        const row = rowFor('동문 입장 안내');
        await act(() => row.getByRole('button', { name: '전광판 출력', exact: true }).click());
        await shot('notice-output-confirm-390');
        await act(() => row.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '전광판 출력', exact: true }).click());
        await row.getByText('전광판 출력으로 선택됨', { exact: true }).waitFor();
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
        await act(() => page.locator(`#campaign-${old.id}`).getByRole('button', { name: '내용·대상 불러오기', exact: true }).click());
        assert.equal(await page.locator('#campaign-title').inputValue(), old.title);
        assert.equal(await page.locator('#campaign-body').inputValue(), old.body);
        assert.equal(await page.locator('#campaign-scheduled').inputValue(), '');
        assert.equal(await page.getByRole('checkbox', { name: /모의 발송으로 기록/ }).isChecked(), true);
        assert.equal(await page.locator('#campaign-title').evaluate(el => el === document.activeElement), true);
        await shot('message-recomposed-390');
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
      await page.locator('#campaign-title').fill('덮어쓰지 말아야 할 초안');
      const writes = f.gateway.commands.length;
      await oldRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
      const confirm = page.locator(`#campaign-detail-${old.id}`).getByRole('group', { name: '실행 확인' });
      await confirm.getByRole('button', { name: '취소', exact: true }).click();
      assert.equal(await page.locator('#campaign-title').inputValue(), '덮어쓰지 말아야 할 초안');
      await oldRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
      await confirm.getByRole('button', { name: '불러온다', exact: true }).waitFor();
      assert.equal(await confirm.getByRole('button', { name: '불러온다', exact: true }).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await page.locator('#campaign-title').waitFor();
      assert.equal(await page.locator('#campaign-title').inputValue(), old.title);
      assert.equal(f.gateway.commands.length, writes, 'loading a draft is not a write');
      await shot('message-overwrite-keyboard-result-390');
      // An unsent confirmation is not a missing server response. Opening a
      // replacement confirmation must work without sending or false alarms.
      await page.locator('#campaign-submit').click();
      await oldRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
      await confirm.getByRole('button', { name: '불러온다', exact: true }).waitFor();
      await confirm.getByRole('button', { name: '취소', exact: true }).click();
      assert.equal(f.gateway.commands.length, writes, 'staged send has not posted');
      await oldRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
      await confirm.getByRole('button', { name: '불러온다', exact: true }).click();
      assert.equal(f.gateway.commands.length, writes);
      // Commit one real create, then lose only its transport response. Loading
      // another draft must now block; retry must use that very same receipt.
      let lostId = null;
      const attempts = [];
      await page.route('**/api/events/*/commands', async route => {
        const data = route.request().postDataJSON();
        if (data.command !== 'message.create') return route.continue();
        attempts.push(data.commandId);
        if (lostId) return route.continue();
        const response = await route.fetch();
        assert.ok(response.ok());
        lostId = (await response.json()).message.id;
        await route.abort('failed');
      });
      await page.locator('#campaign-submit').click();
      await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
      await page.getByText('응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.', { exact: true }).first().waitFor();
      await oldRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
      await page.getByText('응답을 확인하지 못한 발송 요청이 있습니다. 결과를 먼저 확인한 뒤 내용을 불러오세요.', { exact: true }).first().waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'campaign-submit');
      const visibleRecoveryError = await page.locator('form [role="alert"]').filter({ hasText: '응답을 확인하지 못한 발송 요청이 있습니다.' }).evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 108 && rect.bottom <= innerHeight;
      });
      assert.equal(visibleRecoveryError, true, 'recovery explanation stays with its action in the viewport');
      assert.equal(await page.locator('#campaign-title').inputValue(), old.title);
      assert.equal(attempts.length, 1);
      await shot('message-ambiguous-reload-blocked-390');
      await page.locator('#campaign-submit').click();
      await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
      await page.getByText('모의 발송을 기록했습니다. 수신자에게 전달되지 않았습니다.', { exact: true }).first().waitFor();
      assert.deepEqual(attempts, [lostId, lostId]);
      assert.equal((await boot()).workspaces[f.eventId].messages.filter(item => item.id === lostId).length, 1);
      await page.unroute('**/api/events/*/commands');
      // A notice can keep an old display reference after unpublishing. It is
      // not evidence of output; stale/off status must be stated accurately.
      await go('/content', '#content-notices');
      await rowFor(notice.title).getByRole('button', { name: '전광판 출력', exact: true }).click();
      await rowFor(notice.title).getByRole('button', { name: '비게시', exact: true }).click();
      await page.getByText('전광판 선택됨 · 비공개로 출력되지 않음', { exact: true }).waitFor();
      assert.equal(await rowFor(notice.title).getByRole('button', { name: '전광판 출력', exact: true }).count(), 0);
      await shot('notice-unpublished-status-390');
      await rowFor(notice.title).getByRole('button', { name: '게시', exact: true }).click();
      await rowFor(notice.title).getByText('게시 중', { exact: true }).waitFor();
      assert.equal(await rowFor(notice.title).getByRole('group', { name: '실행 확인' }).count(), 0, 'refresh invalidates an old output intention');
      results.push({ key: 'recovery-safety', overwriteCancelPreserved: true, keyboardEnterConfirmed: true, noAutoWrite: true, unsentConfirmationReplaceable: true, attemptedResponseLossBlocked: true, receiptReused: true, unpublishedStatusAccurate: true });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'task-results.json'), JSON.stringify({ before, build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), fixture: 'isolated random schema; FAILED historical state synthetic, commands real; no delivery', renderChecks, results, errors }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(results, null, 2));
    await context.close();
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
